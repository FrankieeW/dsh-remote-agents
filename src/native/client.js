import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import packageInfo from "../../package.json" with { type: "json" };

/** DSH/Node transport shim. All plugin business methods execute in Rust. */
export class NativeBackend {
  constructor(config) {
    this.config = config;
    this.pending = new Map();
    this.child = null;
    this.starting = null;
    this.closed = false;
  }
  async start() {
    if (this.closed) throw Error("Backend is closed");
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const target = `${process.platform}-${process.arch}`;
      if (!["darwin", "linux"].includes(process.platform))
        throw Error("The Rust backend currently supports macOS and Linux");
      const candidates = [
        new URL(`./native/${target}/backend`, import.meta.url),
        new URL(`../../lib/native/${target}/backend`, import.meta.url),
      ];
      let executable;
      for (const url of candidates) {
        try {
          await access(url, constants.X_OK);
          executable = fileURLToPath(url);
          break;
        } catch {}
      }
      if (!executable)
        throw Error(
          `The package has no Rust backend for ${target}. Install a package built for this platform; developers can run npm run build:native.`,
        );
      const child = spawn(executable, [], {
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      });
      this.child = child;
      let parts = [],
        length = 0;
      const fail = (message) => {
        for (const request of this.pending.values()) {
          clearTimeout(request.timer);
          request.cleanup?.();
          request.reject(Error(message));
        }
        this.pending.clear();
      };
      child.on("error", () => fail("Could not start the Rust backend"));
      child.on("exit", (code, signal) => {
        fail(
          `Rust backend exited (${signal || code}); check the conversation before retrying an unconfirmed action.`,
        );
        if (this.child === child) {
          this.child = null;
          this.starting = null;
        }
      });
      child.stdin.on("error", () => fail("Rust backend input closed"));
      child.stderr.resume(); // Never surface raw provider diagnostics or configuration.
      child.stdout.on("data", (chunk) => {
        try {
          let start = 0;
          while (start < chunk.length) {
            const newline = chunk.indexOf(10, start),
              end = newline < 0 ? chunk.length : newline;
            const part = chunk.subarray(start, end);
            parts.push(part);
            length += part.length;
            if (length > 64 * 1024 * 1024) throw Error("frame limit");
            start = newline < 0 ? chunk.length : newline + 1;
            if (newline < 0) break;
            const frame = JSON.parse(
              Buffer.concat(parts, length).toString("utf8"),
            );
            parts = [];
            length = 0;
            const request = this.pending.get(frame.id);
            if (!request) continue;
            this.pending.delete(frame.id);
            clearTimeout(request.timer);
            request.cleanup?.();
            frame.ok === true
              ? request.resolve(frame.value)
              : request.reject(
                  Object.assign(
                    Error(frame.error?.message || "Rust operation failed"),
                    { code: frame.error?.code || "BACKEND_ERROR" },
                  ),
                );
          }
        } catch {
          fail("Rust backend returned an invalid or oversized response");
          child.kill("SIGTERM");
        }
      });
      const response = await this.send(
        "initialize",
        {
          ...this.config,
          pluginVersion: packageInfo.version,
          // Electron's process.execPath is the application, not a Node CLI.
          // Let Rust discover a standalone Node executable in that environment.
          nodeExecutable: Object.hasOwn(this.config, "nodeExecutable")
            ? this.config.nodeExecutable
            : process.versions.electron
              ? null
              : process.execPath,
          claudeBridge:
            this.config.claudeBridge ||
            fileURLToPath(new URL("./claude-bridge.js", import.meta.url)),
        },
        undefined,
        15000,
      );
      if (
        response.protocolVersion !== 1 ||
        response.backend !== "rust" ||
        response.version !== packageInfo.version
      ) {
        child.kill("SIGTERM");
        throw Error("Incompatible native backend protocol");
      }
    })();
    try {
      return await this.starting;
    } catch (error) {
      this.child?.kill("SIGTERM");
      this.starting = null;
      throw error;
    }
  }
  send(method, params, signal, timeout = 45000) {
    return new Promise((resolve, reject) => {
      if (!this.child || signal?.aborted) {
        reject(Error("Backend unavailable or request cancelled"));
        return;
      }
      if (
        method !== "shutdown" &&
        (this.pending.size >= 64 ||
          this.child.stdin.writableLength > 8 * 1024 * 1024)
      ) {
        reject(
          Error("Rust backend is busy; wait for pending operations to finish."),
        );
        return;
      }
      const id = randomUUID();
      const abort = () => {
        const request = this.pending.get(id);
        if (!request) return;
        clearTimeout(request.timer);
        this.pending.delete(id);
        request.cleanup?.();
        reject(
          Error("Request cancelled; check the conversation before retrying."),
        );
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        signal?.removeEventListener("abort", abort);
        reject(
          Error(
            "Rust backend request timed out. Check the conversation before retrying.",
          ),
        );
      }, timeout);
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        cleanup: () => signal?.removeEventListener("abort", abort),
      });
      signal?.addEventListener("abort", abort, { once: true });
      this.child.stdin.write(
        JSON.stringify({ id, method, params }) + "\n",
        (error) => {
          if (error) {
            const r = this.pending.get(id);
            if (r) {
              this.pending.delete(id);
              clearTimeout(r.timer);
              r.cleanup?.();
              reject(Error("Rust backend input failed"));
            }
          }
        },
      );
    });
  }
  async request(method, params = {}, signal) {
    await this.start();
    return this.send(method, params, signal);
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    const child = this.child;
    if (!child) return;
    try {
      await this.send("shutdown", {}, undefined, 4000);
    } catch {}
    child.stdin.end();
    if (child.exitCode === null && !child.signalCode) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
}

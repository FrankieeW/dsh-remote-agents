import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, chmod } from "node:fs/promises";
import { resolve, dirname, basename, isAbsolute } from "node:path";
import { validSSH, machineKey } from "./ssh.js";
import { buildHerdrPreview } from "../import/herdr.js";

const exec = promisify(execFile);
const UUID = /^[a-f0-9-]{36}$/;
const KINDS = new Set(["dsh", "codex", "claude", "shell"]);
const KEYS = new Set(["C-c", "C-d", "Escape", "Enter", "Tab", "Up", "Down"]);
const LIMIT = 256 * 1024;
const clone = (value) => JSON.parse(JSON.stringify(value));
export class FleetError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "FleetError";
    this.code = code;
  }
}
function fail(message) {
  throw new FleetError("INVALID_INPUT", message);
}
function text(value, label, max = 512) {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > max ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    fail(`Invalid ${label}`);
  return value;
}
export function shellQuote(value) {
  if (typeof value !== "string" || value.includes("\0"))
    fail("Invalid shell argument");
  return `'${value.replaceAll("'", "'\\''")}'`;
}
function diagnostic(error) {
  return String(error?.message || error).slice(0, 2048);
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Dependency-free Node ESM API. All methods return promises. No execution occurs in constructor. */
export class FleetManager {
  constructor({
    statePath,
    executor = exec,
    timeout = 10000,
    maxBuffer = LIMIT,
    lockTimeout = 15000,
  } = {}) {
    text(statePath, "statePath", 4096);
    if (!Number.isInteger(timeout) || timeout < 100 || timeout > 120000)
      fail("Invalid timeout");
    if (
      !Number.isInteger(maxBuffer) ||
      maxBuffer < 1024 ||
      maxBuffer > 1024 * 1024
    )
      fail("Invalid maxBuffer");
    if (
      !Number.isInteger(lockTimeout) ||
      lockTimeout < 100 ||
      lockTimeout > 120000
    )
      fail("Invalid lockTimeout");
    if (typeof executor !== "function") fail("Invalid executor");
    this.statePath = resolve(statePath);
    this.executor = executor;
    this.options = { timeout, maxBuffer, encoding: "utf8", windowsHide: true };
    this.lockTimeout = lockTimeout;
    this.queue = Promise.resolve();
  }

  async _loadState() {
    let state;
    try {
      state = JSON.parse(await readFile(this.statePath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT")
        throw new FleetError(
          "INVALID_STATE",
          `Cannot read state: ${diagnostic(error)}`,
        );
      state = {
        version: 1,
        namespace: randomUUID(),
        machines: [{ id: "local", name: "Local", type: "local" }],
        agents: [],
        projects: [],
      };
    }
    if (state && typeof state === "object" && state.projects === undefined)
      state.projects = [];
    this._validateState(state);
    return state;
  }

  async _transaction(fn, { readOnly = false } = {}) {
    const run = async () => {
      if (readOnly) {
        // Atomic state replacement makes an unlocked read a consistent snapshot.
        // Confirmation recomputes under the writer lock, detecting intervening edits.
        this.state = await this._loadState();
        return clone((await fn()) ?? null);
      }
      await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 });
      const lockPath = `${this.statePath}.lock`;
      const deadline = Date.now() + this.lockTimeout;
      let lock;
      for (;;) {
        try {
          lock = await open(lockPath, "wx", 0o600);
          break;
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
          if (Date.now() >= deadline)
            throw new FleetError(
              "STATE_LOCKED",
              "State is locked; check for another running writer before removing a stale lock",
            );
          await pause(25);
        }
      }
      try {
        const state = await this._loadState();
        await chmod(this.statePath, 0o600).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
        this.state = state;
        const result = await fn();
        await this._save();
        return clone(result ?? null);
      } finally {
        await lock.close();
        await unlink(lockPath);
      }
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  _validateState(state) {
    if (
      state?.version !== 1 ||
      !UUID.test(state.namespace) ||
      !Array.isArray(state.machines) ||
      !Array.isArray(state.agents) ||
      !Array.isArray(state.projects)
    )
      throw new FleetError("INVALID_STATE", "Unsupported state schema");
    const ids = new Set();
    for (const machine of state.machines) {
      if (
        !machine ||
        ids.has(machine.id) ||
        !(
          (machine.id === "local" && machine.type === "local") ||
          (UUID.test(machine.id) && machine.type === "ssh" && validSSH(machine))
        )
      )
        throw new FleetError("INVALID_STATE", "Invalid machine record");
      ids.add(machine.id);
    }
    if (!ids.has("local"))
      throw new FleetError("INVALID_STATE", "Missing local machine");
    const projects = new Set();
    for (const project of state.projects) {
      if (
        !project ||
        !UUID.test(project.id) ||
        projects.has(project.id) ||
        !ids.has(project.machineId) ||
        project.source !== "herdr" ||
        typeof project.name !== "string" ||
        !project.name.length ||
        project.name.length > 100 ||
        /[\x00-\x1f\x7f]/.test(project.name) ||
        typeof project.cwd !== "string" ||
        !isAbsolute(project.cwd) ||
        project.cwd.length > 4096 ||
        /[\x00-\x1f\x7f]/.test(project.cwd)
      ) {
        throw new FleetError("INVALID_STATE", "Invalid project record");
      }
      projects.add(project.id);
    }
    const agents = new Set();
    for (const agent of state.agents) {
      if (
        !agent ||
        !UUID.test(agent.id) ||
        agents.has(agent.id) ||
        !ids.has(agent.machineId) ||
        !UUID.test(agent.owner) ||
        !/^dsh-[a-z0-9-]{1,24}-[a-f0-9]{32}$/.test(agent.session) ||
        !agent.session.endsWith(agent.id.replaceAll("-", "")) ||
        !KINDS.has(agent.kind) ||
        !["running", "exited", "unknown"].includes(agent.status)
      )
        throw new FleetError("INVALID_STATE", "Invalid agent record");
      if (agent.sessionId !== undefined && !/^\$\d+$/.test(agent.sessionId))
        throw new FleetError("INVALID_STATE", "Invalid tmux session ID");
      agents.add(agent.id);
    }
  }

  async _save() {
    const temporary = `${this.statePath}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(
        `${JSON.stringify(this.state, null, 2)}\n`,
        "utf8",
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, this.statePath);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  _machine(id) {
    const machine = this.state.machines.find((item) => item.id === id);
    if (!machine) throw new FleetError("NOT_FOUND", "Machine not found");
    return machine;
  }
  _agent(id) {
    const agent = this.state.agents.find((item) => item.id === id);
    if (!agent) throw new FleetError("NOT_FOUND", "Agent not found");
    return agent;
  }
  async _tmux(machine, args) {
    // Dedicated server socket: never enumerate or mutate the user's default tmux server.
    const tmuxArgs = ["-L", `dsh-fleet-${this.state.namespace}`, ...args];
    let file = "tmux";
    let argv = tmuxArgs;
    if (machine.type === "ssh") {
      file = "ssh";
      argv = [
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "ConnectTimeout=8",
        ...(machine.user === undefined ? [] : ["-l", machine.user]),
        ...(machine.port === undefined ? [] : ["-p", String(machine.port)]),
        "--",
        machine.host,
        ["tmux", ...tmuxArgs].map(shellQuote).join(" "),
      ];
    }
    const result = await this.executor(file, argv, { ...this.options });
    const stdout = String(result?.stdout ?? "");
    const stderr = String(result?.stderr ?? "");
    if (
      Buffer.byteLength(stdout) > this.options.maxBuffer ||
      Buffer.byteLength(stderr) > this.options.maxBuffer
    )
      throw new FleetError("OUTPUT_LIMIT", "Command output exceeded limit");
    return { stdout, stderr };
  }
  _target(agent) {
    return agent.sessionId || agent.session;
  }
  _pane(agent) {
    return `${agent.sessionId || `=${agent.session}`}:main`;
  }
  async _inspect(agent) {
    if (agent.stoppedAt) return { status: "exited", owned: false };
    try {
      const { stdout } = await this._tmux(this._machine(agent.machineId), [
        "display-message",
        "-p",
        "-t",
        this._pane(agent),
        "#{session_name}\t#{@dsh_fleet_owner}\t#{pane_dead}\t#{session_id}",
      ]);
      const [session, owner, dead, sessionId] = stdout.trim().split("\t");
      if (
        session !== agent.session ||
        owner !== agent.owner ||
        !["0", "1"].includes(dead) ||
        !/^\$\d+$/.test(sessionId)
      )
        return {
          status: "unknown",
          owned: false,
          diagnostic: "Session ownership could not be verified",
        };
      agent.sessionId = sessionId;
      return { status: dead === "1" ? "exited" : "running", owned: true };
    } catch (error) {
      return { status: "unknown", owned: false, diagnostic: diagnostic(error) };
    }
  }
  async _requireOwned(agent) {
    const result = await this._inspect(agent);
    agent.status = result.status;
    agent.updatedAt = new Date().toISOString();
    if (!result.owned) {
      await this._save();
      throw new FleetError(
        "OWNERSHIP_UNVERIFIED",
        result.diagnostic || "Agent has been stopped",
      );
    }
    return result;
  }

  snapshot({ readOnly = false } = {}) {
    if (typeof readOnly !== "boolean")
      return Promise.reject(
        new FleetError("INVALID_INPUT", "readOnly must be boolean"),
      );
    return this._transaction(
      () => ({
        version: 1,
        machines: this.state.machines,
        agents: this.state.agents,
        projects: this.state.projects,
      }),
      { readOnly },
    );
  }
  previewHerdr(input = {}) {
    return this._transaction(() => buildHerdrPreview(input, this.state), {
      readOnly: true,
    });
  }

  importHerdr(input = {}) {
    return this._transaction(() => {
      const preview = buildHerdrPreview(input, this.state);
      if (
        typeof input.confirmation !== "string" ||
        input.confirmation !== preview.digest
      ) {
        throw new FleetError(
          "STALE_PREVIEW",
          "Import confirmation is missing or stale; preview again and confirm the current plan",
        );
      }
      const importedMachineIds = [];
      const importedProjectIds = [];
      for (const { action, ...machine } of preview.machines) {
        if (action === "add") {
          const id = randomUUID();
          this.state.machines.push({ id, type: "ssh", ...machine });
          importedMachineIds.push(id);
        }
      }
      for (const { action, ...project } of preview.projects) {
        if (action === "add") {
          const id = randomUUID();
          this.state.projects.push({ id, ...project, source: "herdr" });
          importedProjectIds.push(id);
        }
      }
      return {
        ...preview,
        imported: {
          machines: preview.summary.machines,
          projects: preview.summary.projects,
        },
        importedMachineIds,
        importedProjectIds,
      };
    });
  }

  addMachine({ name, host, user, port } = {}) {
    return this._transaction(() => {
      text(name, "machine name", 128);
      const target = {
        host,
        ...(user === undefined ? {} : { user }),
        ...(port === undefined ? {} : { port }),
      };
      if (!validSSH(target)) fail("Invalid SSH host, user or port");
      if (
        this.state.machines.some(
          (machine) =>
            machine.type === "ssh" &&
            machineKey(machine) === machineKey(target),
        )
      )
        throw new FleetError("CONFLICT", "Machine already exists");
      const machine = { id: randomUUID(), name, ...target, type: "ssh" };
      this.state.machines.push(machine);
      return machine;
    });
  }
  removeMachine(machineId) {
    return this._transaction(() => {
      this._machine(machineId);
      if (machineId === "local") fail("Cannot remove local machine");
      if (
        this.state.projects.some((project) => project.machineId === machineId)
      )
        throw new FleetError(
          "CONFLICT",
          "Machine has imported projects; removal is refused to preserve their machine mapping",
        );
      if (
        this.state.agents.some(
          (agent) => agent.machineId === machineId && !agent.stoppedAt,
        )
      )
        throw new FleetError(
          "CONFLICT",
          "Stop all managed agents before removing machine",
        );
      this.state.agents = this.state.agents.filter(
        (agent) => agent.machineId !== machineId,
      );
      this.state.machines = this.state.machines.filter(
        (machine) => machine.id !== machineId,
      );
      return { machineId, removed: true };
    });
  }
  probe(machineId = "local") {
    return this._transaction(async () => {
      const machine = this._machine(machineId);
      try {
        const { stdout } = await this._tmux(machine, ["-V"]);
        return { machineId, ok: true, version: stdout.trim() };
      } catch (error) {
        return { machineId, ok: false, error: diagnostic(error) };
      }
    });
  }
  start({ machineId = "local", name, cwd, kind, args = [] } = {}) {
    return this._transaction(async () => {
      const machine = this._machine(machineId);
      text(name, "agent name", 100);
      text(cwd, "cwd", 4096);
      if (!isAbsolute(cwd)) fail("cwd must be absolute");
      if (!KINDS.has(kind)) fail("Unsupported agent kind");
      if (
        !Array.isArray(args) ||
        args.length > 100 ||
        args.some(
          (arg) =>
            typeof arg !== "string" ||
            arg.length > 4096 ||
            /[\x00-\x1f\x7f]/.test(arg),
        )
      )
        fail("Invalid args");
      const id = randomUUID();
      const project =
        basename(cwd)
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, "-")
          .slice(0, 24) || "root";
      const now = new Date().toISOString();
      const agent = {
        id,
        machineId,
        name,
        cwd,
        kind,
        args: [...args],
        session: `dsh-${project}-${id.replaceAll("-", "")}`,
        owner: randomUUID(),
        status: "unknown",
        createdAt: now,
        updatedAt: now,
      };
      try {
        await this._tmux(machine, ["has-session", "-t", this._target(agent)]);
        throw new FleetError("CONFLICT", "Generated session already exists");
      } catch (error) {
        if (error.code !== 1) throw error;
        // Creation is exclusive even if the preliminary absence check races.
      }
      this.state.agents.push(agent);
      await this._save(); // Reserve a recovery record before any session can be created.
      try {
        const created = await this._tmux(machine, [
          "new-session",
          "-d",
          "-P",
          "-F",
          "#{session_id}",
          "-s",
          agent.session,
          "-n",
          "main",
          "-c",
          cwd,
        ]);
        const sessionId = created.stdout.trim();
        if (!/^\$\d+$/.test(sessionId))
          throw new FleetError(
            "INVALID_SESSION",
            "tmux did not return a valid session ID",
          );
        agent.sessionId = sessionId;
        await this._tmux(machine, [
          "set-option",
          "-t",
          this._target(agent),
          "@dsh_fleet_owner",
          agent.owner,
        ]);
        await this._requireOwned(agent);
        await this._tmux(machine, [
          "set-option",
          "-w",
          "-t",
          this._pane(agent),
          "remain-on-exit",
          "on",
        ]);
        const command = [
          "exec",
          ...(kind === "shell"
            ? ["sh", "-i"]
            : kind === "dsh"
              ? ["dsh", "tui"]
              : [kind]),
          ...args,
        ]
          .map(shellQuote)
          .join(" ");
        await this._tmux(machine, [
          "send-keys",
          "-t",
          this._pane(agent),
          "-l",
          "--",
          command,
        ]);
        await this._tmux(machine, [
          "send-keys",
          "-t",
          this._pane(agent),
          "Enter",
        ]);
        agent.status = "running";
      } catch (error) {
        agent.status = "unknown";
        agent.diagnostic = diagnostic(error);
        await this._save();
        throw new FleetError(
          "START_FAILED",
          `Agent ${id} retained for recovery (socket dsh-fleet-${this.state.namespace}, session ${agent.session}): ${diagnostic(error)}`,
        );
      }
      return agent;
    });
  }
  read(agentId, { lines = 200 } = {}) {
    return this._transaction(async () => {
      if (!Number.isInteger(lines) || lines < 1 || lines > 2000)
        fail("lines must be 1–2000");
      const agent = this._agent(agentId);
      const result = await this._inspect(agent);
      agent.status = result.status;
      agent.updatedAt = new Date().toISOString();
      if (!result.owned)
        return {
          agentId,
          output: "",
          status: agent.status,
          truncated: false,
          diagnostic: result.diagnostic,
        };
      try {
        const { stdout } = await this._tmux(this._machine(agent.machineId), [
          "capture-pane",
          "-p",
          "-t",
          this._pane(agent),
          "-S",
          String(-lines),
        ]);
        const captured = stdout.replace(/\n$/, "").split("\n");
        return {
          agentId,
          output: captured.slice(-lines).join("\n"),
          status: agent.status,
          truncated: captured.length > lines,
        };
      } catch (error) {
        agent.status = "unknown";
        return {
          agentId,
          output: "",
          status: "unknown",
          truncated:
            error.code === "OUTPUT_LIMIT" ||
            error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
          diagnostic: diagnostic(error),
        };
      }
    });
  }
  send(agentId, { text: input, enter = true, key } = {}) {
    return this._transaction(async () => {
      if (typeof enter !== "boolean") fail("enter must be boolean");
      if (key !== undefined) {
        if (!KEYS.has(key) || input !== undefined)
          fail("Invalid key or mixed text/key input");
      } else if (
        typeof input !== "string" ||
        !input.length ||
        input.length > 16384 ||
        /[\x00-\x1f\x7f]/.test(input)
      )
        fail("Input must be single-line text up to 16384 characters");
      const agent = this._agent(agentId);
      const result = await this._requireOwned(agent);
      if (result.status !== "running")
        throw new FleetError("NOT_RUNNING", "Agent is not running");
      const machine = this._machine(agent.machineId);
      try {
        if (key !== undefined)
          await this._tmux(machine, [
            "send-keys",
            "-t",
            this._pane(agent),
            key,
          ]);
        else {
          await this._tmux(machine, [
            "send-keys",
            "-t",
            this._pane(agent),
            "-l",
            "--",
            input,
          ]);
          if (enter)
            await this._tmux(machine, [
              "send-keys",
              "-t",
              this._pane(agent),
              "Enter",
            ]);
        }
      } catch (error) {
        agent.status = "unknown";
        await this._save();
        throw error;
      }
      return agent;
    });
  }
  interrupt(agentId) {
    return this.send(agentId, { key: "C-c" });
  }
  stop(agentId) {
    return this._transaction(async () => {
      const agent = this._agent(agentId);
      if (agent.stoppedAt) return agent;
      await this._requireOwned(agent);
      try {
        await this._tmux(this._machine(agent.machineId), [
          "kill-session",
          "-t",
          this._target(agent),
        ]);
      } catch (error) {
        agent.status = "unknown";
        await this._save();
        throw error;
      }
      agent.status = "exited";
      agent.stoppedAt = agent.updatedAt = new Date().toISOString();
      return agent;
    });
  }
}

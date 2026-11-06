// Vendor SDK transport only. Rust owns sessions, policy validation, approval
// state, persistence, event normalization and remote command construction.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
const controller = new AbortController(),
  approvals = new Map();
let started = false,
  active,
  sequence = 0;
const output = (value) => {
  const line = JSON.stringify(value) + "\n";
  if (
    Buffer.byteLength(line) > 8 * 1024 * 1024 ||
    process.stdout.writableLength > 16 * 1024 * 1024
  ) {
    throw Error("Claude SDK transport exceeded its frame/backpressure limit");
  }
  return process.stdout.write(line);
};
const stop = () => {
  controller.abort();
  try {
    active?.close();
  } catch {}
  for (const reply of approvals.values()) reply(false);
  approvals.clear();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
const input = createInterface({ input: process.stdin });
input.on("close", stop);
input.on("line", (line) => {
  try {
    if (Buffer.byteLength(line) > 1024 * 1024)
      throw Error("Bridge input exceeds limit");
    const command = JSON.parse(line);
    if (command.type === "abort") {
      stop();
      return;
    }
    if (command.type === "approval") {
      const reply = approvals.get(command.id);
      approvals.delete(command.id);
      reply?.(command.allow === true);
      return;
    }
    if (command.type !== "start" || started)
      throw Error("Invalid SDK bridge command");
    started = true;
    void run(command)
      .catch((error) =>
        output({
          type: "bridge_error",
          message: String(error.message || "Claude SDK failed").slice(0, 2048),
        }),
      )
      .finally(() => {
        stop();
        input.close();
      });
  } catch {
    output({ type: "bridge_error", message: "Invalid SDK bridge input" });
    stop();
    input.close();
  }
});
async function run(config) {
  const { session, executable, prompt, backendBinary, machine } = config,
    settings = session.settings;
  active = query({
    prompt,
    options: {
      cwd: session.cwd,
      pathToClaudeCodeExecutable: executable,
      abortController: controller,
      includePartialMessages: true,
      settingSources: ["user", "project", "local"],
      ...(session.providerSessionId
        ? { resume: session.providerSessionId }
        : {}),
      ...(settings.model ? { model: settings.model } : {}),
      ...(settings.effort ? { effort: settings.effort } : {}),
      ...(settings.permissions !== "cli"
        ? { permissionMode: settings.permissions }
        : {}),
      ...(settings.permissions === "bypassPermissions"
        ? { allowDangerouslySkipPermissions: true }
        : {}),
      ...(machine?.type === "ssh"
        ? {
            spawnClaudeCodeProcess: (options) =>
              spawn(
                backendBinary,
                [
                  "--claude-ssh",
                  JSON.stringify(machine),
                  session.cwd,
                  executable,
                  ...options.args,
                ],
                { stdio: ["pipe", "pipe", "pipe"], signal: options.signal },
              ),
          }
        : {}),
      canUseTool: async (toolName, toolInput, context) => {
        const id = `sdk-approval-${++sequence}`;
        if (controller.signal.aborted || context.signal?.aborted)
          return { behavior: "deny", message: "Request cancelled" };
        const allow = await new Promise((resolve) => {
          const abort = () => {
            approvals.delete(id);
            output({ type: "bridge_cancel", id });
            resolve(false);
          };
          context.signal?.addEventListener("abort", abort, { once: true });
          approvals.set(id, (value) => {
            context.signal?.removeEventListener("abort", abort);
            resolve(value);
          });
          output({
            type: "bridge_approval",
            id,
            toolName,
            input: toolInput,
            title: context.title,
            description: context.description,
            requiresUserInteraction: context.requiresUserInteraction,
          });
        });
        return allow && !controller.signal.aborted && !context.signal?.aborted
          ? { behavior: "allow", updatedInput: toolInput }
          : { behavior: "deny", message: "User declined or approval expired" };
      },
    },
  });
  for await (const message of active) output({ type: "sdk_message", message });
  output({ type: "bridge_end" });
}

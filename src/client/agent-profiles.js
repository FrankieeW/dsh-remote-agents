/**
 * Per-agent presentation. DSH stays fully native; external agents share the
 * native chrome but keep the behaviors that are specific to their runtime.
 */
export const AGENT_ORDER = Object.freeze(["native", "claude", "codex", "omp"]);

const PROFILES = Object.freeze({
  native: Object.freeze({ id: "native", name: "DSH", fullName: "DeepSeek Harness" }),
  claude: Object.freeze({
    id: "claude",
    name: "Claude Code",
    fullName: "Claude Code",
    placeholder: "Ask Claude Code…",
    approvalScope: "Allowing applies to this tool call only.",
  }),
  codex: Object.freeze({
    id: "codex",
    name: "Codex",
    fullName: "OpenAI Codex",
    placeholder: "Ask Codex…",
    approvalScope: "Allowing applies to this command or file change only.",
  }),
  omp: Object.freeze({
    id: "omp",
    name: "OMP",
    fullName: "OMP (oh-my-pi)",
    placeholder: "Ask OMP…",
    approvalScope: "OMP grants this call only; remembered approvals are never chosen for you.",
  }),
});

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Profile for a provider id; unknown ids get a neutral profile rather than a guess. */
export function agentProfile(provider) {
  return PROFILES[provider] || { id: String(provider || ""), name: provider ? String(provider) : "Agent", fullName: provider ? String(provider) : "Agent" };
}

export const agentName = (provider) => agentProfile(provider).name;

/** POSIX single-quote escaping for text the user pastes into a shell. */
export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

/**
 * Claude Code and Codex: the command that continues this conversation in a terminal.
 * Claude stores sessions per project directory, so the command enters the cwd first.
 */
export function resumeCommand(session, machine) {
  if (!["claude", "codex"].includes(session?.provider)) return "";
  const id = session.providerSessionId;
  const cwd = session.cwd;
  if (typeof id !== "string" || !SESSION_ID.test(id) || typeof cwd !== "string" || !cwd.startsWith("/")) return "";
  const command = `cd ${shellQuote(cwd)} && ${session.provider === "codex" ? "codex resume" : "claude --resume"} ${id}`;
  if (!session.machineId || session.machineId === "local") return command;
  if (!machine || machine.id !== session.machineId || !machine.host) return "";
  return `ssh -t${machine.user ? ` -l ${shellQuote(machine.user)}` : ""}${machine.port ? ` -p ${machine.port}` : ""} -- ${shellQuote(machine.host)} ${shellQuote(command)}`;
}

/**
 * OMP only: its RPC adapter refuses `/` commands and `!` shell shortcuts, which
 * would otherwise be accepted and then fail. Explain before sending instead.
 */
export function inputIssue(provider, text) {
  if (provider !== "omp") return "";
  return /^[/!]/.test(String(text ?? "").trimStart())
    ? "OMP chat only sends plain prompts. / commands and ! shell shortcuts are not run here."
    : "";
}

/** The scope sentence shown under an approval request for this agent. */
export function approvalScope(provider, approval) {
  const grant = approval?.details?.grant;
  if (provider === "omp" && typeof grant === "string" && grant) return `OMP grants ${grant}; remembered approvals are never chosen for you.`;
  return agentProfile(provider).approvalScope || "";
}

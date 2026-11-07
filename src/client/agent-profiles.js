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
    welcome: "Explore code, review edits, and follow Claude's tool activity.",
    views: [{ id: "chat", label: "Chat" }, { id: "tools", label: "Tools" }, { id: "tasks", label: "To-dos" }],
    taskLabel: "To-dos",
    permissionLabel: "Claude permissions",
    effortLabel: "Effort",
    suggestions: [
      { label: "Explore project", prompt: "Explain this project's structure and its main components." },
      { label: "Review code", prompt: "Review the current changes and identify correctness issues worth fixing." },
      { label: "Plan a change", prompt: "Help me plan a change to this project, including the implementation steps and validation." },
    ],
    approvalScope: "Allowing applies to this tool call only.",
  }),
  codex: Object.freeze({
    id: "codex",
    name: "Codex",
    fullName: "OpenAI Codex",
    placeholder: "Ask Codex…",
    welcome: "Keep your implementation plan, commands, and file changes together.",
    views: [{ id: "chat", label: "Chat" }, { id: "tasks", label: "Plan" }, { id: "changes", label: "Changes" }],
    taskLabel: "Plan",
    permissionLabel: "Codex sandbox & approvals",
    effortLabel: "Reasoning effort",
    suggestions: [
      { label: "Review changes", prompt: "Review the current working-tree changes, identify likely bugs, and explain suggested fixes." },
      { label: "Make a plan", prompt: "Create an implementation plan for the next change, with clear steps and checks." },
      { label: "Investigate a failure", prompt: "Help me investigate a failing check in this project and find its root cause." },
    ],
    approvalScope: "Allowing applies to this command or file change only.",
  }),
  omp: Object.freeze({
    id: "omp",
    name: "OMP",
    fullName: "OMP (oh-my-pi)",
    placeholder: "Ask OMP…",
    welcome: "Follow phased tasks and inspect tools in your local or SSH workspace.",
    views: [{ id: "chat", label: "Chat" }, { id: "tasks", label: "Tasks" }, { id: "tools", label: "Tools" }, { id: "models", label: "Models" }],
    taskLabel: "Tasks",
    permissionLabel: "OMP tool approval policy",
    effortLabel: "Thinking level",
    suggestions: [
      { label: "Inspect workspace", prompt: "Inspect this workspace and summarize its structure and development workflow." },
      { label: "Track a task", prompt: "Help me organize the next task into phases and keep a to-do list as we work." },
      { label: "Run checks", prompt: "Find the project's documented checks, run the relevant ones, and summarize their results." },
    ],
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

/** OMP's shell shortcut belongs to its terminal interface. */
export function inputIssue(provider, text) {
  if (provider !== "omp") return "";
  return /^!/.test(String(text ?? "").trimStart())
    ? "OMP ! shell shortcuts are not run here. Ask OMP to run a shell command in a plain prompt."
    : "";
}

/** The scope sentence shown under an approval request for this agent. */
export function approvalScope(provider, approval) {
  const grant = approval?.details?.grant;
  if (provider === "omp" && typeof grant === "string" && grant) return `OMP grants ${grant}; remembered approvals are never chosen for you.`;
  return agentProfile(provider).approvalScope || "";
}

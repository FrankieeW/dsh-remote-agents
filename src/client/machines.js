/** Pure helpers for fleet machine records; no DSH dependency. */

export const isLocalMachine = (machine) => machine?.type === "local" || machine?.kind === "local";
export const isRemovedMachine = (machine) => Boolean(machine?.removedAt);
export const activeMachines = (machines = []) => machines.filter((machine) => !isRemovedMachine(machine));

/** `user@host:port`, bracketing IPv6 hosts before a port so it parses back as a destination. */
export function machineAddress(machine) {
  const host = machine?.host || "SSH";
  const port = machine?.port ? `:${machine.port}` : "";
  const shown = port && host.includes(":") ? `[${host}]` : host;
  return `${machine?.user ? `${machine.user}@` : ""}${shown}${port}`;
}

/** One line from the last recorded connection test, or null when there is nothing to say. */
export function machineHealth(machine) {
  const check = machine?.lastCheck;
  if (!check) return isLocalMachine(machine) ? null : { state: "unknown", label: "Not tested yet" };
  if (!check.ok) return { state: "error", label: check.message || "Connection failed", checkedAt: check.checkedAt };
  const tmux = !check.tmux ? [] : check.tmux.ok ? [check.tmux.version || "tmux"] : ["no tmux (terminals unavailable)"];
  const clis = (check.clis || []).filter((cli) => cli.available).map((cli) => `${cli.label} ${cli.version || ""}`.trim());
  return {
    state: check.tmux && !check.tmux.ok ? "warn" : "ok",
    label: ["Connected", ...tmux, ...clis].join(" · "),
    checkedAt: check.checkedAt,
  };
}

/** Records that must go before a machine can be removed. */
export function removalBlockers(machine, snapshot) {
  return {
    workspaces: (snapshot?.projects || []).filter((project) => project.machineId === machine.id),
    terminals: (snapshot?.agents || []).filter((agent) => agent.machineId === machine.id && !agent.stoppedAt),
  };
}

/** “a”, “b”, “c” and 2 more */
export function quotedNames(items, limit = 3) {
  const shown = items.slice(0, limit).map((item) => `“${item.name || item.cwd || item.id}”`).join(", ");
  return items.length > limit ? `${shown} and ${items.length - limit} more` : shown;
}

/** Whether an add failure is a connection problem the user may choose to ignore. */
const NOT_RETRYABLE = new Set(["CONFLICT", "INVALID_INPUT", "MACHINE_REMOVED", "STATE_LOCKED"]);
export const canSaveUntested = (code) => !NOT_RETRYABLE.has(code);

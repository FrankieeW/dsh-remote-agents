import { describeTool, latestTodos } from "./tool-presentation.js";

/** Only project the records actually retained by the backend. */
export function agentViewData(session) {
  const records = [];
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  for (const message of messages) {
    for (const [index, tool] of (Array.isArray(message?.tools)
      ? message.tools
      : []
    ).entries()) {
      if (!tool || typeof tool !== "object" || Array.isArray(tool)) continue;
      let view;
      try {
        view = describeTool(tool, { cwd: session.cwd });
      } catch {
        view = { kind: "generic" };
      }
      records.push({
        key: `${message.id}:${typeof tool.id === "string" ? tool.id : index}`,
        tool,
        kind: view.kind,
      });
    }
  }
  const changes = records.filter(
    (r) => r.kind === "edit" || r.kind === "write",
  );
  const todos = latestTodos(messages) || [];
  return {
    records,
    changes,
    todos,
    limited:
      messages.some((m) => m?.toolsTruncated || m?.historyTruncated || Array.isArray(m?.tools) && m.tools.some(t => t?.truncated)) ||
      !!session?.historyTruncated,
  };
}

export function toolMatches(record, filter) {
  return (
    filter === "all" ||
    (filter === "files" &&
      ["read", "edit", "write", "search"].includes(record.kind)) ||
    (filter === "commands" && record.kind === "terminal") ||
    (filter === "agents" && record.kind === "task")
  );
}

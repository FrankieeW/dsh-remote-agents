/**
 * Turn an agent's structured tool record into native DSH tool-row content.
 * Claude Code (Bash, Read, Edit, MultiEdit, Write, Grep, Glob, WebFetch,
 * WebSearch, Task, TodoWrite) and OMP (bash, read, edit, write, grep, find, ls)
 * name their tools differently; both resolve to the same native views.
 */
const KINDS = Object.freeze({
  terminal: new Set(["bash", "shell", "commandexecution"]),
  edit: new Set(["filechange", "edit", "multiedit", "str_replace", "replace"]),
  write: new Set(["write", "create", "write_file"]),
  read: new Set(["read", "read_file", "view", "notebookread"]),
  search: new Set(["grep", "glob", "find", "ls", "list", "search", "rg"]),
  fetch: new Set(["webfetch", "web_fetch", "fetch"]),
  websearch: new Set(["websearch", "web_search"]),
  todo: new Set(["update_plan", "todowrite", "todo_write", "todo", "update_todos"]),
  task: new Set(["task", "agent", "subagent", "dispatch_agent"]),
});
const ICONS = Object.freeze({ terminal: "api", edit: "edit", write: "edit", read: "browse", search: "search", fetch: "browse", websearch: "globe", todo: "checklist", task: "users", generic: "sparkle" });
const TODO_STATUS = Object.freeze({ completed: "completed", done: "completed", in_progress: "in_progress", "in-progress": "in_progress", active: "in_progress" });

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => (typeof value === "string" ? value : "");
const firstLine = (value) => text(value).split("\n").find((line) => line.trim()) || "";

function kindOf(name) {
  const key = String(name || "").toLowerCase();
  for (const [kind, names] of Object.entries(KINDS)) if (names.has(key)) return kind;
  return "generic";
}

/** `mcp__server__tool` reads as `server · tool`; other names stay as the agent wrote them. */
export function toolTitle(name) {
  const value = String(name || "").trim();
  const mcp = /^mcp__(.+?)__(.+)$/.exec(value);
  return mcp ? `${mcp[1]} · ${mcp[2]}` : value || "Tool";
}

/** Paths inside the session directory are shown relative to it. */
export function displayPath(path, cwd) {
  const value = text(path);
  const root = text(cwd).replace(/\/+$/, "");
  return root && value.startsWith(`${root}/`) ? value.slice(root.length + 1) : value;
}

const pathOf = (input) => text(input.file_path) || text(input.path) || text(input.notebook_path) || text(input.filePath);

function joinTextBlocks(blocks) {
  const parts = blocks.filter((block) => isObject(block) && typeof block.text === "string").map((block) => block.text);
  return parts.length ? parts.join("\n") : undefined;
}

/** Readable tool output from SDK content blocks, OMP results or plain strings. */
export function toolResultText(result) {
  if (result === undefined || result === null) return "";
  if (typeof result === "string") {
    if (!/^\s*\[/.test(result)) return result;
    try {
      const parsed = JSON.parse(result);
      return Array.isArray(parsed) ? joinTextBlocks(parsed) ?? result : result;
    } catch { return result; }
  }
  if (Array.isArray(result)) return joinTextBlocks(result) ?? printable(result);
  if (isObject(result) && Array.isArray(result.content)) return joinTextBlocks(result.content) ?? printable(result);
  return printable(result);
}

export function printable(value) {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2) ?? ""; } catch { return "Unable to display this data"; }
}

function exitCodeOf(tool, output) {
  const detailed = tool.result?.details?.exitCode;
  if (Number.isInteger(detailed)) return detailed;
  const match = /(?:^|\n)\s*(?:exit code|command exited with code)\s*:?\s*(-?\d+)/i.exec(output);
  if (match) return Number(match[1]);
  return tool.isError || tool.status === "error" ? null : undefined;
}

function editDiffs(input, path) {
  const pairs = Array.isArray(input.edits) ? input.edits : [input];
  return pairs.filter(isObject).flatMap((edit) => {
    const oldText = edit.old_string ?? edit.oldText ?? edit.old_str;
    const newText = edit.new_string ?? edit.newText ?? edit.new_str;
    return typeof oldText === "string" && typeof newText === "string" ? [{ path, oldText, newText }] : [];
  });
}

/** Normalized todo items, or null when the input is not a todo list. */
export function todoItems(input) {
  if (!isObject(input) || !Array.isArray(input.todos)) return null;
  const items = input.todos.filter(isObject).map((item) => ({
    content: text(item.content) || text(item.title) || text(item.text) || text(item.activeForm),
    status: TODO_STATUS[item.status] || "pending",
  })).filter((item) => item.content);
  return items.length ? items : null;
}

/** DSH's native progress phrasing: "2 completed · 1 in progress · 3 pending". */
export function todoProgress(todos) {
  const done = todos.filter((item) => item.status === "completed").length;
  const active = todos.filter((item) => item.status === "in_progress").length;
  const pending = todos.length - done - active;
  return [done && `${done} completed`, active && `${active} in progress`, pending && `${pending} pending`].filter(Boolean).join(" · ");
}

function summaryFor(kind, input, cwd) {
  const path = displayPath(pathOf(input), cwd);
  switch (kind) {
    case "terminal": return text(input.description) || firstLine(input.command);
    case "edit": case "write": case "read": return path;
    case "search": {
      const pattern = text(input.pattern) || text(input.query);
      return pattern ? `${pattern}${path ? ` in ${path}` : ""}` : path;
    }
    case "fetch": return text(input.url);
    case "websearch": return text(input.query);
    case "task": return text(input.description) || firstLine(input.prompt);
    default: return path || firstLine(input.command) || text(input.pattern) || text(input.query) || text(input.url) || text(input.description);
  }
}

/** Everything a tool row renders: icon key, title, summary and an optional native body. */
export function describeTool(tool, { cwd } = {}) {
  const input = isObject(tool?.input) ? tool.input : {};
  let kind = kindOf(tool?.name);
  const output = toolResultText(tool?.result) || text(tool?.text);
  const todos = todoItems(input);
  if (todos) kind = "todo";
  const base = { kind, icon: ICONS[kind], title: toolTitle(tool?.name), summary: summaryFor(kind, input, cwd), output, input };
  if (kind === "todo") return { ...base, todos, summary: todoProgress(todos) };
  if (kind === "terminal" && typeof input.command === "string" && input.command) {
    return { ...base, terminal: { command: input.command, output, exitCode: exitCodeOf(tool, output) } };
  }
  if (kind === "edit" && Array.isArray(input.changes)) {
    const patches = input.changes.filter(change => isObject(change) && typeof change.diff === "string").map(change => ({
      path: displayPath(change.path, cwd), diff: change.diff,
    }));
    return { ...base, patches, summary: patches.map(change => change.path).join(", ") };
  }
  const path = pathOf(input);
  if (kind === "edit" && path) {
    const diffs = editDiffs(input, displayPath(path, cwd));
    if (diffs.length) return { ...base, diffs };
  }
  if (kind === "write" && path && typeof input.content === "string") {
    return { ...base, diffs: [{ path: displayPath(path, cwd), newText: input.content }] };
  }
  return base;
}

/** The newest todo list any tool call in the transcript wrote, or null. */
export function latestTodos(messages) {
  for (const message of [...(messages || [])].reverse()) {
    for (const tool of [...(message.tools || [])].reverse()) {
      const todos = todoItems(tool.input);
      if (todos) return todos;
    }
  }
  return null;
}

import test from "node:test";
import assert from "node:assert/strict";
import { agentProfile, approvalScope, inputIssue, resumeCommand, shellQuote } from "../src/client/agent-profiles.js";
import { relativeTimeAgo, relativeTimeLabel, timestampOf } from "../src/client/relative-time.js";
import { rowStatus, statusClass } from "../src/client/session-status.js";
import { describeTool, displayPath, latestTodos, todoProgress, toolResultText, toolTitle } from "../src/client/tool-presentation.js";
import { basename } from "../src/client/paths.js";

test("relative time uses DSH's native buckets for numbers and ISO strings", () => {
  const now = Date.parse("2026-11-07T12:00:00Z");
  assert.equal(relativeTimeLabel(now - 30_000, now), "now");
  assert.equal(relativeTimeLabel(now - 5 * 60_000, now), "5min");
  assert.equal(relativeTimeLabel(new Date(now - 3 * 3_600_000).toISOString(), now), "3h");
  assert.equal(relativeTimeLabel(now - 2 * 86_400_000, now), "2d");
  assert.equal(relativeTimeLabel(now - 65 * 86_400_000, now), "2mo");
  assert.equal(relativeTimeLabel(now - 800 * 86_400_000, now), "2y");
  assert.equal(relativeTimeLabel(now + 60_000, now), "now", "clock skew never yields negative distances");
  assert.equal(relativeTimeLabel(undefined, now), "");
  assert.equal(relativeTimeLabel("not a date", now), "");
  assert.equal(relativeTimeAgo(now - 5 * 60_000, now), "5min ago");
  assert.equal(relativeTimeAgo(now, now), "now");
  assert.equal(timestampOf("2026-11-07T12:00:00Z"), now);
});

test("agent profiles keep DSH native and give external agents their own behavior", () => {
  assert.equal(agentProfile("native").name, "DSH");
  assert.equal(agentProfile("claude").placeholder, "Ask Claude Code…");
  assert.equal(agentProfile("unknown-agent").name, "unknown-agent");
  assert.equal(agentProfile(undefined).name, "Agent");
  assert.match(inputIssue("omp", "/compact"), /plain prompts/);
  assert.match(inputIssue("omp", "   !rm -rf /"), /plain prompts/);
  assert.equal(inputIssue("omp", "explain src/a.js"), "");
  assert.equal(inputIssue("claude", "/compact"), "", "Claude handles its own slash commands");
  assert.match(approvalScope("omp", { details: { grant: "this call only" } }), /^OMP grants this call only/);
  assert.match(approvalScope("claude", {}), /this tool call only/);
});

test("Claude resume commands quote the project path and reject unsafe session IDs", () => {
  const session = { provider: "claude", cwd: "/Users/me/it's here", providerSessionId: "0f8b2c1e-1111-4222-8333-444455556666" };
  assert.equal(resumeCommand(session), `cd '/Users/me/it'\\''s here' && claude --resume 0f8b2c1e-1111-4222-8333-444455556666`);
  assert.equal(shellQuote("a b"), "'a b'");
  assert.equal(resumeCommand({ ...session, providerSessionId: "x; rm -rf ~" }), "");
  assert.equal(resumeCommand({ ...session, providerSessionId: undefined }), "");
  assert.equal(resumeCommand({ ...session, cwd: "relative" }), "");
  assert.equal(resumeCommand({ ...session, provider: "omp" }), "");
});

test("row status ranks pending input over running over unread completion", () => {
  assert.deepEqual(rowStatus({ provider: "native", status: "waiting", pendingInteraction: { kind: "question" } }), { state: "warning", label: "Waiting for answer", trailing: "Answer" });
  assert.deepEqual(rowStatus({ provider: "omp", status: "waiting" }), { state: "warning", label: "Waiting for approval", trailing: "Approval" });
  assert.equal(rowStatus({ provider: "native", status: "waiting", pendingInteraction: { kind: "other" } }).trailing, "Input");
  assert.equal(rowStatus({ provider: "claude", status: "running" }).state, "ongoing");
  assert.equal(rowStatus({ provider: "native", status: "completed", completionUnread: true }).state, "done");
  assert.equal(rowStatus({ provider: "claude", status: "error" }).state, "error");
  assert.equal(rowStatus({ provider: "native", status: "running", archived: true }).label, "Archived");
  assert.equal(rowStatus({ provider: "omp", status: "closed", archived: true }).label, "Closed");
  assert.equal(rowStatus({ provider: "omp", status: "interrupted" }).label, "Interrupted");
  assert.equal(statusClass("warning"), "is-waiting");
  assert.equal(statusClass("idle"), "");
});

test("tool presentation maps Claude Code and OMP tools onto native views", () => {
  const cwd = "/work/app";
  const bash = describeTool({ name: "Bash", status: "done", input: { command: "npm test\nnpm run lint", description: "Run checks" }, result: JSON.stringify([{ type: "text", text: "ok" }]) }, { cwd });
  assert.equal(bash.icon, "api");
  assert.equal(bash.summary, "Run checks");
  assert.deepEqual(bash.terminal, { command: "npm test\nnpm run lint", output: "ok", exitCode: undefined });
  const ompBash = describeTool({ name: "bash", isError: true, input: { command: "make" }, result: { content: [{ type: "text", text: "Command exited with code 2" }] } });
  assert.equal(ompBash.summary, "make");
  assert.equal(ompBash.terminal.exitCode, 2);
  assert.equal(describeTool({ name: "bash", isError: true, input: { command: "x" }, result: "boom" }).terminal.exitCode, null, "unknown failures still read as failed");

  const multi = describeTool({ name: "MultiEdit", input: { file_path: "/work/app/src/a.js", edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d" }] } }, { cwd });
  assert.equal(multi.summary, "src/a.js");
  assert.deepEqual(multi.diffs, [{ path: "src/a.js", oldText: "a", newText: "b" }, { path: "src/a.js", oldText: "c", newText: "d" }]);
  const ompEdit = describeTool({ name: "edit", input: { path: "/elsewhere/b.js", oldText: "x", newText: "y" } }, { cwd });
  assert.deepEqual(ompEdit.diffs, [{ path: "/elsewhere/b.js", oldText: "x", newText: "y" }]);
  assert.equal(describeTool({ name: "edit", input: { path: "/work/app/z", hashes: [1] } }, { cwd }).diffs, undefined, "unknown edit shapes fall back to the generic view");
  assert.deepEqual(describeTool({ name: "Write", input: { file_path: "/work/app/new.md", content: "# hi" } }, { cwd }).diffs, [{ path: "new.md", newText: "# hi" }]);

  assert.equal(describeTool({ name: "Grep", input: { pattern: "TODO", path: "/work/app/src" } }, { cwd }).summary, "TODO in src");
  assert.equal(describeTool({ name: "ls", input: { path: "/work/app/lib" } }, { cwd }).summary, "lib");
  assert.equal(describeTool({ name: "WebFetch", input: { url: "https://example.com", prompt: "x" } }).summary, "https://example.com");
  assert.equal(describeTool({ name: "WebSearch", input: { query: "dsh" } }).icon, "globe");
  assert.equal(describeTool({ name: "Task", input: { description: "Explore", prompt: "long" } }).icon, "users");
  const todo = describeTool({ name: "TodoWrite", input: { todos: [{ content: "A", status: "completed" }, { content: "B", status: "in_progress" }, { title: "C", status: "weird" }, { status: "pending" }] } });
  assert.equal(todo.kind, "todo");
  assert.deepEqual(todo.todos, [{ content: "A", status: "completed" }, { content: "B", status: "in_progress" }, { content: "C", status: "pending" }]);
  assert.equal(todo.summary, "1 completed · 1 in progress · 1 pending");
  const mcp = describeTool({ name: "mcp__github__create_issue", input: { title: "x" } });
  assert.equal(mcp.title, "github · create_issue");
  assert.equal(mcp.icon, "sparkle");
  assert.equal(describeTool({ name: "", input: null }).title, "Tool");
});

test("tool output parsing tolerates truncated or foreign payloads", () => {
  assert.equal(toolResultText(undefined), "");
  assert.equal(toolResultText("plain"), "plain");
  assert.equal(toolResultText('[{"type":"text","text":"a"},{"type":"image"},{"type":"text","text":"b"}]'), "a\nb");
  assert.equal(toolResultText('[{"type":"text","text":"cut'), '[{"type":"text","text":"cut', "truncated JSON stays verbatim");
  assert.equal(toolResultText([1, 2]), "[\n  1,\n  2\n]");
  assert.equal(toolResultText({ content: [{ type: "text", text: "omp" }], details: {} }), "omp");
  assert.equal(toolResultText({ ok: true }), '{\n  "ok": true\n}');
  assert.equal(toolTitle("Read"), "Read");
  assert.equal(displayPath("/work/app/x", "/work/app/"), "x");
  assert.equal(displayPath("/work/application/x", "/work/app"), "/work/application/x", "path boundaries are respected");
  assert.equal(todoProgress([{ status: "pending" }]), "1 pending");
  assert.equal(basename("/a/b/"), "b");
  assert.equal(basename("/"), "/");
  assert.equal(basename(""), "");
});

test("the docked to-do list follows the newest todo write", () => {
  const write = (id, content) => ({ id, name: "TodoWrite", input: { todos: [{ content, status: "pending" }] } });
  assert.equal(latestTodos([]), null);
  assert.equal(latestTodos(undefined), null);
  const messages = [{ tools: [write("1", "old")] }, { tools: [write("2", "newer"), { id: "3", name: "Bash", input: { command: "ls" } }] }, { tools: [] }];
  assert.deepEqual(latestTodos(messages), [{ content: "newer", status: "pending" }]);
});

test("Codex keeps terminal output, patches, plans and native resume identity", () => {
  assert.equal(agentProfile("codex").placeholder, "Ask Codex…");
  assert.equal(resumeCommand({ provider: "codex", cwd: "/tmp/a b", providerSessionId: "thread-1" }), "cd '/tmp/a b' && codex resume thread-1");
  assert.match(approvalScope("codex", {}), /this command or file change only/);
  const command = describeTool({ name: "commandExecution", input: { command: "npm test" }, result: { content: [{ text: "passed" }], details: { exitCode: 0 } } });
  assert.deepEqual(command.terminal, { command: "npm test", output: "passed", exitCode: 0 });
  const patch = describeTool({ name: "fileChange", input: { changes: [{ path: "/tmp/project/a.js", diff: "-a\n+b" }] } }, { cwd: "/tmp/project" });
  assert.deepEqual(patch.patches, [{ path: "a.js", diff: "-a\n+b" }]);
  assert.equal(patch.summary, "a.js");
  assert.deepEqual(describeTool({ name: "update_plan", input: { todos: [{ content: "Verify", status: "in_progress" }] } }).todos, [{ content: "Verify", status: "in_progress" }]);
});

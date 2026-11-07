import React, { useState, useEffect, useRef } from "react";
import { TodoList } from "./chat-todos.jsx";
import { DIFF_LABELS, MARKDOWN_LABELS, TERMINAL_LABELS } from "./native-labels.js";
import { describeTool, printable, toolTitle, unifiedHunks } from "./tool-presentation.js";
import {
  DiffBlock, DisclosureRow, IconApiOutlineRegular, IconBrowseOutlineRegular, IconChecklistOutlineRegular, IconEditOutlineRegular,
  IconGlobeOutlineRegular, IconSearchOutlineRegular, IconSparkleRegular, IconUsersOutlineRegular, MarkdownText, StateDot,
  TerminalBlock, TextShimmer, UserMessageBubble,
} from "./native.js";

const ICONS = Object.freeze({
  api: IconApiOutlineRegular, edit: IconEditOutlineRegular, browse: IconBrowseOutlineRegular, search: IconSearchOutlineRegular,
  globe: IconGlobeOutlineRegular, checklist: IconChecklistOutlineRegular, users: IconUsersOutlineRegular, sparkle: IconSparkleRegular,
});

/** One unfamiliar tool payload must never unmount the conversation/composer. */
export class ToolRenderBoundary extends React.Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    const tool = this.props.tool;
    return <details className="agent-chat-tool" role="status">
      <summary>{toolTitle(tool?.name)} · Tool display unavailable — view raw data</summary>
      <pre>{printable({ input: tool?.input, result: tool?.result, text: tool?.text })}</pre>
    </details>;
  }
}

function IoCard({ input, output, failed }) {
  return <div className="agent-chat-io">
    {input && <div className="agent-chat-io-section"><span className="agent-chat-io-label">IN</span><span className="agent-chat-io-text">{input}</span></div>}
    {input && output && <div className="agent-chat-io-divider" />}
    {output && <div className="agent-chat-io-section"><span className="agent-chat-io-label">OUT</span>
      <span className="agent-chat-io-text" data-error={failed || undefined}>{output}</span></div>}
  </div>;
}

function ToolBody({ view, running, failed, cwd }) {
  if (view.terminal) {
    return <TerminalBlock className="agent-chat-tool-block" command={view.terminal.command} output={view.terminal.output}
      exitCode={view.terminal.exitCode} running={running} cwd={cwd} labels={TERMINAL_LABELS} />;
  }
  if (view.diffs) {
    return <>
      <DiffBlock className="agent-chat-tool-block" diffs={view.diffs} labels={DIFF_LABELS} maxLines={9} />
      {failed && view.output && <IoCard output={view.output} failed />}
    </>;
  }
  if (view.patches) return <>{view.patches.map((patch, index) => {
    const hunks = unifiedHunks(patch.diff);
    return <div className="agent-chat-patch" key={`${patch.path}:${index}`}>
      {hunks.length ? hunks.map((hunk, i) => <div key={i}><p className="agent-chat-caption">{hunk.header}</p><DiffBlock className="agent-chat-tool-block" diffs={[{ path: patch.path, oldText: hunk.oldText, newText: hunk.newText }]} labels={DIFF_LABELS} maxLines={9} /></div>) : <>
        <div className="agent-chat-patch-path">{patch.path}</div>
        <MarkdownText text={`\`\`\`diff\n${patch.diff}\n\`\`\``} labels={MARKDOWN_LABELS} />
      </>}
    </div>;
  })}</>;
  if (view.todos) return <TodoList todos={view.todos} />;
  const input = Object.keys(view.input).length ? printable(view.input) : "";
  return <IoCard input={input} output={view.output} failed={failed} />;
}

/** A native DSH tool row: icon, the agent's tool name, a one-line summary, expandable detail. */
function ToolRow({ tool, cwd, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  const view = describeTool(tool, { cwd });
  const Icon = ICONS[view.icon] || IconSparkleRegular;
  const running = tool.status === "running";
  const failed = tool.isError === true || tool.status === "error";
  const expandable = !!(view.terminal || view.diffs || view.patches || view.todos || view.output || Object.keys(view.input).length);
  const summary = <>
    {view.summary && <><span className="agent-chat-tool-sep" aria-hidden="true" />
      <span className={`agent-chat-tool-summary${failed ? " is-error" : ""}`}><TextShimmer active={running}>{view.summary}</TextShimmer></span></>}
    {failed && <span className="agent-chat-tool-flag">Failed</span>}
  </>;
  return <DisclosureRow className={`agent-chat-tool agent-tool-kind-${view.kind} agent-tool-status-${failed ? 'error' : running ? 'running' : 'idle'}`} rowClassName="agent-chat-tool-row" titleClassName="agent-chat-tool-title"
    icon={<span className="agent-chat-tool-icon"><Icon size={14} /></span>} title={view.title} running={running} open={open && expandable} expandable={expandable}
    expandOnRowClick keepContentWhenOpen onToggle={() => setOpen((value) => !value)} collapsedContent={summary}>
    <div className="agent-chat-tool-body">
      <ToolBody view={view} running={running} failed={failed} cwd={cwd} />
      {tool.truncated && <p className="agent-chat-caption">Tool data was truncated to fit the stored transcript.</p>}
    </div>
  </DisclosureRow>;
}

export function ToolCard({ tool, cwd, defaultOpen = false }) {
  return <ToolRenderBoundary tool={tool}><ToolRow tool={tool} cwd={cwd} defaultOpen={defaultOpen} /></ToolRenderBoundary>;
}

function UserMessage({ message }) {
  return <article className="agent-chat-user" aria-label="User message">
    <UserMessageBubble className="agent-chat-bubble">{message.text}</UserMessageBubble>
    {message.textTruncated && <p className="agent-chat-caption">This message was truncated.</p>}
  </article>;
}

function OriginalOmpTurn({ api, session, message }) {
  const [snapshot, setSnapshot] = useState(null), [opened, setOpened] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [detail, setDetail] = useState(null);
  const epoch = useRef(0), locked = useRef(false);
  useEffect(() => () => { epoch.current++; }, []);
  async function load(offset = 0, toolId) {
    if (locked.current) return;
    locked.current = true; const current = ++epoch.current;
    setBusy(true); setError(''); setOpened(true);
    try {
      const result = await api('chatOmpHistory', { id: session.id, messageId: message.id, offset, limit: 16, ...(toolId ? {toolId} : {}) });
      if (current !== epoch.current) return;
      if (toolId) {
        if (!result?.tool || result.tool.id !== toolId) throw new Error('Invalid original tool response');
        setDetail(result);
      } else {
        if (!Array.isArray(result?.tools) || !Number.isSafeInteger(result.totalTools)) throw new Error('Invalid original history response');
        setSnapshot(previous => ({ ...result, tools: offset && previous ? [...previous.tools, ...result.tools] : result.tools }));
        if (!offset) setDetail(null);
      }
    } catch (cause) { if (current === epoch.current) setError(cause.message || 'Could not load original history'); }
    finally { locked.current = false; if (current === epoch.current) setBusy(false); }
  }
  if ((session.machineId || 'local') !== 'local') return <p className="agent-chat-caption">For the complete remote record, inspect this session using OMP on its SSH host.</p>;
  return <section className="agent-original-history" aria-label="Original OMP history">
    <button type="button" disabled={busy} onClick={() => opened ? setOpened(false) : load()}>{busy ? 'Reading OMP history…' : opened ? 'Hide original OMP history' : 'View original OMP turn'}</button>
    {opened && <>
      <p className="agent-chat-caption">Read-only snapshot of this session's saved OMP history. Refresh to see later changes; this does not send a message or start an agent.</p>
      {error && <p role="alert">{error}</p>}
      <button type="button" disabled={busy} onClick={() => load()}>Refresh original history</button>
      {snapshot && <>
        <p role="status">Showing {snapshot.tools.length} of {snapshot.totalTools} original tool calls.</p>
        <div className="agent-original-history-tools">{snapshot.tools.map(tool => <div key={tool.id}>
          <ToolRenderBoundary tool={tool}><ToolRow tool={tool} cwd={session.cwd} /></ToolRenderBoundary>
          {tool.previewTruncated && <button type="button" disabled={busy} onClick={() => load(0, tool.id)}>Read larger record for {toolTitle(tool.name)}</button>}
        </div>)}</div>
        {snapshot.hasMore && <button type="button" disabled={busy} onClick={() => load(snapshot.nextOffset)}>Load more original tool calls</button>}
        {detail && <details open className="agent-original-tool-detail"><summary>{toolTitle(detail.tool.name)} · original record</summary><pre>{printable({input:detail.tool.input,result:detail.tool.result})}</pre>
          {detail.tool.previewTruncated && <p className="agent-chat-caption">This view is limited to {detail.detailLimit.toLocaleString()} characters per value. The original OMP file is unchanged.</p>}
        </details>}
        {snapshot.text && <details><summary>Original assistant text ({snapshot.textLength.toLocaleString()} characters)</summary><pre>{snapshot.text}</pre>
          {snapshot.textPreviewTruncated && <p className="agent-chat-caption">Text preview shortened; the original OMP file is unchanged.</p>}
        </details>}
      </>}
    </>}
  </section>;
}

function AssistantMessage({ message, cwd, streaming, session, api }) {
  const tools = message.tools || [];
  if (!tools.length && !message.text && !streaming) return null;
  return <article className="agent-chat-assistant" aria-label="Assistant message">
    {tools.length > 0 && <div className="agent-chat-tools">{tools.map((tool) => <ToolRenderBoundary key={tool.id} tool={tool}><ToolRow tool={tool} cwd={cwd} /></ToolRenderBoundary>)}</div>}
    {message.text
      ? <div className="agent-chat-markdown"><MarkdownText text={message.text} streaming={streaming} labels={MARKDOWN_LABELS} /></div>
      : streaming && <TextShimmer active className="agent-chat-working">Working…</TextShimmer>}
    {message.textTruncated && <p className="agent-chat-caption">Reply text exceeded the retained-message limit and was shortened.</p>}
    {message.toolsTruncated && <p className="agent-chat-caption">Only the first {tools.length} tool calls were retained in this plugin message.</p>}
    {session.provider === 'omp' && api && (message.textTruncated || message.toolsTruncated || tools.some(tool => tool.truncated)) && <OriginalOmpTurn key={message.id} api={api} session={session} message={message} />}
  </article>;
}

/** Messages in turn order; only the newest assistant turn streams. */
export function Transcript({ session, active, api }) {
  const last = session.messages.at(-1);
  return session.messages.map((message) => message.role === "user"
    ? <UserMessage key={message.id} message={message} />
    : <AssistantMessage key={message.id} message={message} cwd={session.cwd} streaming={active && message === last} session={session} api={api} />);
}

/** Native-style turn error row: red dot, title, message. */
export function TurnError({ title = "Error", children }) {
  return <div className="agent-chat-turn-error" role="alert">
    <StateDot state="error" className="agent-chat-turn-error-dot" />
    <span><strong>{title}</strong> <span className="agent-chat-turn-error-message">{children}</span></span>
  </div>;
}

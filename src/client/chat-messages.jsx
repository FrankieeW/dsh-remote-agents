import React, { useState } from "react";
import { TodoList } from "./chat-todos.jsx";
import { DIFF_LABELS, MARKDOWN_LABELS, TERMINAL_LABELS } from "./native-labels.js";
import { describeTool, printable, toolTitle } from "./tool-presentation.js";
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
  if (view.patches) return <>{view.patches.map((patch, index) => <div className="agent-chat-patch" key={`${patch.path}:${index}`}>
    <div className="agent-chat-patch-path">{patch.path}</div>
    <MarkdownText text={`\`\`\`diff\n${patch.diff}\n\`\`\``} labels={MARKDOWN_LABELS} />
  </div>)}</>;
  if (view.todos) return <TodoList todos={view.todos} />;
  const input = Object.keys(view.input).length ? printable(view.input) : "";
  return <IoCard input={input} output={view.output} failed={failed} />;
}

/** A native DSH tool row: icon, the agent's tool name, a one-line summary, expandable detail. */
function ToolRow({ tool, cwd }) {
  const [open, setOpen] = useState(false);
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
  return <DisclosureRow className="agent-chat-tool" rowClassName="agent-chat-tool-row" titleClassName="agent-chat-tool-title"
    icon={<Icon size={14} />} title={view.title} running={running} open={open && expandable} expandable={expandable}
    expandOnRowClick keepContentWhenOpen onToggle={() => setOpen((value) => !value)} collapsedContent={summary}>
    <div className="agent-chat-tool-body">
      <ToolBody view={view} running={running} failed={failed} cwd={cwd} />
      {tool.truncated && <p className="agent-chat-caption">Tool data was truncated to fit the stored transcript.</p>}
    </div>
  </DisclosureRow>;
}

function UserMessage({ message }) {
  return <article className="agent-chat-user" aria-label="User message">
    <UserMessageBubble className="agent-chat-bubble">{message.text}</UserMessageBubble>
    {message.textTruncated && <p className="agent-chat-caption">This message was truncated.</p>}
  </article>;
}

function AssistantMessage({ message, cwd, streaming }) {
  const tools = message.tools || [];
  if (!tools.length && !message.text && !streaming) return null;
  return <article className="agent-chat-assistant" aria-label="Assistant message">
    {tools.length > 0 && <div className="agent-chat-tools">{tools.map((tool) => <ToolRenderBoundary key={tool.id} tool={tool}><ToolRow tool={tool} cwd={cwd} /></ToolRenderBoundary>)}</div>}
    {message.text
      ? <div className="agent-chat-markdown"><MarkdownText text={message.text} streaming={streaming} labels={MARKDOWN_LABELS} /></div>
      : streaming && <TextShimmer active className="agent-chat-working">Working…</TextShimmer>}
    {(message.textTruncated || message.toolsTruncated) && <p className="agent-chat-caption">Some content in this message was truncated.</p>}
  </article>;
}

/** Messages in turn order; only the newest assistant turn streams. */
export function Transcript({ session, active }) {
  const last = session.messages.at(-1);
  return session.messages.map((message) => message.role === "user"
    ? <UserMessage key={message.id} message={message} />
    : <AssistantMessage key={message.id} message={message} cwd={session.cwd} streaming={active && message === last} />);
}

/** Native-style turn error row: red dot, title, message. */
export function TurnError({ title = "Error", children }) {
  return <div className="agent-chat-turn-error" role="alert">
    <StateDot state="error" className="agent-chat-turn-error-dot" />
    <span><strong>{title}</strong> <span className="agent-chat-turn-error-message">{children}</span></span>
  </div>;
}

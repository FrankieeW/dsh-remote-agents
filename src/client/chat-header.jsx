import React, { useEffect, useState } from "react";
import AgentLogo from "./AgentLogo.jsx";
import { resumeCommand } from "./agent-profiles.js";
import { rowStatus } from "./session-status.js";
import { basename } from "./paths.js";
import { Button, IconCheckOutlineRegular, IconCopyOutlineRegular, StateDot, Tooltip, writeClipboard } from "./native.js";

/** Claude Code / Codex: copy `cd <cwd> && claude --resume <id>` to continue in a terminal. */
function ResumeAction({ session, machine }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied || typeof setTimeout !== "function") return undefined;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const command = resumeCommand(session, machine);
  if (!command) return null;
  return <Tooltip label={copied ? "Copied" : command} side="bottom" delayMs={300} maxWidth={420} portal>
    <Button size="sm" variant="ghost" className="agent-chat-header-button"
      icon={copied ? <IconCheckOutlineRegular size={14} /> : <IconCopyOutlineRegular size={14} />}
      onClick={async () => { if (await writeClipboard(command)) setCopied(true); }}>Copy resume command</Button>
  </Tooltip>;
}

/** Native conversation header: workspace / session crumbs, live status, then actions. */
export function ChatHeader({ session, summary, provider, machine, busy, onClose, onExport }) {
  const name = session?.name || summary?.name || "Loading session…";
  const cwd = session?.cwd || summary?.cwd || "";
  const closed = session?.status === "closed";
  const status = session ? rowStatus({ ...session, provider, archived: closed }) : null;
  return <header className="agent-chat-header">
    <div className="agent-chat-title-row">
      <div className="agent-chat-crumbs" title={cwd}>
        {session?.machineId && session.machineId !== "local" && <span className="agent-chat-host" title="Remote SSH workspace">SSH · {machine?.name || session.machineId}</span>}
        {cwd && <><span className="agent-chat-crumb">{basename(cwd)}</span><span className="agent-chat-crumb-sep" aria-hidden="true">/</span></>}
        <h2 className="agent-chat-crumb is-current"><AgentLogo provider={provider} size={16} /><span>{name}</span></h2>
        {status && status.label !== "Idle" && <span className="agent-chat-status" data-state={status.state}>
          {status.state !== "idle" && <StateDot state={status.state} />}{status.label}
        </span>}
      </div>
      <div className="agent-chat-header-actions">
        <select aria-label="Export conversation" value="" disabled={busy || !session} onChange={event => { if (event.target.value) void onExport?.(event.target.value); }}><option value="" disabled>Export…</option><option value="markdown">Markdown</option><option value="json">JSON</option></select>
        <ResumeAction key={session?.id} session={session} machine={machine} />
        <Button size="sm" variant="ghost" className="agent-chat-header-button" disabled={busy || !session || closed} onClick={onClose}>Close session</Button>
      </div>
    </div>
  </header>;
}

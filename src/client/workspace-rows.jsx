import { RemoteAgentManager } from "./remote-agent-manager.jsx";
import React, { useEffect, useId, useState } from "react";
import AgentLogo from "./AgentLogo.jsx";
import { AGENT_ORDER, agentProfile } from "./agent-profiles.js";
import { relativeTimeAgo, relativeTimeLabel } from "./relative-time.js";
import { rowStatus, statusClass } from "./session-status.js";
import { basename } from "./paths.js";
import {
  HoverCard, IconArchiveOutlineRegular, IconBranchOutlineRegular, IconEditOutlineRegular, IconEllipsisOutlineRegular,
  IconFolderCloseRegular, IconFolderOpenRegular, IconNewChatOutlineRegular, IconPinFillRegular, IconPinOutlineRegular,
  IconTriangleRightFillRegular, IconUnarchiveOutlineRegular, Menu, StateDot, Tooltip,
} from "./native.js";

const COPY_LABELS = { copyLabel: "Copy", copiedLabel: "Copied" };

function HoverStatus({ state, label }) {
  return <div className="agent-hover-status">{state === "idle" ? null : <StateDot state={state} />}<span>{label}</span></div>;
}

function SessionHover({ row, status, now }) {
  const time = relativeTimeAgo(row.updatedAt, now);
  return <div className="agent-hover">
    <div className="agent-hover-title">{row.name}</div>
    {row.cwd && <div className="agent-hover-path">{row.cwd}</div>}
    {time && <div className="agent-hover-time">{time}</div>}
    <div className="agent-hover-status"><AgentLogo provider={row.provider} size={14} decorative /><span>{agentProfile(row.provider).fullName}</span></div>
    {status.label !== "Idle" && <HoverStatus state={status.state} label={status.label} />}
  </div>;
}

/** The native "new session" glyph; it opens an agent choice instead of a form. */
function NewSessionMenu({ title, providers, machineId, loadProviders, busy, onCreate, onOpenChange }) {
  const [open, setOpen] = useState(false);
  const toggle = (value) => { setOpen(value); onOpenChange(value); };
  const [remoteProviders, setRemoteProviders] = useState([]);
  const [error, setError] = useState("");
  const remote = machineId && machineId !== "local";
  useEffect(() => {
    if (!open || !remote || !loadProviders) return;
    let cancelled = false; setError(""); setRemoteProviders([]);
    loadProviders(machineId).then(value => { if (!cancelled) setRemoteProviders(value); }, cause => { if (!cancelled) setError(cause.message); });
    return () => { cancelled = true; };
  }, [open, remote, machineId, loadProviders]);
  const info = (id) => (remote ? remoteProviders : providers).find((item) => item.id === id);
  const available = (id) => (id === "native" && !remote) || info(id)?.available === true;
  const items = [
    { type: "label", id: "new-session", text: "New session" },
    ...AGENT_ORDER.map((id) => ({
      id,
      disabled: !available(id),
      icon: <AgentLogo provider={id} size={14} decorative />,
      label: <span className="agent-menu-option"><span>{agentProfile(id).name}</span>
        {!available(id) && <small>{(id === "native" && remote ? "DSH runs on the local Host" : info(id)?.reason || error || "Checking availability…")}</small>}</span>,
    })),
  ];
  return <Menu open={open} onClose={() => toggle(false)} items={items} align="end" dense portal
    onSelect={(id) => { toggle(false); if (available(id)) onCreate(id); }}
    anchor={<Tooltip label="New session" side="bottom" align="end" delayMs={500} portal>
      <button type="button" className="agent-workspace-row-button" aria-label={`New session in ${title}`} aria-haspopup="menu"
        aria-expanded={open} disabled={busy} onClick={(event) => { event.stopPropagation(); toggle(!open); }}>
        {busy ? <StateDot state="ongoing" size={14} /> : <IconNewChatOutlineRegular size={14} />}
      </button>
    </Tooltip>} />;
}

export function ProjectRow({ group, expanded, active, contentId, onToggle, providers, loadProviders, updateAgent, updateStatus, updatePlan, onRemoveWorkspace, creating, onCreate }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { path } = group.workspace;
  const title = group.workspace.title || basename(path) || "Other sessions";
  const row = <div className={`agent-workspace-heading${menuOpen ? " is-menu-open" : ""}`}>
    <button type="button" className="agent-workspace-collapse" aria-expanded={expanded} aria-controls={contentId} onClick={onToggle}>
      <span className={`agent-workspace-slot agent-workspace-folder${active ? " is-active" : ""}`} aria-hidden="true">
        {expanded ? <IconFolderOpenRegular /> : <IconFolderCloseRegular />}
      </span>
      <span className="agent-workspace-slot agent-workspace-chevron" aria-hidden="true">
        <IconTriangleRightFillRegular className={`agent-workspace-arrow${expanded ? " is-open" : ""}`} />
      </span>
      <span className="agent-workspace-title">{title}</span>
      {group.workspace.machineId && group.workspace.machineId !== "local" && <span className="agent-workspace-tag" title={group.workspace.machineName || group.workspace.machineId}>{group.workspace.machineName || "SSH"}</span>}
      {group.unregistered && <span className="agent-workspace-tag">History</span>}
    </button>
    {path && <span className="agent-workspace-row-actions">
      {group.workspace.machineId && group.workspace.machineId !== "local" && updateAgent && <RemoteAgentManager machineId={group.workspace.machineId} machineName={group.workspace.machineName} loadProviders={loadProviders} updateAgent={updateAgent} updateStatus={updateStatus} updatePlan={updatePlan} onOpenChange={setMenuOpen} />}
      {!group.unregistered && onRemoveWorkspace && <button type="button" className="agent-workspace-row-button" aria-label={`Remove workspace ${title}`} title="Remove workspace registration" onClick={() => onRemoveWorkspace(group)}>×</button>}
      <NewSessionMenu title={title} providers={providers} machineId={group.workspace.machineId} loadProviders={loadProviders} busy={creating} onCreate={onCreate} onOpenChange={setMenuOpen} />
    </span>}
  </div>;
  if (!path) return row;
  return <HoverCard anchor={row} openDelayMs={800} disabled={menuOpen} copyText={path} {...COPY_LABELS}
    content={<div className="agent-hover"><div className="agent-hover-title">{title}</div><div className="agent-hover-path">{path}</div>
      {group.unregistered && <div className="agent-hover-time">Not a registered workspace</div>}</div>} />;
}

function SessionMenu({ row, busy, onAction, onRename, onOpenChange }) {
  const [open, setOpen] = useState(false);
  const toggle = (value) => { setOpen(value); onOpenChange(value); };
  const items = [
    { id: "rename", label: "Rename", icon: <IconEditOutlineRegular /> },
    ...(row.provider !== "native" ? [{ id: "auto-name", label: "Use automatic title", icon: <IconEditOutlineRegular /> }] : []),
    { id: "fork", label: "Fork", icon: <IconBranchOutlineRegular /> },
    { id: row.pinned ? "unpin" : "pin", label: row.pinned ? "Unpin" : "Pin", icon: <IconPinOutlineRegular /> },
    row.archived
      ? { id: "unarchive", label: "Unarchive", icon: <IconUnarchiveOutlineRegular /> }
      : { id: "archive", label: "Archive", icon: <IconArchiveOutlineRegular /> },
  ].filter(item => row.provider === "native" || item.id !== "fork").map((item) => ({ ...item, disabled: busy || (item.id === "auto-name" && row.nameSource === "auto") || (item.id === "archive" && ["running", "waiting"].includes(row.status)) }));
  return <Menu open={open} onClose={() => toggle(false)} items={items} align="start" dense portal
    onSelect={(id) => { toggle(false); if (id === "rename") onRename(); else onAction(id, row.id); }}
    anchor={<button type="button" className="agent-workspace-row-button" aria-label={`Session actions for ${row.name}`}
      aria-haspopup="menu" aria-expanded={open} onClick={(event) => { event.stopPropagation(); toggle(!open); }}>
      <IconEllipsisOutlineRegular />
    </button>} />;
}

function RenameField({ row, busy, onSubmit, onDone }) {
  const [title, setTitle] = useState(row.name);
  return <form className="agent-workspace-rename" onSubmit={async (event) => {
    event.preventDefault();
    const value = title.trim();
    if (!value || busy) return;
    if (await onSubmit(value)) onDone();
  }}>
    <span className="agent-workspace-slot" aria-hidden="true"><AgentLogo provider={row.provider} size={14} decorative /></span>
    <input aria-label={`Rename ${row.name}`} title="Enter to save · Esc to cancel" value={title} readOnly={busy} autoFocus
      onFocus={(event) => event.currentTarget.select()} onChange={(event) => setTitle(event.target.value)}
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); onDone(); } }} />
  </form>;
}

export function SessionRow({ row, selected, now, opening, busy, onOpen, onAction }) {
  const [renaming, setRenaming] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const status = rowStatus(row);
  const time = relativeTimeLabel(row.updatedAt, now);
  const agent = agentProfile(row.provider);
  const actions = onAction && !renaming;
  const content = <div className={`agent-workspace-session-row${selected ? " is-selected" : ""}${row.archived ? " is-archived" : ""}${menuOpen ? " is-menu-open" : ""}`}>
    {renaming
      ? <RenameField row={row} busy={busy} onDone={() => setRenaming(false)} onSubmit={(title) => onAction("rename", row.id, title, row.provider)} />
      : <button type="button" className="agent-workspace-open" aria-current={selected ? "page" : undefined} disabled={opening} onClick={() => onOpen(row)}>
        <span className={`agent-workspace-slot agent-workspace-status ${statusClass(status.state)}`} role="img" aria-label={`${agent.name} · ${status.label}`}>
          {status.state === "idle" ? <AgentLogo provider={row.provider} size={14} decorative /> : <StateDot state={status.state} />}
        </span>
        <span className="agent-workspace-session-name">{row.name}</span>
        <span className="agent-workspace-resting">
          {status.trailing
            ? <span className="agent-workspace-time agent-workspace-pending">{status.trailing}</span>
            : time && <span className="agent-workspace-time">{time}</span>}
          {row.pinned && !row.archived && <span className="agent-workspace-pin" role="img" aria-label="Pinned" title="Pinned"><IconPinFillRegular size={14} /></span>}
        </span>
      </button>}
    {actions && <span className="agent-workspace-row-actions">
      <SessionMenu row={row} busy={busy} onAction={(action, id, value) => onAction(action, id, value, row.provider)} onRename={() => setRenaming(true)} onOpenChange={setMenuOpen} />
    </span>}
  </div>;
  return <li className="agent-workspace-session">
    <HoverCard anchor={content} openDelayMs={800} disabled={menuOpen || renaming} copyText={row.name} {...COPY_LABELS}
      content={<SessionHover row={row} status={status} now={now} />} />
  </li>;
}

const collapseKey = (group) => `dsh.remote-agents.collapsed:${group.key}`;
function readCollapsed(group) {
  try { return globalThis.localStorage?.getItem(collapseKey(group)) === "true"; } catch { return false; }
}

/** One workspace: its folder row, then nested workspaces, then its own sessions (native order). */
export function WorkspaceGroup({ group, depth, rows, searchActive, ownSelected, subtreeSelected, providers, loadProviders, updateAgent, updateStatus, updatePlan, onRemoveWorkspace, pending, onCreate, onOpen, onAction, isSelected, now, children }) {
  const contentId = useId();
  const [collapsed, setCollapsed] = useState(() => readCollapsed(group));
  const expanded = searchActive || !collapsed;
  const toggle = () => {
    setCollapsed(!collapsed);
    try { globalThis.localStorage?.setItem(collapseKey(group), String(!collapsed)); } catch { /* Storage may be disabled. */ }
  };
  return <section className="agent-workspace-group" aria-label={group.workspace.path || group.workspace.title} style={{ "--agent-ws-indent": `${depth * 12}px` }}>
    <ProjectRow group={group} expanded={expanded} active={ownSelected || (!expanded && subtreeSelected)} contentId={contentId} onToggle={toggle}
      providers={providers} loadProviders={loadProviders} updateAgent={updateAgent} updateStatus={updateStatus} updatePlan={updatePlan} onRemoveWorkspace={onRemoveWorkspace} creating={!!pending[`create:${group.key}`]} onCreate={(provider) => onCreate(group, provider)} />
    <div id={contentId} className="agent-workspace-group-body" hidden={!expanded}>
      {children && <div role="group" className="agent-workspace-children">{children}</div>}
      {rows.length > 0 && <ul className="agent-workspace-sessions">
        {rows.map((row) => <SessionRow key={`${row.provider}:${row.id}`} row={row} selected={isSelected(row)} now={now}
          opening={!!pending[`open:${row.provider}:${row.id}`]} busy={!!pending[`native:${row.id}`]} onOpen={onOpen} onAction={onAction} />)}
      </ul>}
    </div>
  </section>;
}

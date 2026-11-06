import React, { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import AgentLogo from './AgentLogo.jsx';

const LABELS = { native: 'DeepSeek Harness', omp: 'OMP', claude: 'Claude Code' };
const STATUS = { idle: 'Ready', starting: 'Starting', running: 'Running', waiting: 'Awaiting approval', waiting_approval: 'Awaiting approval', awaiting_approval: 'Awaiting approval', interrupted: 'Interrupted', completed: 'Completed', error: 'Error', closed: 'Closed' };
const PENDING = { approval: ['Awaiting approval', 'Approval'], question: ['Awaiting answer', 'Answer'], 'plan-review': ['Plan awaiting review', 'Plan review'] };
const identity = (value) => value;
const message = (error) => typeof error === 'string' ? error : error?.message || 'The request failed. Please try again.';
const basename = (path) => path?.split('/').filter(Boolean).at(-1) || path || 'Other sessions';
const rowKey = (row) => `${row.provider}:${row.id}`;

/** Keep host membership/order authoritative while retaining unregistered cwd history. */
export function groupWorkspaceSessions(workspaces, nativeState, externalSessions, nativeSelectedId, nativeStatuses) {
  const groups = workspaces.items.map((workspace) => ({ key: `workspace:${workspace.workspaceId}`, workspace, rows: [] }));
  const paths = new Map();
  const memberships = new Map();
  for (const group of groups) {
    if (!paths.has(group.workspace.path)) paths.set(group.workspace.path, group);
    for (const id of group.workspace.sessionIds || []) if (!memberships.has(id)) memberships.set(id, group);
  }
  const archived = new Set(workspaces.archivedSessionIds);
  const pinned = new Set(workspaces.pinnedSessionIds);
  const destination = (cwd) => {
    const path = cwd || '';
    if (!paths.has(path)) {
      const group = { key: `path:${path}`, workspace: { path, title: basename(path) }, rows: [], unregistered: true };
      paths.set(path, group);
      groups.push(group);
    }
    return paths.get(path);
  };
  for (const listedId of nativeState.ids) {
    const session = nativeState.byId[listedId];
    if (!session || session.origin === 'subagent') continue;
    const id = session.id || listedId;
    if (session.blank && id !== nativeSelectedId) continue;
    const live = nativeStatuses.get(id);
    const running = live?.running ?? session.running;
    const status = live?.pendingInteraction ? 'waiting' : running ? 'running' : live?.completionUnread ? 'completed' : 'idle';
    const row = { ...session, id, provider: 'native', name: session.title || session.displayTitle || (session.cwd ? basename(session.cwd) : id), archived: archived.has(id), pinned: pinned.has(id), status, pendingInteraction: live?.pendingInteraction, completionUnread: live?.completionUnread === true };
    (memberships.get(id) || destination(session.cwd)).rows.push(row);
  }
  for (const session of externalSessions) {
    destination(session.cwd).rows.push({ ...session, name: session.name || session.title || session.id, archived: session.status === 'closed' });
  }
  for (const group of groups) {
    const manualOrder = new Map((group.workspace.sessionIds || []).map((id, index) => [id, index]));
    group.rows.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned)
      || (a.provider === 'native' ? manualOrder.get(a.id) ?? Infinity : Infinity) - (b.provider === 'native' ? manualOrder.get(b.id) ?? Infinity : Infinity)
      || (Number(b.updatedAt) || Date.parse(b.updatedAt) || 0) - (Number(a.updatedAt) || Date.parse(a.updatedAt) || 0));
  }
  return groups;
}

function NativeActions({ row, busy, onAction }) {
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(row.name);
  const details = useRef(null);
  const close = () => { if (details.current) details.current.open = false; };
  if (renaming) return <form className="agent-workspace-rename" onSubmit={async (event) => {
    event.preventDefault();
    if (!title.trim() || busy) return;
    if (await onAction('rename', row.id, title.trim())) setRenaming(false);
  }}>
    <input aria-label={`Rename ${row.name}`} value={title} onChange={(event) => setTitle(event.target.value)} disabled={busy} autoFocus onKeyDown={(event) => { if (event.key === 'Escape') setRenaming(false); }} />
    <button type="submit" disabled={busy || !title.trim()}>Save</button>
    <button type="button" disabled={busy} onClick={() => setRenaming(false)}>Cancel</button>
  </form>;
  return <details className="agent-workspace-actions" ref={details}>
    <summary aria-label={`Actions for ${row.name}`} title="Session actions">⋯</summary>
    <div className="agent-workspace-menu">
      <button type="button" disabled={busy} onClick={() => { close(); setTitle(row.name); setRenaming(true); }}>Rename</button>
      {[['fork', 'Fork'], [row.pinned ? 'unpin' : 'pin', row.pinned ? 'Unpin' : 'Pin'], [row.archived ? 'unarchive' : 'archive', row.archived ? 'Unarchive' : 'Archive']].map(([action, label]) =>
        <button type="button" key={action} disabled={busy} onClick={() => { close(); onAction(action, row.id); }}>{label}</button>)}
    </div>
  </details>;
}

function WorkspaceGroup({ group, rows, providers, selectedId, nativeSelectedId, externalActive, onCreate, onOpen, onNativeAction, pending }) {
  const [collapsed, setCollapsed] = useState(false);
  const [choice, setChoice] = useState(null);
  const contentId = useId();
  const info = (provider) => providers.find((item) => item.id === provider);
  const available = (provider) => provider === 'native' || info(provider)?.available === true;
  const provider = choice && available(choice) ? choice : available('omp') ? 'omp' : 'native';
  const unavailable = ['omp', 'claude'].filter((id) => !available(id));
  const createPending = !!pending[`create:${group.key}`];
  return <section className="agent-workspace-group" aria-label={group.workspace.path || group.workspace.title}>
    <div className="agent-workspace-heading">
      <button type="button" className="agent-workspace-collapse" aria-expanded={!collapsed} aria-controls={contentId} onClick={() => setCollapsed(!collapsed)} title={group.workspace.path || group.workspace.title}>
        <span aria-hidden="true">{collapsed ? '›' : '⌄'}</span><strong>{group.workspace.title || basename(group.workspace.path)}</strong><span className="agent-workspace-count">{rows.length}</span>
      </button>
    </div>
    <div id={contentId} hidden={collapsed}>
      <p className="agent-workspace-path" title={group.workspace.path}>{group.workspace.path || 'No project directory'}{group.unregistered && <span> · History</span>}</p>
      {group.workspace.path && <form className="agent-workspace-create" aria-label={`New session in ${group.workspace.path}`} onSubmit={(event) => { event.preventDefault(); if (!createPending && available(provider)) onCreate(group, provider); }}>
        <select aria-label={`Backend for ${group.workspace.path}`} value={provider} disabled={createPending} onChange={(event) => setChoice(event.target.value)}>
          {['omp', 'native', 'claude'].map((id) => <option key={id} value={id} disabled={!available(id)} title={!available(id) ? info(id)?.reason || 'Runtime unavailable' : LABELS[id]}>{LABELS[id]}{!available(id) ? ` — ${info(id)?.reason || 'Unavailable'}` : ''}</option>)}
        </select>
        <button type="submit" disabled={createPending} title={`Create ${LABELS[provider]} session in ${group.workspace.path}`}><AgentLogo provider={provider} size={13} />{createPending ? 'Creating…' : '+ New'}</button>
      </form>}
      {group.workspace.path && unavailable.length > 0 && <details className="agent-workspace-availability"><summary>Unavailable backends</summary>{unavailable.map((id) => <p key={id}>{LABELS[id]}: {info(id)?.reason || 'Runtime unavailable'}</p>)}</details>}
      <ul className="agent-workspace-sessions">
        {rows.map((row) => {
          const selected = row.provider === 'native' ? row.id === nativeSelectedId : externalActive && !nativeSelectedId && row.id === selectedId;
          const backend = LABELS[row.provider] || row.provider;
          const interaction = row.pendingInteraction ? PENDING[row.pendingInteraction.kind] || ['Awaiting input', 'Input'] : null;
          const unread = !row.archived && row.status === 'completed' && row.completionUnread;
          const waiting = !row.archived && row.status === 'waiting';
          const status = row.archived ? row.provider === 'native' ? 'Archived' : 'Closed' : interaction?.[0] || (unread ? 'Completed · Unread' : STATUS[row.status] || row.status || 'Ready');
          return <li className={`agent-workspace-session${selected ? ' is-selected' : ''}`} key={rowKey(row)}>
            <div className="agent-workspace-session-line">
              <button type="button" className="agent-workspace-open" aria-current={selected ? 'page' : undefined} title={`${row.name} · ${backend}\n${row.cwd || group.workspace.path}`} disabled={!!pending[`open:${rowKey(row)}`]} onClick={() => onOpen(row)}>
                <span className="agent-workspace-logo" title={backend}><AgentLogo provider={row.provider} size={17} /></span>
                <span className="agent-workspace-session-name">{row.name}</span>
                {row.pinned && <span className="agent-workspace-pin" title="Pinned" aria-label="Pinned">◆</span>}
                {waiting && interaction && <span className="agent-workspace-pending">{interaction[1]}</span>}
                <span className={`agent-workspace-status${waiting ? ' is-waiting' : unread ? ' is-unread' : !row.archived && (row.status === 'running' || row.status === 'starting') ? ' is-running' : ''}`} title={status} aria-label={status}><span aria-hidden="true">{unread ? '◆' : '●'}</span></span>
              </button>
              {row.provider === 'native' && onNativeAction && <NativeActions row={row} busy={!!pending[`native:${row.id}`]} onAction={onNativeAction} />}
            </div>
          </li>;
        })}
      </ul>
      {!rows.length && <p className="agent-workspace-empty">No matching sessions</p>}
    </div>
  </section>;
}

/** A root-seat sidebar only: navigation and mutations belong to the plugin owner. */
export default function WorkspaceSidebar({ useSessions, useSessionStatus, useWorkspaces, store, onCreate, onOpen, onAddWorkspace, onNativeAction, nativeSelectedId, externalActive = true, wide = true, expandSidebar }) {
  const nativeState = useSessions(identity);
  const nativeStatuses = useSessionStatus(identity);
  const workspaces = useWorkspaces(identity);
  const catalog = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [path, setPath] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState({});
  const locks = useRef(new Set());
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const groups = useMemo(() => groupWorkspaceSessions(workspaces, nativeState, catalog.sessions, nativeSelectedId, nativeStatuses), [workspaces, nativeState, catalog.sessions, nativeSelectedId, nativeStatuses]);
  async function run(key, operation) {
    if (locks.current.has(key)) return false;
    locks.current.add(key);
    setPending((previous) => ({ ...previous, [key]: true }));
    setError('');
    try { await operation(); return true; }
    catch (failure) { if (mounted.current) setError(message(failure)); return false; }
    finally {
      locks.current.delete(key);
      if (mounted.current) setPending((previous) => { const next = { ...previous }; delete next[key]; return next; });
    }
  }
  if (!wide) return <aside className="agent-workspaces is-compact" aria-label="Workspaces"><button type="button" title="Expand workspaces" aria-label="Expand workspaces" onClick={expandSidebar}>☰</button></aside>;
  const search = query.trim().toLocaleLowerCase();
  return <aside className="agent-workspaces" aria-label="Workspaces">
    <header className="agent-workspace-toolbar"><h2>Workspaces</h2><label className="agent-workspace-sr-only" htmlFor="agent-workspace-search">Search sessions</label><input id="agent-workspace-search" type="search" placeholder="Search sessions…" value={query} onChange={(event) => setQuery(event.target.value)} />
      <select aria-label="Session history filter" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">All sessions</option><option value="active">Active sessions</option><option value="archived">Archived / closed</option></select>
    </header>
    <details className="agent-workspace-add"><summary>Add workspace</summary><form onSubmit={async (event) => {
      event.preventDefault();
      if (!path.trim().startsWith('/')) { setError('Enter an absolute project directory.'); return; }
      const directory = path.trim();
      if (await run('add', () => onAddWorkspace(directory))) { if (mounted.current) setPath((current) => current === directory ? '' : current); }
    }}><label>Project directory<input aria-label="Workspace directory" placeholder="/path/to/project" value={path} disabled={!!pending.add} onChange={(event) => setPath(event.target.value)} spellCheck={false} required /></label><button type="submit" disabled={!!pending.add || !path.trim()}>{pending.add ? 'Adding…' : 'Add workspace'}</button></form></details>
    {(error || catalog.error || workspaces.error) && <p className="agent-workspace-error" role="alert">{message(error || catalog.error || workspaces.error)}</p>}
    {(catalog.loading || nativeState.phase === 'pending' || workspaces.phase === 'pending') && <p className="agent-workspace-empty" role="status">Loading sessions…</p>}
    <nav className="agent-workspace-list" aria-label="Workspace sessions">
      {groups.map((group) => {
        const rows = group.rows.filter((row) => (filter === 'all' || (filter === 'archived' ? row.archived : !row.archived)) && (!search || [row.name, row.cwd, group.workspace.path, group.workspace.title, LABELS[row.provider], row.provider].some((value) => String(value || '').toLocaleLowerCase().includes(search))));
        const workspaceMatch = [group.workspace.path, group.workspace.title].some((value) => String(value || '').toLocaleLowerCase().includes(search));
        if (search && !rows.length && !workspaceMatch) return null;
        return <WorkspaceGroup key={group.key} group={group} rows={rows} providers={catalog.providers} nativeSelectedId={nativeSelectedId} externalActive={externalActive} selectedId={catalog.selectedId} pending={pending}
          onCreate={(target, provider) => run(`create:${target.key}`, () => onCreate({ provider, workspace: target.workspace }))}
          onOpen={(row) => run(`open:${rowKey(row)}`, () => onOpen({ provider: row.provider, id: row.id }))}
          onNativeAction={onNativeAction ? (action, id, value) => run(`native:${id}`, () => onNativeAction(action, id, value)) : null} />;
      })}
      {!groups.length && !catalog.loading && <p className="agent-workspace-empty">Add a workspace to create a session.</p>}
    </nav>
  </aside>;
}

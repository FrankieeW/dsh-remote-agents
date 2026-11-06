import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { agentProfile } from "./agent-profiles.js";
import { timestampOf } from "./relative-time.js";
import { FILTERS, LAYOUTS, WorkspaceHeader } from "./workspace-header.jsx";
import { basename } from "./paths.js";
import { WorkspaceGroup } from "./workspace-rows.jsx";
import { IconWorkspaceTreeOutlineRegular, Tooltip } from "./native.js";

const locationKey = (path, machineId = "local") => JSON.stringify([machineId, path]);
const identity = (value) => value;
const message = (error) => typeof error === "string" ? error : error?.message || "The request failed. Please try again.";
const LAYOUT_KEY = "dsh.remote-agents.workspace-layout";
const FILTER_KEY = "dsh.remote-agents.workspace-filter";

function readPreference(key, allowed) {
  try {
    const value = globalThis.localStorage?.getItem(key);
    return allowed.includes(value) ? value : allowed[0];
  } catch { return allowed[0]; }
}
function writePreference(key, value) {
  try { globalThis.localStorage?.setItem(key, value); } catch { /* Storage may be disabled. */ }
}

/** Re-render relative times once a minute, like the native list. */
function useNow(interval = 60_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (typeof setInterval !== "function") return undefined;
    const timer = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(timer);
  }, [interval]);
  return now;
}

/** Keep host membership/order authoritative while retaining unregistered cwd history. */
export function groupWorkspaceSessions(workspaces, nativeState, externalSessions, nativeSelectedId, nativeStatuses) {
  const groups = workspaces.items.map((workspace) => ({ key: `workspace:${workspace.workspaceId}`, workspace, rows: [] }));
  const paths = new Map();
  const memberships = new Map();
  for (const group of groups) {
    if (!paths.has(locationKey(group.workspace.path, group.workspace.machineId))) paths.set(locationKey(group.workspace.path, group.workspace.machineId), group);
    for (const id of group.workspace.sessionIds || []) if (!memberships.has(id)) memberships.set(id, group);
  }
  const archived = new Set(workspaces.archivedSessionIds);
  const pinned = new Set(workspaces.pinnedSessionIds);
  const destination = (cwd, machineId = "local") => {
    const path = cwd || "";
    const key = locationKey(path, machineId);
    if (!paths.has(key)) {
      const group = { key: `path:${key}`, workspace: { path, machineId, title: basename(path) || "Other sessions" }, rows: [], unregistered: true };
      paths.set(key, group);
      groups.push(group);
    }
    return paths.get(key);
  };
  for (const listedId of nativeState.ids) {
    const session = nativeState.byId[listedId];
    if (!session || session.origin === "subagent") continue;
    const id = session.id || listedId;
    if (session.blank && id !== nativeSelectedId) continue;
    const live = nativeStatuses.get(id);
    const running = live?.running ?? session.running;
    const status = live?.pendingInteraction ? "waiting" : running ? "running" : live?.completionUnread ? "completed" : "idle";
    const row = { ...session, id, provider: "native", name: session.title || session.displayTitle || (session.cwd ? basename(session.cwd) : id), archived: archived.has(id), pinned: pinned.has(id), status, pendingInteraction: live?.pendingInteraction, completionUnread: live?.completionUnread === true };
    (memberships.get(id) || destination(session.cwd)).rows.push(row);
  }
  for (const session of externalSessions) {
    destination(session.cwd, session.machineId).rows.push({ ...session, name: session.name || session.title || session.id, archived: session.archived ?? session.status === "closed" });
  }
  for (const group of groups) {
    const manualOrder = new Map((group.workspace.sessionIds || []).map((id, index) => [id, index]));
    group.rows.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned)
      || (a.provider === "native" ? manualOrder.get(a.id) ?? Infinity : Infinity) - (b.provider === "native" ? manualOrder.get(b.id) ?? Infinity : Infinity)
      || timestampOf(b.updatedAt) - timestampOf(a.updatedAt));
  }
  return groups;
}

/** Nest each group under its nearest registered path ancestor (segment-aware). */
export function workspaceForest(groups, nested) {
  const nodes = groups.map((group) => ({ ...group, children: [] }));
  if (!nested) return nodes;
  const roots = [];
  const pathOf = (node) => node.workspace.path.replace(/\/+$/, "") || "/";
  for (const node of nodes) {
    const path = pathOf(node);
    let parent;
    for (const candidate of nodes) {
      const ancestor = pathOf(candidate);
      if (candidate !== node && (candidate.workspace.machineId || "local") === (node.workspace.machineId || "local") && !candidate.unregistered && candidate.workspace.path && ancestor !== path && path.startsWith(ancestor === "/" ? "/" : `${ancestor}/`)
        && (!parent || ancestor.length > pathOf(parent).length)) parent = candidate;
    }
    if (parent) parent.children.push(node); else roots.push(node);
  }
  return roots;
}

function matchesFilter(row, filter) {
  return filter === "all" || (filter === "archived" ? row.archived : !row.archived);
}
function matchesSearch(row, group, search) {
  return !search || [row.name, row.cwd, group.workspace.path, group.workspace.title, agentProfile(row.provider).name, row.provider]
    .some((value) => String(value || "").toLocaleLowerCase().includes(search));
}

/** Filter one forest node and record whether its visible subtree holds the selection. */
function prepareGroup(group, { filter, search, isSelected, matches = new Set() }) {
  const children = group.children.map((child) => prepareGroup(child, { filter, search, isSelected, matches })).filter(Boolean);
  const rows = group.rows.filter((row) => matchesFilter(row, filter) && (matchesSearch(row, group, search) || matches.has(row.id)));
  const workspaceMatch = [group.workspace.path, group.workspace.title].some((value) => String(value || "").toLocaleLowerCase().includes(search));
  if (search && !rows.length && !workspaceMatch && !children.length) return null;
  if (group.unregistered && !rows.length && !children.length) return null;
  const ownSelected = rows.some(isSelected);
  return { group, rows, children, ownSelected, subtreeSelected: ownSelected || children.some((child) => child.subtreeSelected) };
}

function useOperations() {
  const [error, setError] = useState("");
  const [pending, setPending] = useState({});
  const locks = useRef(new Set());
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function run(key, operation) {
    if (locks.current.has(key)) return false;
    locks.current.add(key);
    setPending((previous) => ({ ...previous, [key]: true }));
    setError("");
    try { await operation(); return true; }
    catch (failure) { if (mounted.current) setError(message(failure)); return false; }
    finally {
      locks.current.delete(key);
      if (mounted.current) setPending((previous) => { const next = { ...previous }; delete next[key]; return next; });
    }
  }
  return { error, pending, run };
}

/** A root-seat sidebar only: navigation and mutations belong to the plugin owner. */
export default function WorkspaceSidebar({ useSessions, useSessionStatus, useWorkspaces, store, onCreate, onOpen, onAddWorkspace, onNativeAction, onRemoveWorkspace, nativeSelectedId, externalActive = true, wide = true, expandSidebar }) {
  const nativeState = useSessions(identity);
  const nativeStatuses = useSessionStatus(identity);
  const workspaces = useWorkspaces(identity);
  const catalog = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [query, setQuery] = useState("");
  const [textMatches, setTextMatches] = useState({ query: '', ids: [] });
  const [searchError, setSearchError] = useState('');
  const [removeTarget, setRemoveTarget] = useState(null);
  useEffect(() => {
    let cancelled = false; setSearchError('');
    if (!query.trim() || !store.search) { setTextMatches({ query: '', ids: [] }); return; }
    const timer = setTimeout(() => {
      store.search(query.trim()).then(rows => { if (!cancelled) setTextMatches({ query: query.trim().toLocaleLowerCase(), ids: rows.map(r => r.id) }); }, error => { if (!cancelled) setSearchError(error.message || 'Transcript search failed'); });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, store]);
  const [filter, setFilter] = useState(() => readPreference(FILTER_KEY, FILTERS));
  const [layout, setLayout] = useState(() => readPreference(LAYOUT_KEY, LAYOUTS));
  const groups = useMemo(() => groupWorkspaceSessions({ ...workspaces, items: [...workspaces.items, ...(catalog.remoteWorkspaces || [])] }, nativeState, catalog.sessions, nativeSelectedId, nativeStatuses), [workspaces, catalog.remoteWorkspaces, nativeState, catalog.sessions, nativeSelectedId, nativeStatuses]);
  const { error, pending, run } = useOperations();
  const now = useNow();
  if (!wide) {
    return <aside className="agent-workspaces is-compact" aria-label="Workspaces">
      <Tooltip label="Expand workspaces" side="right" delayMs={500} portal>
        <button type="button" className="agent-workspace-icon is-rail" aria-label="Expand workspaces" onClick={expandSidebar}><IconWorkspaceTreeOutlineRegular size={18} /></button>
      </Tooltip>
    </aside>;
  }
  const search = query.trim().toLocaleLowerCase();
  const isSelected = (row) => row.provider === "native" ? row.id === nativeSelectedId : externalActive && !nativeSelectedId && row.id === catalog.selectedId;
  const create = (group, provider) => run(`create:${group.key}`, () => onCreate({ provider, workspace: group.workspace }));
  const open = (row) => run(`open:${row.provider}:${row.id}`, () => onOpen({ provider: row.provider, id: row.id }));
  const nativeAction = (action, id, value, provider = 'native') => run(`native:${id}`, () => provider === 'native' ? onNativeAction?.(action, id, value) : store.sessionAction(action, id, value));
  const matches = new Set(textMatches.query === search ? textMatches.ids : []);
  const render = (node, depth) => <WorkspaceGroup key={node.group.key} group={node.group} depth={depth} rows={node.rows}
    searchActive={!!search} ownSelected={node.ownSelected} subtreeSelected={node.subtreeSelected} providers={catalog.providers} loadProviders={store.loadProviders} updateAgent={store.updateAgent} updateStatus={store.updateStatus} updatePlan={store.updatePlan} onRemoveWorkspace={onRemoveWorkspace ? group => setRemoveTarget(group.workspace) : undefined}
    pending={pending} now={now} isSelected={isSelected} onCreate={create} onOpen={open} onAction={nativeAction}>
    {node.children.length ? node.children.map((child) => render(child, depth + 1)) : null}
  </WorkspaceGroup>;
  const tree = workspaceForest(groups, layout === "workspace-tree")
    .map((group) => prepareGroup(group, { filter, search, isSelected, matches })).filter(Boolean);
  const loading = catalog.loading || nativeState.phase === "pending" || workspaces.phase === "pending";
  const failure = error || catalog.workspaceError || catalog.error || searchError || workspaces.error;
  return <aside className="agent-workspaces" aria-label="Workspaces">
    <WorkspaceHeader query={query} onQuery={setQuery} layout={layout} filter={filter} adding={!!pending.add}
      onLayout={(value) => { setLayout(value); writePreference(LAYOUT_KEY, value); }}
      onFilter={(value) => { setFilter(value); writePreference(FILTER_KEY, value); }}
      onAdd={(directory, machineId) => run("add", () => onAddWorkspace(directory, machineId))}
      machines={catalog.machines} browseDirectories={store.browseDirectories} addSSHHost={store.addSSHHost} />
    {failure && <p className="agent-workspace-error" role="alert">{message(failure)} <button type="button" onClick={() => store.refresh?.()}>Retry connection</button></p>}
    <button type="button" className="agent-workspace-refresh" onClick={() => store.refresh?.()}>Refresh workspaces & agents</button>
    {loading && <p className="agent-workspace-empty" role="status">Loading sessions…</p>}
    {removeTarget && <div role="alertdialog" aria-label="Remove workspace" className="agent-workspace-remove">
      <p>Remove {removeTarget.title || removeTarget.path} from registered workspaces? Files and session history are kept. Existing conversations remain under History.</p>
      <button type="button" disabled={pending.remove} onClick={() => setRemoveTarget(null)}>Cancel</button>
      <button type="button" disabled={pending.remove} onClick={async () => { if (await run('remove', () => onRemoveWorkspace(removeTarget))) setRemoveTarget(null); }}>Remove registration</button>
    </div>}
    <nav className="agent-workspace-list" aria-label="Workspace sessions">
      {tree.map((node) => render(node, 0))}
      {!tree.length && !loading && <p className="agent-workspace-empty">{search ? "No matching sessions" : groups.length ? "No sessions match this filter." : "Add a workspace to create a session."}</p>}
    </nav>
  </aside>;
}

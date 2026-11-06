import { createPoller } from "./polling.js";

/** One plugin lifetime owns catalog polling, drafts and uncertain-send receipts. */
export function createWorkspaceStore(api) {
  let snapshot = { configRevision: 0, machines: [{ id: "local", name: "Local", type: "local" }], remoteWorkspaces: [], sessions: [], providers: [], selectedId: "", drafts: {}, loading: true, error: "", workspaceError: "", workspaceLoading: true };
  const listeners = new Set();
  const completedUpdates = new Set();
  let stopped = false;
  let catalogPoller, sessionPoller;
  let catalogFailures = 0;
  let generation = 0;
  const revisions = new Map();
  let started = false;
  const publish = (patch) => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  };
  const store = {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    attempts: new Map(),
    updateAgent: (machineId, provider, token) => api("agentUpdate", { machineId, provider, token }),
    updatePlan: (machineId, provider) => api("agentUpdatePlan", { machineId, provider }),
    async updateStatus(id) {
      const value = await api("agentUpdateStatus", { id });
      if (value.status !== "running" && !completedUpdates.has(id)) {
        completedUpdates.add(id); publish({ configRevision: snapshot.configRevision + 1 });
      }
      return value;
    },
    loadProviders: (machineId, refresh = false) => api("chatProviders", { machineId, refresh }),
    browseDirectories: (machineId, path) => api("workspaceBrowse", { machineId, path }),
    async loadWorkspaces() {
      try {
        const value = await api("workspaceCatalog");
        if (!Array.isArray(value?.machines) || !Array.isArray(value?.workspaces)) throw new Error("The workspace catalog response is invalid.");
        catalogFailures = 0;
        if (!stopped) publish({ machines: value.machines, remoteWorkspaces: value.workspaces, workspaceLoading: false, workspaceError: "" });
      } catch (error) {
        catalogFailures++;
        if (!stopped) publish({ workspaceLoading: false, workspaceError: error.message || "Could not load workspaces" });
      }
    },
    refresh() { void catalogPoller?.refresh(); void sessionPoller?.refresh(); },
    search: query => api("chatSearch", { query }),
    async sessionAction(action, id, value) {
      const patch = action === 'rename' ? { name: value } : action === 'auto-name' ? { autoName: true } : action === 'pin' || action === 'unpin' ? { pinned: action === 'pin' } : { archived: action === 'archive' };
      const result = await api("chatMetadata", { id, ...patch }); store.update(result); return result;
    },
    async removeWorkspace(workspaceId) { await api("workspaceRemove", { workspaceId }); await store.loadWorkspaces(); },
    async addRemoteWorkspace(machineId, path) {
      await api("workspaceAdd", { machineId, path });
      await store.loadWorkspaces();
    },
    async addSSHHost(host) {
      const machine = await api("addMachine", { name: host, host });
      await store.loadWorkspaces();
      return machine;
    },
    select(id) { publish({ selectedId: id }); },
    setDrafts(update) { publish({ drafts: update(snapshot.drafts) }); },
    update(session) {
      revisions.set(session.id, ++generation);
      const { id, provider, name, nameSource, cwd, machineId, status, createdAt, updatedAt, error, archived, pinned, settingsRevision } = session;
      const summary = { id, provider, name, nameSource, cwd, machineId, status, createdAt, updatedAt, error, archived, pinned, settingsRevision };
      publish({ sessions: [summary, ...snapshot.sessions.filter((item) => item.id !== id)] });
    },
    start() {
      if (started) return;
      started = true;
      catalogPoller = createPoller(() => store.loadWorkspaces(), { delay: () => catalogFailures ? Math.min(30000, 1000 * 2 ** Math.min(catalogFailures - 1, 5)) : 30000 });
      void catalogPoller.start();
      async function poll() {
        const epoch = generation;
        try {
          const value = await api("chatList", {});
          if (!value || !Array.isArray(value.sessions) || !Array.isArray(value.providers)) throw new Error("The session list response is invalid.");
          if (!stopped) {
            const newer = snapshot.sessions.filter((item) => (revisions.get(item.id) || 0) > epoch);
            const ids = new Set(newer.map((item) => item.id));
            publish({ providers: value.providers, sessions: [...newer, ...value.sessions.filter((item) => !ids.has(item.id))], loading: false, error: "" });
          }
        } catch (error) {
          if (!stopped) publish({ loading: false, error: error?.message || "Could not load external sessions." });
        }
      }
      sessionPoller = createPoller(poll, { delay: () => snapshot.sessions.some(s => ['running', 'waiting'].includes(s.status)) ? 3000 : 10000 });
      void sessionPoller.start();
    },
    dispose() { stopped = true; catalogPoller?.stop(); sessionPoller?.stop(); listeners.clear(); store.attempts.clear(); },
  };
  return store;
}

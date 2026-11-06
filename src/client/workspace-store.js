/** One plugin lifetime owns catalog polling, drafts and uncertain-send receipts. */
export function createWorkspaceStore(api) {
  let snapshot = { sessions: [], providers: [], selectedId: "", drafts: {}, loading: true, error: "" };
  const listeners = new Set();
  let stopped = false;
  let timer;
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
    select(id) { publish({ selectedId: id }); },
    setDrafts(update) { publish({ drafts: update(snapshot.drafts) }); },
    update(session) {
      revisions.set(session.id, ++generation);
      const { id, provider, name, cwd, status, createdAt, updatedAt, error } = session;
      const summary = { id, provider, name, cwd, status, createdAt, updatedAt, error };
      publish({ sessions: [summary, ...snapshot.sessions.filter((item) => item.id !== id)] });
    },
    start() {
      if (started) return;
      started = true;
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
        } finally {
          if (!stopped) timer = setTimeout(poll, 3000);
        }
      }
      void poll();
    },
    dispose() { stopped = true; clearTimeout(timer); listeners.clear(); store.attempts.clear(); },
  };
  return store;
}

import React, { useState, useSyncExternalStore } from "react";
import WorkspaceSidebar from "./WorkspaceSidebar.jsx";
import AgentLogo from "./AgentLogo.jsx";

export function WorkspaceBrowser({ usePanelInfo, useSessions, chatPanel, ...props }) {
  const panel = usePanelInfo((state) => state.activePanelId);
  const nativeSelectedId = useSessions((state) => panel === null
    ? state.ids.find((id) => (state.byId[id]?.retainedBy?.mainView || 0) > 0)
    : undefined);
  return <WorkspaceSidebar {...props} useSessions={useSessions} nativeSelectedId={nativeSelectedId} externalActive={panel === chatPanel} />;
}

/** The native blank keeps its draft; another backend opens directly in this workspace. */
export function NativeBackendChoice({ useSessions, useWorkspaces, sessionId, store, onCreate }) {
  const cwd = useSessions((state) => state.byId[sessionId]?.cwd || "");
  const workspace = useWorkspaces((state) => state.items.find((item) => item.path === cwd));
  const { providers } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <div className="fleet-session-picker"><AgentLogo provider="native" />
    <label>Agent <select aria-label="New session agent" value="native" disabled={busy} onChange={async (event) => {
      const provider = event.target.value;
      if (provider === "native") return;
      setBusy(true); setError("");
      try { await onCreate({ provider, workspace: workspace || { path: cwd } }); }
      catch (cause) { setError(cause?.message || "Could not create this session."); }
      finally { setBusy(false); }
    }}>
      <option value="native">DSH</option>
      {[['omp', 'OMP'], ['claude', 'Claude Code']].map(([id, label]) => {
        const info = providers.find((item) => item.id === id);
        return <option key={id} value={id} disabled={!cwd || !info?.available}>{label}{info?.available ? "" : ` — ${info?.reason || "Checking availability…"}`}</option>;
      })}
    </select></label>
    {error && <span role="alert">{error}</span>}
  </div>;
}

export function NativeAgentIdentity() {
  return <span className="workspace-agent-identity" title="DeepSeek Harness"><AgentLogo provider="native" size={18} />DSH</span>;
}

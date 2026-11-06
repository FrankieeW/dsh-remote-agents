import React, { useState, useSyncExternalStore } from "react";
import WorkspaceSidebar from "./WorkspaceSidebar.jsx";
import AgentLogo from "./AgentLogo.jsx";
import { AGENT_ORDER, agentProfile } from "./agent-profiles.js";
import { IconChevronDownOutlineRegular, Menu, Tooltip } from "./native.js";

export function WorkspaceBrowser({ usePanelInfo, useSessions, chatPanel, ...props }) {
  const panel = usePanelInfo((state) => state.activePanelId);
  const nativeSelectedId = useSessions((state) => panel === null
    ? state.ids.find((id) => (state.byId[id]?.retainedBy?.mainView || 0) > 0)
    : undefined);
  return <WorkspaceSidebar {...props} useSessions={useSessions} nativeSelectedId={nativeSelectedId} externalActive={panel === chatPanel} />;
}

function agentItems(providers, cwd) {
  const info = (id) => providers.find((item) => item.id === id);
  const reason = (id) => {
    if (id === "native") return "";
    if (!info(id)?.available) return info(id)?.reason || "Checking availability…";
    return cwd ? "" : "Choose a workspace first";
  };
  return [
    { type: "label", id: "agent", text: "Agent" },
    ...AGENT_ORDER.map((id) => ({
      id,
      disabled: !!reason(id),
      icon: <AgentLogo provider={id} size={14} decorative />,
      label: <span className="agent-menu-option"><span>{agentProfile(id).name}</span>{reason(id) && <small>{reason(id)}</small>}</span>,
    })),
  ];
}

/** The native blank keeps its draft; another agent opens directly in this workspace. */
export function NativeBackendChoice({ useSessions, useWorkspaces, sessionId, store, onCreate }) {
  const cwd = useSessions((state) => state.byId[sessionId]?.cwd || "");
  const workspace = useWorkspaces((state) => state.items.find((item) => item.path === cwd));
  const { providers } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function choose(provider) {
    setOpen(false);
    if (provider === "native") return;
    setBusy(true); setError("");
    try { await onCreate({ provider, workspace: workspace || { path: cwd } }); }
    catch (cause) { setError(cause?.message || "Could not create this session."); }
    finally { setBusy(false); }
  }
  return <span className="agent-hero-choice">
    <Menu open={open} onClose={() => setOpen(false)} items={agentItems(providers, cwd)} selectedIds={["native"]} onSelect={choose}
      align="end" dense portal anchor={<Tooltip label="Agent for this session" side="top" delayMs={500} portal>
        <button type="button" className="agent-hero-picker" aria-label="New session agent" aria-haspopup="menu" aria-expanded={open}
          disabled={busy} onClick={() => setOpen((value) => !value)}>
          <AgentLogo provider="native" size={14} decorative /><span>{busy ? "Creating…" : "DSH"}</span>
          <IconChevronDownOutlineRegular size={12} className="agent-hero-picker-chevron" />
        </button>
      </Tooltip>} />
    {error && <span className="agent-hero-error" role="alert">{error}</span>}
  </span>;
}

export function NativeAgentIdentity() {
  return <span className="workspace-agent-identity" title="DeepSeek Harness"><AgentLogo provider="native" size={16} decorative />DSH</span>;
}

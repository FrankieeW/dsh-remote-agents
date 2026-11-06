import React from "react";
import ChatWorkbench from "./client/ChatWorkbench.jsx";
import FleetPage from "./client/FleetPage.jsx";
import { WorkspaceBrowser, NativeBackendChoice, NativeAgentIdentity } from "./client/WorkspaceIntegration.jsx";
import { createWorkspaceStore } from "./client/workspace-store.js";
import css from "./client/fleet.css";
import chatCss from "./client/chat.css";
import workspaceCss from "./client/workspace.css";
import { CHANNEL, RPC_PREFIX } from "./rpc.js";

export const name = "remote-agents-client";
export const inject = ["slots", "connection", "layout", "uiWorkspace", "workspaces", "sessions"];
const PANEL = "remote-agents";
const CHAT_PANEL = "remote-agents-chat";

function FleetIcon({ size = 20 }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="7" rx="2" />
      <path d="M12 10v5M5 15h14M5 15v3m14-3v3" />
      <circle cx="5" cy="20" r="2" />
      <circle cx="19" cy="20" r="2" />
      <path d="M6 6.5h2m2 0h2" />
    </svg>
  );
}
export function apply(ctx) {
  const api = async (endpoint, payload = {}, signal) => {
    const result = await ctx.connection.rpc.call(
      CHANNEL,
      RPC_PREFIX + endpoint,
      payload,
      signal,
    );
    if (!result.ok) throw new Error(result.error?.message || "Operation failed");
    return result.value;
  };
  const store = createWorkspaceStore(api);
  const onOpen = ({ provider, id }) => {
    ctx.layout.beginNavigation();
    if (provider === "native") ctx.uiWorkspace.openSession(id);
    else { store.select(id); ctx.layout.selectPanel(CHAT_PANEL); }
  };
  const onCreate = async ({ provider, workspace }) => {
    if (!workspace?.path) throw new Error("Choose a workspace first.");
    const navigation = ctx.layout.beginNavigation();
    if (provider === "native") {
      const target = workspace.workspaceId ? workspace : await ctx.workspaces.create({ path: workspace.path });
      if (!navigation.aborted) ctx.uiWorkspace.startSession(target.workspaceId, { whenDraftExists: "keep" });
      return;
    }
    const session = await api("chatCreate", { provider, cwd: workspace.path });
    if (!session?.id) throw new Error("The server did not return a session ID.");
    store.update(session);
    if (!navigation.aborted) { store.select(session.id); ctx.layout.selectPanel(CHAT_PANEL); }
    return session;
  };
  const onNativeAction = async (action, id, value) => {
    if (action === "rename") {
      return ctx.sessions.using(id, { source: "workspaceOperation" }, async (reference) => {
        const result = await reference.binding.session.rename(value);
        if (!result.ok) throw new Error(result.error?.message || "Rename failed.");
      });
    }
    if (action === "fork") return ctx.uiWorkspace.forkSession(id);
    const operations = { archive: "archiveSession", unarchive: "unarchiveSession", pin: "pinSession", unpin: "unpinSession" };
    if (!operations[action]) throw new Error("Unsupported session action.");
    return ctx.uiWorkspace[operations[action]](id);
  };
  ctx.effect(() => { store.start(); return () => store.dispose(); });
  ctx.effect(() => {
    const style = document.createElement("style");
    style.dataset.plugin = PANEL;
    style.textContent = css + "\n" + chatCss + "\n" + workspaceCss;
    document.head.appendChild(style);
    return () => style.remove();
  });
  ctx.slots.inject("main", function* () {
    yield ctx.slots.register({ name: "main", key: CHAT_PANEL, inject: () => ({ api, store }) }, ChatWorkbench);
    yield ctx.slots.register({ name: "main", key: PANEL, inject: () => ({ api }) }, FleetPage);
  });
  ctx.slots.inject("sidebar.workspaces", () => ctx.slots.register({
    name: "sidebar.workspaces",
    priority: -10,
    inject: () => ({ store, chatPanel: CHAT_PANEL, onCreate, onOpen, onNativeAction,
      onAddWorkspace: (path) => ctx.workspaces.create({ path }) }),
  }, WorkspaceBrowser));
  ctx.slots.inject("conversation.hero.options", () => ctx.slots.register({
    name: "conversation.hero.options", id: "remote-agents.backend", order: 40,
    inject: () => ({ store, onCreate }),
  }, NativeBackendChoice));
  ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
    name: "conversation.session.header.actions", id: "remote-agents.identity", order: -10,
  }, NativeAgentIdentity));
  ctx.slots.inject("sidebar.panellist", () =>
    ctx.slots.register(
      {
        name: "sidebar.panellist",
        id: PANEL,
        order: 20,
        label: "Machines & projects",
      },
      FleetIcon,
    ),
  );
}

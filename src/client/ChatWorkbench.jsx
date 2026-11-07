import { createPoller } from "./polling.js";
import { diagnose } from "./diagnostics.js";
import { ChatSettings } from "./chat-settings.jsx";
import OmpModelsPage from "./OmpModelsPage.jsx";
import { AgentViewTabs, AgentWelcome, AgentDetailView } from "./agent-views.jsx";
import { agentViewData } from "./agent-view-data.js";
import React, { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ChatHeader } from "./chat-header.jsx";
import { Composer } from "./chat-composer.jsx";
import { Transcript, TurnError } from "./chat-messages.jsx";
import { ApprovalCard, CloseDialog } from "./chat-panels.jsx";
import { TodoDock } from "./chat-todos.jsx";
import AgentLogo from "./AgentLogo.jsx";
import { agentProfile, inputIssue } from "./agent-profiles.js";
import { latestTodos } from "./tool-presentation.js";
import { commandInput, commandUnavailable, downloadChatFile } from "./chat-commands.js";

const running = (session) => ["running", "starting", "waiting", "waiting_approval", "awaiting_approval"].includes(session?.status) || !!session?.pendingApprovals?.length;
const errorText = (error) => typeof error === "string" ? error : error?.message || "The request failed. Please try again.";

/** Polls the selected session; a newer selection or local action invalidates late responses. */
function useSessionDetail(api, store, selectedId) {
  const [detail, setDetail] = useState(null);
  const [getError, setGetError] = useState("");
  const epoch = useRef(0), poller = useRef(null);
  useEffect(() => {
    let cancelled = false;
    let lastStatus = "idle";
    setGetError("");
    if (!selectedId) { setDetail(null); return undefined; }
    async function poll() {
      try {
        const current = epoch.current;
        const value = await api("chatGet", { id: selectedId });
        if (current !== epoch.current) return;
        if (!value || value.id !== selectedId || !Array.isArray(value.messages) || !Array.isArray(value.pendingApprovals)) throw new Error("The chat response is invalid.");
        if (!cancelled) { lastStatus = value.status; setDetail(previous => previous?.id === value.id && (previous.settingsRevision || 0) > (value.settingsRevision || 0) ? previous : value); store.update(value); setGetError(""); }
      } catch (error) { if (!cancelled) setGetError(errorText(error)); }

    }
    const loop = createPoller(poll, { delay: () => ['running', 'waiting'].includes(lastStatus) ? 700 : 5000 });
    poller.current = loop;
    void loop.start();
    return () => { cancelled = true; loop.stop(); };
  }, [api, selectedId, store]);
  return { detail, setDetail, getError, epoch, refresh: () => poller.current?.refresh() };
}

function Notice({ error, children, detail }) {
  return <div className={`agent-chat-notice${error ? " is-error" : ""}`} role={error ? "alert" : "status"}>{children}{detail && <small>{detail}</small>}</div>;
}

/** Content-only conversation; navigation and creation belong to the Workspace. */
export default function ChatWorkbench({ api, store }) {
  const { sessions, providers, selectedId, drafts, machines, configRevision } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const { detail, setDetail, getError, epoch, refresh } = useSessionDetail(api, store, selectedId);
  const [busy, setBusy] = useState("");
  const [actionError, setActionError] = useState("");
  const [settingsStatus, setSettingsStatus] = useState("");
  const [viewState, setViewState] = useState({ id: '', view: 'chat' });
  const [modelsSessionId, setModelsSessionId] = useState("");
  const [catalog, setCatalog] = useState({ id: "", commands: [] });
  const [commandResult, setCommandResult] = useState(null);
  const selectionVersion = useRef(0);
  const lastSelection = useRef(selectedId);
  if (lastSelection.current !== selectedId) { lastSelection.current = selectedId; selectionVersion.current++; }
  const viewsId = useId();
  const [closeTarget, setCloseTarget] = useState(null);
  const alive = useRef(false);
  const lock = useRef(false);
  const retries = useRef(store.attempts);
  const scroller = useRef(null);
  const autoScroll = useRef(true);
  const setDrafts = store.setDrafts;

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setActionError(""); setSettingsStatus(""); setCommandResult(previous => previous?.id === selectedId ? previous : null); setCloseTarget(null); setViewState({ id: selectedId, view: 'chat' }); autoScroll.current = true; }, [selectedId]);
  useEffect(() => {
    let cancelled = false;
    setCatalog({ id: selectedId, commands: [] });
    if (selectedId) Promise.resolve().then(() => api("chatCommands", { id: selectedId })).then(value => {
      if (!cancelled && Array.isArray(value?.commands)) setCatalog({ id: selectedId, commands: value.commands });
    }, () => { /* Older hosts can still send ordinary messages. */ });
    return () => { cancelled = true; };
  }, [api, selectedId]);

  const session = detail?.id === selectedId ? detail : null;
  const summary = sessions.find((item) => item.id === selectedId);
  const provider = session?.provider || summary?.provider;
  const view = viewState.id === selectedId ? viewState.view : 'chat';
  const changeView = value => { if (value === 'models') setModelsSessionId(selectedId); setViewState({ id: selectedId, view: value }); autoScroll.current = value === 'chat'; };
  const viewData = useMemo(() => agentViewData(session), [session]);
  useEffect(() => {
    const node = scroller.current;
    if (node && view === 'chat' && autoScroll.current) node.scrollTop = node.scrollHeight;
  }, [detail, view]);
  const remote = session?.machineId && session.machineId !== "local";
  const [remoteRuntimes, setRemoteRuntimes] = useState(null);
  useEffect(() => {
    setRemoteRuntimes(null);
    if (!remote) return;
    let cancelled = false;
    store.loadProviders(session.machineId).then(items => { if (!cancelled) setRemoteRuntimes({ machineId: session.machineId, items }); }, error => {
      if (!cancelled) setRemoteRuntimes({ machineId: session.machineId, items: [{ id: provider, available: false, reason: error.message }] });
    });
    return () => { cancelled = true; };
  }, [remote, session?.machineId, provider, store, configRevision]);
  const runtime = (remote ? remoteRuntimes?.machineId === session.machineId ? remoteRuntimes.items : [] : providers).find((item) => item.id === provider);
  const draft = drafts[selectedId] || "";
  const active = running(session);
  const closed = session?.status === "closed";
  const unavailable = session && runtime?.available !== true ? runtime?.reason || "This runtime is unavailable. Messages cannot be sent right now." : "";
  const commands = catalog.id === selectedId ? catalog.commands : [];
  const parsedCommand = commandInput(draft, commands);
  const commandBlocked = parsedCommand?.exact ? commandUnavailable(parsedCommand.exact, { active, closed }) : "";
  const canSend = !!session && !!draft.trim() && !busy && !inputIssue(provider, draft) && (parsedCommand ? !!parsedCommand.exact && !commandBlocked : !active && !closed && !unavailable);
  const todos = useMemo(() => latestTodos(session?.messages), [session?.messages]);

  async function act(label, operation) {
    if (lock.current) return;
    const version = selectionVersion.current;
    lock.current = true;
    setBusy(label); setActionError("");
    try { await operation(); }
    catch (error) { if (alive.current && version === selectionVersion.current && store.getSnapshot().selectedId === selectedId) setActionError(errorText(error)); }
    finally { lock.current = false; if (alive.current) setBusy(""); }
  }
  function send(event) {
    event?.preventDefault();
    if (parsedCommand) {
      if (!parsedCommand.exact) { setActionError(commands.length ? "Unknown slash command. Type /help to see available commands." : "Session commands are unavailable. Reload the session and try again."); return; }
      if (commandBlocked) { setActionError(commandBlocked); return; }
      if (!canSend) return;
      const id = selectedId, text = draft, version = selectionVersion.current;
      act("Run command", async () => {
        let attempt = retries.current.get(id);
        if (!attempt || attempt.text !== text || attempt.kind !== "command") {
          if (!globalThis.crypto?.randomUUID) throw new Error("This browser cannot generate secure request IDs. Please use a secure connection.");
          attempt = { text, requestId: globalThis.crypto.randomUUID(), kind: "command" };
          retries.current.set(id, attempt);
        }
        epoch.current++;
        const result = await api("chatCommand", { id, text, requestId: attempt.requestId, expectedRevision: session.settingsRevision || 0 });
        if (!result || typeof result.command !== "string" || typeof result.message !== "string") throw new Error("The server did not confirm the command result. Your command is preserved for retry.");
        if (result.session && (!result.session.id || !Array.isArray(result.session.messages) || !Array.isArray(result.session.pendingApprovals))) throw new Error("The command returned an invalid session snapshot. Retry the command to recover its result.");
        if (result.session) store.update(result.session);
        setDrafts(previous => ({ ...previous, [id]: previous[id] === text ? "" : previous[id] }));
        if (retries.current.get(id) === attempt) retries.current.delete(id);
        if (alive.current && version === selectionVersion.current && store.getSnapshot().selectedId === id) {
          epoch.current++;
          setCommandResult({ id, ...result });
          if (Array.isArray(result.commands)) setCatalog({ id, commands: result.commands });
          if (result.session) {
            if (result.session.id !== id) {
              setDetail(result.session);
              setCommandResult({ ...result, id: result.session.id });
              store.select(result.session.id);
            } else setDetail(result.session);
          }
          if (result.file) downloadChatFile(result.file);
          void refresh();
        }
      });
      return;
    }
    if (!canSend) return;
    const id = selectedId;
    const text = draft;
    act("Send message", async () => {
      let attempt = retries.current.get(id);
      if (!attempt || attempt.text !== text || attempt.kind === "command") {
        if (!globalThis.crypto?.randomUUID) throw new Error("This browser cannot generate secure request IDs. Please use a secure connection.");
        attempt = { text, requestId: globalThis.crypto.randomUUID() };
        retries.current.set(id, attempt);
      }
      const result = await api("chatSend", { id, text, requestId: attempt.requestId });
      if (!result?.accepted) throw new Error("The server has not confirmed receipt. Check the conversation before retrying manually.");
      setDrafts((previous) => ({ ...previous, [id]: previous[id] === text ? "" : previous[id] }));
      if (retries.current.get(id) === attempt) retries.current.delete(id);
      if (alive.current) {
        epoch.current += 1;
        autoScroll.current = true;
        if (!result.duplicate) {
          setDetail((previous) => previous?.id === id ? { ...previous, status: "running" } : previous);
          const current = store.getSnapshot().sessions.find((item) => item.id === id);
          if (current) store.update({ ...current, status: "running" });
          void refresh();
        }
      }
    });
  }
  async function configure(patch) {
    if (lock.current || !session || active || closed) throw new Error("Finish the current operation before changing settings.");
    const id = session.id;
    lock.current = true; setBusy("Update settings"); setSettingsStatus("Saving settings…"); setActionError("");
    epoch.current++;
    try {
      const result = await api("chatConfigure", { id, patch, expectedRevision: session.settingsRevision || 0 });
      if (!result || result.id !== id) throw new Error("The server did not confirm the settings change.");
      store.update(result);
      if (alive.current) { epoch.current++; setDetail(previous => previous?.id === id ? result : previous); setSettingsStatus("Settings saved · applies to the next turn"); }
    } catch (error) { if (alive.current) setSettingsStatus("Settings not saved — " + errorText(error)); throw error; }
    finally { lock.current = false; if (alive.current) setBusy(""); }
  }
  function approve(approval, allow) {
    const id = selectedId;
    act(allow ? "Approve action" : "Deny action", async () => {
      const result = await api("chatApprove", { id, approvalId: approval.id, allow });
      if (result?.id === id) store.update(result);
      if (alive.current) {
        epoch.current += 1;
        setDetail((previous) => previous?.id === id ? result?.id === id && Array.isArray(result.messages) ? result : { ...previous, pendingApprovals: previous.pendingApprovals.filter((item) => item.id !== approval.id) } : previous);
      }
    });
  }
  function endSession(method, id) {
    act(method === "chatClose" ? "Close session" : "Stop generating", async () => {
      const result = await api(method, { id });
      if (!result || result.id !== id || !Array.isArray(result.messages)) throw new Error("The chat response is invalid.");
      store.update(result);
      if (alive.current) {
        epoch.current += 1;
        setDetail((previous) => previous?.id === id ? result : previous);
      }
    });
  }

  if (!selectedId) {
    return <main className="agent-chat"><div className="agent-chat-welcome">
      <h2>Choose a session</h2>
      <p>Open a Claude Code, Codex or OMP session from the Workspace sidebar, or start one with the new-session button beside a workspace.</p>
    </div></main>;
  }
  return <main className="agent-chat" data-agent={provider}>
    <ChatHeader session={session} summary={summary} provider={provider} machine={machines?.find(m => m.id === session?.machineId)} busy={!!busy} onExport={async format => { await act("Export conversation", async () => { const file = await api("chatExport", { id: session.id, format }); const url = URL.createObjectURL(new Blob([file.content], { type: file.mime })); const a = document.createElement("a"); a.href = url; a.download = file.filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }); }} onClose={() => setCloseTarget({ id: session.id, name: session.name })} />
    <AgentViewTabs provider={provider} view={view} onChange={changeView} data={viewData} idPrefix={viewsId} />
    <div className={`agent-chat-scroll${session && !session.messages.length && view === 'chat' ? " is-empty" : ""}`} ref={scroller} aria-label="Conversation messages"
      onScroll={(event) => { const node = event.currentTarget; autoScroll.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80; }}>
      <div className="agent-chat-column" role="tabpanel" id={`${viewsId}-panel`} aria-labelledby={`${viewsId}-${view}`}>
        {getError && <Notice error detail={session ? "Showing the last loaded messages while polling retries." : ""}>{getError}</Notice>}
        {session?.persistenceError && <Notice error>Could not save session history: {session.persistenceError}</Notice>}
        {session?.historyTruncated && <Notice>Earlier messages have been truncated. Only the retained history is shown.</Notice>}
        {!session && <p role="status" className="agent-chat-placeholder">Loading messages…</p>}
        {session && !session.messages.length && view === 'chat' && <div className="agent-chat-hero">
          <AgentLogo provider={provider} size={32} decorative />
          <h2>What would you like to work on?</h2>
          <AgentWelcome provider={provider} workspace={session.cwd.split("/").filter(Boolean).at(-1) || session.cwd} onDraft={text => setDrafts(previous => ({ ...previous, [selectedId]: text }))} />
        </div>}
        {session && (view === 'chat' ? <Transcript session={session} active={active} api={api} /> : view !== 'models' && <AgentDetailView key={`${session.id}:${view}`} session={session} view={view} data={viewData} api={api} onChat={() => changeView('chat')} />)}
        {session?.provider === 'omp' && modelsSessionId === session.id && <div hidden={view !== 'models'}><OmpModelsPage key={session.id} api={api} store={store} session={session} onConversation={() => changeView('chat')} /></div>}
        {session?.error && <TurnError><strong>{diagnose(session.error, provider).title}</strong><p>{diagnose(session.error, provider).action}</p><details><summary>Error details</summary>{errorText(session.error)}</details></TurnError>}
      </div>
      <div className="agent-chat-seat">
        {actionError && <Notice error detail="Requests are not retried automatically. Your unsent text is preserved.">{actionError}</Notice>}
        {commandResult?.id === selectedId && <Notice><span className="agent-chat-command-result">{commandResult.message}</span>{commandResult.file && <button type="button" onClick={() => downloadChatFile(commandResult.file)}>Download {commandResult.file.filename}</button>}</Notice>}
        {view !== 'tasks' && <TodoDock todos={todos} label={agentProfile(provider).taskLabel || 'To-dos'} />}
        {session?.pendingApprovals.map((approval) => <ApprovalCard key={approval.id} approval={approval} provider={provider}
          cwd={session.cwd} busy={!!busy} onDecide={approve} />)}
        <Composer key={selectedId} provider={provider} draft={draft} disabled={!session} closed={closed} active={active} canSend={canSend} commands={commands}
          configuration={session && runtime?.capabilities?.settings && <ChatSettings key={`${session.id}:${configRevision || 0}`} session={session} api={api} disabled={active || !!busy || closed} onConfigure={configure} saveStatus={settingsStatus} onOpenModels={() => changeView('models')} />}
          sending={busy === "Send message" || busy === "Run command"} stopDisabled={!!busy || closed} unavailable={unavailable}
          onDraft={(value) => setDrafts((previous) => ({ ...previous, [selectedId]: value }))}
          onSend={send} onStop={() => endSession("chatInterrupt", selectedId)} />
      </div>
    </div>
    {closeTarget && <CloseDialog name={closeTarget.name} busy={!!busy} onCancel={() => setCloseTarget(null)}
      onConfirm={() => { const id = closeTarget.id; setCloseTarget(null); endSession("chatClose", id); }} />}
  </main>;
}

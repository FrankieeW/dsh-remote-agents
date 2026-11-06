import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import AgentLogo from "./AgentLogo.jsx";

const LABELS = { native: "DeepSeek Harness", claude: "Claude Code", omp: "OMP" };
const STATUS = { idle: "Ready", running: "Running", starting: "Starting", waiting: "Awaiting approval", waiting_approval: "Awaiting approval", awaiting_approval: "Awaiting approval", error: "Error", closed: "Closed", interrupted: "Interrupted", completed: "Completed" };
const running = (session) => ["running", "starting", "waiting", "waiting_approval", "awaiting_approval"].includes(session?.status) || !!session?.pendingApprovals?.length;
const errorText = (error) => typeof error === "string" ? error : error?.message || "The request failed. Please try again.";
const printable = (value) => { if (typeof value === "string") return value; try { return JSON.stringify(value, null, 2) ?? ""; } catch { return "Unable to display this data"; } };

function ToolCall({ tool }) {
  return <details className="fleet-chat-tool"><summary>{tool.name || "Tool call"}{tool.status ? ` · ${tool.status}` : ""}{tool.isError ? " · Failed" : ""}</summary>
    {tool.input !== undefined && <><h4>Input</h4><pre>{printable(tool.input)}</pre></>}
    {tool.result !== undefined && <><h4>Result</h4><pre>{printable(tool.result)}</pre></>}
    {tool.text && <div className="chat-text">{tool.text}</div>}
    {tool.truncated && <p className="fleet-muted">Tool output has been truncated.</p>}
  </details>;
}

/** Content-only conversation; navigation and creation belong to the Workspace. */
export default function ChatWorkbench({ api, store }) {
  const { sessions, providers, selectedId, drafts } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [detail, setDetail] = useState(null);
  const [getError, setGetError] = useState("");
  const [busy, setBusy] = useState("");
  const [actionError, setActionError] = useState("");
  const setDrafts = store.setDrafts;
  const [closeTarget, setCloseTarget] = useState(null);
  const alive = useRef(false);
  const lock = useRef(false);
  const detailEpoch = useRef(0);
  const retries = useRef(store.attempts);
  const composing = useRef(false);
  const cancelRef = useRef(null);
  const scrollEnd = useRef(null);
  const autoScroll = useRef(true);

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  useEffect(() => {
    let cancelled = false;
    let timer;
    setGetError("");
    if (!selectedId) { setDetail(null); return undefined; }
    autoScroll.current = true;
    async function poll() {
      try {
        const epoch = detailEpoch.current;
        const value = await api("chatGet", { id: selectedId });
        if (epoch !== detailEpoch.current) return;
        if (!value || value.id !== selectedId || !Array.isArray(value.messages) || !Array.isArray(value.pendingApprovals)) throw new Error("The chat response is invalid.");
        if (!cancelled) { setDetail(value); store.update(value); setGetError(""); }
      } catch (error) { if (!cancelled) setGetError(errorText(error)); }
      finally { if (!cancelled) timer = setTimeout(poll, 700); }
    }
    poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [api, selectedId, store]);
  useEffect(() => { setActionError(""); setCloseTarget(null); }, [selectedId]);
  useEffect(() => { if (closeTarget) cancelRef.current?.focus(); }, [closeTarget]);
  useEffect(() => { if (autoScroll.current) scrollEnd.current?.scrollIntoView?.({ block: "nearest" }); }, [detail]);

  const session = detail?.id === selectedId ? detail : null;
  const summary = sessions.find((item) => item.id === selectedId);
  const selectedProvider = providers.find((item) => item.id === session?.provider);
  const draft = drafts[selectedId] || "";
  const active = running(session);
  const closed = session?.status === "closed";
  const canSend = !!session && !active && !closed && selectedProvider?.available === true && !!draft.trim() && !busy;

  async function act(label, operation) {
    if (lock.current) return;
    lock.current = true;
    setBusy(label); setActionError("");
    try { await operation(); }
    catch (error) { if (alive.current) setActionError(errorText(error)); }
    finally { lock.current = false; if (alive.current) setBusy(""); }
  }
  function send(event) {
    event?.preventDefault();
    if (!canSend) return;
    const id = selectedId;
    const text = draft;
    act("Send message", async () => {
      let attempt = retries.current.get(id);
      if (!attempt || attempt.text !== text) {
        if (!globalThis.crypto?.randomUUID) throw new Error("This browser cannot generate secure request IDs. Please use a secure connection.");
        attempt = { text, requestId: globalThis.crypto.randomUUID() };
        retries.current.set(id, attempt);
      }
      const result = await api("chatSend", { id, text, requestId: attempt.requestId });
      if (!result?.accepted) throw new Error("The server has not confirmed receipt. Check the conversation before retrying manually.");
      setDrafts((previous) => ({ ...previous, [id]: previous[id] === text ? "" : previous[id] }));
      if (retries.current.get(id) === attempt) retries.current.delete(id);
      if (alive.current) {
        detailEpoch.current += 1;
        if (!result.duplicate) {
          setDetail((previous) => previous?.id === id ? { ...previous, status: "running" } : previous);
          const summary = store.getSnapshot().sessions.find((item) => item.id === id);
          if (summary) store.update({ ...summary, status: "running" });
        }
      }
    });
  }
  function approve(approval, allow) {
    const id = selectedId;
    act(allow ? "Approve action" : "Deny action", async () => {
      const result = await api("chatApprove", { id, approvalId: approval.id, allow });
      if (result?.id === id) store.update(result);
      if (alive.current) {
        detailEpoch.current += 1;
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
        detailEpoch.current += 1;
        setDetail((previous) => previous?.id === id ? result : previous);
      }
    });
  }

  return <main className="fleet-page chat-workbench">
      <section className="chat-main" aria-label="Chat workspace">
        {actionError && <div className="fleet-alert fleet-alert--error" role="alert">{actionError}<small>Messages are not retried automatically. Your unsent text is preserved.</small></div>}
        {!selectedId ? <div className="chat-welcome"><h2>Choose a workspace session</h2><p>Create or select an agent in the Workspace sidebar.</p></div> : <>
          <div className="chat-session-header"><div><h2><AgentLogo provider={session?.provider || summary?.provider} size={22} />{session?.name || summary?.name || "Loading session…"}</h2><p>{LABELS[session?.provider || summary?.provider] || ""} · {session ? STATUS[session.status] || "Unknown status" : "Syncing"}</p><small>{session?.cwd || summary?.cwd}</small></div><button className="fleet-button" disabled={!!busy || !session || closed} onClick={() => setCloseTarget({ id: session.id, name: session.name })}>Close session</button></div>
          {getError && <div className="fleet-alert fleet-alert--error" role="alert">{getError}{session && <small>Showing the last loaded messages while polling retries.</small>}</div>}
          {session?.error && <div className="fleet-alert fleet-alert--error" role="alert">{errorText(session.error)}</div>}
          {session?.persistenceError && <div className="fleet-alert fleet-alert--error" role="alert">Could not save session history: {session.persistenceError}</div>}
          {session?.historyTruncated && <p className="fleet-muted">Earlier messages have been truncated. Only the retained history is shown.</p>}
          <div className="fleet-chat-transcript" aria-label="Conversation messages" onScroll={(event) => { const node = event.currentTarget; autoScroll.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80; }}>
            {!session && <p role="status" className="fleet-muted">Loading structured messages…</p>}
            {session && !session.messages.length && <p className="fleet-muted">No messages yet. Send your first message to start this runtime.</p>}
            {session?.messages.map((message) => <article className={`fleet-chat-message ${message.role === "user" ? "fleet-chat-user" : "fleet-chat-assistant"}`} key={message.id} aria-label={message.role === "user" ? "User message" : "Assistant message"}><div className="chat-message-role">{message.role === "user" ? "You" : LABELS[session.provider] || "Assistant"}</div><div className="chat-text">{message.text}</div>{message.tools?.map((tool) => <ToolCall key={tool.id} tool={tool} />)}{(message.textTruncated || message.toolsTruncated) && <p className="fleet-muted">Some content in this message has been truncated.</p>}</article>)}
            {session?.pendingApprovals.map((approval) => <section className="fleet-chat-message fleet-chat-approval" key={approval.id} aria-label="Pending approval"><h3>{approval.title || "This runtime requests approval"}</h3><p className="chat-text">{approval.description}</p>{approval.details !== undefined && <details><summary>View action details</summary><pre>{printable(approval.details)}</pre></details>}{approval.truncated && <p className="chat-error">Approval details have been truncated. Make sure you understand the action before allowing it.</p>}<button className="fleet-button" disabled={!!busy} onClick={() => approve(approval, false)}>Deny</button><button className="fleet-button fleet-button--primary" disabled={!!busy} onClick={() => approve(approval, true)}>Allow this action</button></section>)}
            <div ref={scrollEnd} />
          </div>
          <form className="fleet-chat-composer" onSubmit={send}>
            <label htmlFor="chat-message-input">{closed ? "Session closed" : "Send message"}</label>
            <textarea id="chat-message-input" aria-label="Message content" value={draft} disabled={!session || closed}
              onChange={(event) => setDrafts((previous) => ({ ...previous, [selectedId]: event.target.value }))}
              onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
              onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !composing.current && event.keyCode !== 229) { event.preventDefault(); send(); } }}
              placeholder="Type a message…" />
            <div className="chat-composer-actions">
              <span>{active ? "Running — you can draft your next message" : "Enter to send · Shift+Enter for a new line"}</span>
              {active && <button type="button" className="fleet-button" disabled={!!busy || closed} onClick={() => endSession("chatInterrupt", selectedId)}>Stop generating</button>}
              <button className="fleet-button fleet-button--primary" disabled={!canSend}>{busy === "Send message" ? "Sending…" : "Send"}</button>
            </div>
            {session && selectedProvider?.available !== true && <p className="chat-error">{selectedProvider?.reason || "This runtime is unavailable. Messages cannot be sent right now."}</p>}
          </form>
        </>}
      </section>
    {closeTarget && <div className="fleet-modal-backdrop" onKeyDown={(event) => {
      if (event.key === "Escape" && !busy) setCloseTarget(null);
      if (event.key === "Tab") {
        const controls = event.currentTarget.querySelectorAll("button:not(:disabled)");
        const first = controls[0]; const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <section className="fleet-modal" role="alertdialog" aria-modal="true" aria-labelledby="chat-close-title">
        <h2 id="chat-close-title">Close “{closeTarget.name || "session"}”?</h2>
        <p>This ends the external session. Any running task will stop, and you will no longer be able to send messages.</p>
        <div>
          <button ref={cancelRef} className="fleet-button" disabled={!!busy} onClick={() => setCloseTarget(null)}>Cancel</button>
          <button className="fleet-button fleet-button--danger" disabled={!!busy} onClick={() => {
            const id = closeTarget.id; setCloseTarget(null); endSession("chatClose", id);
          }}>Confirm close</button>
        </div>
      </section>
    </div>}
  </main>;
}

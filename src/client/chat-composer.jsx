import React, { useRef } from "react";
import AgentLogo from "./AgentLogo.jsx";
import { agentProfile, inputIssue } from "./agent-profiles.js";
import { Tooltip } from "./native.js";

// The same glyphs DSH's composer draws for send, stop and sending.
const SendGlyph = () => <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z" /></svg>;
const StopGlyph = () => <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="3" fill="currentColor" /></svg>;
const SendingGlyph = () => <svg className="agent-chat-sending" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
  <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.35" strokeWidth="2" />
  <path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
</svg>;

function hint({ issue, unavailable, closed, active }) {
  if (issue) return issue;
  if (unavailable) return unavailable;
  if (closed) return "This session is closed. Its transcript stays readable.";
  return active ? "Running — you can draft your next message" : "Enter to send · Shift+Enter for a new line";
}

/** DSH's composer card: auto-growing input, agent chip, round stop/send buttons. */
export function Composer({ provider, draft, disabled, closed, active, canSend, sending, stopDisabled, unavailable, configuration, onDraft, onSend, onStop }) {
  const composing = useRef(false);
  const agent = agentProfile(provider);
  const issue = inputIssue(provider, draft);
  const message = hint({ issue, unavailable, closed, active });
  return <form className="agent-chat-composer" onSubmit={onSend}>
    <div className={`agent-chat-composer-card${disabled ? " is-disabled" : ""}`}>
      <label className="agent-chat-sr-only" htmlFor="chat-message-input">{closed ? "Session closed" : `Message ${agent.name}`}</label>
      <textarea id="chat-message-input" className="agent-chat-input" aria-label="Message content" rows={1} value={draft} disabled={disabled}
        placeholder={closed ? "This session is closed" : agent.placeholder || "Type a message…"}
        aria-invalid={issue ? true : undefined} aria-describedby="chat-composer-hint"
        onChange={(event) => onDraft(event.target.value)}
        onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || composing.current || event.keyCode === 229) return;
          event.preventDefault();
          onSend();
        }} />
      <div className="agent-chat-composer-row">
        <span className="agent-chat-composer-agent"><AgentLogo provider={provider} size={14} decorative /><span>{agent.name}</span></span>
        {configuration}
        <span className="agent-chat-composer-trailing">
          {active && <Tooltip label="Stop generating" side="top" delayMs={500} portal>
            <button type="button" className="agent-chat-round is-stop" aria-label="Stop generating" disabled={stopDisabled} onClick={onStop}><StopGlyph /></button>
          </Tooltip>}
          <Tooltip label="Send message" side="top" delayMs={500} disabled={!canSend || !!issue} portal>
            <button type="submit" className="agent-chat-round" aria-label="Send message" aria-busy={sending || undefined}
              data-sending={sending ? "" : undefined} disabled={!canSend || !!issue}>{sending ? <SendingGlyph /> : <SendGlyph />}</button>
          </Tooltip>
        </span>
      </div>
    </div>
    <p id="chat-composer-hint" className={`agent-chat-hint${issue || unavailable ? " is-error" : ""}`} role={issue ? "alert" : undefined}>{message}</p>
  </form>;
}

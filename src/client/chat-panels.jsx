import React, { useEffect, useRef } from "react";
import { agentProfile, approvalScope } from "./agent-profiles.js";
import { DIFF_LABELS } from "./native-labels.js";
import { describeTool, printable } from "./tool-presentation.js";
import { Button, DiffBlock, IconShieldOutlineRegular } from "./native.js";

/** Claude Code sends `{toolName, input}`: preview it with the same native views as tool rows. */
function requestPreview(provider, approval, cwd) {
  const details = approval.details;
  if (!details || typeof details.toolName !== "string") return null;
  return describeTool({ name: details.toolName, input: details.input, status: "running" }, { cwd });
}

function RequestPreview({ preview }) {
  if (!preview) return null;
  if (preview.terminal) return <code className="agent-chat-approval-command">{preview.terminal.command}</code>;
  if (preview.diffs) return <DiffBlock className="agent-chat-approval-diff" diffs={preview.diffs} labels={DIFF_LABELS} maxLines={9} />;
  return preview.summary ? <code className="agent-chat-approval-command">{preview.summary}</code> : null;
}

/** DSH's approval card: warning strip, what is requested, and an explicit decision. */
export function ApprovalCard({ approval, provider, cwd, busy, onDecide }) {
  const preview = requestPreview(provider, approval, cwd);
  const scope = approvalScope(provider, approval);
  const description = approval.description && approval.description !== approval.title ? approval.description : "";
  return <section className="agent-chat-approval" aria-label="Pending approval">
    <div className="agent-chat-approval-strip"><IconShieldOutlineRegular size={14} /><span>{agentProfile(provider).name} needs your approval</span></div>
    <div className="agent-chat-approval-body">
      <h3 className="agent-chat-approval-headline">{approval.title || "This runtime requests approval"}</h3>
      <RequestPreview preview={preview} />
      {description && <p className="agent-chat-approval-description">{description}</p>}
      {approval.details !== undefined && <details className="agent-chat-approval-details">
        <summary>View request details</summary><pre>{printable(approval.details)}</pre>
      </details>}
      {approval.truncated && <p className="agent-chat-approval-warning">Approval details have been truncated. Make sure you understand the action before allowing it.</p>}
      {scope && <p className="agent-chat-approval-scope">{scope}</p>}
    </div>
    <div className="agent-chat-approval-actions">
      <Button variant="outline" className="agent-chat-reject" disabled={busy} onClick={() => onDecide(approval, false)}>Deny</Button>
      <Button variant="primary" disabled={busy} onClick={() => onDecide(approval, true)}>Allow once</Button>
    </div>
  </section>;
}

/** Destructive confirmation with a focus trap; Escape cancels unless an action is running. */
export function CloseDialog({ name, busy, onCancel, onConfirm }) {
  const cancelRef = useRef(null);
  useEffect(() => { cancelRef.current?.focus(); }, []);
  return <div className="agent-chat-modal-backdrop" onKeyDown={(event) => {
    if (event.key === "Escape" && !busy) onCancel();
    if (event.key !== "Tab") return;
    const controls = event.currentTarget.querySelectorAll("button:not(:disabled)");
    const first = controls[0];
    const last = controls[controls.length - 1];
    const focused = event.currentTarget.ownerDocument.activeElement;
    if (event.shiftKey && focused === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && focused === last) { event.preventDefault(); first?.focus(); }
  }}>
    <section className="agent-chat-modal" role="alertdialog" aria-modal="true" aria-labelledby="chat-close-title" aria-describedby="chat-close-description">
      <h2 id="chat-close-title">Close “{name || "session"}”?</h2>
      <p id="chat-close-description">This ends the external session. Any running task will stop, and you will no longer be able to send messages.</p>
      <div className="agent-chat-modal-actions">
        <Button ref={cancelRef} variant="outline" disabled={busy} onClick={onCancel}>Cancel</Button>
        <Button variant="primary" className="agent-chat-danger" disabled={busy} onClick={onConfirm}>Confirm close</Button>
      </div>
    </section>
  </div>;
}

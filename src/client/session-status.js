/**
 * One status vocabulary for native and external rows, matching DSH's sidebar:
 * pending input outranks running, which outranks an unread completion.
 */
const PENDING = Object.freeze({
  approval: Object.freeze({ label: "Waiting for approval", trailing: "Approval" }),
  question: Object.freeze({ label: "Waiting for answer", trailing: "Answer" }),
  "plan-review": Object.freeze({ label: "Plan awaiting review", trailing: "Plan review" }),
});
const WAITING = new Set(["waiting", "waiting_approval", "awaiting_approval"]);
const DEFAULT_PENDING = Object.freeze({ label: "Waiting for input", trailing: "Input" });

/**
 * @returns {{state: 'ongoing'|'warning'|'error'|'done'|'idle', label: string, trailing?: string}}
 */
export function rowStatus(row) {
  if (row.archived) return { state: "idle", label: row.provider === "native" ? "Archived" : "Closed" };
  if (WAITING.has(row.status)) {
    const pending = PENDING[row.pendingInteraction?.kind] || (row.provider === "native" ? DEFAULT_PENDING : PENDING.approval);
    return { state: "warning", label: pending.label, trailing: pending.trailing };
  }
  if (row.status === "running") return { state: "ongoing", label: "Running" };
  if (row.status === "starting") return { state: "ongoing", label: "Starting" };
  if (row.status === "completed") return row.completionUnread ? { state: "done", label: "Completed, unread" } : { state: "idle", label: "Completed" };
  if (row.status === "error") return { state: "error", label: "Error" };
  if (row.status === "interrupted") return { state: "idle", label: "Interrupted" };
  if (row.status === "closed") return { state: "idle", label: "Closed" };
  return { state: "idle", label: "Idle" };
}

/** Class used by the sidebar marker; kept stable for styling and tests. */
export function statusClass(state) {
  return { warning: "is-waiting", ongoing: "is-running", done: "is-unread", error: "is-error" }[state] || "";
}

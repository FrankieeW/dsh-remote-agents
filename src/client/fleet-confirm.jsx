import React, { useEffect, useRef } from "react";

/**
 * Confirmation for a destructive request, or (without `endpoint`) an
 * explanation of what blocks it. Keeps focus inside while open.
 */
export function ConfirmDialog({ confirm, busy, onCancel, onConfirm }) {
  const cancel = useRef(null);
  useEffect(() => {
    cancel.current?.focus();
  }, [confirm]);
  return (
    <div
      className="fleet-modal-backdrop"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) onCancel();
        if (event.key === "Tab") {
          const buttons = event.currentTarget.querySelectorAll("button:not(:disabled)");
          const first = buttons[0];
          const last = buttons[buttons.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }
      }}
    >
      <section
        className="fleet-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="fleet-confirm-title"
        aria-describedby="fleet-confirm-description"
      >
        <span className="fleet-modal-icon" aria-hidden="true">
          !
        </span>
        <h2 id="fleet-confirm-title">{confirm.title}</h2>
        <p id="fleet-confirm-description">{confirm.description}</p>
        {confirm.items?.length > 0 && (
          <ul className="fleet-modal-list">
            {confirm.items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        )}
        <div>
          <button ref={cancel} className="fleet-button" disabled={!!busy} onClick={onCancel}>
            {confirm.endpoint ? "Cancel" : "Close"}
          </button>
          {confirm.endpoint && (
            <button className="fleet-button fleet-button--danger" disabled={!!busy} onClick={onConfirm}>
              {confirm.label}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

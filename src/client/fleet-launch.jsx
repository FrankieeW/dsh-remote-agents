import React from "react";
import { isLocalMachine, machineAddress } from "./machines.js";

/** The legacy terminal launch form; `machines` lists only active machines. */
export function LaunchForm({ machines, machineFilter, startForm, setStartForm, busy, onSubmit, onClose }) {
  const update = (key) => (event) => setStartForm({ ...startForm, [key]: event.target.value });
  return (
    <form className="fleet-form fleet-launch" onSubmit={onSubmit}>
      <div className="fleet-section-heading">
        <h3>New agent</h3>
        <button type="button" aria-label="Close launch form" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="fleet-form-grid">
        <label>
          Target machine
          <select value={startForm.machineId || machineFilter || machines[0]?.id || ""} onChange={update("machineId")}>
            {machines.map((machine) => (
              <option key={machine.id} value={machine.id}>
                {machine.name} · {isLocalMachine(machine) ? "Local" : machineAddress(machine)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Program
          <select value={startForm.kind} onChange={update("kind")}>
            <option value="codex">Codex</option>
            <option value="claude">Claude Code</option>
            <option value="dsh">DeepSeek Harness</option>
            <option value="shell">Shell</option>
          </select>
        </label>
        <label>
          Agent name
          <input required maxLength={80} value={startForm.name} onChange={update("name")} placeholder="Name this task" />
        </label>
        <label>
          Absolute project path
          <input required value={startForm.cwd} onChange={update("cwd")} placeholder="/home/user/project" spellCheck={false} />
        </label>
      </div>
      <label>
        Additional arguments <span className="fleet-muted">Optional · JSON array of strings</span>
        <input value={startForm.args} onChange={update("args")} placeholder={'["--help"]'} spellCheck={false} />
      </label>
      <p className="fleet-muted">
        The program and project directory must already exist on the target machine. Nothing is installed automatically
        and permission prompts are not bypassed.
      </p>
      <button className="fleet-button fleet-button--primary" disabled={!!busy}>
        {busy === "Start agent" ? "Starting…" : "Start process"}
      </button>
    </form>
  );
}

import React, { useCallback, useId, useState } from "react";
import {
  activeMachines, canSaveUntested, isLocalMachine, isRemovedMachine, machineAddress, machineHealth, quotedNames,
  removalBlockers,
} from "./machines.js";
import { relativeTimeAgo } from "./relative-time.js";
import { SshHostOptions, useSshHosts } from "./ssh-hosts.jsx";

const messageOf = (error) => (error instanceof Error ? error.message : String(error || "Request failed. Please try again."));
const conversations = (n) => (n === 1 ? "1 conversation keeps its history" : `${n} conversations keep their history`);

function MachineHealth({ machine }) {
  const health = machineHealth(machine);
  if (!health) return null;
  const when = relativeTimeAgo(health.checkedAt);
  return (
    <p className={`fleet-probe is-${health.state}`}>
      {health.label}
      {when && <span className="fleet-probe-time"> · {when === "now" ? "just now" : when}</span>}
    </p>
  );
}

/** Edits the name and, for SSH machines, the destination; only changed fields are sent. */
function EditMachine({ machine, busy, onSave, onCancel }) {
  const local = isLocalMachine(machine);
  const [name, setName] = useState(machine.name);
  const [target, setTarget] = useState(local ? "" : machineAddress(machine));
  function submit(event) {
    event.preventDefault();
    const patch = {
      ...(name.trim() && name.trim() !== machine.name ? { name: name.trim() } : {}),
      ...(!local && target.trim() && target.trim() !== machineAddress(machine) ? { target: target.trim() } : {}),
    };
    onSave(patch);
  }
  return (
    <form className="fleet-form fleet-machine-edit" onSubmit={submit}>
      <label>
        Name
        <input aria-label="Machine name" required maxLength={128} value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      {!local && (
        <label>
          SSH destination
          <input aria-label="SSH destination" required value={target} onChange={(event) => setTarget(event.target.value)}
            autoCapitalize="none" spellCheck={false} />
        </label>
      )}
      {!local && <p className="fleet-muted">The machine keeps its conversations and workspaces. Stop its terminals before changing the destination.</p>}
      <div className="fleet-form-actions">
        <button type="button" className="fleet-button" onClick={onCancel}>Cancel</button>
        <button className="fleet-button fleet-button--primary" disabled={!!busy}>Save</button>
      </div>
    </form>
  );
}

/** Tests SSH before saving; an unreachable destination is saved only on request. */
function AddMachine({ api, busy, run, onAdded }) {
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [failure, setFailure] = useState(null);
  const listId = useId();
  const suggestions = useSshHosts(useCallback(() => api("sshConfigHosts"), [api]), true);
  function add(verify) {
    const destination = target.trim();
    run("Add machine", async () => {
      try {
        const machine = await api("addMachine", { target: destination, verify, ...(name.trim() ? { name: name.trim() } : {}) });
        setFailure(null);
        onAdded(machine, verify);
      } catch (error) {
        setFailure({ target: destination, message: messageOf(error), untested: verify && canSaveUntested(error?.code) });
      }
    });
  }
  return (
    <form className="fleet-form fleet-machine-form" onSubmit={(event) => { event.preventDefault(); add(true); }}>
      <label>
        SSH destination
        <input aria-label="SSH destination" required value={target} placeholder="dev-box, user@host:2222" list={listId}
          onChange={(event) => { setTarget(event.target.value); setFailure(null); }} autoCapitalize="none" spellCheck={false} />
      </label>
      <SshHostOptions id={listId} hosts={suggestions.hosts} />
      {suggestions.error && <p className="fleet-muted">SSH config suggestions are unavailable: {suggestions.error}</p>}
      <label>
        Display name <span className="fleet-muted">Optional</span>
        <input aria-label="Machine name" maxLength={128} value={name} onChange={(event) => setName(event.target.value)}
          placeholder="Defaults to the destination" />
      </label>
      <p className="fleet-muted">Uses your SSH config, keys and known_hosts. Accepts an alias, user@host, host:port or ssh://user@host:port. Passwords are never stored.</p>
      {failure && <p className="fleet-machine-failure" role="alert">{failure.message}</p>}
      <div className="fleet-form-actions">
        {failure?.untested && failure.target === target.trim() && (
          <button type="button" className="fleet-button" disabled={!!busy} onClick={() => add(false)}>Save without testing</button>
        )}
        <button className="fleet-button fleet-button--primary" disabled={!!busy}>{busy === "Add machine" ? "Testing…" : "Test & add"}</button>
      </div>
    </form>
  );
}

function RemovedMachines({ machines, busy, onRestore }) {
  const [open, setOpen] = useState(false);
  if (!machines.length) return null;
  return (
    <div className="fleet-removed">
      <button className="fleet-button fleet-add-machine" aria-expanded={open} onClick={() => setOpen(!open)}>
        Removed machines ({machines.length})
      </button>
      {open && (
        <>
          <ul>
            {machines.map((machine) => (
              <li key={machine.id}>
                <span><strong>{machine.name}</strong><small>{machineAddress(machine)}</small></span>
                <button disabled={!!busy} onClick={() => onRestore(machine)}>Restore</button>
              </li>
            ))}
          </ul>
          <p className="fleet-muted">Removed machines keep their conversations; restoring one makes them usable again.</p>
        </>
      )}
    </div>
  );
}

/** Machines sidebar: health, test, edit, removal with explicit blockers, add and restore. */
export function MachinePanel({ api, snapshot, loading, busy, run, filter, onFilter, onConfirm, onNotice, importOpen, onImport }) {
  const [editing, setEditing] = useState("");
  const [adding, setAdding] = useState(false);
  const machines = snapshot?.machines || [];
  const active = activeMachines(machines);
  function save(machine, patch) {
    if (!Object.keys(patch).length) return setEditing("");
    run("Save machine", async () => {
      await api("updateMachine", { machineId: machine.id, ...patch });
      setEditing("");
      onNotice(patch.target ? `“${machine.name}” now connects to ${patch.target}. Test the connection to confirm.` : "Machine renamed.");
    });
  }
  function remove(machine) {
    const { workspaces, terminals } = removalBlockers(machine, snapshot);
    if (workspaces.length || terminals.length) {
      return onConfirm({
        title: `“${machine.name}” can't be removed yet`,
        description: "Remove these records first. SSH configuration is never changed.",
        items: [
          ...(workspaces.length ? [`Workspaces ${quotedNames(workspaces)}: remove their registrations under Projects or in the Workspaces sidebar.`] : []),
          ...(terminals.length ? [`Terminals ${quotedNames(terminals)}: stop them, or forget their records if the machine is gone.`] : []),
        ],
      });
    }
    onConfirm({
      endpoint: "removeMachine",
      payload: { machineId: machine.id },
      title: `Remove “${machine.name}”?`,
      description: "Its conversations keep their history. Restoring the machine, or adding the same SSH destination again, makes them usable again. SSH configuration is unchanged.",
      label: "Confirm removal",
      notice: (result) => result?.retained && result.sessions
        ? `“${machine.name}” was removed. ${conversations(result.sessions)}; restore the machine to continue.`
        : `“${machine.name}” was removed.`,
    });
  }
  const test = (machine) => run("Test connection", async () => {
    const result = await api("probe", { machineId: machine.id });
    if (result?.warning) onNotice(result.warning);
  });
  const restore = (machine) => run("Restore machine", async () => {
    await api("restoreMachine", { machineId: machine.id });
    onNotice(`Restored “${machine.name}” with its conversations.`);
  });
  return (
    <aside className="fleet-sidebar">
      <div className="fleet-section-heading">
        <h2>Machines</h2>
        <span className="fleet-count">{snapshot ? active.length : "—"}</span>
      </div>
      <button className={`fleet-machine fleet-machine--all ${!filter ? "is-active" : ""}`} onClick={() => onFilter("")}>
        <span className="fleet-machine-icon">▦</span>
        <span><strong>All machines</strong><small>Projects across machines</small></span>
        <span className="fleet-count">{snapshot ? (snapshot.agents || []).length : "—"}</span>
      </button>
      <div className="fleet-machine-list">
        {active.map((machine) => (
          <div className={`fleet-machine-wrap ${filter === machine.id ? "is-active" : ""}`} key={machine.id}>
            <button className="fleet-machine" onClick={() => onFilter(machine.id)}>
              <span className="fleet-machine-icon" aria-hidden="true">{isLocalMachine(machine) ? "▣" : "⌁"}</span>
              <span><strong>{machine.name}</strong><small>{isLocalMachine(machine) ? "Local machine" : machineAddress(machine)}</small></span>
            </button>
            {editing === machine.id ? (
              <EditMachine machine={machine} busy={busy} onSave={(patch) => save(machine, patch)} onCancel={() => setEditing("")} />
            ) : (
              <>
                <MachineHealth machine={machine} />
                <div className="fleet-machine-actions">
                  <button disabled={!!busy} onClick={() => test(machine)}>Test connection</button>
                  <button disabled={!!busy} onClick={() => setEditing(machine.id)}>Edit</button>
                  {!isLocalMachine(machine) && <button disabled={!!busy} onClick={() => remove(machine)}>Remove</button>}
                </div>
              </>
            )}
          </div>
        ))}
      </div>
      {!snapshot && <p className="fleet-muted">{loading ? "Loading machines…" : "Machine list is not available"}</p>}
      <button className="fleet-button fleet-add-machine" onClick={() => setAdding(!adding)} aria-expanded={adding}>
        ＋ Add SSH machine
      </button>
      {adding && (
        <AddMachine api={api} busy={busy} run={run} onAdded={(machine, verified) => {
          setAdding(false);
          onNotice(machine?.restored
            ? `Restored “${machine.name}” with its conversations.`
            : verified ? `“${machine.name}” is connected.` : `“${machine.name}” was saved without a connection test. Test it before starting agents.`);
        }} />
      )}
      <button className="fleet-button fleet-add-machine" onClick={onImport} disabled={!!busy} aria-expanded={importOpen}>
        ◇ Import from Herdr
      </button>
      <RemovedMachines machines={machines.filter(isRemovedMachine)} busy={busy} onRestore={restore} />
      <div className="fleet-sidebar-note">
        <span aria-hidden="true">◈</span>
        <strong>Your machines, your sessions</strong>
        <p>Only sessions created by this workbench are managed. Existing terminals are left untouched.</p>
      </div>
    </aside>
  );
}

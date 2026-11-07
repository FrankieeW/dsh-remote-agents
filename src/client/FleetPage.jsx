import React, { useEffect, useMemo, useRef, useState } from "react";
import HerdrImport from "./HerdrImport.jsx";
import { ConfirmDialog } from "./fleet-confirm.jsx";
import { LaunchForm } from "./fleet-launch.jsx";
import { MachinePanel } from "./fleet-machines.jsx";
import { activeMachines } from "./machines.js";

const STATUS = { running: "Running", exited: "Exited", unknown: "Unknown" };
const messageOf = (error) =>
  error instanceof Error ? error.message : String(error || "Request failed. Please try again.");
const statusOf = (status) =>
  Object.hasOwn(STATUS, status) ? status : "unknown";

function StateBadge({ status }) {
  const value = statusOf(status);
  return (
    <span className={`fleet-badge fleet-badge--${value}`}>
      <i />
      {STATUS[value]}
    </span>
  );
}

function Empty({ title, children }) {
  return (
    <div className="fleet-empty">
      <span className="fleet-empty-symbol" aria-hidden="true">
        ◇
      </span>
      <strong>{title}</strong>
      <p>{children}</p>
    </div>
  );
}

/** Transport returns unwrapped endpoint values; this component has no DSH dependency. */
export default function FleetPage({ api }) {
  const [snapshot, setSnapshot] = useState(null);
  const [snapshotError, setSnapshotError] = useState("");
  const [loading, setLoading] = useState(true);
  const [auto, setAuto] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [machineFilter, setMachineFilter] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [output, setOutput] = useState(null);
  const [outputError, setOutputError] = useState("");
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [startOpen, setStartOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [startForm, setStartForm] = useState({
    machineId: "",
    name: "",
    cwd: "",
    kind: "codex",
    args: "",
  });
  const [text, setText] = useState("");
  const [enter, setEnter] = useState(true);
  const lock = useRef(false);
  const pendingSelection = useRef("");
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer;
    async function poll() {
      setLoading(true);
      try {
        if (typeof api !== "function")
          throw new Error("The workbench API is unavailable. Check the plugin integration.");
        const value = await api("snapshot", {});
        if (
          !value ||
          !Array.isArray(value.machines) ||
          !Array.isArray(value.agents)
        )
          throw new Error("The server returned invalid workbench data.");
        if (!cancelled) {
          setSnapshot(value);
          if (
            pendingSelection.current &&
            value.agents.some((agent) => agent.id === pendingSelection.current)
          ) {
            setSelectedId(pendingSelection.current);
            pendingSelection.current = "";
          }
          setSnapshotError("");
          setUpdatedAt(new Date());
        }
      } catch (error) {
        if (!cancelled) setSnapshotError(messageOf(error));
      } finally {
        if (!cancelled) {
          setLoading(false);
          if (auto) timer = setTimeout(poll, 5000);
        }
      }
    }
    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, auto, refresh]);

  useEffect(() => {
    let cancelled = false;
    let timer;
    setOutputError("");
    if (!selectedId) {
      setOutput(null);
      setReading(false);
      return undefined;
    }
    async function poll() {
      setReading(true);
      try {
        const value = await api("read", { agentId: selectedId, lines: 300 });
        if (!value || typeof value.output !== "string")
          throw new Error("The server returned invalid terminal output.");
        if (!cancelled) {
          setOutput({ ...value, agentId: selectedId });
          setOutputError("");
        }
      } catch (error) {
        if (!cancelled) setOutputError(messageOf(error));
      } finally {
        if (!cancelled) {
          setReading(false);
          if (auto) timer = setTimeout(poll, 3000);
        }
      }
    }
    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, selectedId, auto, refresh]);

  const machines = snapshot?.machines || [];
  const active = activeMachines(machines);
  const agents = snapshot?.agents || [];
  const selected = agents.find((agent) => agent.id === selectedId);
  const visibleAgents = agents.filter(
    (agent) => !machineFilter || agent.machineId === machineFilter,
  );
  const groups = useMemo(() => {
    const result = new Map();
    (snapshot?.projects || []).forEach((project) => {
      if (machineFilter && project.machineId !== machineFilter) return;
      const key = JSON.stringify([project.machineId, project.cwd]);
      if (!result.has(key))
        result.set(key, {
          key,
          projectId: project.id,
          machineId: project.machineId,
          cwd: project.cwd,
          name: project.name,
          source: project.source,
          agents: [],
        });
    });
    visibleAgents.forEach((agent) => {
      const key = JSON.stringify([agent.machineId, agent.cwd]);
      if (!result.has(key))
        result.set(key, {
          key,
          machineId: agent.machineId,
          cwd: agent.cwd,
          agents: [],
        });
      result.get(key).agents.push(agent);
    });
    return [...result.values()];
  }, [snapshot, machineFilter]);

  useEffect(() => {
    if (
      snapshot &&
      selectedId &&
      !agents.some((agent) => agent.id === selectedId)
    )
      setSelectedId("");
    if (
      snapshot &&
      machineFilter &&
      !active.some((machine) => machine.id === machineFilter)
    )
      setMachineFilter("");
  }, [snapshot, selectedId, machineFilter]);
  useEffect(() => {
    setText("");
  }, [selectedId]);

  const machineName = (id) =>
    machines.find((machine) => machine.id === id)?.name || id;
  const refreshNow = () => setRefresh((value) => value + 1);
  async function run(label, operation) {
    if (lock.current) return;
    lock.current = true;
    setBusy(label);
    setActionError("");
    setNotice("");
    try {
      await operation();
    } catch (error) {
      if (mounted.current) setActionError(messageOf(error));
    } finally {
      lock.current = false;
      if (mounted.current) {
        setBusy("");
        refreshNow();
      }
    }
  }
  function startAgent(event) {
    event.preventDefault();
    run("Start agent", async () => {
      let args;
      try {
        args = startForm.args.trim() ? JSON.parse(startForm.args) : [];
      } catch {
        throw new Error('Additional arguments must be a JSON array of strings, such as ["--help"].');
      }
      if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string"))
        throw new Error("Every additional argument must be a string.");
      const machineId = startForm.machineId || machineFilter || active[0]?.id;
      if (!machineId) throw new Error("Add or select a machine first.");
      if (!startForm.cwd.startsWith("/"))
        throw new Error("The project directory must be an absolute path on the target machine (starting with /).");
      const result = await api("start", {
        ...startForm,
        name: startForm.name.trim(),
        machineId,
        args,
      });
      if (mounted.current) {
        setStartOpen(false);
        setNotice("Start request completed. Check the process status and terminal output.");
        if (result?.id) pendingSelection.current = result.id;
      }
    });
  }
  function requestAction(endpoint, agent) {
    setConfirm({
      endpoint,
      payload: { agentId: agent.id },
      title:
        endpoint === "stop"
          ? `Stop “${agent.name}”?`
          : `Interrupt “${agent.name}”?`,
      description:
        endpoint === "stop"
          ? "This terminates the managed tmux session. Unsaved work may be lost. This cannot be undone."
          : "This sends Ctrl+C to the process. It may cancel the current task without removing the session.",
      label: endpoint === "stop" ? "Confirm stop" : "Send Ctrl+C",
    });
  }
  /** Deletes a terminal record; never touches the session itself. */
  function requestForget(agent) {
    setConfirm(
      agent.stoppedAt
        ? {
            endpoint: "forgetAgent",
            payload: { agentId: agent.id },
            title: `Remove “${agent.name}” from the list?`,
            description: "The session is already stopped. Only its record is deleted.",
            label: "Remove from list",
          }
        : {
            endpoint: "forgetAgent",
            payload: { agentId: agent.id, force: true },
            title: `Forget “${agent.name}”?`,
            description:
              "Use this when the machine is gone or the session cannot be verified. Forgetting never terminates the session: if it still runs on the machine, it keeps running unmanaged.",
            label: "Forget record",
          },
    );
  }
  function requestWorkspaceRemoval(group) {
    setConfirm({
      endpoint: "workspaceRemove",
      payload: { workspaceId: group.projectId },
      title: `Remove “${group.name || group.cwd}” from registered workspaces?`,
      description: "Its files and conversations are kept, and terminals in this directory stay listed.",
      label: "Remove registration",
    });
  }
  const currentOutput = output?.agentId === selectedId ? output : null;
  const selectedStatus = statusOf(currentOutput?.status || selected?.status);

  return (
    <main className="fleet-page">
      <header className="fleet-topbar">
        <div className="fleet-brand">
          <span className="fleet-logo" aria-hidden="true">
            ⌘
          </span>
          <div>
            <span className="fleet-eyebrow">REMOTE AGENT FLEET</span>
            <h1>Agent Workbench</h1>
          </div>
        </div>
        <div className="fleet-toolbar">
          <span className="fleet-sync">
            {loading
              ? "Syncing…"
              : updatedAt
                ? `Updated ${updatedAt.toLocaleTimeString("en-US")}`
                : "Not synced yet"}
          </span>
          <label className="fleet-toggle">
            <input
              type="checkbox"
              checked={auto}
              onChange={(event) => setAuto(event.target.checked)}
            />
            Auto-polling
          </label>
          <button
            className="fleet-button"
            onClick={refreshNow}
            disabled={loading || reading}
          >
            ↻ Refresh
          </button>
        </div>
      </header>
      {(snapshotError || actionError) && (
        <div className="fleet-alert fleet-alert--error" role="alert">
          <strong>Action not completed</strong>
          <span>{actionError || snapshotError}</span>
          {snapshot && snapshotError && (
            <small>Showing data from the last successful sync.</small>
          )}
          <button
            className="fleet-button"
            onClick={() => {
              setActionError("");
              refreshNow();
            }}
          >
            Retry sync
          </button>
        </div>
      )}
      {notice && (
        <div className="fleet-alert" role="status">
          {notice}
          <button aria-label="Dismiss notification" onClick={() => setNotice("")}>
            ×
          </button>
        </div>
      )}
      <div className="fleet-workspace">
        <MachinePanel
          api={api}
          snapshot={snapshot}
          loading={loading}
          busy={busy}
          run={run}
          filter={machineFilter}
          onFilter={setMachineFilter}
          onConfirm={setConfirm}
          onNotice={(message) => mounted.current && setNotice(message)}
          importOpen={importOpen}
          onImport={() => setImportOpen(!importOpen)}
        />

        <section className="fleet-projects" aria-label="Projects and agents">
          <div className="fleet-main-heading">
            <div>
              <span className="fleet-eyebrow">WORKSPACE</span>
              <h2>
                {machineFilter ? machineName(machineFilter) : "All projects"}
                <span className="fleet-count">
                  {snapshot ? groups.length : "—"}
                </span>
              </h2>
              <p>Monitor every process in one place, grouped by project.</p>
            </div>
            <button
              className="fleet-button fleet-button--primary"
              disabled={!active.length || !!busy}
              onClick={() => setStartOpen(!startOpen)}
              aria-expanded={startOpen}
            >
              ＋ Start agent
            </button>
          </div>
          <div className="fleet-summary">
            <span>
              <b>{snapshot ? visibleAgents.length : "—"}</b> Agent
            </span>
            <span>
              <i className="fleet-dot" />
              <b>
                {snapshot
                  ? visibleAgents.filter((agent) => agent.status === "running")
                      .length
                  : "—"}
              </b>{" "}
              Running
            </span>
            <span>Cards show the last recorded status · Model activity is not inferred</span>
          </div>
          {importOpen && (
            <HerdrImport
              api={api}
              machines={active}
              busy={busy}
              run={run}
              onClose={() => setImportOpen(false)}
              onImported={() => {
                setNotice(
                  "Herdr static configuration imported. No Herdr sessions were connected, started or taken over.",
                );
                refreshNow();
              }}
            />
          )}
          {startOpen && (
            <LaunchForm
              machines={active}
              machineFilter={machineFilter}
              startForm={startForm}
              setStartForm={setStartForm}
              busy={busy}
              onSubmit={startAgent}
              onClose={() => setStartOpen(false)}
            />
          )}
          {!snapshot ? (
            <Empty title={loading ? "Connecting to the workbench" : "Unable to load"}>
              {loading
                ? "Loading machines and managed sessions."
                : "Review the error above and retry syncing."}
            </Empty>
          ) : !groups.length ? (
            <Empty title="Start with a project">
              Choose a machine and project directory, then start your first agent. No sample or simulated data is shown.
            </Empty>
          ) : (
            groups.map((group) => (
              <section className="fleet-project" key={group.key}>
                <div className="fleet-project-heading">
                  <span aria-hidden="true">▱</span>
                  <div>
                    {group.name && (
                      <strong className="fleet-project-name">
                        {group.name}
                      </strong>
                    )}
                    <h3 title={group.cwd}>{group.cwd || "No project directory provided"}</h3>
                    <p>
                      {machineName(group.machineId)}{" "}
                      <span>
                        · {group.agents.length} agents
                        {group.source === "herdr" ? " · Imported from Herdr" : ""}
                      </span>
                    </p>
                  </div>
                  {group.projectId && (
                    <button
                      className="fleet-button fleet-project-start"
                      disabled={!!busy}
                      onClick={() => requestWorkspaceRemoval(group)}
                    >
                      Remove registration
                    </button>
                  )}
                  <button
                    className="fleet-button fleet-project-start"
                    disabled={
                      !!busy ||
                      !active.some(
                        (machine) => machine.id === group.machineId,
                      )
                    }
                    onClick={() => {
                      setStartForm({
                        machineId: group.machineId,
                        cwd: group.cwd,
                        name: group.name || "",
                        kind: "codex",
                        args: "",
                      });
                      setStartOpen(true);
                    }}
                  >
                    Start agent
                  </button>
                </div>
                {!group.agents.length && (
                  <p className="fleet-project-idle">
                    Project ready. No managed agents yet. A process is created only when you start one.
                  </p>
                )}
                <div className="fleet-agent-grid">
                  {group.agents.map((agent) => (
                    <button
                      className={`fleet-agent ${selectedId === agent.id ? "is-selected" : ""}`}
                      key={agent.id}
                      onClick={() => setSelectedId(agent.id)}
                      aria-pressed={selectedId === agent.id}
                    >
                      <div className="fleet-agent-top">
                        <span className="fleet-agent-kind">
                          {agent.kind || "agent"}
                        </span>
                        <StateBadge status={agent.status} />
                      </div>
                      <strong>{agent.name}</strong>
                      <div className="fleet-agent-bottom">
                        <span>
                          {agent.createdAt &&
                          !Number.isNaN(new Date(agent.createdAt).getTime())
                            ? new Date(agent.createdAt).toLocaleString(
                                "en-US",
                                {
                                  month: "short",
                                  day: "numeric",
                                  hour: "2-digit",
                                  minute: "2-digit",
                                },
                              )
                            : "Creation time unknown"}
                        </span>
                        <span>View output ↗</span>
                      </div>
                    </button>
                  ))}
                </div>
              </section>
            ))
          )}
        </section>

        <aside className="fleet-inspector" aria-label="Agent terminal output">
          <div className="fleet-inspector-heading">
            <span className="fleet-eyebrow">LIVE CONSOLE</span>
            <h2>{selected?.name || "Terminal inspector"}</h2>
            {selected && (
              <div className="fleet-inspector-meta">
                <StateBadge status={selectedStatus} />
                <span>{machineName(selected.machineId)}</span>
              </div>
            )}
          </div>
          {!selected ? (
            <Empty title="Select an agent">
              Select a project card to view live terminal output and send input.
            </Empty>
          ) : (
            <>
              <div className="fleet-terminal-toolbar">
                <span>
                  <i className="fleet-dot" />
                  Read-only output · Last 300 lines
                </span>
                <span>
                  {reading ? "Reading…" : auto ? "Polling every 3 seconds" : "Polling paused"}
                </span>
              </div>
              {outputError && (
                <div className="fleet-output-error" role="alert">
                  {outputError}
                  {currentOutput && <small>Showing output from the last successful read.</small>}
                </div>
              )}
              {currentOutput?.diagnostic && (
                <div className="fleet-output-error" role="alert">
                  <strong>Terminal diagnostics</strong>
                  <p>{String(currentOutput.diagnostic)}</p>
                </div>
              )}
              <pre
                className="fleet-terminal"
                tabIndex={0}
                aria-label="Terminal output"
              >
                {currentOutput
                  ? currentOutput.output ||
                    (currentOutput.diagnostic || selectedStatus === "unknown"
                      ? "(Terminal output is unavailable. Check diagnostics or retry.)"
                      : "(No process output yet)")
                  : reading
                    ? "Reading terminal output…"
                    : "No output available"}
              </pre>
              {currentOutput?.truncated && (
                <p className="fleet-truncated">Output was truncated. Only recent content is shown.</p>
              )}
              <form
                className="fleet-input-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const sentText = text;
                  const agentId = selected.id;
                  run("Send input", async () => {
                    await api("send", { agentId, text: sentText, enter });
                    if (mounted.current) {
                      setText((current) =>
                        current === sentText ? "" : current,
                      );
                      setNotice("Input sent.");
                    }
                  });
                }}
              >
                <label htmlFor="fleet-agent-input">Send to terminal</label>
                <input
                  id="fleet-agent-input"
                  type="text"
                  maxLength={16384}
                  autoComplete="off"
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  placeholder="Enter a single-line message or command…"
                  disabled={!!busy || selectedStatus === "exited"}
                />
                <div className="fleet-input-actions">
                  <label className="fleet-toggle">
                    <input
                      type="checkbox"
                      checked={enter}
                      onChange={(event) => setEnter(event.target.checked)}
                    />
                    Append Enter
                  </label>
                  <button
                    className="fleet-button fleet-button--primary"
                    disabled={!!busy || !text || selectedStatus === "exited"}
                  >
                    Send ↗
                  </button>
                </div>
                <p className="fleet-muted">
                  Input is sent directly to the target process. Text in a shell may execute as a command.
                </p>
              </form>
              <div className="fleet-danger-actions">
                <button
                  className="fleet-button"
                  disabled={!!busy || selectedStatus === "exited"}
                  onClick={() => requestAction("interrupt", selected)}
                >
                  Interrupt Ctrl+C
                </button>
                <button
                  className="fleet-button fleet-button--danger"
                  disabled={!!busy || !!selected.stoppedAt}
                  onClick={() => requestAction("stop", selected)}
                >
                  {selected.stoppedAt ? "Session stopped" : "Stop session"}
                </button>
              </div>
              {(selected.stoppedAt || selectedStatus !== "running") && (
                <div className="fleet-record-actions">
                  <button
                    className="fleet-button"
                    disabled={!!busy}
                    onClick={() => requestForget(selected)}
                  >
                    {selected.stoppedAt ? "Remove from list" : "Forget record"}
                  </button>
                </div>
              )}
            </>
          )}
        </aside>
      </div>
      <footer className="fleet-footer">
        <span>FLEET / Agent control panel for your machines</span>
        <span role="status">
          {busy
            ? `${busy}…`
            : auto
              ? "Auto-polling on · List 5s / Output 3s"
              : "Auto-polling paused"}
        </span>
      </footer>
      {confirm && (
        <ConfirmDialog
          confirm={confirm}
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const action = confirm;
            setConfirm(null);
            run(action.label, async () => {
              const result = await api(action.endpoint, action.payload);
              if (mounted.current) setNotice(action.notice ? action.notice(result) : "Action completed.");
            });
          }}
        />
      )}
    </main>
  );
}

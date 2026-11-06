import React, { useEffect, useRef, useState } from "react";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 2 * MAX_FILE_BYTES;

export function machineAddress(machine) {
  return `${machine.user ? `${machine.user}@` : ""}${machine.host || "SSH"}${machine.port ? `:${machine.port}` : ""}`;
}

function fileBuffer(file) {
  if (typeof file.arrayBuffer === "function") return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Unable to read the selected file. Please select it again."));
    reader.readAsArrayBuffer(file);
  });
}

/** Files stay in component memory. Only the explicit preview/import actions send them. */
export default function HerdrImport({
  api,
  machines,
  busy,
  run,
  onClose,
  onImported,
}) {
  const [files, setFiles] = useState({ machines: null, session: null });
  const [reading, setReading] = useState({ machines: false, session: false });
  const [fileErrors, setFileErrors] = useState({ machines: "", session: "" });
  const [machineId, setMachineId] = useState("");
  const [preview, setPreview] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const [fileKey, setFileKey] = useState(0);
  const alive = useRef(false);
  const revision = useRef(0);
  const fileGeneration = useRef({ machines: 0, session: 0 });
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      revision.current += 1;
      fileGeneration.current.machines += 1;
      fileGeneration.current.session += 1;
    };
  }, []);

  function invalidate() {
    revision.current += 1;
    setPreview(null);
    setConfirmed(false);
  }

  useEffect(() => {
    if (machineId && !machines.some((machine) => machine.id === machineId)) {
      setMachineId("");
      revision.current += 1;
      setPreview(null);
      setConfirmed(false);
    }
  }, [machines, machineId]);

  async function chooseFile(kind, file) {
    invalidate();
    const generation = ++fileGeneration.current[kind];
    setFiles((previous) => ({ ...previous, [kind]: null }));
    setFileErrors((previous) => ({ ...previous, [kind]: "" }));
    setReading((previous) => ({ ...previous, [kind]: !!file }));
    if (!file) return;
    try {
      if (file.size > MAX_FILE_BYTES)
        throw new Error("Each file must be 1 MiB or smaller. Choose a smaller static configuration file.");
      const buffer = await fileBuffer(file);
      if (buffer.byteLength > MAX_FILE_BYTES)
        throw new Error("Each file must be 1 MiB or smaller.");
      let text;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      } catch {
        throw new Error("Files must use UTF-8 encoding.");
      }
      try {
        JSON.parse(text);
      } catch {
        throw new Error("The file is not valid JSON. Its raw contents will not be displayed or imported.");
      }
      if (alive.current && fileGeneration.current[kind] === generation) {
        setFiles((previous) => ({
          ...previous,
          [kind]: { text, size: buffer.byteLength, name: file.name },
        }));
      }
    } catch (error) {
      if (alive.current && fileGeneration.current[kind] === generation) {
        setFileErrors((previous) => ({
          ...previous,
          [kind]: error.message || "Unable to read the file.",
        }));
      }
    } finally {
      if (alive.current && fileGeneration.current[kind] === generation) {
        setReading((previous) => ({ ...previous, [kind]: false }));
      }
    }
  }

  const isReading = reading.machines || reading.session;
  const totalBytes = (files.machines?.size || 0) + (files.session?.size || 0);
  const validTarget = machines.some((machine) => machine.id === machineId);
  const canPreview =
    !busy &&
    !isReading &&
    totalBytes <= MAX_TOTAL_BYTES &&
    (files.machines || files.session) &&
    !fileErrors.machines &&
    !fileErrors.session &&
    (!files.session || validTarget);

  function requestPreview(event) {
    event.preventDefault();
    if (!canPreview) return;
    invalidate();
    const requestRevision = revision.current;
    const input = {
      ...(files.machines ? { machinesText: files.machines.text } : {}),
      ...(files.session
        ? { sessionText: files.session.text, projectMachineId: machineId }
        : {}),
    };
    run("Preview Herdr configuration", async () => {
      const value = await api("previewHerdr", input);
      if (!alive.current || revision.current !== requestRevision) return;
      if (
        !value ||
        typeof value.digest !== "string" ||
        !value.digest ||
        !Array.isArray(value.machines) ||
        !Array.isArray(value.projects) ||
        !Array.isArray(value.warnings) ||
        !value.summary
      ) {
        throw new Error("The import preview response is invalid. Try again; no configuration has been imported.");
      }
      setPreview({ value, input, revision: requestRevision });
    });
  }

  function importConfirmed() {
    if (
      !preview ||
      !confirmed ||
      busy ||
      isReading ||
      preview.revision !== revision.current
    )
      return;
    if (preview.input.sessionText && !validTarget) return;
    const approved = preview;
    run("Import Herdr configuration", async () => {
      // Reuse the exact previewed input, never reconstruct it from mutable form values.
      await api("importHerdr", {
        ...approved.input,
        confirmation: approved.value.digest,
      });
      if (!alive.current) return;
      invalidate();
      setFiles({ machines: null, session: null });
      setFileErrors({ machines: "", session: "" });
      setMachineId("");
      setFileKey((value) => value + 1);
      onImported();
    });
  }

  const value = preview?.value;
  return (
    <section className="fleet-import" aria-label="Herdr static configuration import">
      <div className="fleet-section-heading">
        <div>
          <span className="fleet-eyebrow">BRING YOUR WORKSPACE</span>
          <h3>Import machines and projects from Herdr</h3>
        </div>
        <button
          type="button"
          aria-label="Close Herdr import"
          disabled={!!busy}
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <p className="fleet-import-safety">
        Import only machine connection settings and project paths. This does not take over agents, read terminal output, run the Herdr CLI or modify Herdr files.
      </p>
      <form className="fleet-form" onSubmit={requestPreview}>
        <div className="fleet-form-grid">
          <label>
            Machine catalog · endpoints.json (optional)
            <input
              key={`machines-${fileKey}`}
              type="file"
              accept=".json,application/json"
              disabled={!!busy}
              onChange={(event) =>
                chooseFile("machines", event.target.files?.[0])
              }
            />
            <span className="fleet-muted">
              Unix default: ~/.local/state/herdr/client/endpoints.json. If XDG_STATE_HOME is set, its corresponding directory is used.
            </span>
            {files.machines && (
              <span className="fleet-import-file">
                Loaded {files.machines.name} ·{" "}
                {files.machines.size.toLocaleString()} B
              </span>
            )}
            {reading.machines && <span role="status">Reading machine catalog…</span>}
            {fileErrors.machines && (
              <span className="fleet-import-error" role="alert">
                {fileErrors.machines}
              </span>
            )}
          </label>
          <label>
            Project snapshot · session.json (optional)
            <input
              key={`session-${fileKey}`}
              type="file"
              accept=".json,application/json"
              disabled={!!busy}
              onChange={(event) =>
                chooseFile("session", event.target.files?.[0])
              }
            />
            <span className="fleet-muted">
              Default: ~/.config/herdr/session.json or ~/.config/herdr/sessions/&lt;name&gt;/session.json. You may select a copy from a remote machine.
            </span>
            {files.session && (
              <span className="fleet-import-file">
                Loaded {files.session.name} ·{" "}
                {files.session.size.toLocaleString()} B
              </span>
            )}
            {reading.session && <span role="status">Reading project snapshot…</span>}
            {fileErrors.session && (
              <span className="fleet-import-error" role="alert">
                {fileErrors.session}
              </span>
            )}
          </label>
        </div>
        <label>
          Project machine · Explicit selection required for session.json
          <select
            value={machineId}
            disabled={!!busy}
            onChange={(event) => {
              invalidate();
              setMachineId(event.target.value);
            }}
          >
            <option value="">Select the machine where these project paths exist</option>
            {machines.map((machine) => (
              <option key={machine.id} value={machine.id}>
                {machine.name} ·{" "}
                {machine.type === "local" || machine.kind === "local"
                  ? "Local"
                  : machineAddress(machine)}
              </option>
            ))}
          </select>
        </label>
        {files.session && !validTarget && (
          <p className="fleet-import-error" role="status">
            Select the machine where the projects exist. Local cannot be inferred from the file source.
          </p>
        )}
        <p className="fleet-muted">
          Select at least one UTF-8 JSON file. Limit: 1 MiB per file, 2 MiB total. File text stays temporarily in this view’s memory. Import machines first, then select a new machine to import its remote projects.
        </p>
        <div className="fleet-import-actions">
          <button
            className="fleet-button"
            type="button"
            disabled={!!busy}
            onClick={() => {
              invalidate();
              fileGeneration.current.machines += 1;
              fileGeneration.current.session += 1;
              setFiles({ machines: null, session: null });
              setReading({ machines: false, session: false });
              setFileErrors({ machines: "", session: "" });
              setFileKey((number) => number + 1);
            }}
          >
            Clear files
          </button>
          <button
            className="fleet-button fleet-button--primary"
            disabled={!canPreview}
          >
            {busy === "Preview Herdr configuration" ? "Preparing preview…" : "Preview import"}
          </button>
        </div>
      </form>
      {value && (
        <div className="fleet-import-preview">
          <div className="fleet-section-heading">
            <h3>Review import preview</h3>
            <span className="fleet-count">Not saved yet</span>
          </div>
          <p className="fleet-import-summary">
            Add {value.summary.machines} machines · Add {value.summary.projects}{" "}
            projects · Skip {value.summary.duplicates} duplicates
          </p>
          {value.warnings.length > 0 && (
            <div className="fleet-import-warnings" role="status">
              <strong>Please review</strong>
              <ul>
                {value.warnings.map((warning, index) => (
                  <li key={index}>{String(warning)}</li>
                ))}
              </ul>
            </div>
          )}
          <h4>Machines</h4>
          {value.machines.length ? (
            <ul className="fleet-import-items">
              {value.machines.map((machine, index) => (
                <li key={index}>
                  <div>
                    <strong>{machine.name}</strong>
                    <code>{machineAddress(machine)}</code>
                  </div>
                  <span className="fleet-count">
                    {machine.action === "add"
                      ? "Add"
                      : machine.action === "duplicate"
                        ? "Duplicate · Skip"
                        : "Unknown"}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="fleet-muted">No machines to import.</p>
          )}
          <h4>Projects</h4>
          {value.projects.length ? (
            <ul className="fleet-import-items">
              {value.projects.map((project, index) => (
                <li key={index}>
                  <div>
                    <strong>{project.name}</strong>
                    <code>{project.cwd}</code>
                    <small>
                      {(() => {
                        const target = machines.find(
                          (machine) => machine.id === project.machineId,
                        );
                        return target
                          ? `${target.name} · ${target.type === "local" || target.kind === "local" ? "Local" : machineAddress(target)}`
                          : project.machineId;
                      })()}
                    </small>
                  </div>
                  <span className="fleet-count">
                    {project.action === "add"
                      ? "Add"
                      : project.action === "duplicate"
                        ? "Duplicate · Skip"
                        : "Unknown"}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="fleet-muted">No projects to import.</p>
          )}
          <label className="fleet-import-confirm">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={!!busy}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            <span>
              I have reviewed the target machines, project paths and warnings. Import only this static configuration without starting or taking over processes.
            </span>
          </label>
          <button
            className="fleet-button fleet-button--primary"
            disabled={
              !!busy || !confirmed || preview.revision !== revision.current
            }
            onClick={importConfirmed}
          >
            {busy === "Import Herdr configuration" ? "Importing…" : "Confirm import"}
          </button>
        </div>
      )}
    </section>
  );
}

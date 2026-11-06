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
    reader.onerror = () => reject(new Error("无法读取所选文件，请重新选择。"));
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
        throw new Error("单个文件不能超过 1 MiB，请选择较小的静态配置文件。");
      const buffer = await fileBuffer(file);
      if (buffer.byteLength > MAX_FILE_BYTES)
        throw new Error("单个文件不能超过 1 MiB。");
      let text;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      } catch {
        throw new Error("文件必须使用 UTF-8 编码。");
      }
      try {
        JSON.parse(text);
      } catch {
        throw new Error("文件不是有效的 JSON。不会显示或导入原始内容。");
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
          [kind]: error.message || "文件读取失败。",
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
    run("预览 Herdr 配置", async () => {
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
        throw new Error("导入预览响应无效，请重试；尚未导入任何配置。");
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
    run("导入 Herdr 配置", async () => {
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
    <section className="fleet-import" aria-label="Herdr 静态配置导入">
      <div className="fleet-section-heading">
        <div>
          <span className="fleet-eyebrow">BRING YOUR WORKSPACE</span>
          <h3>从 Herdr 导入机器与项目</h3>
        </div>
        <button
          type="button"
          aria-label="关闭 Herdr 导入"
          disabled={!!busy}
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <p className="fleet-import-safety">
        只导入机器连接配置与项目目录，不接管 Agent，不读取终端输出，不执行 Herdr
        CLI，也不修改 Herdr 文件。
      </p>
      <form className="fleet-form" onSubmit={requestPreview}>
        <div className="fleet-form-grid">
          <label>
            机器配置 · endpoints.json（可选）
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
              Unix 默认 ~/.local/state/herdr/client/endpoints.json；设置
              XDG_STATE_HOME 时使用其对应目录。
            </span>
            {files.machines && (
              <span className="fleet-import-file">
                已读取 {files.machines.name} ·{" "}
                {files.machines.size.toLocaleString()} B
              </span>
            )}
            {reading.machines && <span role="status">正在读取机器配置…</span>}
            {fileErrors.machines && (
              <span className="fleet-import-error" role="alert">
                {fileErrors.machines}
              </span>
            )}
          </label>
          <label>
            项目快照 · session.json（可选）
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
              默认 ~/.config/herdr/session.json 或
              ~/.config/herdr/sessions/&lt;name&gt;/session.json。可选择远端文件副本。
            </span>
            {files.session && (
              <span className="fleet-import-file">
                已读取 {files.session.name} ·{" "}
                {files.session.size.toLocaleString()} B
              </span>
            )}
            {reading.session && <span role="status">正在读取项目快照…</span>}
            {fileErrors.session && (
              <span className="fleet-import-error" role="alert">
                {fileErrors.session}
              </span>
            )}
          </label>
        </div>
        <label>
          项目所属机器 · 导入 session.json 时必须明确选择
          <select
            value={machineId}
            disabled={!!busy}
            onChange={(event) => {
              invalidate();
              setMachineId(event.target.value);
            }}
          >
            <option value="">请选择项目路径实际所在的机器</option>
            {machines.map((machine) => (
              <option key={machine.id} value={machine.id}>
                {machine.name} ·{" "}
                {machine.type === "local" || machine.kind === "local"
                  ? "本机"
                  : machineAddress(machine)}
              </option>
            ))}
          </select>
        </label>
        {files.session && !validTarget && (
          <p className="fleet-import-error" role="status">
            必须选择项目实际所属机器，不能根据文件来源自动推断为本机。
          </p>
        )}
        <p className="fleet-muted">
          每个文件限 1 MiB，总计限 2 MiB，UTF-8
          JSON。至少选择一个文件；文件文本仅暂存当前界面内存。可先仅导入机器，再选择新机器导入远端项目。
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
            清除文件
          </button>
          <button
            className="fleet-button fleet-button--primary"
            disabled={!canPreview}
          >
            {busy === "预览 Herdr 配置" ? "正在预览…" : "生成导入预览"}
          </button>
        </div>
      </form>
      {value && (
        <div className="fleet-import-preview">
          <div className="fleet-section-heading">
            <h3>核对导入预览</h3>
            <span className="fleet-count">尚未写入</span>
          </div>
          <p className="fleet-import-summary">
            新增 {value.summary.machines} 台机器 · 新增 {value.summary.projects}{" "}
            个项目 · 跳过 {value.summary.duplicates} 个重复项
          </p>
          {value.warnings.length > 0 && (
            <div className="fleet-import-warnings" role="status">
              <strong>请留意</strong>
              <ul>
                {value.warnings.map((warning, index) => (
                  <li key={index}>{String(warning)}</li>
                ))}
              </ul>
            </div>
          )}
          <h4>机器</h4>
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
                      ? "新增"
                      : machine.action === "duplicate"
                        ? "重复 · 跳过"
                        : "未识别"}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="fleet-muted">没有可导入的机器。</p>
          )}
          <h4>项目</h4>
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
                          ? `${target.name} · ${target.type === "local" || target.kind === "local" ? "本机" : machineAddress(target)}`
                          : project.machineId;
                      })()}
                    </small>
                  </div>
                  <span className="fleet-count">
                    {project.action === "add"
                      ? "新增"
                      : project.action === "duplicate"
                        ? "重复 · 跳过"
                        : "未识别"}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="fleet-muted">没有可导入的项目。</p>
          )}
          <label className="fleet-import-confirm">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={!!busy}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            <span>
              我已核对目标机器、项目路径与警告，仅导入以上静态配置，不启动或接管进程。
            </span>
          </label>
          <button
            className="fleet-button fleet-button--primary"
            disabled={
              !!busy || !confirmed || preview.revision !== revision.current
            }
            onClick={importConfirmed}
          >
            {busy === "导入 Herdr 配置" ? "正在导入…" : "确认导入配置"}
          </button>
        </div>
      )}
    </section>
  );
}

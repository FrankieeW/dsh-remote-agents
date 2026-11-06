import React, { useEffect, useMemo, useRef, useState } from "react";
import HerdrImport, { machineAddress } from "./HerdrImport.jsx";

const STATUS = { running: "运行中", exited: "已退出", unknown: "状态未知" };
const messageOf = (error) =>
  error instanceof Error ? error.message : String(error || "请求失败，请重试");
const localMachine = (machine) =>
  machine.type === "local" || machine.kind === "local";
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
  const [probeResults, setProbeResults] = useState({});
  const [addOpen, setAddOpen] = useState(false);
  const [startOpen, setStartOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [machineForm, setMachineForm] = useState({ name: "", host: "" });
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
  const confirmCancel = useRef(null);
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
          throw new Error("工作台尚未连接 API，请检查插件集成。");
        const value = await api("snapshot", {});
        if (
          !value ||
          !Array.isArray(value.machines) ||
          !Array.isArray(value.agents)
        )
          throw new Error("服务返回了无效的工作台数据。");
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
          throw new Error("服务返回了无效的终端输出。");
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
      !machines.some((machine) => machine.id === machineFilter)
    )
      setMachineFilter("");
  }, [snapshot, selectedId, machineFilter]);
  useEffect(() => {
    setText("");
  }, [selectedId]);
  useEffect(() => {
    if (confirm) confirmCancel.current?.focus();
  }, [confirm]);

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
  function addMachine(event) {
    event.preventDefault();
    run("添加机器", async () => {
      await api("addMachine", {
        name: machineForm.name.trim(),
        host: machineForm.host.trim(),
      });
      if (mounted.current) {
        setMachineForm({ name: "", host: "" });
        setAddOpen(false);
        setNotice("SSH 机器已添加；请检测连接后启动 Agent。");
      }
    });
  }
  function startAgent(event) {
    event.preventDefault();
    run("启动 Agent", async () => {
      let args;
      try {
        args = startForm.args.trim() ? JSON.parse(startForm.args) : [];
      } catch {
        throw new Error('附加参数必须是 JSON 字符串数组，例如 ["--help"]。');
      }
      if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string"))
        throw new Error("附加参数中的每一项都必须是字符串。");
      const machineId = startForm.machineId || machineFilter || machines[0]?.id;
      if (!machineId) throw new Error("请先添加或选择一台机器。");
      if (!startForm.cwd.startsWith("/"))
        throw new Error("项目目录必须是目标机器上的绝对路径（以 / 开头）。");
      const result = await api("start", {
        ...startForm,
        name: startForm.name.trim(),
        machineId,
        args,
      });
      if (mounted.current) {
        setStartOpen(false);
        setNotice("启动请求已完成，请以进程状态和终端输出为准。");
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
          ? `停止「${agent.name}」？`
          : `中断「${agent.name}」？`,
      description:
        endpoint === "stop"
          ? "这将终止该 Agent 的托管 tmux 会话。未保存的工作可能丢失，此操作不可撤销。"
          : "这将向进程发送 Ctrl+C，可能取消当前任务，但不会删除会话。",
      label: endpoint === "stop" ? "确认停止" : "发送 Ctrl+C",
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
            <h1>Agent 工作台</h1>
          </div>
        </div>
        <div className="fleet-toolbar">
          <span className="fleet-sync">
            {loading
              ? "正在同步…"
              : updatedAt
                ? `更新于 ${updatedAt.toLocaleTimeString("zh-CN")}`
                : "尚未同步"}
          </span>
          <label className="fleet-toggle">
            <input
              type="checkbox"
              checked={auto}
              onChange={(event) => setAuto(event.target.checked)}
            />
            自动轮询
          </label>
          <button
            className="fleet-button"
            onClick={refreshNow}
            disabled={loading || reading}
          >
            ↻ 刷新
          </button>
        </div>
      </header>
      {(snapshotError || actionError) && (
        <div className="fleet-alert fleet-alert--error" role="alert">
          <strong>操作未完成</strong>
          <span>{actionError || snapshotError}</span>
          {snapshot && snapshotError && (
            <small>当前展示的是上次成功同步的数据。</small>
          )}
          <button
            className="fleet-button"
            onClick={() => {
              setActionError("");
              refreshNow();
            }}
          >
            重试同步
          </button>
        </div>
      )}
      {notice && (
        <div className="fleet-alert" role="status">
          {notice}
          <button aria-label="关闭提示" onClick={() => setNotice("")}>
            ×
          </button>
        </div>
      )}
      <div className="fleet-workspace">
        <aside className="fleet-sidebar">
          <div className="fleet-section-heading">
            <h2>机器</h2>
            <span className="fleet-count">
              {snapshot ? machines.length : "—"}
            </span>
          </div>
          <button
            className={`fleet-machine fleet-machine--all ${!machineFilter ? "is-active" : ""}`}
            onClick={() => setMachineFilter("")}
          >
            <span className="fleet-machine-icon">▦</span>
            <span>
              <strong>全部机器</strong>
              <small>跨机器项目视图</small>
            </span>
            <span className="fleet-count">
              {snapshot ? agents.length : "—"}
            </span>
          </button>
          <div className="fleet-machine-list">
            {machines.map((machine) => (
              <div
                className={`fleet-machine-wrap ${machineFilter === machine.id ? "is-active" : ""}`}
                key={machine.id}
              >
                <button
                  className="fleet-machine"
                  onClick={() => setMachineFilter(machine.id)}
                >
                  <span className="fleet-machine-icon" aria-hidden="true">
                    {localMachine(machine) ? "▣" : "⌁"}
                  </span>
                  <span>
                    <strong>{machine.name}</strong>
                    <small>
                      {localMachine(machine)
                        ? "本机 · LOCAL"
                        : machineAddress(machine)}
                    </small>
                  </span>
                </button>
                <div className="fleet-machine-actions">
                  <button
                    disabled={!!busy}
                    onClick={() =>
                      run("检测连接", async () => {
                        const result = await api("probe", {
                          machineId: machine.id,
                        });
                        if (mounted.current)
                          setProbeResults((previous) => ({
                            ...previous,
                            [machine.id]: result,
                          }));
                      })
                    }
                  >
                    检测连接
                  </button>
                  {!localMachine(machine) && (
                    <button
                      disabled={!!busy}
                      onClick={() =>
                        setConfirm({
                          endpoint: "removeMachine",
                          payload: { machineId: machine.id },
                          title: `移除「${machine.name}」？`,
                          description:
                            "仅移除机器配置；有托管 Agent 的机器可能无法移除。不会修改 SSH 配置。",
                          label: "确认移除",
                        })
                      }
                    >
                      移除
                    </button>
                  )}
                </div>
                {probeResults[machine.id] && (
                  <p
                    className={`fleet-probe ${probeResults[machine.id].ok ? "is-ok" : "is-error"}`}
                    role="status"
                  >
                    {probeResults[machine.id].ok
                      ? "连接检测成功"
                      : `连接失败：${probeResults[machine.id].error || "请检查 SSH 与 tmux 配置"}`}
                  </p>
                )}
              </div>
            ))}
          </div>
          {!snapshot && (
            <p className="fleet-muted">
              {loading ? "正在加载机器…" : "尚未获取机器列表"}
            </p>
          )}
          <button
            className="fleet-button fleet-add-machine"
            onClick={() => setAddOpen(!addOpen)}
            aria-expanded={addOpen}
          >
            ＋ 添加 SSH 机器
          </button>
          {addOpen && (
            <form
              className="fleet-form fleet-machine-form"
              onSubmit={addMachine}
            >
              <label>
                显示名称
                <input
                  required
                  maxLength={80}
                  value={machineForm.name}
                  onChange={(event) =>
                    setMachineForm({ ...machineForm, name: event.target.value })
                  }
                  placeholder="例如：开发服务器"
                />
              </label>
              <label>
                SSH Host / 别名
                <input
                  required
                  value={machineForm.host}
                  onChange={(event) =>
                    setMachineForm({ ...machineForm, host: event.target.value })
                  }
                  placeholder="例如：dev-server"
                  autoCapitalize="none"
                  spellCheck={false}
                />
              </label>
              <p className="fleet-muted">
                使用已有 SSH
                配置与密钥。不会保存密码，未知主机需先在终端完成可信验证。
              </p>
              <button
                className="fleet-button fleet-button--primary"
                disabled={!!busy}
              >
                添加机器
              </button>
            </form>
          )}
          <button
            className="fleet-button fleet-add-machine"
            onClick={() => setImportOpen(!importOpen)}
            disabled={!!busy}
            aria-expanded={importOpen}
          >
            ◇ 从 Herdr 导入
          </button>
          <div className="fleet-sidebar-note">
            <span aria-hidden="true">◈</span>
            <strong>你的机器，你的会话</strong>
            <p>只管理本工作台创建的会话，不接管已有终端。</p>
          </div>
        </aside>

        <section className="fleet-projects" aria-label="项目与 Agent">
          <div className="fleet-main-heading">
            <div>
              <span className="fleet-eyebrow">WORKSPACE</span>
              <h2>
                {machineFilter ? machineName(machineFilter) : "所有项目"}
                <span className="fleet-count">
                  {snapshot ? groups.length : "—"}
                </span>
              </h2>
              <p>按项目聚合，在同一处掌握每个进程。</p>
            </div>
            <button
              className="fleet-button fleet-button--primary"
              disabled={!machines.length || !!busy}
              onClick={() => setStartOpen(!startOpen)}
              aria-expanded={startOpen}
            >
              ＋ 启动 Agent
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
              运行中
            </span>
            <span>卡片为最近记录状态 · 不推断模型活动</span>
          </div>
          {importOpen && (
            <HerdrImport
              api={api}
              machines={machines}
              busy={busy}
              run={run}
              onClose={() => setImportOpen(false)}
              onImported={() => {
                setNotice(
                  "Herdr 静态配置已导入。未连接、启动或接管任何 Herdr 会话。",
                );
                refreshNow();
              }}
            />
          )}
          {startOpen && (
            <form className="fleet-form fleet-launch" onSubmit={startAgent}>
              <div className="fleet-section-heading">
                <h3>新建 Agent</h3>
                <button
                  type="button"
                  aria-label="关闭启动表单"
                  onClick={() => setStartOpen(false)}
                >
                  ×
                </button>
              </div>
              <div className="fleet-form-grid">
                <label>
                  目标机器
                  <select
                    value={
                      startForm.machineId ||
                      machineFilter ||
                      machines[0]?.id ||
                      ""
                    }
                    onChange={(event) =>
                      setStartForm({
                        ...startForm,
                        machineId: event.target.value,
                      })
                    }
                  >
                    {machines.map((machine) => (
                      <option key={machine.id} value={machine.id}>
                        {machine.name} ·{" "}
                        {localMachine(machine)
                          ? "本机"
                          : machineAddress(machine)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  运行程序
                  <select
                    value={startForm.kind}
                    onChange={(event) =>
                      setStartForm({ ...startForm, kind: event.target.value })
                    }
                  >
                    <option value="codex">Codex</option>
                    <option value="claude">Claude Code</option>
                    <option value="dsh">DeepSeek Harness</option>
                    <option value="shell">Shell</option>
                  </select>
                </label>
                <label>
                  Agent 名称
                  <input
                    required
                    maxLength={80}
                    value={startForm.name}
                    onChange={(event) =>
                      setStartForm({ ...startForm, name: event.target.value })
                    }
                    placeholder="给这个任务起个名字"
                  />
                </label>
                <label>
                  项目绝对路径
                  <input
                    required
                    value={startForm.cwd}
                    onChange={(event) =>
                      setStartForm({ ...startForm, cwd: event.target.value })
                    }
                    placeholder="/home/user/project"
                    spellCheck={false}
                  />
                </label>
              </div>
              <label>
                附加参数{" "}
                <span className="fleet-muted">可选 · JSON 字符串数组</span>
                <input
                  value={startForm.args}
                  onChange={(event) =>
                    setStartForm({ ...startForm, args: event.target.value })
                  }
                  placeholder={'["--help"]'}
                  spellCheck={false}
                />
              </label>
              <p className="fleet-muted">
                程序与项目目录必须已存在于目标机器；不自动安装或绕过程序权限确认。
              </p>
              <button
                className="fleet-button fleet-button--primary"
                disabled={!!busy}
              >
                {busy === "启动 Agent" ? "正在启动…" : "启动进程"}
              </button>
            </form>
          )}
          {!snapshot ? (
            <Empty title={loading ? "正在连接工作台" : "暂时无法加载"}>
              {loading
                ? "正在读取机器与托管会话。"
                : "请查看上方错误并重试同步。"}
            </Empty>
          ) : !groups.length ? (
            <Empty title="从一个项目开始">
              选择机器，指定项目目录，启动你的第一个
              Agent。这里不会展示示例或模拟数据。
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
                    <h3 title={group.cwd}>{group.cwd || "未提供项目目录"}</h3>
                    <p>
                      {machineName(group.machineId)}{" "}
                      <span>
                        · {group.agents.length} 个 Agent
                        {group.source === "herdr" ? " · Herdr 导入" : ""}
                      </span>
                    </p>
                  </div>
                  <button
                    className="fleet-button fleet-project-start"
                    disabled={
                      !!busy ||
                      !machines.some(
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
                    启动 Agent
                  </button>
                </div>
                {!group.agents.length && (
                  <p className="fleet-project-idle">
                    项目已就绪，尚无托管 Agent。启动后才会创建新进程。
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
                                "zh-CN",
                                {
                                  month: "short",
                                  day: "numeric",
                                  hour: "2-digit",
                                  minute: "2-digit",
                                },
                              )
                            : "创建时间未知"}
                        </span>
                        <span>查看输出 ↗</span>
                      </div>
                    </button>
                  ))}
                </div>
              </section>
            ))
          )}
        </section>

        <aside className="fleet-inspector" aria-label="Agent 终端输出">
          <div className="fleet-inspector-heading">
            <span className="fleet-eyebrow">LIVE CONSOLE</span>
            <h2>{selected?.name || "终端观察台"}</h2>
            {selected && (
              <div className="fleet-inspector-meta">
                <StateBadge status={selectedStatus} />
                <span>{machineName(selected.machineId)}</span>
              </div>
            )}
          </div>
          {!selected ? (
            <Empty title="选择一个 Agent">
              点击项目中的卡片，查看真实终端输出并发送输入。
            </Empty>
          ) : (
            <>
              <div className="fleet-terminal-toolbar">
                <span>
                  <i className="fleet-dot" />
                  只读输出 · 最近 300 行
                </span>
                <span>
                  {reading ? "读取中…" : auto ? "每 3 秒轮询" : "轮询已暂停"}
                </span>
              </div>
              {outputError && (
                <div className="fleet-output-error" role="alert">
                  {outputError}
                  {currentOutput && <small>以下为上次成功读取的输出。</small>}
                </div>
              )}
              {currentOutput?.diagnostic && (
                <div className="fleet-output-error" role="alert">
                  <strong>终端诊断</strong>
                  <p>{String(currentOutput.diagnostic)}</p>
                </div>
              )}
              <pre
                className="fleet-terminal"
                tabIndex={0}
                aria-label="终端输出"
              >
                {currentOutput
                  ? currentOutput.output ||
                    (currentOutput.diagnostic || selectedStatus === "unknown"
                      ? "（暂时无法确认终端输出，请查看诊断或重试）"
                      : "（进程尚无输出）")
                  : reading
                    ? "正在读取终端输出…"
                    : "暂无可用输出"}
              </pre>
              {currentOutput?.truncated && (
                <p className="fleet-truncated">输出已截断，仅显示最近内容。</p>
              )}
              <form
                className="fleet-input-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const sentText = text;
                  const agentId = selected.id;
                  run("发送输入", async () => {
                    await api("send", { agentId, text: sentText, enter });
                    if (mounted.current) {
                      setText((current) =>
                        current === sentText ? "" : current,
                      );
                      setNotice("输入已发送。");
                    }
                  });
                }}
              >
                <label htmlFor="fleet-agent-input">发送到终端</label>
                <input
                  id="fleet-agent-input"
                  type="text"
                  maxLength={16384}
                  autoComplete="off"
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  placeholder="输入单行消息或命令…"
                  disabled={!!busy || selectedStatus === "exited"}
                />
                <div className="fleet-input-actions">
                  <label className="fleet-toggle">
                    <input
                      type="checkbox"
                      checked={enter}
                      onChange={(event) => setEnter(event.target.checked)}
                    />
                    附加回车
                  </label>
                  <button
                    className="fleet-button fleet-button--primary"
                    disabled={!!busy || !text || selectedStatus === "exited"}
                  >
                    发送 ↗
                  </button>
                </div>
                <p className="fleet-muted">
                  输入直接交给目标进程；Shell 中的文本可能作为命令执行。
                </p>
              </form>
              <div className="fleet-danger-actions">
                <button
                  className="fleet-button"
                  disabled={!!busy || selectedStatus === "exited"}
                  onClick={() => requestAction("interrupt", selected)}
                >
                  中断 Ctrl+C
                </button>
                <button
                  className="fleet-button fleet-button--danger"
                  disabled={!!busy || !!selected.stoppedAt}
                  onClick={() => requestAction("stop", selected)}
                >
                  {selected.stoppedAt ? "会话已停止" : "停止会话"}
                </button>
              </div>
            </>
          )}
        </aside>
      </div>
      <footer className="fleet-footer">
        <span>FLEET / 自有机器上的 Agent 控制面板</span>
        <span role="status">
          {busy
            ? `${busy}…`
            : auto
              ? "自动轮询已开启 · 列表 5s / 输出 3s"
              : "自动轮询已暂停"}
        </span>
      </footer>
      {confirm && (
        <div
          className="fleet-modal-backdrop"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !busy) setConfirm(null);
            if (event.key === "Tab") {
              const buttons = event.currentTarget.querySelectorAll(
                "button:not(:disabled)",
              );
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
            <div>
              <button
                ref={confirmCancel}
                className="fleet-button"
                disabled={!!busy}
                onClick={() => setConfirm(null)}
              >
                取消
              </button>
              <button
                className="fleet-button fleet-button--danger"
                disabled={!!busy}
                onClick={() => {
                  const action = confirm;
                  setConfirm(null);
                  run(action.label, async () => {
                    await api(action.endpoint, action.payload);
                    if (mounted.current) setNotice("操作已完成。");
                  });
                }}
              >
                {confirm.label}
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

import React, {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import AgentLogo from "./AgentLogo.jsx";

const EMPTY = Object.freeze({});
const editableEfforts = ["minimal", "low", "medium", "high", "xhigh", "max"];
const kindLabels = {
  chat: "Chat",
  tiny: "Tiny",
  image: "Image",
  tts: "Speech",
  stt: "Transcription",
  judge: "Judge",
  embedding: "Embedding",
  rerank: "Rerank",
  video: "Video",
};
const own = (obj, key) => Object.hasOwn(obj || {}, key);
function Field({ label, hint, children }) {
  return (
    <label className="omp-model-field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
function ModelInput({
  label,
  value,
  onChange,
  catalog,
  kinds,
  id,
  placeholder = "Inherit / automatic",
}) {
  return (
    <Field label={label}>
      <input
        aria-label={label}
        list={id}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
      />
      <datalist id={id}>
        {catalog
          .filter((m) => !kinds || kinds.includes(m.kind || "chat"))
          .map((m) => (
            <option
              key={m.selector || `${m.provider}/${m.id}`}
              value={m.selector || `${m.provider}/${m.id}`}
            >
              {m.name} · {m.provider}
            </option>
          ))}
      </datalist>
    </Field>
  );
}
function Dropdown({
  label,
  value,
  options,
  onChange,
  blank = "Inherit",
  disabled = false,
}) {
  return (
    <Field label={label}>
      <select
        aria-label={label}
        disabled={disabled}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
      >
        {blank !== null && <option value="">{blank}</option>}
        {options.map((o) => (
          <option key={o.id ?? o} value={o.id ?? o}>
            {o.label ?? o}
          </option>
        ))}
      </select>
    </Field>
  );
}
function NumberField({ label, value, onChange, step = "1" }) {
  return (
    <Field label={label}>
      <input
        aria-label={label}
        type="number"
        min="0"
        step={step}
        value={value ?? ""}
        placeholder="Inherit"
        onChange={(e) =>
          onChange(e.target.value === "" ? null : Number(e.target.value))
        }
      />
    </Field>
  );
}

/** A dedicated configuration workspace. All forms stage changes until Save. */
export default function OmpModelsPage({ api, store, onConversation }) {
  const workspace = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const initial = workspace.sessions.find((s) => s.id === workspace.selectedId);
  const [machineId, setMachine] = useState(initial?.machineId || "local"),
    [cwd, setCwd] = useState(initial?.cwd || "");
  const [data, setData] = useState(null),
    [tab, setTab] = useState("roles"),
    [scope, setScope] = useState("global");
  const [cycleText, setCycleText] = useState(null);
  const [rolePatch, setRolePatch] = useState({}),
    [customRole, setCustomRole] = useState(""),
    [presetName, setPresetName] = useState(""),
    [preset, setPreset] = useState("");
  const [providerId, setProviderId] = useState(""),
    [providerDraft, setProviderDraft] = useState({}),
    [creating, setCreating] = useState(false);
  const [modelEditor, setModelEditor] = useState(null),
    [confirmRemove, setConfirmRemove] = useState(null);
  const [catalogQuery, setCatalogQuery] = useState(""),
    [catalogKind, setCatalogKind] = useState(""),
    [catalogProvider, setCatalogProvider] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [status, setStatus] = useState("");
  const generation = useRef(0),
    alive = useRef(true),
    locked = useRef(false);
  const rolesDirty = Object.keys(rolePatch).length > 0;
  const providerDirty = Object.keys(providerDraft).length > 0 || creating;
  const dirty = rolesDirty || providerDirty || !!modelEditor?.dirty;
  const configuredProvider = data?.providers.find((p) => p.id === providerId);
  const provider =
    configuredProvider ||
    (modelEditor?.kind === "override" && providerId
      ? { id: providerId, models: [], overrides: [] }
      : null);
  const current = data?.[scope] || EMPTY;
  const catalog = data?.catalog || [];
  const spec = data?.spec;
  const contextChanged =
    data && (data.machineId !== machineId || data.cwd !== cwd);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      generation.current++;
    };
  }, []);
  async function load() {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    const token = ++generation.current;
    try {
      const result = await api("ompConfigRead", { machineId, cwd });
      if (alive.current && token === generation.current) {
        setData(result);
        setCwd(result.cwd);
        setRolePatch({});
        setCycleText(null);
        setProviderDraft({});
        setCreating(false);
        setModelEditor(null);
        setStatus("Configuration loaded");
      }
    } catch (cause) {
      if (alive.current && token === generation.current)
        setError(cause.message || "Could not load OMP configuration");
    } finally {
      locked.current = false;
      if (alive.current && token === generation.current) setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  function discard() {
    setRolePatch({});
    setCycleText(null);
    setProviderDraft({});
    setCreating(false);
    setModelEditor(null);
    setConfirmRemove(null);
    setStatus("Unsaved edits discarded");
  }
  async function save(body, file) {
    if (locked.current || !data || contextChanged) return;
    locked.current = true;
    setBusy(true);
    setError("");
    setStatus("Saving…");
    try {
      const result = await api("ompConfigSave", {
        machineId: data.machineId,
        cwd: data.cwd,
        revision: data.files[file].revision,
        ...body,
      });
      if (!alive.current) return;
      store.configurationChanged?.();
      // Clear write-only secrets before issuing any follow-up request.
      setProviderDraft({});
      setRolePatch({});
      setCycleText(null);
      setCreating(false);
      setModelEditor(null);
      setConfirmRemove(null);
      setStatus(
        `Saved to ${result.path}${result.backupPath ? " · previous file backed up" : ""}`,
      );
      try {
        const refreshed = await api("ompConfigRead", {
          machineId: data.machineId,
          cwd: data.cwd,
        });
        if (alive.current) setData(refreshed);
      } catch {
        if (alive.current) {
          setError(
            "Saved successfully, but the catalog could not be reloaded. Reload before another save.",
          );
          setData(null);
        }
      }
    } catch (cause) {
      if (alive.current) {
        setError(cause.message || "Could not save configuration");
        setStatus("Not saved");
      }
    } finally {
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  }
  const changeRole = (id, value) =>
    setRolePatch((old) => ({
      ...old,
      modelRoles: { ...old.modelRoles, [id]: value || null },
    }));
  const roleValue = (id) =>
    own(rolePatch.modelRoles, id)
      ? rolePatch.modelRoles[id] || ""
      : current.modelRoles?.[id] || "";
  const roles = spec
    ? [
        ...spec.roles,
        ...[
          ...new Set([
            ...Object.keys(data.effective.modelRoles || {}),
            ...Object.keys(current.modelRoles || {}),
            ...Object.keys(rolePatch.modelRoles || {}),
          ]),
        ]
          .filter((id) => !spec.roles.some((r) => r.id === id))
          .map((id) => ({
            id,
            name: data.effective.modelTags?.[id]?.name || id,
            description: "Custom role",
          })),
      ]
    : [];
  function stagePreset() {
    const assignments = { ...data.effective.modelRoles };
    for (const [id, value] of Object.entries(rolePatch.modelRoles || {})) {
      if (value) assignments[id] = value;
      else if (scope === "project" && data.global.modelRoles?.[id])
        assignments[id] = data.global.modelRoles[id];
      else delete assignments[id];
    }
    const thought = own(rolePatch, "defaultThinkingLevel")
      ? rolePatch.defaultThinkingLevel
      : (current.defaultThinkingLevel ?? data.effective.defaultThinkingLevel);
    setRolePatch((old) => ({
      ...old,
      modelPresets: {
        ...old.modelPresets,
        [presetName.trim()]: {
          modelRoles: assignments,
          ...(thought ? { defaultThinkingLevel: thought } : {}),
        },
      },
    }));
    setStatus("Preset staged. Save role configuration to keep it.");
    setPresetName("");
  }
  function applyPreset() {
    const p =
      current.modelPresets?.[preset] || data.effective.modelPresets?.[preset];
    if (!p) return;
    const values = Object.fromEntries(
      Object.keys(current.modelRoles || {}).map((id) => [id, null]),
    );
    Object.assign(values, p.modelRoles);
    setRolePatch((old) => ({
      ...old,
      modelRoles: values,
      ...(p.defaultThinkingLevel
        ? { defaultThinkingLevel: p.defaultThinkingLevel }
        : {}),
    }));
    setStatus("Preset applied to draft. Review the roles, then Save.");
  }
  const providerValue = (key) =>
    own(providerDraft, key) ? providerDraft[key] : provider?.[key];
  const updateProvider = (key, value) =>
    setProviderDraft((old) => ({ ...old, [key]: value === "" ? null : value }));
  const credential = providerDraft.credential || { mode: "keep", value: "" };
  function editModel(model, kind = "model") {
    const original = { ...(model || {}) };
    const catalogEfforts = Array.isArray(original.thinking)
      ? original.thinking.filter((level) => editableEfforts.includes(level))
      : null;
    if (Array.isArray(original.thinking)) delete original.thinking;
    setModelEditor({
      kind,
      id: model?.id || "",
      original,
      catalogEfforts,
      patch: {},
      dirty: !model,
    });
  }
  function changeModel(key, value) {
    setModelEditor((old) => ({
      ...old,
      dirty: true,
      patch: { ...old.patch, [key]: value === "" ? null : value },
    }));
  }
  const mv = (key) =>
    own(modelEditor?.patch, key)
      ? modelEditor.patch[key]
      : modelEditor?.original[key];
  const filtered = catalog.filter(
    (m) =>
      (!catalogProvider || m.provider === catalogProvider) &&
      (!catalogKind || (m.kind || "chat") === catalogKind) &&
      `${m.provider}/${m.id} ${m.name}`
        .toLowerCase()
        .includes(catalogQuery.toLowerCase()),
  );
  const shown = filtered.slice(0, 80);
  return (
    <main className="omp-models-page">
      <header className="omp-models-heading">
        <div>
          <div className="omp-models-title">
            <AgentLogo provider="omp" size={24} />
            <h1>OMP model configuration</h1>
          </div>
          <p>Role assignments, provider connections and custom models</p>
        </div>
        {onConversation && initial && (
          <button onClick={onConversation}>Back to conversation</button>
        )}
      </header>
      <div className="omp-models-context">
        <Dropdown
          label="Machine"
          disabled={dirty || busy}
          value={machineId}
          blank={null}
          options={(workspace.machines || [{ id: "local", name: "Local" }]).map(
            (m) => ({ id: m.id, label: m.name || m.id }),
          )}
          onChange={(value) => {
            if (!dirty && !busy) setMachine(value);
          }}
        />
        <Field
          label="Workspace directory"
          hint="Project overrides apply to this directory."
        >
          <input
            aria-label="Workspace directory"
            value={cwd}
            disabled={dirty || busy}
            placeholder="Home directory"
            onChange={(e) => setCwd(e.target.value)}
          />
        </Field>
        <button disabled={busy || dirty} onClick={load}>
          {busy ? "Working…" : "Load / refresh"}
        </button>
      </div>
      {dirty && (
        <div className="omp-models-banner" role="status">
          Unsaved changes{" "}
          <button disabled={busy} onClick={discard}>
            Discard edits
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="omp-models-error">
          {error}
        </p>
      )}
      {status && (
        <p role="status" className="omp-models-status">
          {status}
        </p>
      )}
      {contextChanged && (
        <p className="omp-models-banner">
          Load this machine and directory before editing.
        </p>
      )}
      {data && !contextChanged && (
        <>
          {data.effectiveError && (
            <p className="omp-models-banner">
              OMP could not resolve effective settings. Reload after correcting
              the configuration.
            </p>
          )}
          {data.catalogError && (
            <p className="omp-models-banner">
              The model catalog is unavailable. Existing configuration can still
              be edited; reload after correcting it.
            </p>
          )}
          <div
            className="omp-models-tabs"
            role="tablist"
            aria-label="OMP configuration sections"
          >
            {[
              ["roles", "Model roles"],
              ["providers", "Providers & custom models"],
              ["catalog", "Model catalog"],
            ].map(([id, label]) => (
              <button
                key={id}
                role="tab"
                disabled={busy || (dirty && tab !== id)}
                aria-selected={tab === id}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </div>
          <fieldset className="omp-provider-fields" disabled={busy}>
            {(() => {
              const file = data.files[tab === "roles" ? scope : "providers"];
              return file.resolvedPath && file.resolvedPath !== file.path ? (
                <p className="omp-models-banner">
                  Resolved configuration target: {file.resolvedPath}. Saving
                  changes the shared target file.
                </p>
              ) : null;
            })()}
            <div
              role="tabpanel"
              aria-label={
                tab === "roles"
                  ? "Model roles"
                  : tab === "providers"
                    ? "Providers & custom models"
                    : "Model catalog"
              }
            >
              {tab === "roles" && (
                <>
                  <div className="omp-models-toolbar">
                    <Dropdown
                      label="Edit scope"
                      disabled={rolesDirty || busy}
                      value={scope}
                      blank={null}
                      options={[
                        { id: "global", label: "OMP global defaults" },
                        { id: "project", label: "This project overrides" },
                      ]}
                      onChange={(value) => {
                        if (!rolesDirty && !busy) {
                          setScope(value);
                          setPreset("");
                          setCycleText(null);
                        }
                      }}
                    />
                    <button
                      className="is-primary"
                      disabled={busy || !rolesDirty}
                      onClick={() =>
                        save({ kind: "roles", scope, patch: rolePatch }, scope)
                      }
                    >
                      Save role configuration
                    </button>
                  </div>
                  <p className="omp-models-caption">
                    {scope === "global"
                      ? "Shared by sessions using this OMP profile. Project and session overrides may take precedence."
                      : "Written to this workspace’s .omp/config.yml. Empty roles inherit global defaults."}{" "}
                    Changes here are shared with OMP itself.
                  </p>
                  <div className="omp-models-form-grid">
                    <Dropdown
                      label="Default thinking level"
                      value={
                        own(rolePatch, "defaultThinkingLevel")
                          ? rolePatch.defaultThinkingLevel
                          : current.defaultThinkingLevel
                      }
                      options={spec.efforts}
                      onChange={(v) =>
                        setRolePatch((old) => ({
                          ...old,
                          defaultThinkingLevel: v || null,
                        }))
                      }
                    />
                    <Field
                      label="Role cycle order"
                      hint="Comma-separated role IDs. Blank removes this layer’s override."
                    >
                      <input
                        aria-label="Role cycle order"
                        value={
                          cycleText ?? (current.cycleOrder?.join(", ") || "")
                        }
                        placeholder={(data.effective.cycleOrder || []).join(
                          ", ",
                        )}
                        onChange={(e) => {
                          setCycleText(e.target.value);
                          setRolePatch((old) => ({
                            ...old,
                            cycleOrder: e.target.value.trim()
                              ? e.target.value
                                  .split(",")
                                  .map((v) => v.trim())
                                  .filter(Boolean)
                              : null,
                          }));
                        }}
                      />
                    </Field>
                  </div>
                  <div className="omp-models-roles">
                    {roles.map((role) => (
                      <div className="omp-models-role" key={role.id}>
                        <div className="omp-models-role-title">
                          <strong>{role.name}</strong>
                          <code>@{role.id}</code>
                        </div>
                        <p>{role.description}</p>
                        <ModelInput
                          label={`Model for ${role.id}`}
                          id={`omp-role-${role.id}`}
                          value={roleValue(role.id)}
                          onChange={(value) => changeRole(role.id, value)}
                          catalog={catalog}
                          kinds={role.kinds}
                        />
                        <small>
                          Effective:{" "}
                          <span>
                            {data.effective.modelRoles?.[role.id] ||
                              "OMP automatic selection"}
                          </span>
                        </small>
                        {scope === "global" &&
                          data.project.modelRoles?.[role.id] && (
                            <small className="omp-models-warning">
                              Overridden in this project
                            </small>
                          )}
                      </div>
                    ))}
                  </div>
                  <div className="omp-models-toolbar">
                    <input
                      aria-label="Custom role name"
                      value={customRole}
                      onChange={(e) => setCustomRole(e.target.value)}
                      placeholder="New custom role ID"
                    />
                    <button
                      disabled={
                        !customRole.trim() ||
                        roles.some((r) => r.id === customRole.trim()) ||
                        busy
                      }
                      onClick={() => {
                        changeRole(customRole.trim(), "");
                        setCustomRole("");
                      }}
                    >
                      Add custom role
                    </button>
                  </div>
                  <section className="omp-models-card">
                    <h2>Role presets</h2>
                    <p>
                      Apply a saved setup to the draft, or capture the current
                      assignments.
                    </p>
                    <div className="omp-models-toolbar">
                      <Dropdown
                        label="Saved preset"
                        value={preset}
                        blank="Choose preset"
                        options={Object.keys(data.effective.modelPresets || {})}
                        onChange={setPreset}
                      />
                      <button disabled={!preset || busy} onClick={applyPreset}>
                        Apply to draft
                      </button>
                      <button
                        disabled={
                          !preset || !own(current.modelPresets, preset) || busy
                        }
                        onClick={() =>
                          setRolePatch((old) => ({
                            ...old,
                            modelPresets: {
                              ...old.modelPresets,
                              [preset]: null,
                            },
                          }))
                        }
                      >
                        Remove from this scope
                      </button>
                    </div>
                    <div className="omp-models-toolbar">
                      <input
                        aria-label="New preset name"
                        value={presetName}
                        onChange={(e) => setPresetName(e.target.value)}
                        placeholder="Preset name"
                      />
                      <button
                        disabled={!presetName.trim() || busy}
                        onClick={stagePreset}
                      >
                        Stage new preset
                      </button>
                    </div>
                  </section>
                  {initial?.provider === "omp" && (
                    <p className="omp-models-caption">
                      Current conversation: {initial.name}. Its model and
                      thinking overrides are managed in the conversation
                      composer; they do not change these shared files.
                    </p>
                  )}
                </>
              )}
              {tab === "providers" && (
                <div className="omp-provider-layout">
                  <aside className="omp-provider-list">
                    <h2>Configured providers</h2>
                    <p>Active OMP profile</p>
                    {data.providers.map((p) => (
                      <button
                        key={p.id}
                        className={providerId === p.id ? "is-selected" : ""}
                        disabled={providerDirty || modelEditor?.dirty || busy}
                        onClick={() => {
                          setProviderId(p.id);
                          setModelEditor(null);
                        }}
                      >
                        {p.id}
                        <small>
                          {p.models.length} custom · {p.overrides.length}{" "}
                          overrides
                        </small>
                      </button>
                    ))}
                    <button
                      disabled={dirty || busy}
                      onClick={() => {
                        setCreating(true);
                        setProviderId("");
                        setModelEditor(null);
                        setProviderDraft({
                          api: "openai-completions",
                          auth: "apiKey",
                        });
                      }}
                    >
                      Add provider
                    </button>
                    <p className="omp-models-caption">
                      Bundled providers appear in the catalog. Add their
                      provider ID here to configure an override. Existing
                      advanced fields are preserved.
                    </p>
                  </aside>
                  <div className="omp-provider-editor">
                    {provider || creating ? (
                      <>
                        <h2>{creating ? "New provider" : provider.id}</h2>
                        <fieldset
                          className="omp-provider-fields"
                          disabled={busy || !!modelEditor}
                        >
                          <div className="omp-models-form-grid">
                            <Field label="Provider ID">
                              <input
                                aria-label="Provider ID"
                                disabled={!creating || busy}
                                value={providerId}
                                onChange={(e) => setProviderId(e.target.value)}
                                placeholder="my-provider"
                              />
                            </Field>
                            <Field
                              label="Base URL"
                              hint="HTTP(S) endpoint; put authentication in the credential field."
                            >
                              <input
                                aria-label="Base URL"
                                value={providerValue("baseUrl") || ""}
                                onChange={(e) =>
                                  updateProvider("baseUrl", e.target.value)
                                }
                                placeholder={
                                  provider?.privateEndpoint
                                    ? "Private endpoint configured · unchanged until edited"
                                    : "https://api.example.com/v1"
                                }
                              />
                            </Field>
                            <Dropdown
                              label="Provider API"
                              value={providerValue("api")}
                              options={spec.providerApis}
                              onChange={(v) => updateProvider("api", v)}
                            />
                            <Dropdown
                              label="Authentication"
                              value={providerValue("auth") || "apiKey"}
                              blank={null}
                              options={[
                                { id: "apiKey", label: "API key" },
                                {
                                  id: "oauth",
                                  label: "Existing OMP OAuth account",
                                },
                                {
                                  id: "none",
                                  label:
                                    "No authentication (local / trusted service)",
                                },
                              ]}
                              onChange={(v) => updateProvider("auth", v)}
                            />
                            <Dropdown
                              label="Credential action"
                              value={credential.mode}
                              blank={null}
                              options={[
                                {
                                  id: "keep",
                                  label: provider?.credential?.configured
                                    ? `Keep configured ${provider.credential.kind} credential`
                                    : "Keep unchanged",
                                },
                                { id: "env", label: "Environment variable" },
                                { id: "key", label: "Set a new API key" },
                                {
                                  id: "remove",
                                  label: "Remove configured key",
                                },
                              ]}
                              onChange={(mode) =>
                                setProviderDraft((old) => ({
                                  ...old,
                                  credential: {
                                    mode,
                                    value:
                                      mode === "env"
                                        ? provider?.credential?.reference || ""
                                        : "",
                                  },
                                }))
                              }
                            />
                            {["env", "key"].includes(credential.mode) && (
                              <Field
                                label={
                                  credential.mode === "env"
                                    ? "Environment variable name"
                                    : "New API key"
                                }
                                hint={
                                  credential.mode === "env"
                                    ? "Must be set in the environment where OMP runs."
                                    : "Write-only. Existing keys are never sent to this page."
                                }
                              >
                                <input
                                  aria-label={
                                    credential.mode === "env"
                                      ? "Environment variable name"
                                      : "New API key"
                                  }
                                  type={
                                    credential.mode === "key"
                                      ? "password"
                                      : "text"
                                  }
                                  autoComplete="new-password"
                                  value={credential.value}
                                  onChange={(e) =>
                                    setProviderDraft((old) => ({
                                      ...old,
                                      credential: {
                                        ...credential,
                                        value: e.target.value,
                                      },
                                    }))
                                  }
                                />
                              </Field>
                            )}
                            <Dropdown
                              label="Model discovery"
                              value={providerValue("discovery")?.type}
                              options={spec.discoveryTypes}
                              blank="No discovery override"
                              onChange={(type) =>
                                updateProvider(
                                  "discovery",
                                  type ? { type } : null,
                                )
                              }
                            />
                          </div>
                        </fieldset>
                        <p className="omp-models-caption">
                          OAuth sign-in remains in the OMP CLI. Saving
                          configuration does not send a model prompt. Catalog
                          refresh may query configured discovery endpoints.
                        </p>
                        <div className="omp-models-toolbar">
                          <button
                            className="is-primary"
                            disabled={
                              busy ||
                              !providerDirty ||
                              !providerId.trim() ||
                              rolesDirty ||
                              modelEditor?.dirty
                            }
                            onClick={() =>
                              save(
                                {
                                  kind: "provider",
                                  provider: providerId,
                                  patch: providerDraft,
                                },
                                "providers",
                              )
                            }
                          >
                            Save provider
                          </button>
                          {configuredProvider && (
                            <button
                              disabled={dirty || busy}
                              onClick={() =>
                                setConfirmRemove({
                                  kind: "provider",
                                  provider: providerId,
                                  label: providerId,
                                })
                              }
                            >
                              Remove provider configuration
                            </button>
                          )}
                        </div>
                        {provider && (
                          <>
                            <section className="omp-models-card">
                              <div className="omp-models-toolbar">
                                <h3>Custom models</h3>
                                <button
                                  disabled={dirty || busy}
                                  onClick={() => editModel(null)}
                                >
                                  Add custom model
                                </button>
                              </div>
                              {provider.models.map((m) => (
                                <div
                                  className="omp-models-model-row"
                                  key={m.id}
                                >
                                  <span>
                                    <strong>{m.name || m.id}</strong>
                                    <small>
                                      {m.id} · {m.kind || "chat"}
                                    </small>
                                  </span>
                                  <button
                                    disabled={dirty || busy}
                                    onClick={() => editModel(m)}
                                  >
                                    Edit
                                  </button>
                                  <button
                                    disabled={dirty || busy}
                                    onClick={() =>
                                      setConfirmRemove({
                                        kind: "model",
                                        provider: providerId,
                                        model: m.id,
                                        label: m.id,
                                      })
                                    }
                                  >
                                    Remove
                                  </button>
                                </div>
                              ))}
                            </section>
                            <section className="omp-models-card">
                              <div className="omp-models-toolbar">
                                <h3>Catalog overrides</h3>
                                <button
                                  disabled={dirty || busy}
                                  onClick={() => editModel(null, "override")}
                                >
                                  Add model override
                                </button>
                              </div>
                              {provider.overrides.map((m) => (
                                <div
                                  className="omp-models-model-row"
                                  key={m.id}
                                >
                                  <span>{m.id}</span>
                                  <button
                                    disabled={dirty || busy}
                                    onClick={() => editModel(m, "override")}
                                  >
                                    Edit override
                                  </button>
                                  <button
                                    disabled={dirty || busy}
                                    onClick={() =>
                                      setConfirmRemove({
                                        kind: "override",
                                        provider: providerId,
                                        model: m.id,
                                        label: m.id,
                                      })
                                    }
                                  >
                                    Remove
                                  </button>
                                </div>
                              ))}
                            </section>
                          </>
                        )}
                        {modelEditor && (
                          <section
                            className="omp-models-card omp-model-editor"
                            aria-label="Model definition"
                          >
                            <h3>
                              {modelEditor.kind === "override"
                                ? "Model override"
                                : "Custom model definition"}
                            </h3>
                            <div className="omp-models-form-grid">
                              <Field label="Model ID">
                                <input
                                  aria-label="Model ID"
                                  disabled={!!modelEditor.original.id}
                                  value={modelEditor.id}
                                  onChange={(e) =>
                                    setModelEditor((old) => ({
                                      ...old,
                                      id: e.target.value,
                                      dirty: true,
                                    }))
                                  }
                                />
                              </Field>
                              <Field label="Display name">
                                <input
                                  aria-label="Display name"
                                  value={mv("name") || ""}
                                  onChange={(e) =>
                                    changeModel("name", e.target.value)
                                  }
                                />
                              </Field>
                              <Dropdown
                                label="Model API"
                                value={mv("api")}
                                options={[
                                  ...new Set([
                                    ...spec.providerApis,
                                    ...Object.keys(spec.runnerApis),
                                  ]),
                                ]}
                                onChange={(v) => changeModel("api", v)}
                              />
                              <Dropdown
                                label="Model kind"
                                value={mv("kind")}
                                options={Object.entries(kindLabels).map(
                                  ([id, label]) => ({ id, label }),
                                )}
                                onChange={(v) => changeModel("kind", v)}
                              />
                              <Dropdown
                                label="Reasoning support"
                                value={
                                  mv("reasoning") == null
                                    ? ""
                                    : String(mv("reasoning"))
                                }
                                options={[
                                  { id: "true", label: "Supported" },
                                  { id: "false", label: "Not supported" },
                                ]}
                                onChange={(v) =>
                                  changeModel(
                                    "reasoning",
                                    v === "" ? null : v === "true",
                                  )
                                }
                              />
                              <Dropdown
                                label="Tool calling"
                                value={
                                  mv("supportsTools") == null
                                    ? ""
                                    : String(mv("supportsTools"))
                                }
                                options={[
                                  { id: "true", label: "Supported" },
                                  { id: "false", label: "Not supported" },
                                ]}
                                onChange={(v) =>
                                  changeModel(
                                    "supportsTools",
                                    v === "" ? null : v === "true",
                                  )
                                }
                              />
                              <NumberField
                                label="Context window"
                                value={mv("contextWindow")}
                                onChange={(v) =>
                                  changeModel("contextWindow", v)
                                }
                              />
                              <NumberField
                                label="Maximum output tokens"
                                value={mv("maxTokens")}
                                onChange={(v) => changeModel("maxTokens", v)}
                              />
                              <NumberField
                                label="Maximum context window"
                                value={mv("maxContextWindow")}
                                onChange={(v) =>
                                  changeModel("maxContextWindow", v)
                                }
                              />
                              <Dropdown
                                label="Input types"
                                value={mv("input")?.join(",") || ""}
                                options={[
                                  { id: "text", label: "Text" },
                                  {
                                    id: "text,image",
                                    label: "Text and images",
                                  },
                                  { id: "image", label: "Images" },
                                ]}
                                onChange={(v) =>
                                  changeModel("input", v ? v.split(",") : null)
                                }
                              />
                            </div>
                            <details>
                              <summary>Thinking controls and pricing</summary>
                              <div className="omp-models-form-grid">
                                <Dropdown
                                  label="Thinking control mode"
                                  value={mv("thinking")?.mode}
                                  options={spec.thinkingModes}
                                  onChange={(v) =>
                                    changeModel(
                                      "thinking",
                                      v
                                        ? {
                                            ...mv("thinking"),
                                            mode: v,
                                            efforts: mv("thinking")?.efforts ||
                                              modelEditor.catalogEfforts || [
                                                "low",
                                                "medium",
                                                "high",
                                              ],
                                          }
                                        : null,
                                    )
                                  }
                                />
                                {mv("thinking") && (
                                  <>
                                    <fieldset className="omp-thinking-controls">
                                      <legend>Supported thinking levels</legend>
                                      <div className="omp-thinking-levels">
                                        {editableEfforts.map((level) => (
                                          <label key={level}>
                                            <input
                                              type="checkbox"
                                              checked={(
                                                mv("thinking").efforts ||
                                                mv("thinking").levels ||
                                                []
                                              ).includes(level)}
                                              onChange={(e) => {
                                                const efforts =
                                                  editableEfforts.filter((l) =>
                                                    l === level
                                                      ? e.target.checked
                                                      : (
                                                          mv("thinking")
                                                            .efforts || []
                                                        ).includes(l),
                                                  );
                                                changeModel("thinking", {
                                                  ...mv("thinking"),
                                                  efforts,
                                                });
                                              }}
                                            />
                                            {level}
                                          </label>
                                        ))}
                                      </div>
                                    </fieldset>
                                    <Dropdown
                                      label="Model default thinking"
                                      value={mv("thinking")?.defaultLevel}
                                      options={mv("thinking")?.efforts || []}
                                      onChange={(v) => {
                                        const next = { ...mv("thinking") };
                                        if (v) next.defaultLevel = v;
                                        else delete next.defaultLevel;
                                        changeModel("thinking", next);
                                      }}
                                    />
                                  </>
                                )}
                                {[
                                  "input",
                                  "output",
                                  "cacheRead",
                                  "cacheWrite",
                                ].map((key) => (
                                  <NumberField
                                    key={key}
                                    label={`USD / 1M ${key} tokens`}
                                    value={mv("cost")?.[key]}
                                    step="any"
                                    onChange={(v) =>
                                      changeModel("cost", {
                                        input: 0,
                                        output: 0,
                                        cacheRead: 0,
                                        cacheWrite: 0,
                                        ...mv("cost"),
                                        [key]: v ?? 0,
                                      })
                                    }
                                  />
                                ))}
                                <button
                                  onClick={() => changeModel("cost", null)}
                                >
                                  Use inherited pricing
                                </button>
                              </div>
                            </details>
                            <div className="omp-models-toolbar">
                              <button
                                className="is-primary"
                                disabled={
                                  busy ||
                                  !modelEditor.dirty ||
                                  !modelEditor.id.trim() ||
                                  rolesDirty ||
                                  providerDirty
                                }
                                onClick={() =>
                                  save(
                                    {
                                      kind: modelEditor.kind,
                                      provider: providerId,
                                      model: modelEditor.id,
                                      patch: modelEditor.patch,
                                    },
                                    "providers",
                                  )
                                }
                              >
                                Save model definition
                              </button>
                              <button
                                disabled={busy}
                                onClick={() => setModelEditor(null)}
                              >
                                Cancel model edit
                              </button>
                            </div>
                          </section>
                        )}
                      </>
                    ) : (
                      <p className="omp-models-empty">
                        Choose a configured provider or add one. Credentials
                        stored by OMP remain in OMP.
                      </p>
                    )}
                  </div>
                </div>
              )}
              {tab === "catalog" && (
                <>
                  <div className="omp-models-toolbar">
                    <input
                      aria-label="Search model catalog"
                      placeholder="Search name, provider or model ID…"
                      value={catalogQuery}
                      onChange={(e) => setCatalogQuery(e.target.value)}
                    />
                    <Dropdown
                      label="Filter provider"
                      value={catalogProvider}
                      options={[...new Set(catalog.map((m) => m.provider))]}
                      blank="All providers"
                      onChange={setCatalogProvider}
                    />
                    <Dropdown
                      label="Filter model kind"
                      value={catalogKind}
                      options={[
                        ...new Set(catalog.map((m) => m.kind || "chat")),
                      ]}
                      blank="All kinds"
                      onChange={setCatalogKind}
                    />
                  </div>
                  <p className="omp-models-caption">
                    {filtered.length} models · showing up to 80 matches. Filter
                    to narrow the list. Extension discovery is disabled for this
                    catalog view.
                  </p>
                  <div className="omp-models-table">
                    <table>
                      <thead>
                        <tr>
                          <th>Model</th>
                          <th>Provider</th>
                          <th>Kind</th>
                          <th>Context / output</th>
                          <th>Thinking</th>
                          <th>Configuration</th>
                        </tr>
                      </thead>
                      <tbody>
                        {shown.map((m) => (
                          <tr key={m.selector || `${m.provider}/${m.id}`}>
                            <td>
                              <strong>{m.name || m.id}</strong>
                              <small>{m.selector || m.id}</small>
                            </td>
                            <td>{m.provider}</td>
                            <td>{m.kind || "chat"}</td>
                            <td>
                              {m.contextWindow?.toLocaleString() || "—"} /{" "}
                              {m.maxTokens?.toLocaleString() || "—"}
                            </td>
                            <td>
                              {(Array.isArray(m.thinking)
                                ? m.thinking.join(", ")
                                : m.thinking?.efforts?.join(", ")) ||
                                (m.reasoning ? "Supported" : "—")}
                            </td>
                            <td>
                              <button
                                disabled={dirty || busy}
                                onClick={() => {
                                  setProviderId(m.provider);
                                  setProviderDraft({});
                                  setCreating(false);
                                  editModel(m, "override");
                                  setTab("providers");
                                }}
                              >
                                Override model
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          </fieldset>
          <footer className="omp-models-caption">
            {tab === "roles"
              ? data.files[scope].path
              : data.files.providers.path}
          </footer>
        </>
      )}
      {confirmRemove && (
        <div
          className="omp-remove-confirm"
          role="alertdialog"
          aria-label="Remove OMP configuration"
        >
          <h2>Remove {confirmRemove.label}?</h2>
          <p>
            This removes its configuration entry. Existing role selectors may
            still refer to it. A backup is kept; OMP login accounts are
            unchanged.
          </p>
          <button
            disabled={busy}
            onClick={() =>
              save({ ...confirmRemove, remove: true }, "providers")
            }
          >
            Remove configuration
          </button>
          <button disabled={busy} onClick={() => setConfirmRemove(null)}>
            Cancel
          </button>
        </div>
      )}
    </main>
  );
}

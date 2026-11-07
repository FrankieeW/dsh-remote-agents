import { FloatingPanel } from "./floating-panel.jsx";
import { agentProfile } from "./agent-profiles.js";
import React, { useEffect, useRef, useState } from 'react';
import { EFFORTS, PERMISSIONS, DEFAULT_SETTINGS } from '../chat/settings.js';
import { IconChevronDownOutlineRegular, IconShieldOutlineRegular, IconSlidersTwoOutlineRegular, Tooltip } from './native.js';

/** Session overrides; the CLI remains authoritative about effective settings and model access. */
export function ChatSettings({ session, api, disabled, onConfigure, saveStatus }) {
  const profile = agentProfile(session.provider);
  const [open, setOpen] = useState(null);
  const [catalog, setCatalog] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const container = useRef(null);
  const generation = useRef(0);
  const settings = session.settings || DEFAULT_SETTINGS;
  const defaults = catalog?.defaults || {};
  const effective = session.effectiveSettings || {};
  const permissions = catalog?.permissions || PERMISSIONS[session.provider] || [];
  const chosenModel = settings.model || effective.model || defaults.model;
  const model = catalog?.models.find(m => m.id === chosenModel);
  const efforts = model?.efforts || catalog?.efforts || EFFORTS[session.provider] || [];
  const permission = permissions.find(p => p.id === settings.permissions);
  async function load(refresh = false) {
    const current = ++generation.current; setLoading(true); setError('');
    try { const value = await api('chatOptions', { id: session.id, refresh }); if (current === generation.current) setCatalog(value); }
    catch (cause) { if (current === generation.current) setError(cause.message || 'Could not read CLI configuration'); }
    finally { if (current === generation.current) setLoading(false); }
  }
  useEffect(() => () => { generation.current++; }, []);
  useEffect(() => { if (['running', 'waiting', 'closed'].includes(session.status)) setOpen(null); }, [session.status]);
  useEffect(() => {
    if (!open) return;
    const outside = event => { if (!container.current?.contains(event.target)) setOpen(null); };
    const doc = container.current?.ownerDocument;
    doc?.addEventListener('pointerdown', outside);
    return () => doc?.removeEventListener('pointerdown', outside);
  }, [open]);
  function toggle(value) { setOpen(open === value ? null : value); setSearch(''); if (!catalog && !loading) void load(); }
  useEffect(() => {
    const doc = container.current?.ownerDocument;
    const shortcut = event => {
      if (disabled || !(event.metaKey || event.ctrlKey) || !event.shiftKey || !doc.activeElement?.closest('.agent-chat, .agent-floating-panel')) return;
      const target = { m: 'model', e: 'effort', a: 'permissions' }[event.key.toLowerCase()];
      if (target) { event.preventDefault(); toggle(target); }
    };
    doc?.addEventListener('keydown', shortcut);
    return () => doc?.removeEventListener('keydown', shortcut);
  }, [disabled, open, catalog, loading]);
  function navigate(event) {
    if (event.key === 'Escape') { setOpen(null); container.current?.querySelector('[aria-expanded="true"]')?.focus(); return; }
    if (['ArrowLeft', 'ArrowRight'].includes(event.key) && (event.target.tagName !== 'INPUT' || !search)) {
      event.preventDefault(); const tabs = ['model', 'effort', 'permissions'];
      setOpen(tabs[(tabs.indexOf(open) + (event.key === 'ArrowRight' ? 1 : 2)) % 3]); return;
    }
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    const buttons = [...event.currentTarget.querySelectorAll('.agent-chat-settings-options button:not(:disabled)')];
    if (!buttons.length) return;
    event.preventDefault(); const index = buttons.indexOf(event.target);
    const next = buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1) + buttons.length) % buttons.length];
    next.focus(); next.scrollIntoView?.({ block: 'nearest' });
  }
  async function choose(patch) {
    setError('');
    try { await onConfigure(patch); setOpen(null); }
    catch (cause) { setError(cause.message || 'Could not update this session'); }
  }
  const modelLabel = settings.model ? model?.label || settings.model : chosenModel ? `${model?.label || chosenModel} · CLI` : 'CLI model';
  const effortLabel = settings.effort || effective.effort || defaults.effort || 'Thinking';
  const inheritedPermissions = [effective.permissions || defaults.permissions, effective.sandbox || defaults.sandbox].filter(Boolean).join(' · ');
  const inheritedMode = effective.permissions || defaults.permissions;
  const sandbox = effective.sandbox || defaults.sandbox;
  const inheritedLabel = session.provider === 'codex'
    ? ['dangerFullAccess', 'danger-full-access'].includes(sandbox) && inheritedMode === 'never' ? 'Full access · YOLO'
      : ['readOnly', 'read-only'].includes(sandbox) ? 'Read only'
        : ['workspaceWrite', 'workspace-write'].includes(sandbox) ? 'Workspace write' : inheritedMode
    : permissions.find(option => option.id === inheritedMode)?.label || inheritedMode;
  const permissionLabel = settings.permissions === 'cli' ? inheritedLabel ? `${inheritedLabel} · CLI` : 'CLI permissions' : permission?.label;
  const options = open === 'effort' ? [{ id: null, label: 'Follow CLI' }, ...efforts.map(id => ({ id, label: id }))] : permissions;
  return <div className="agent-chat-settings" ref={container} onKeyDown={event => { if (event.key === 'Escape') { setOpen(null); event.stopPropagation(); } }}>
    <Tooltip label={permission?.description || 'Permissions'} side="top" portal>
      <button type="button" className={`agent-chat-setting${['yolo', 'bypassPermissions'].includes(settings.permissions) ? ' is-yolo' : ''}`}
        aria-label="Permission mode" aria-haspopup="dialog" aria-expanded={open === 'permissions'} disabled={disabled} onClick={() => toggle('permissions')}>
        <IconShieldOutlineRegular size={14} /><span>{permissionLabel}</span><IconChevronDownOutlineRegular size={10} />
      </button>
    </Tooltip>
    <button type="button" className="agent-chat-setting" aria-label="Model" aria-haspopup="dialog" aria-expanded={open === 'model'} disabled={disabled} onClick={() => toggle('model')}>
      <span>{modelLabel}</span><IconChevronDownOutlineRegular size={10} />
    </button>
    <button type="button" className="agent-chat-setting" data-effort={effortLabel.toLowerCase()} aria-label="Reasoning effort" aria-haspopup="dialog" aria-expanded={open === 'effort'} disabled={disabled} onClick={() => toggle('effort')}>
      <IconSlidersTwoOutlineRegular size={14} /><span>{effortLabel}</span><IconChevronDownOutlineRegular size={10} />
    </button>
    {saveStatus && <span className="agent-settings-save" role="status">{saveStatus}</span>}
    {open && <FloatingPanel anchor={container} width={360} placement="top"><section className="agent-chat-settings-panel" onKeyDown={navigate} role="dialog" aria-label={open === 'model' ? 'Choose model' : open === 'effort' ? 'Choose reasoning effort' : 'Choose permissions'}>
      <header><strong>{open === 'model' ? `${profile.name} model` : open === 'effort' ? profile.effortLabel || 'Reasoning effort' : profile.permissionLabel || 'Permissions'}</strong>
        <button type="button" disabled={loading} onClick={() => load(true)}>Refresh CLI</button></header>
      <p className="agent-chat-caption">This session only · Follow CLI uses its configuration</p>
      {saveStatus && <p className="agent-chat-caption" role="status">{saveStatus}</p>}
      {Object.keys(effective).length > 0 && <p className="agent-chat-caption">Last turn used: {[effective.model, effective.effort, effective.permissions, effective.sandbox].filter(Boolean).join(" · ")}</p>}
      {open === "permissions" && inheritedPermissions && <p className="agent-chat-caption">CLI: {inheritedPermissions}</p>}
      {loading && <p role="status" className="agent-chat-caption">Reading CLI configuration…</p>}
      {error && <p role="alert" className="agent-chat-settings-error">{error}</p>}
      {open === 'model' && <input autoFocus type="search" aria-label="Search models or enter model ID" placeholder="Search models or enter an ID…" value={search} maxLength={256} onChange={event => setSearch(event.target.value)} />}
      <div className="agent-chat-settings-options">
        {open === 'model' ? <>
          <button type="button" aria-pressed={settings.model === null} onClick={() => choose({ model: null, effort: null })}><span>Follow CLI</span><small>{defaults.model || 'Use the CLI’s default model'}</small></button>
          {(catalog?.models || []).filter(m => [m.id, m.label, m.provider].some(v => typeof v === 'string' && v.toLowerCase().includes(search.toLowerCase()))).map(m =>
            <button type="button" key={m.id} aria-pressed={settings.model === m.id} onClick={() => choose({ model: m.id, effort: null })}><span>{m.label}</span><small>{session.provider === 'omp' && m.provider ? `${m.provider} · ${m.id}` : m.id}</small></button>)}
          {search.trim() && !catalog?.models.some(m => m.id === search.trim()) && <button type="button" onClick={() => choose({ model: search.trim(), effort: null })}><span>Use “{search.trim()}”</span><small>Custom model ID or CLI alias</small></button>}
        </> : options.map(option => <button type="button" key={option.id || 'cli'} disabled={option.disabled} title={option.reason}
          aria-pressed={(open === 'effort' ? settings.effort : settings.permissions) === option.id}
          onClick={() => choose(open === 'effort' ? { effort: option.id } : { permissions: option.id })}>
          <span>{option.label}</span>{option.description && <small>{option.description}</small>}{option.reason && <small>{option.reason}</small>}
        </button>)}
      </div>
    </section></FloatingPanel>}
  </div>;
}

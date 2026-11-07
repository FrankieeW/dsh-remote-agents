import { FloatingPanel } from "./floating-panel.jsx";
import React, { useEffect, useId, useRef, useState } from "react";
import { activeMachines, canSaveUntested, machineAddress } from "./machines.js";
import { SshHostOptions, useSshHosts } from "./ssh-hosts.jsx";
import {
  Button, IconArchiveCheckOutlineRegular, IconArchiveOffOutlineRegular, IconCloseFillRegular, IconFolderCloseRegular,
  IconProjectAddOutlineRegular, IconQueueOutlineRegular, IconSearchOutlineRegular, IconSlidersTwoOutlineRegular,
  IconWorkspaceTreeOutlineRegular, Menu, Tooltip,
} from "./native.js";

export const LAYOUTS = Object.freeze(["workspace-tree", "workspace"]);
export const FILTERS = Object.freeze(["active", "all", "archived"]);

function ViewOptions({ layout, filter, onLayout, onFilter }) {
  const [open, setOpen] = useState(false);
  const items = [
    { type: "label", id: "group-by", text: "Group by" },
    { id: "workspace-tree", label: "Workspace Tree", icon: <IconWorkspaceTreeOutlineRegular /> },
    { id: "workspace", label: "Workspaces", icon: <IconFolderCloseRegular /> },
    { type: "separator", id: "filter-separator" },
    { type: "label", id: "filter-by", text: "Filter sessions" },
    { id: "filter:active", label: "Hide archived", icon: <IconArchiveOffOutlineRegular /> },
    { id: "filter:all", label: "All sessions (show archived)", icon: <IconQueueOutlineRegular /> },
    { id: "filter:archived", label: "Archived only", icon: <IconArchiveCheckOutlineRegular /> },
  ];
  return <Menu open={open} onClose={() => setOpen(false)} items={items} selectedIds={[layout, `filter:${filter}`]}
    align="end" dense portal listClassName="agent-workspace-view-menu"
    onSelect={(id) => { setOpen(false); if (id.startsWith("filter:")) onFilter(id.slice("filter:".length)); else onLayout(id); }}
    anchor={<Tooltip label="View options" side="bottom" delayMs={500} portal>
      <button type="button" className="agent-workspace-icon" aria-label="View options" aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen((value) => !value)}><IconSlidersTwoOutlineRegular /></button>
    </Tooltip>} />;
}

const machineLabel = (machine) => [machine.name, machine.type === "ssh" && machineAddress(machine),
  machine.lastCheck?.ok === false && "last test failed"].filter(Boolean).join(" · ");

/** Adopts an absolute host directory; the browser cannot browse the Host filesystem itself. */
function AddWorkspace({ adding, onAdd, machines = [{ id: "local", name: "Local", type: "local" }], browseDirectories, addSSHHost, sshConfigHosts, onManageMachines }) {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState("");
  const [machineId, setMachineId] = useState("local");
  const [host, setHost] = useState("");
  const [untested, setUntested] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [invalid, setInvalid] = useState("");
  const [listing, setListing] = useState(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(-1);
  const inputId = useId();
  const container = useRef(null);
  const suggestions = useSshHosts(sshConfigHosts, open && machineId === "new-ssh");
  const close = () => { setOpen(false); setInvalid(""); };
  useEffect(() => {
    if (!open) return;
    const outside = event => { if (!container.current?.contains(event.target)) close(); };
    const doc = container.current?.ownerDocument;
    doc?.addEventListener('pointerdown', outside);
    return () => doc?.removeEventListener('pointerdown', outside);
  }, [open]);
  useEffect(() => {
    setListing(null); setSelected(-1);
    if (!open || !browseDirectories || machineId === "new-ssh" || !/^(\/|~(?:\/|$))/.test(path)) { setLoading(false); return; }
    let cancelled = false; setLoading(true); setInvalid("");
    const timer = setTimeout(() => {
      browseDirectories(machineId, path).then(value => { if (!cancelled) setListing(value); }, cause => { if (!cancelled) setInvalid(cause.message || "Directory lookup failed"); }).finally(() => { if (!cancelled) setLoading(false); });
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [path, machineId, open, browseDirectories]);
  async function submit(event) {
    event.preventDefault();
    let directory = path.trim();
    if (!/^(\/|~(?:\/|$))/.test(directory)) { setInvalid("Enter an absolute project directory or ~/path."); return; }
    setInvalid("");
    try {
      if (machineId === 'local' && directory.startsWith('~')) {
        if (!browseDirectories) throw new Error('Enter an absolute project directory.');
        directory = (await browseDirectories(machineId, directory.endsWith('/') ? directory : `${directory}/`)).base;
      }
      if (await onAdd(directory, machineId)) { setPath(""); close(); }
    } catch (cause) { setInvalid(cause.message || 'Could not add workspace'); }
  }
  /** Tests SSH before saving; a failed test can be overridden explicitly. */
  async function connect(verify) {
    const target = host.trim();
    setConnecting(true); setInvalid(""); setUntested("");
    try { const machine = await addSSHHost(target, { verify }); setHost(""); setMachineId(machine.id); setPath('~/'); }
    catch (cause) { setInvalid(cause.message || 'Could not add SSH host'); if (verify && canSaveUntested(cause.code)) setUntested(target); }
    finally { setConnecting(false); }
  }
  function complete(index) { const entry = listing?.entries[index]; if (entry) { setPath(entry.path); setSelected(-1); } }
  return <div className="agent-workspace-add" ref={container}>
    <Tooltip label="Add workspace" side="bottom" delayMs={500} portal>
      <button type="button" className="agent-workspace-icon" aria-label="Add workspace" aria-haspopup="dialog" aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}><IconProjectAddOutlineRegular size={16} /></button>
    </Tooltip>
    {open && <FloatingPanel anchor={container} width={320}><form className="agent-workspace-add-panel" role="dialog" aria-label="Add workspace" onSubmit={submit}
      onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }}>
      <label htmlFor={`${inputId}-machine`}>Machine</label>
      <select id={`${inputId}-machine`} aria-label="Workspace machine" value={machineId} disabled={adding || connecting}
        onChange={event => { setMachineId(event.target.value); setPath(event.target.value === 'local' ? '' : '~/'); setInvalid(''); }}>
        {activeMachines(machines).map(machine => <option key={machine.id} value={machine.id}>{machineLabel(machine)}</option>)}
        {addSSHHost && <option value="new-ssh">Add SSH host…</option>}
      </select>
      {machineId === 'new-ssh' ? <>
        <label htmlFor={`${inputId}-host`}>SSH destination</label>
        <input id={`${inputId}-host`} aria-label="SSH destination" value={host} onChange={event => { setHost(event.target.value); setUntested(""); }}
          placeholder="dev-box or user@host:2222" spellCheck={false} autoCapitalize="none" list={`${inputId}-ssh-hosts`} />
        <SshHostOptions id={`${inputId}-ssh-hosts`} hosts={suggestions.hosts} />
        <Button size="sm" variant="outline" disabled={!host.trim() || connecting} onClick={() => connect(true)}>{connecting ? 'Testing…' : 'Test & add'}</Button>
        {untested && untested === host.trim() && <Button size="sm" variant="ghost" disabled={connecting} onClick={() => connect(false)}>Add without testing</Button>}
        <p className="agent-workspace-directory-hint">Uses your SSH config, keys and known_hosts. Passwords are not supported.</p>
      </> : <>
        <label htmlFor={inputId}>{machineId === 'local' ? 'Project directory on the Host' : 'Project directory on the SSH host'}</label>
        <input id={inputId} aria-label="Workspace directory" placeholder="/path/to/project" value={path} readOnly={adding} autoFocus
          role="combobox" aria-autocomplete="list" aria-controls={`${inputId}-paths`} aria-expanded={!!listing?.entries.length}
          aria-activedescendant={selected >= 0 ? `${inputId}-path-${selected}` : undefined}
          spellCheck={false} autoComplete="off" onChange={event => setPath(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'ArrowDown' && listing?.entries.length) { event.preventDefault(); setSelected(index => Math.min(index + 1, listing.entries.length - 1)); }
            if (event.key === 'ArrowUp' && listing?.entries.length) { event.preventDefault(); setSelected(index => Math.max(index - 1, 0)); }
            if ((event.key === 'Tab' && !event.shiftKey || event.key === 'Enter' && selected >= 0) && listing?.entries.length) { event.preventDefault(); complete(Math.max(0, selected)); }
          }} />
        {loading && <p className="agent-workspace-directory-hint" role="status">Reading directories…</p>}
        {listing && <div className="agent-workspace-directories" role="listbox" id={`${inputId}-paths`} aria-label="Directory suggestions">
          {listing.entries.map((entry, index) => <button type="button" key={entry.path} role="option" id={`${inputId}-path-${index}`} aria-selected={index === selected}
            onMouseDown={event => event.preventDefault()} onClick={() => complete(index)}><IconFolderCloseRegular size={14} /><span>{entry.name}/</span></button>)}
        </div>}
        {listing?.truncated && <p className="agent-workspace-directory-hint">Type more of the name to narrow the list.</p>}
        <p className="agent-workspace-directory-hint">Tab to complete · ↑ ↓ to choose · Enter to add</p>
      </>}
      {invalid && <p className="agent-workspace-add-error" role="alert">{invalid}</p>}
      {onManageMachines && <button type="button" className="agent-workspace-manage" onClick={() => { close(); onManageMachines(); }}>Manage machines…</button>}
      <div className="agent-workspace-add-actions">
        <Button size="sm" variant="ghost" onClick={close}>Cancel</Button>
        <Button size="sm" variant="primary" type="submit" disabled={adding || connecting || machineId === 'new-ssh' || !path.trim()}>{adding ? "Adding…" : "Add"}</Button>
      </div>
    </form></FloatingPanel>}
  </div>;
}

/** Native section header: label, expanding search, view options and add-workspace. */
export function WorkspaceHeader({ query, onQuery, layout, filter, onLayout, onFilter, adding, onAdd, machines, browseDirectories, addSSHHost, sshConfigHosts, onManageMachines }) {
  const [searching, setSearching] = useState(false);
  const input = useRef(null);
  const expanded = searching || query !== "";
  const collapse = () => { onQuery(""); setSearching(false); };
  return <header className={`agent-workspace-header${expanded ? " is-searching" : ""}`}>
    <span className="agent-workspace-section-label" aria-hidden={expanded || undefined}>Workspaces</span>
    <div className={`agent-workspace-search${expanded ? " is-expanded" : ""}`} onClick={() => { setSearching(true); input.current?.focus(); }}>
      <Tooltip label="Search" side="bottom" delayMs={500} disabled={expanded} portal>
        <button type="button" className="agent-workspace-search-button" aria-label="Search sessions" aria-expanded={expanded}
          onClick={(event) => { event.stopPropagation(); setSearching(true); input.current?.focus(); }}>
          <IconSearchOutlineRegular size={expanded ? 11 : 14} />
        </button>
      </Tooltip>
      <input ref={input} id="agent-workspace-search" className="agent-workspace-search-input" type="text" placeholder="Search sessions"
        aria-label="Search sessions" value={query} tabIndex={expanded ? 0 : -1} maxLength={200} spellCheck={false}
        onChange={(event) => onQuery(event.target.value)} onFocus={() => setSearching(true)}
        onBlur={() => { if (query === "") setSearching(false); }}
        onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); collapse(); event.currentTarget.blur(); } }} />
      {expanded && <button type="button" className="agent-workspace-search-clear" aria-label="Clear search"
        onClick={(event) => { event.stopPropagation(); collapse(); }}><IconCloseFillRegular /></button>}
    </div>
    <div className="agent-workspace-header-actions" hidden={expanded}>
      <ViewOptions layout={layout} filter={filter} onLayout={onLayout} onFilter={onFilter} />
      <AddWorkspace adding={adding} onAdd={onAdd} machines={machines} browseDirectories={browseDirectories} addSSHHost={addSSHHost} sshConfigHosts={sshConfigHosts} onManageMachines={onManageMachines} />
    </div>
  </header>;
}

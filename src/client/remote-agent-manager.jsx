import { FloatingPanel } from "./floating-panel.jsx";
import React, { useEffect, useRef, useState } from 'react';
import { IconSlidersTwoOutlineRegular, Tooltip } from './native.js';
import AgentLogo from './AgentLogo.jsx';

export function RemoteAgentManager({ machineId, machineName, loadProviders, updateAgent, updateStatus, updatePlan, onOpenChange }) {
  const [open, setOpen] = useState(false), [providers, setProviders] = useState([]), [plans, setPlans] = useState({}), [jobs, setJobs] = useState({}), [error, setError] = useState(''), [revision, setRevision] = useState(0);
  const container = useRef(null), live = useRef(true), lock = useRef(new Set());
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const toggle = value => { setOpen(value); onOpenChange(value); };
  useEffect(() => {
    if (!open) return;
    let cancelled = false; setError('');
    loadProviders(machineId, true).then(async value => {
      if (cancelled) return; setProviders(value); setJobs(old => ({ ...old, ...Object.fromEntries(value.filter(p => p.update).map(p => [p.id, p.update])) }));
      setPlans({});
      for (const provider of value) {
        const plan = await updatePlan(machineId, provider.id);
        if (!cancelled) setPlans(old => ({ ...old, [provider.id]: plan }));
      }
    }).catch(cause => { if (!cancelled) setError(cause.message); });
    const outside = event => { if (!container.current?.contains(event.target)) toggle(false); };
    const doc = container.current?.ownerDocument; doc?.addEventListener('pointerdown', outside);
    return () => { cancelled = true; doc?.removeEventListener('pointerdown', outside); };
  }, [open, machineId, loadProviders, updatePlan, revision]);
  const running = Object.values(jobs).filter(job => job.status === 'running');
  useEffect(() => {
    if (!running.length) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      for (const job of running) {
        try {
          const value = await updateStatus(job.id);
          if (cancelled) return;
          setJobs(old => ({ ...old, [job.provider]: value }));
          if (value.status !== 'running') { setProviders(await loadProviders(machineId, true)); setRevision(value => value + 1); }
        } catch (cause) { if (!cancelled) { setError(cause.message); setJobs(old => ({ ...old, [job.provider]: { ...job, status: 'unknown', message: 'Refresh versions to check the result before retrying.' } })); } }
      }
    }, 1500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [jobs, machineId, updateStatus, loadProviders]);
  async function update(provider) {
    if (lock.current.has(provider)) return;
    lock.current.add(provider); setError('');
    setJobs(old => ({ ...old, [provider]: { provider, status: 'starting' } }));
    try { const job = await updateAgent(machineId, provider, plans[provider]?.token); if (live.current) setJobs(old => ({ ...old, [provider]: job })); }
    catch (cause) { if (live.current) { setError(cause.message); setJobs(old => ({ ...old, [provider]: { status: 'unknown', message: 'Check CLI versions before retrying.' } })); } }
    finally { lock.current.delete(provider); }
  }
  return <span className="agent-workspace-remote-tools" ref={container} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); toggle(false); } }}>
    <Tooltip label="Remote CLI versions & updates" side="bottom" portal>
      <button type="button" className="agent-workspace-row-button" aria-label={`Manage remote CLIs on ${machineName || 'SSH host'}`} aria-haspopup="dialog" aria-expanded={open}
        onClick={event => { event.stopPropagation(); toggle(!open); }}><IconSlidersTwoOutlineRegular size={14} /></button>
    </Tooltip>
    {open && <FloatingPanel anchor={container} width={340}><section className="agent-workspace-remote-panel" role="dialog" aria-label="Remote CLI updates">
      <strong>{machineName || 'SSH host'} · Agent CLIs</strong>
      <p className="agent-workspace-directory-hint">Installs the tested target using the detected installation method. Review the command before updating.</p>
      <button type="button" onClick={() => setRevision(value => value + 1)}>Refresh versions</button>
      {!providers.length && <p role="status">Checking installed versions…</p>}
      {error && <p className="agent-workspace-add-error" role="alert">{error}</p>}
      {providers.map(provider => {
        const plan = plans[provider.id], job = jobs[provider.id], busy = ['running', 'starting'].includes(job?.status);
        return <div className="agent-workspace-remote-agent" key={provider.id}>
          <div><AgentLogo provider={provider.id} size={14} decorative /><strong>{provider.label}</strong><span>{provider.version || 'Not found'}</span>
            <button type="button" disabled={busy || !plan?.canUpdate} onClick={() => update(provider.id)}>{busy ? 'Updating…' : `Install ${plan?.targetVersion || provider.id}`}</button></div>
          {!provider.available && <p>{provider.reason}</p>}
          {plan && <p>{plan.method} · {plan.reason || `Target: ${plan.targetVersion}`}</p>}
          {plan?.command && <code className="agent-update-command">{plan.command}</code>}
          {job && <p role="status">{busy ? 'Updating on the SSH host…' : job.message || `Installed ${job.version}`}</p>}
        </div>;
      })}
    </section></FloatingPanel>}
  </span>;
}

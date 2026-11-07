import React, { useEffect, useRef, useState } from 'react';

/** Replaces pages instead of accumulating DOM nodes. Full fields stay on disk. */
export function ToolHistory({ api, session, message, renderTool, preview = true }) {
  const [opened, setOpened] = useState(false), [page, setPage] = useState(null);
  const [search, setSearch] = useState(''), [query, setQuery] = useState('');
  const [detail, setDetail] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const alive = useRef(true), lock = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const active = ['running', 'waiting'].includes(session.status) && session.messages.at(-1)?.id === message.id;
  const total = message.toolCount ?? message.tools?.length ?? 0;
  async function request(extra) {
    if (!alive.current) throw Error('History view closed');
    const result = await api('chatToolHistory', { id: session.id, messageId: message.id, ...extra });
    if (!alive.current) throw Error('History view closed');
    return result;
  }
  async function action(fn) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try { await fn(); } catch (cause) { if (alive.current) setError(cause.message || 'Could not read tool history'); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  const load = (offset = 0, term = query) => action(async () => {
    const result = await request({ offset, limit: 16, query: term });
    setPage(result); setQuery(term); setDetail(null); setOpened(true);
  });
  const read = (tool, field, offset = 0, previous = []) => action(async () => {
    const result = await request({ toolId: tool.id, field, offset });
    setDetail({ ...result, tool, previous });
  });
  async function download() {
    await action(async () => {
      // Each JSONL line is one tool. Build a Blob from bounded field chunks, never render it.
      const parts = []; let offset = 0;
      for (;;) {
        const batch = await request({ offset, limit: 16 });
        for (const tool of batch.tools) {
          parts.push(JSON.stringify({ id: tool.id, name: tool.name, status: tool.status, isError: tool.isError ?? false }).slice(0, -1));
          for (const field of ['input', 'result', 'text']) {
            parts.push(`,"${field}":${field === 'text' ? '"' : ''}`);
            let position = 0;
            for (;;) {
              const chunk = await request({ toolId: tool.id, field, offset: position });
              parts.push(field === 'text' ? JSON.stringify(chunk.text).slice(1, -1) : chunk.text);
              if (!chunk.hasMore) break;
              if (chunk.nextOffset <= position) throw Error('Tool history cursor did not advance');
              position = chunk.nextOffset;
            }
            if (field === 'text') parts.push('"');
          }
          parts.push('}\n');
        }
        if (!batch.hasMore) break;
        offset = batch.nextOffset;
      }
      const url = URL.createObjectURL(new Blob(parts, { type: 'application/x-ndjson' }));
      const link = document.createElement('a'); link.href = url; link.download = `tools-${message.id}.jsonl`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }
  return <section className="agent-tool-history" aria-label="Saved tool history">
    {preview && !opened && <div className="agent-chat-tools">{message.tools.map(tool => <React.Fragment key={tool.id}>{renderTool(tool)}</React.Fragment>)}</div>}
    {message.toolHistoryError ? <p role="alert">{message.toolHistoryError}</p> : <p className="agent-chat-caption">
      {preview && !opened ? `Showing ${message.tools.length} of ${total} tool calls` : `${total} saved tool calls`} · {active ? 'Saving full records as they arrive' : message.archiveSource === 'omp-original' ? 'Recovered original snapshot' : 'Complete tool records saved'}
    </p>}
    <div className="agent-history-actions">
      <button type="button" disabled={busy} onClick={() => opened ? setOpened(false) : load()}>{opened ? 'Hide saved tools' : 'Browse saved tools'}</button>
      <button type="button" disabled={busy || active || !!message.toolHistoryError} onClick={download}>{busy ? 'Reading…' : 'Export full tools (JSONL)'}</button>
    </div>
    {error && <p role="alert">{error}</p>}
    {opened && <>
      <form className="agent-history-actions" onSubmit={event => { event.preventDefault(); void load(0, search); }}>
        <input aria-label="Search full tool history" placeholder="Search tool names, inputs and results…" value={search} maxLength={128} onChange={event => setSearch(event.target.value)} />
        <button disabled={busy}>Search</button>
        <button type="button" disabled={busy} onClick={() => load()}>Refresh</button>
      </form>
      {page && <>
        <p role="status" className="agent-chat-caption">{page.tools.length ? page.offset + 1 : 0}–{page.offset + page.tools.length} of {page.matchedTools} {query ? 'matching' : 'saved'} tools</p>
        {page.tools.map(tool => <div key={tool.id} className="agent-history-record">
          {renderTool(tool)}
          <div className="agent-history-actions">{['input', 'result', 'text'].map(field => <button type="button" key={field} disabled={busy} onClick={() => read(tool, field)}>Read full {field} for {tool.name}</button>)}</div>
        </div>)}
        <div className="agent-history-actions">
          <button type="button" disabled={busy || page.offset === 0} onClick={() => load(Math.max(0, page.offset - 16))}>Previous tools</button>
          <button type="button" disabled={busy || !page.hasMore} onClick={() => load(page.nextOffset)}>Next tools</button>
        </div>
      </>}
      {detail && <section className="agent-history-detail" aria-label="Full tool data">
        <strong>{detail.tool.name} · {detail.field}</strong>
        <p className="agent-chat-caption">Bytes {detail.offset}–{detail.nextOffset} of {detail.size} · paged full record</p>
        <pre>{detail.text || '(empty)'}</pre>
        <div className="agent-history-actions">
          <button type="button" disabled={busy || !detail.previous.length} onClick={() => read(detail.tool, detail.field, detail.previous.at(-1), detail.previous.slice(0, -1))}>Previous data</button>
          <button type="button" disabled={busy || !detail.hasMore} onClick={() => read(detail.tool, detail.field, detail.nextOffset, [...detail.previous, detail.offset])}>Next data</button>
          <button type="button" onClick={() => setDetail(null)}>Close full data</button>
        </div>
      </section>}
    </>}
  </section>;
}

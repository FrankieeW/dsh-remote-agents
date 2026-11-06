import { constants } from 'node:fs';
import { open, readdir, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const MAX_FILE = 32 * 1024 * 1024;
const PREVIEW = 4096;
const DETAIL = 256 * 1024;
const hash = text => createHash('sha256').update(text).digest('hex');
const fail = message => { throw Object.assign(new Error(message), { code: 'HISTORY_UNAVAILABLE' }); };
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const textOf = message => (Array.isArray(message?.content) ? message.content : []).filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('');
function bound(value, limit) {
  const serialized = JSON.stringify(value ?? null);
  return serialized.length > limit ? { value: serialized.slice(0, limit) + '…', truncated: true } : { value: JSON.parse(serialized), truncated: false };
}
function present(tool, limit) {
  const input = bound(tool.input, limit), result = bound(tool.result, limit);
  return { ...tool, input: input.value, result: result.value, truncated: false, previewTruncated: input.truncated || result.truncated };
}

/** Read only the CLI transcript owned by this local plugin session. No provider
 * credentials, raw provider envelopes or unrelated session files are returned. */
export async function readOmpTurn(sessionRoot, session, messageId, { offset = 0, limit = 16, toolId } = {}) {
  if (session.provider !== 'omp' || (session.machineId || 'local') !== 'local') fail('Original-history lookup currently supports local OMP sessions only.');
  if (!safeId(session.id) || !safeId(session.providerSessionId)) fail('This session has no owned OMP history identity.');
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 32 || (toolId !== undefined && (typeof toolId !== 'string' || toolId.length > 128))) throw new Error('Invalid history page');
  const requestIndex = session.requests.findIndex(r => r.assistantMessageId === messageId);
  if (requestIndex < 0 || !session.messages.some(m => m.id === messageId && m.role === 'assistant')) fail('This message has no matching request record.');
  const directory = join(resolve(sessionRoot), session.id);
  if ((await lstat(directory).catch(() => null))?.isSymbolicLink()) fail('Refusing an OMP history directory symlink.');
  let files;
  try { files = (await readdir(directory, { withFileTypes: true })).filter(f => f.isFile() && f.name.endsWith(`_${session.providerSessionId}.jsonl`)); }
  catch { fail('The original OMP history file is unavailable. The retained plugin preview is still readable.'); }
  if (files.length !== 1) fail('Could not uniquely identify the owned OMP history file.');
  const handle = await open(join(directory, files[0].name), constants.O_RDONLY | constants.O_NOFOLLOW);
  let raw;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_FILE) fail('OMP history exceeds the 32 MiB reader limit; inspect it using the native CLI.');
    const data = Buffer.alloc(info.size); let size = 0;
    while (size < data.length) { const read = await handle.read(data, size, data.length - size, size); if (!read.bytesRead) break; size += read.bytesRead; }
    raw = data.subarray(0, size).toString('utf8');
  } finally { await handle.close(); }
  const lines = raw.split('\n'), rows = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    try { rows.push(JSON.parse(lines[i])); }
    catch { if (i !== lines.length - 1) fail('The original OMP history contains an invalid record.'); }
  }
  const headers = rows.filter(r => r?.type === 'session');
  if (headers.length !== 1 || headers[0].id !== session.providerSessionId || typeof headers[0].cwd !== 'string' || resolve(headers[0].cwd) !== resolve(session.cwd)) fail('OMP history identity or project directory does not match this session.');
  const entries = rows.filter(r => typeof r?.id === 'string' && Object.hasOwn(r, 'parentId'));
  const byId = new Map(entries.map(r => [r.id, r]));
  if (byId.size !== entries.length) fail('OMP history has duplicate record identities.');
  const chain = [], visited = new Set(); let cursor = entries.at(-1);
  while (cursor) {
    if (visited.has(cursor.id)) fail('OMP history contains a parent cycle.');
    visited.add(cursor.id); chain.push(cursor);
    if (cursor.parentId === null) break;
    const parent = byId.get(cursor.parentId);
    if (!parent) fail('OMP history has an incomplete parent chain.');
    cursor = parent;
  }
  chain.reverse();
  const users = chain.map((r,index) => ({r,index})).filter(({r}) => r.type === 'message' && r.message?.role === 'user');
  if (!users[requestIndex]) fail('This turn is not yet present in the original OMP history. Refresh after it has been saved.');
  if (users.length > session.requests.length || users.some(({r},i) => hash(textOf(r.message)) !== session.requests[i]?.textHash)) fail('The original history differs from this conversation. It cannot be matched safely; inspect it in OMP.');
  const start = users[requestIndex].index + 1, end = users[requestIndex + 1]?.index ?? chain.length;
  const tools = new Map(), texts = [];
  for (const row of chain.slice(start, end)) {
    const m = row.type === 'message' ? row.message : null;
    if (m?.role === 'assistant') {
      const text = textOf(m); if (text) texts.push(text);
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b?.type !== 'toolCall' || typeof b.id !== 'string' || b.id.length > 128 || tools.has(b.id)) continue;
        tools.set(b.id, { id: b.id, name: typeof b.name === 'string' ? b.name.slice(0,128) : 'tool', input: b.arguments ?? {}, text: '', status: 'running' });
      }
    } else if (m?.role === 'toolResult' && tools.has(m.toolCallId)) {
      Object.assign(tools.get(m.toolCallId), { result: { content: (Array.isArray(m.content) ? m.content : []).filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => ({type:'text',text:b.text})), details: m.details }, status: m.isError ? 'error' : 'done', isError: !!m.isError });
    }
  }
  if (toolId !== undefined) {
    if (!tools.has(toolId)) fail('Tool is not part of this OMP turn.');
    return { tool: present(tools.get(toolId), DETAIL), detailLimit: DETAIL };
  }
  const all = [...tools.values()], text = texts.join('\n\n');
  const page = all.slice(offset, offset + limit).map(t => present(t, PREVIEW));
  return { source:'OMP original history', totalTools:all.length, offset, nextOffset:offset + page.length, hasMore:offset + page.length < all.length, tools:page,
    text:text.slice(0,65536), textPreviewTruncated:text.length > 65536, textLength:text.length, snapshot:true };
}

export function exportConversation(session, format = 'markdown') {
  const record = { version: 1, id: session.id, name: session.name, provider: session.provider, cwd: session.cwd, machineId: session.machineId,
    createdAt: session.createdAt, updatedAt: session.updatedAt, settings: session.settings, historyTruncated: !!session.historyTruncated, messages: session.messages };
  if (format === 'json') return { filename: `conversation-${session.id}.json`, mime: 'application/json', content: JSON.stringify(record, null, 2) + '\n' };
  if (format !== 'markdown') throw new Error('Choose markdown or json');
  const fence = value => { const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2); const marker = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(m => m[0].length + 1))); return `${marker}\n${text}\n${marker}`; };
  const lines = [`# ${session.name.replace(/[\r\n]/g, ' ')}`, '', `Agent: ${session.provider}`, `Directory: ${session.cwd}`, `Machine: ${session.machineId || 'local'}`, ''];
  if (session.historyTruncated) lines.push('Earlier history was truncated; this export contains retained messages only.', '');
  for (const message of session.messages) {
    lines.push(`## ${message.role === 'user' ? 'User' : 'Assistant'}`, '', message.text || '', '');
    if (message.textTruncated) lines.push('Reply text was shortened in the retained plugin record.', '');
    if (message.toolsTruncated) lines.push(`Only the first ${message.tools.length} tool calls were retained in the plugin record.`, '');
    for (const tool of message.tools || []) lines.push(`### Tool: ${tool.name}`, '', fence({ input: tool.input, result: tool.result, status: tool.status }), '');
  }
  return { filename: `conversation-${session.id}.md`, mime: 'text/markdown', content: lines.join('\n') };
}

import { legacySettings } from './settings.js';
const OUTPUT_LIMIT = 32_768;

function bounded(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}\n[truncated]` : text;
}

function abortError() {
  return Object.assign(new Error('Claude turn aborted'), { name: 'AbortError' });
}

// Race without retaining abort listeners after a normally completed operation.
async function cancellable(value, signal) {
  if (signal.aborted) throw abortError();
  let listener;
  const aborted = new Promise((_, reject) => {
    listener = () => reject(abortError());
    signal.addEventListener('abort', listener, { once: true });
  });
  try { return await Promise.race([value, aborted]); }
  finally { signal.removeEventListener('abort', listener); }
}

/** Official Agent SDK 0.3.318; loaded only when a real turn is sent. */
export function createClaudeProvider({ queryFn, executable, execution } = {}) {
  return async function createAdapter({ session, emit, requestApproval, signal }) {
    const settings = session.settings || legacySettings('claude');
    let providerSessionId = session.providerSessionId;
    let active;
    let closed = false;

    const abort = () => {
      if (!active) return;
      active.controller.abort();
      try { active.query?.close?.(); } catch { /* Already exited. */ }
    };
    const onAbort = () => abort();
    signal?.addEventListener('abort', onAbort);

    return {
      abort,
      close() {
        closed = true;
        abort();
        signal?.removeEventListener('abort', onAbort);
      },
      async send(text) {
        if (closed || signal?.aborted) throw abortError();
        if (active) throw new Error('Claude session already has an active turn');
        const turn = { controller: new AbortController(), query: null };
        active = turn;
        const turnSignal = turn.controller.signal;
        let iterator;
        let resultSeen = false;
        let resultError;
        let currentMessage;
        let messageSequence = 0;
        const messages = new Map();
        const messageBlocks = (id) => {
          if (!messages.has(id)) messages.set(id, new Map());
          return messages.get(id);
        };
        const fullTurnText = () => [...messages.values()].flatMap(blocks =>
          [...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block.type === 'text' ? block.text : '')
        ).join('');
        let emittedText = false;
        const assistantFrames = new Set();
        const tools = new Set();
        const endedTools = new Set();
        const streamTools = new Map();
        const output = (type, payload) => {
          if (!turnSignal.aborted && active === turn) emit(type, payload);
        };
        const captureSession = (message) => {
          if (typeof message.session_id !== 'string' || !message.session_id) return;
          // Only main-agent init/result messages may establish the owned resume ID.
          if (providerSessionId && providerSessionId !== message.session_id) {
            throw new Error('Claude returned a different session ID');
          }
          if (!providerSessionId) {
            providerSessionId = message.session_id;
            output('provider.session', { id: providerSessionId });
          }
        };
        const startTool = (block, complete = false) => {
          if (!block.id) return;
          if (tools.has(block.id)) {
            if (complete) output('tool.input', { id: block.id, input: block.input ?? {} });
            return;
          }
          tools.add(block.id);
          output('tool.start', { id: block.id, name: block.name, input: block.input ?? {} });
        };
        try {
          const query = queryFn ?? (await import('@anthropic-ai/claude-agent-sdk')).query;
          if (turnSignal.aborted) throw abortError();
          turn.query = query({
            prompt: text,
            options: {
              cwd: session.cwd,
              ...(providerSessionId ? { resume: providerSessionId } : {}),
              ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
              abortController: turn.controller,
              includePartialMessages: true,
              ...(settings.model ? { model: settings.model } : {}),
              ...(settings.effort ? { effort: settings.effort } : {}),
              ...(settings.permissions !== 'cli' ? { permissionMode: settings.permissions } : {}),
              ...(settings.permissions === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
              settingSources: ['user', 'project', 'local'],
              ...(execution?.remote ? { spawnClaudeCodeProcess: options => execution.spawn(executable, options.args, { cwd: session.cwd, signal: options.signal }) } : {}),
              canUseTool: async (toolName, input, context = {}) => {
                const deny = (message) => ({ behavior: 'deny', message });
                if (toolName === 'AskUserQuestion' || context.requiresUserInteraction) {
                  return deny('Structured user answers are not supported by this approval UI. Ask the user in chat instead.');
                }
                if (active !== turn || turnSignal.aborted || resultSeen || !requestApproval) {
                  return deny('Approval request is no longer live');
                }
                const approvalSignal = context.signal
                  ? AbortSignal.any([turnSignal, context.signal]) : turnSignal;
                if (approvalSignal.aborted) return deny('Approval cancelled');
                try {
                  const approved = await cancellable(Promise.resolve().then(() => {
                    if (approvalSignal.aborted || active !== turn || resultSeen) return false;
                    return requestApproval({
                      kind: 'tool',
                      title: context.title || `Allow ${toolName}?`,
                      description: context.description || `Claude requests permission to use ${toolName}`,
                      details: { toolName, input },
                      signal: approvalSignal,
                    });
                  }), approvalSignal);
                  if (approved === true && active === turn && !approvalSignal.aborted && !resultSeen) {
                    return { behavior: 'allow', updatedInput: input };
                  }
                  return deny('User declined or approval expired');
                } catch { return deny('Approval cancelled or unavailable'); }
              },
            },
          });
          iterator = turn.query[Symbol.asyncIterator]();
          while (true) {
            const next = await cancellable(iterator.next(), turnSignal);
            if (next.done) break;
            const message = next.value;
            if (!message || message.parent_tool_use_id || message.agent_id || message.agentId) continue;
            if (message.type === 'system' && message.subtype === 'init') { captureSession(message); output('provider.settings', { model: message.model, effort: message.effort, permissions: message.permissionMode }); }
            if (message.type === 'result') {
              captureSession(message);
              resultSeen = true;
              if (message.subtype !== 'success' || message.is_error) {
                resultError = new Error(bounded(message.errors?.join('\n') || message.result || `Claude result: ${message.subtype}`));
              } else if (!emittedText && typeof message.result === 'string' && message.result) {
                output('text.done', { text: message.result });
                emittedText = true;
              }
              continue;
            }
            if (resultSeen) continue;
            if (message.type === 'stream_event') {
              const event = message.event;
              if (event?.type === 'message_start') {
                currentMessage = event.message?.id || `partial-${++messageSequence}`;
                messageBlocks(currentMessage);
                streamTools.clear();
              }
              if (event?.type === 'content_block_start' && event.content_block) {
                currentMessage ??= `partial-${++messageSequence}`;
                const blocks = messageBlocks(currentMessage);
                if (!blocks.has(event.index)) blocks.set(event.index, { type: event.content_block.type, text: event.content_block.text || '', final: false });
                if (event.content_block.type === 'tool_use') {
                  startTool(event.content_block);
                  streamTools.set(event.index, event.content_block.id);
                }
              }
              if (event?.type === 'content_block_delta') {
                if (event.delta?.type === 'text_delta') {
                  const delta = event.delta.text || '';
                  currentMessage ??= `partial-${++messageSequence}`;
                  const blocks = messageBlocks(currentMessage);
                  const index = event.index ?? 0;
                  const block = blocks.get(index) || { type: 'text', text: '', final: false };
                  blocks.set(index, block);
                  if (!block.final) {
                    block.text += delta;
                    if (delta) { output('text.delta', { text: delta }); emittedText = true; }
                  }
                } else if (event.delta?.type === 'input_json_delta' && streamTools.has(event.index)) {
                  output('tool.update', { id: streamTools.get(event.index), text: bounded(event.delta.partial_json) });
                }
              }
            } else if (message.type === 'assistant') {
              // The SDK emits one envelope per completed block, sharing message.id.
              // Only envelope UUIDs identify duplicate frames, not message IDs.
              if (message.uuid && assistantFrames.has(message.uuid)) continue;
              if (message.uuid) assistantFrames.add(message.uuid);
              const blocks = message.message?.content;
              if (!Array.isArray(blocks)) continue;
              const key = message.message?.id || currentMessage || `assistant-${++messageSequence}`;
              if (currentMessage?.startsWith('partial-') && currentMessage !== key && !messages.has(key)) {
                messages.set(key, messages.get(currentMessage) || new Map());
                messages.delete(currentMessage);
                currentMessage = key;
              }
              const tracked = messageBlocks(key);
              for (const block of blocks) {
                const pending = [...tracked.entries()].sort(([a], [b]) => a - b)
                  .find(([, entry]) => !entry.final && entry.type === block.type);
                const index = pending?.[0] ?? (tracked.size ? Math.max(...tracked.keys()) + 1 : 0);
                tracked.set(index, { type: block.type, text: block.text || '', final: true });
                if (block.type === 'tool_use') startTool(block, true);
              }
              if (fullTurnText()) { output('text.done', { text: fullTurnText() }); emittedText = true; }
            } else if (message.type === 'user' && Array.isArray(message.message?.content)) {
              for (const block of message.message.content) {
                if (block.type !== 'tool_result' || !block.tool_use_id || endedTools.has(block.tool_use_id)) continue;
                endedTools.add(block.tool_use_id);
                output('tool.end', { id: block.tool_use_id, result: bounded(block.content), isError: Boolean(block.is_error) });
              }
            } else if (message.type === 'tool_progress' && message.tool_use_id) {
              output('tool.update', { id: message.tool_use_id, text: `Running ${message.tool_name || 'tool'} (${message.elapsed_time_seconds ?? 0}s)` });
            }
          }
          if (turnSignal.aborted) throw abortError();
          if (!resultSeen) throw new Error('Claude stream ended without a result');
          if (resultError) throw resultError;
        } finally {
          turn.controller.abort(); // Invalidates every late permission callback.
          try { turn.query?.close?.(); } catch { /* Preserve original error. */ }
          // A broken provider may never settle return(); do not let it block cancellation.
          try { Promise.resolve(iterator?.return?.()).catch(() => {}); } catch { /* Already closed. */ }
          if (active === turn) active = null;
        }
      },
    };
  };
}

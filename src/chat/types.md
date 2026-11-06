# Structured chat manager contract

`import { ChatManager } from './manager.js'` (also default export).

```js
const manager = new ChatManager({
  statePath: '/private/plugin/chat.json',
  providers: { claude: claudeFactory, omp: ompFactory },
  // Optional: saveDebounceMs: 50, shutdownTimeoutMs: 1000
});
```

One live manager owns one state path. Atomic writes and in-process queues serialize persistence; this is not a multi-process shared-runtime database. The host must dispose its old manager before constructing another for the same file. Runtime objects, processes, AbortControllers, pending approval authority and promises are never serialized.

## Public methods

All methods return promises. Failures have a readable `.message` and `.code`.

- `list()` → **array** of summaries `{id,provider,name,cwd,status,createdAt,updatedAt,messageCount,error?}`. No transcript or approval details.
- `create({provider,cwd,name?,machineId?})` → full session. Provider is `claude` or `omp`, must be configured, and never changes for that session. cwd must be an existing absolute **local directory**; filesystem `stat` is the only environment check. `machineId`, if supplied, must be `local`; remote execution is unsupported. Creation never constructs a provider or starts a process.
- `get(id)` → full session, including the latest in-memory streaming output and `pendingApprovals`.
- `send({id,text,requestId})` → `{accepted:true,id,requestId,assistantMessageId,duplicate?:true}` after persisting the request, **not** after completing the model turn. The background operation is observed internally. First send lazily constructs the adapter; no CLI/LLM invocation occurs before explicit send.
- `interrupt(id)` → full session with status `interrupted`, denies approvals, aborts its signal and closes the runtime. It does not wait for the model turn. A later explicit send constructs a fresh adapter using the saved provider session ID.
- `approve({id,approvalId,allow})` → current full session. `allow` must literally be boolean; omitted values are not authorization. The approval must belong to the selected session and still be pending. Consumption happens once; repeats/stale/wrong-session IDs reject.
- `close(id)` → full closed session. Idempotent, terminal state; new sends are refused. Persistent transcript remains readable.
- `dispose()` → denies all approvals, invalidates runtimes, aborts/closes adapters with a bounded wait, marks active turns interrupted and flushes state. Idempotent. Subsequent public operations reject `DISPOSED`.

Request IDs are caller-generated stable strings, max 128 characters. Repeating the same session/request ID and text returns the prior assistant ID without sending again, even after restart; different text with that ID rejects `CONFLICT`. A different request while running/waiting rejects `BUSY`. Retry uncertain transport failures using the **same** ID. After an accepted turn visibly fails or is interrupted, a user-authorized new attempt needs a **new** ID; the manager never automatically retries provider work. Request deduplication entries are never evicted: after 2048 requests create a new session.

## Session shape

```js
{
  id, provider: 'claude' | 'omp', name, cwd,
  status: 'idle' | 'running' | 'waiting' | 'error' | 'interrupted' | 'closed',
  createdAt, updatedAt, // ISO 8601 strings
  providerSessionId?, error?, persistenceError?, historyTruncated?,
  messages: [{
    id, role: 'user' | 'assistant', text, createdAt,
    textTruncated?, toolsTruncated?,
    tools: [{ id, name, input, text, status: 'running' | 'done' | 'error',
              result?, isError?, truncated: boolean }]
  }],
  pendingApprovals: [{
    id, kind, title, description, details, truncated, createdAt
  }]
}
```

`error` and `persistenceError` are bounded strings, not Error objects. User messages also have `tools:[]`. Each accepted turn adds exactly one user message and one initially empty assistant message; all assistant events for that turn update that one record. Get returns a detached snapshot, never mutable internal state. `running` and `waiting` disable new sends; `closed` disallows new work. Other statuses permit a new explicit send. `pendingApprovals[].id` is the value to send as `approvalId`.

## Provider factory and events

```js
async function factory({session, emit, requestApproval, signal}) {
  return {
    async send(text) { /* resolves when this turn has ended; rejects on failure */ },
    async abort() {},
    async close() {}
  };
}
```

`session` is a detached snapshot containing `id`, `cwd`, `providerSessionId?` and transcript. Read the provider session ID to resume a provider-native session only after an explicit send. On a normal completed turn the adapter stays live and can receive the next send. Interrupt/error/dispose invalidates that runtime, and late events from it are ignored. Adapter callbacks must not emit events from an already settled turn during a later turn on the same adapter.

Call `emit(type,payload)`; `emit({type,...payload})` is also supported:

| Event | Payload | Effect |
|---|---|---|
| `text.delta` | `{text}` | Append assistant text |
| `text.done` | `{text}` | **Replace** with the complete accumulated assistant text for this turn, not merely an unstreamed suffix |
| `tool.start` | `{id,name,input}` | Add a structured tool record |
| `tool.input` | `{id,input}` | Replace the bounded input of an existing tool (for completed streamed arguments); never create a tool or change its ID/name/status |
| `tool.update` | `{id,text}` | Append bounded tool progress text |
| `tool.end` | `{id,result,isError}` | Set structured result and done/error status |
| `provider.session` | `{id}` | Save provider-native resume ID |

Unknown events, invalid IDs, updates without a matching tool start and late events after interruption are ignored. Provider factories and send failures become visible session errors; their rejected background promises are caught.

`requestApproval({id?,kind,title,description,details,signal?})` returns `Promise<boolean>`. An optional per-dialog AbortSignal expires only that pending request, resolves it as false and removes its UI record/listener; it is never persisted. The supplied optional provider ID is not an authority token and is ignored by the manager; the UI receives a fresh random live ID. No allow response is inferred. Interrupt, close, dispose and turn completion deny any still-pending requests with `false`. Requests from inactive runtimes or beyond the 16-live-approval cap return `false`. Approval objects are not in the persistent file, so refreshing the browser can recover them from the still-running manager but restarting the manager cannot restore them.

## Persistence and bounds

- State is version 1 `{version:1,sessions:[...]}`; internal `requests` entries are persisted but omitted from API snapshots.
- Startup changes persisted `running`/`waiting` sessions to `interrupted` and strips any legacy pending approvals. It never spawns, resumes or retries automatically.
- Mode-0600 temporary files, fsync and same-directory atomic rename; in-process writes are serialized. Streaming events save at most once per debounce interval; lifecycle transitions flush immediately. No file write queue is held for the duration of a model turn.
- At most 32 sessions, 200 messages per session and 2048 deduplicated requests per session. Older complete message pairs are trimmed with `historyTruncated:true`; request IDs are retained.
- Assistant/user text is bounded at 65536 characters; oversized user input is rejected, provider output truncated with `textTruncated:true`. At most 16 tools per assistant, with `toolsTruncated:true` when extra tools are omitted. Each tool input/result is preserved as JSON if at most 4096 serialized characters, otherwise a truncated JSON string plus `truncated:true`; progress text is capped at 4096 characters.
- Persisted JSON has a 16 MiB byte budget. Old message pairs may be removed globally to keep that budget; the latest pair is retained. Storage errors are exposed as `persistenceError` and sends whose initial persistence fails are not dispatched.
- Approvals cap details at 4096 serialized characters, title at 256 and description at 2048. Provider errors are sanitized of terminal/control escapes and capped at 2048 characters.
- Adapter shutdown wait defaults to 1000 ms per runtime (parallel on dispose). The manager cannot forcibly terminate an injected provider that ignores abort/close; real adapters own their child-process termination policies.

Tests use only fake providers, temporary local directories and synthetic events. They never start CLIs, query an LLM, connect over SSH or interact with tmux/Herdr.

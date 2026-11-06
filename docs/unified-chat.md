# Unified conversations (0.3.1)

The interface defaults to **English** and uses DSH's semantic light/dark theme, typography and controls. User messages and provider output are never translated or rewritten.

## Opening a session

- In the **Workspace sidebar**, choose OMP, DSH or Claude Code and press **+ New**. Creation inherits the selected workspace's path and opens its conversation directly, without a second form or independent workbench.
- The native DSH **New Session → Agent** control also creates OMP/Claude conversations directly in that workspace. The original DSH draft remains with its native session.
- Each workspace lists native DSH and external conversations together, with their upstream whale / π / asterisk logos. Selecting a row changes the main content without opening another session browser. Paths no longer registered as workspaces retain their external conversations under a History group; existing records need no migration.
- Native rows subscribe to DSH's `useSessionStatus`: approval, question and plan-review requests show a warning with an explicit label, and idle unread completions show a distinct reminder. Live status overrides stale list summaries; pending input outranks running, which outranks completion reminders. Native acknowledgement clears the reminder through the same source.
- Creating an external session saves a record only. Its CLI starts when you explicitly send the first message. Each session keeps its backend; switching rows is not a cross-engine resume. Drafts and uncertain-send request IDs survive content unmounts during navigation, but unsent drafts are not persisted across page reloads.
- This is a **pure-plugin UI composition**, not a new DSH core backend API: `sidebar.workspaces` is replaced by a mixed browser, DSH rows use `uiWorkspace` navigation, and external rows render content in the same shell through a main-content registration with no separate launcher. Native DSH keeps its conversation renderer and model configuration; external logs remain plugin-owned, not fabricated native DSH history. Native Send is never intercepted.
- The replacement provides workspace adoption by absolute path, metadata search, history filters and native rename/fork/pin/archive actions. It does not mirror native tree/flat view options, content search, drag ordering or workspace rename/delete controls. The global DSH New Session shortcut still creates a native draft. Machines and legacy terminals remain a separate management entry, not a conversation workbench.

## Supported capabilities

| Capability | DSH | Claude Code | OMP |
|---|---|---|---|
| Conversation | Native DSH | Official Agent SDK | Structured RPC v2 |
| Streaming text and tool cards | Native | Yes | Yes |
| Permission decisions | Native | SDK callback, explicit allow/deny | Known single-call approval/confirm dialogs |
| Stop / explicit continuation | Native | Interrupt / owned native session ID | Abort / private session directory and identity check |
| Models, attachments, rich questions | Native | Not exposed in this adapter | Not exposed in this adapter |
| SSH structured chat | Host-native behavior | Not supported | Not supported |

The existing machine/project import and SSH terminal tools remain under **Machines & projects**. Codex is available there as a legacy CLI, not a unified-chat backend. Unsupported questions are denied/cancelled visibly rather than answered with a guessed boolean. Unknown OMP URLs are not opened. OMP `/` and `!` shortcut commands are rejected to avoid implicit session/configuration changes.

## Protocols and lifecycle

- Claude uses pinned `@anthropic-ai/claude-agent-sdk@0.3.318`, with a discovered installed Claude CLI. The adapter uses partial structured events, reconciles completed assistant messages, maps tool calls/results, checks both result subtype and `is_error`, and resumes only its own native session ID.
- OMP targets the source-verified 18.17.0 protocol. It starts without a shell, negotiates RPC v2, validates bounded JSONL/chunk frames, and waits for the matching `prompt_result` plus settled state. A prompt admission ACK or `agent_end` is **not** task completion.
- Backend availability uses cached `--version` checks, not test prompts or automatic login. The current gate accepts Claude Code ≥2.1.318 and <3, and OMP ≥18.17 and <19; runtime protocol checks remain mandatory. Other releases have not been end-to-end certified.
- CLI lookup searches absolute PATH entries and conventional installation locations, never the project directory. Host plugin options `claudeExecutable` and `ompExecutable` may specify an absolute executable path. The browser cannot submit executables, shell arguments, environment variables or native resume paths.
- The Host owns live runtimes independently of browser mounts. Browser polling observes snapshots; reconnecting never resends a prompt. Explicit request IDs prevent duplicate admission, including a retry after an ambiguous network response.
- A crashed/restarted Host marks unfinished sessions interrupted. Continuing requires a new explicit message. Pending approvals are live-only, scoped to a session/request and cancelled on timeout, provider cancellation, interruption or disposal.

## Permissions and storage

All plugin routes use the authenticated DSH shared `/api` carrier and admit the owner only. This is **not an OS sandbox**. A granted tool can have the privileges of the host account; do not share owner access with untrusted users.

Claude uses `permissionMode: default`, no bypass mode and no opt-in project/user settings (`settingSources: []`). Its callback is reached only when native permission handling asks for a decision. OMP uses `--approval-mode always-ask`, disables automatic extensions, title generation and PTY execution. OMP read-tier operations and existing explicit per-tool allowances can still be allowed by its native policy. Neither adapter claims every tool must generate a new approval. Missing/cancelled UI never grants a new permission, and remembered/session-wide approvals are not selected automatically.

Next to the fleet state file:

- `conversations.json` stores bounded external conversation records, messages/tool output, request receipts and owned native IDs. Atomic replacement uses mode 0600; directories are initially 0700. One live ChatManager owns this file: **do not point simultaneous DSH profiles at the same chat state directory**.
- `omp-sessions/<app-session-id>/` isolates native OMP session storage. Resume checks its returned identity/path rather than taking arbitrary client-supplied session paths.
- Claude also uses its normal native persistence. Authentication stays with the installed CLI; the plugin does not read credential files or copy credentials into its state.
- Conversation text, tool inputs and results may contain sensitive project data. The stored transcript is bounded (32 sessions, 200 messages/session, 16 tool cards/message, 64 Ki characters/message, 4 Ki characters/tool value, 16 MiB total). Truncation is displayed; native continuation is not reconstructed from truncated UI history.
- Closing the browser does not stop the Host's owned runtimes. Closing a session or unloading the plugin denies pending approvals and stops the corresponding structured subprocesses. This differs from legacy tmux sessions, which intentionally survive plugin unload.

## Implementation references

This is a small independent implementation, not copied T3/Herdr source or an attempt to import their private APIs.

- [T3 ProviderAdapter contract](https://github.com/pingdotgg/t3code/blob/6577c6b6185167c0e502fa01f9e8e8f2dee6ff25/packages/provider-core/src/server/ProviderAdapter.ts): backend capabilities and normalized conversation events.
- [T3 ClaudeAdapterV2](https://github.com/pingdotgg/t3code/blob/6577c6b6185167c0e502fa01f9e8e8f2dee6ff25/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts): SDK transport and live permission callbacks, not terminal scraping.
- [T3 ProviderSessionManager](https://github.com/pingdotgg/t3code/blob/6577c6b6185167c0e502fa01f9e8e8f2dee6ff25/apps/server/src/orchestration-v2/ProviderSessionManager.ts): separation of runtime and durable application identity.
- [Herdr TerminalRuntimeRegistry](https://github.com/herdrdev/herdr/blob/v0.9.5/src/terminal/runtime_registry.rs): server-owned live resources separate from persisted metadata.
- [OMP RPC documentation](https://github.com/can1357/oh-my-pi/blob/v18.17.0/docs/rpc.md) and [approval policy](https://github.com/can1357/oh-my-pi/blob/v18.17.0/packages/coding-agent/src/tools/approval.ts).
- [Claude SDK permissions](https://code.claude.com/docs/en/agent-sdk/permissions.md).

## Verification boundary

Automated tests use synthetic SDK events and fake subprocesses, including startup failure, malformed/chunked frames, ACK-versus-completion, duplicate final text, one-shot approvals, cancellation, persistence, reconnect-safe request IDs, mixed Workspace grouping, native pending/unread precedence, stale-catalog races and draft/request-ID preservation across content remounts and late acknowledgments. An isolated installed DSH 0.2.2-rc.1 web profile was exercised in Chromium for direct Workspace OMP/Claude/native creation, mixed navigation, native and external draft preservation, close confirmation, history reload and light/dark visual checks. A separate browser fixture exercised native waiting-to-unread transitions and a first turn's late ACK arriving during an ambiguously admitted second turn after remount; retry retained the second turn's request ID. The fixture uses synthetic statuses and admission receipts, not a real pending model turn. No real prompt, model credit, provider-login validation or SSH connection was used.

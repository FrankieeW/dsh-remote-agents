# Unified conversations (0.4.1)

The interface defaults to **English** and uses DSH's semantic light/dark theme, typography and controls. User messages and provider output are never translated or rewritten.

## Opening a session

- In the **Workspace sidebar**, open the compact new-session icon beside a workspace and choose DSH, Claude Code, Codex or OMP. Creation inherits the selected workspace's path and opens its conversation directly, without a second form or independent workbench.
- The native DSH **New Session → Agent** control also creates OMP/Claude/Codex conversations directly in that workspace. The original DSH draft remains with its native session.
- Each workspace lists native DSH and external conversations together, with distinct agent marks. Selecting a row changes the main content without opening another session browser. Paths no longer registered as workspaces retain their external conversations under a History group; existing records need no migration.
- Native rows subscribe to DSH's `useSessionStatus`: approval, question and plan-review requests show a warning with an explicit label, and idle unread completions show a distinct reminder. Live status overrides stale list summaries; pending input outranks running, which outranks completion reminders. Native acknowledgement clears the reminder through the same source.
- Creating an external session saves a record only. Its CLI starts when you explicitly send the first message. Each session keeps its backend; switching rows is not a cross-engine resume. Drafts and uncertain-send request IDs survive content unmounts during navigation, but unsent drafts are not persisted across page reloads.
- This is a **pure-plugin UI composition**, not a new DSH core backend API: `sidebar.workspaces` is replaced by a mixed browser, DSH rows use `uiWorkspace` navigation, and external rows render content in the same shell through a main-content registration with no separate launcher. Native DSH keeps its conversation renderer and model configuration; external logs remain plugin-owned, not fabricated native DSH history. Native Send is never intercepted.
- **Workspace Tree** defaults to nested folders, with each workspace under its nearest registered directory ancestor. Path-segment boundaries keep `/project-other` separate from `/project`. Children keep their own sessions and New controls and appear before their parent's sessions; collapsing a parent hides descendants. Grouping and collapse choices are saved locally. **Workspaces** switches to sibling groups. This changes presentation only, not cwd, host membership or session storage. Metadata search retains ancestor context for matching children.
- Searching temporarily expands matching branches through collapsed ancestors; clearing the query restores the saved collapse state. Unregistered History groups cannot act as ancestors of registered workspaces.
- The replacement provides workspace adoption by absolute path, metadata and retained external-message search, external rename/pin/archive/restore and export, history filters, workspace removal, and native rename/fork/pin/archive actions. It does not mirror native single-session-list view, native content search, drag ordering or workspace renaming. The global DSH New Session shortcut still creates a native draft. Machines and legacy terminals remain a separate management entry, not a conversation workbench.

## Retained previews and original OMP history

The plugin record retains the first 16 tool calls per assistant turn and bounds tool values to 4,096 characters. A tool-count notice does not imply that the assistant reply text was shortened; text truncation is reported separately.

For local OMP sessions, **View original OMP turn** reads the CLI-owned JSONL history on demand, matches the session identity, working directory and ordered prompt hashes, and pages the original tool calls. Individual records can be expanded to 256 Ki characters per value; larger records remain in the unchanged original file. This is a read-only snapshot with an explicit refresh, not a model request. Native files larger than 256 MiB, missing history, ambiguous identities and mismatched branches return a visible error without guessing or changing the conversation. Remote OMP history lookup is not exposed by this reader. The normal conversation export contains the retained plugin preview and labels omitted content.

## Tool rendering recovery

Version 0.4.1 accepts OMP phased `todo` input (`op: init`, `list[].items`) and full state returned in `result.details.phases[].tasks`. Returned task statuses take precedence over initialization input. Unknown, incomplete or truncated todo records remain viewable as structured data. Each tool card has a rendering boundary with a raw-data fallback; a card failure does not unmount the conversation or its composer. Existing persisted transcripts require no migration.

## Supported capabilities

| Capability | DSH | Claude Code | OMP | Codex |
|---|---|---|---|---|
| Conversation | Native DSH | Official Agent SDK | Structured RPC v2 | app-server v2 |
| Streaming text and tool cards | Native | Yes | Yes | Yes |
| Permission decisions | Native | SDK callback, explicit allow/deny | Known single-call approval/confirm dialogs | Command/file approval, one call |
| Stop / explicit continuation | Native | Interrupt / owned native session ID | Abort / private session directory and identity check | Interrupt / owned thread ID |
| Model, effort, permissions | Native | CLI catalog/settings | CLI catalog/settings | app-server catalog/settings |
| Attachments, rich questions | Native | Not exposed | Not exposed | Not exposed |
| SSH structured chat | Local Host only | Yes | Yes, compatible RPC v2 CLI | Yes, compatible app-server CLI |

The existing machine/project import and SSH terminal tools remain under **Machines & projects**. Codex is available as both structured local chat and a legacy terminal. Unsupported questions are denied/cancelled visibly rather than answered with a guessed boolean. Unknown OMP URLs are not opened. OMP `/` and `!` shortcut commands are rejected to avoid implicit session/configuration changes.

## Rust backend

The development branch routes every backend operation to a bundled Rust process over bounded JSONL on stdio. DSH authentication and Fetch registration remain in the thin JavaScript host shim. Rust owns session/fleet storage, CLI discovery and configuration, SSH/tmux, provider event handling, approvals, imports, export/search and original OMP history. The Claude Node helper only invokes the official SDK and forwards its events and permission requests; decisions and normalization remain in Rust. No network listener or automatic JavaScript backend fallback is added. See [native architecture](../native/README.md).

## Protocols and lifecycle

- Claude uses pinned `@anthropic-ai/claude-agent-sdk@0.3.318`, with a discovered installed Claude CLI. The adapter uses partial structured events, reconciles completed assistant messages, maps tool calls/results, checks both result subtype and `is_error`, and resumes only its own native session ID.
- OMP targets the source-verified 18.17.0 protocol. It starts without a shell, negotiates RPC v2, validates bounded JSONL/chunk frames, and waits for the matching `prompt_result` plus settled state. A prompt admission ACK or `agent_end` is **not** task completion.
- Backend availability uses cached `--version` checks, not test prompts or automatic login. The current gate accepts Claude Code ≥2.1.318 and <3, OMP ≥18.17 and <19, and Codex 0.167.x; runtime protocol checks remain mandatory. Other releases have not been end-to-end certified.
- CLI lookup searches absolute PATH entries and conventional installation locations, never the project directory. Host plugin options `claudeExecutable`, `ompExecutable` and `codexExecutable` may specify an absolute executable path. The browser cannot submit executables, shell arguments, environment variables or native resume paths.
- The Host owns live runtimes independently of browser mounts. Browser polling observes snapshots; reconnecting never resends a prompt. Explicit request IDs prevent duplicate admission, including a retry after an ambiguous network response.
- A crashed/restarted Host marks unfinished sessions interrupted. Continuing requires a new explicit message. Pending approvals are live-only, scoped to a session/request and cancelled on timeout, provider cancellation, interruption or disposal.

## Permissions and storage

All plugin routes use the authenticated DSH shared `/api` carrier and admit the owner only. This is **not an OS sandbox**. A granted tool can have the privileges of the host account; do not share owner access with untrusted users.

New sessions follow the native CLI configuration. Claude reads user/project/local settings; explicit permission choices map to SDK `permissionMode`, with `allowDangerouslySkipPermissions` only for an explicit `bypassPermissions` selection. OMP loads its normal extensions/configuration and passes `--model`, `--thinking` and `--approval-mode` only when overridden; title generation and PTY decoration remain disabled for the structured transport. Legacy sessions retain their former explicit approval modes until changed. OMP read-tier operations and existing explicit per-tool allowances can still be allowed by its native policy. No adapter claims every tool must generate a new approval. Missing/cancelled UI never grants a new permission, and remembered/session-wide approvals are not selected automatically.

Next to the fleet state file:

- `conversations.json` stores bounded external conversation records, messages/tool output, request receipts and owned native IDs. Atomic replacement uses mode 0600; directories are initially 0700. One live ChatManager owns this file: **do not point simultaneous DSH profiles at the same chat state directory**.
- `omp-sessions/<app-session-id>/` isolates native OMP session storage. Resume checks its returned identity/path rather than taking arbitrary client-supplied session paths.
- Claude and Codex also use its normal native persistence. Authentication stays with the installed CLI; the plugin does not read credential files or copy credentials into its state.
- Conversation text, tool inputs and results may contain sensitive project data. The stored transcript is bounded (256 sessions, 200 messages/session, 16 tool cards/message, 64 Ki characters/message, 4 Ki characters/tool value, 64 MiB total). Truncation is displayed; native continuation is not reconstructed from truncated UI history.
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

Automated tests use synthetic SDK events and fake subprocesses, including startup failure, malformed/chunked frames, ACK-versus-completion, duplicate final text, one-shot approvals, cancellation, persistence, reconnect-safe request IDs, mixed Workspace grouping, native pending/unread precedence, stale-catalog races and draft/request-ID preservation across content remounts and late acknowledgments. An isolated installed DSH 0.2.2-rc.1 web profile was exercised in Chromium for direct Workspace OMP/Claude/native creation, mixed navigation, native and external draft preservation, close confirmation, history reload and light/dark visual checks. A separate browser fixture exercised native waiting-to-unread transitions and a first turn's late ACK arriving during an ambiguously admitted second turn after remount; retry retained the second turn's request ID. The fixture uses synthetic statuses and admission receipts, not a real pending model turn. Those earlier browser checks used no real prompts. For this revision, Codex 0.167.0 completed a real minimal prompt and then a second prompt after process restart using the same saved thread ID. This also verified macOS symlink/canonical-directory handling. The new configuration path additionally passed a real Codex turn with an explicit model, low effort and read-only sandbox. Netcup directory completion, remote Claude model/configuration discovery and a real remote Claude prompt passed. Remote CLI updates use fake commands in tests; no live upgrade was performed.


## Codex structured adapter (0.4.0)

Codex joins the same Workspace new-session menu, list and conversation view. The adapter uses the [official app-server protocol](https://developers.openai.com/codex/app-server/), checked against TypeScript bindings generated by the installed `codex-cli 0.167.0`. The capability gate accepts 0.167.x only. `codexExecutable` optionally selects an absolute Host executable. It runs locally or through registered SSH hosts and uses the CLI's existing model and authentication configuration; the plugin never reads credentials or changes global Codex settings.

The first explicit message starts an owned `codex app-server --listen stdio://` child, initializes it, creates or resumes the persisted thread ID, and sends `turn/start`. Messages and completion are correlated to both thread and turn; notifications arriving before the turn acknowledgement are buffered within a bounded budget. Final message items reconcile streamed text instead of duplicating it. Command output, file patches, MCP calls and live plans use the shared native conversation components. Copy resume command enters the same directory and runs `codex resume <thread-id>`.

Threads inherit effective CLI configuration unless the session has an explicit override. The read-only/workspace-write presets map to the native sandbox and on-request approval policy; YOLO maps to danger-full-access and never. The legacy supervised preset remains available. CLI policies may still allow trusted actions without a dialog. Command and file approval requests expose a live one-call Allow/Deny choice; no session-wide approval or policy amendment is selected. Additional permission grants are denied. Rich questions and unsupported interactions fail visibly so the user can continue in the native CLI. Stop interrupts the owned turn, closes the child and expires approval callbacks; further work requires an explicit send. Stderr is drained but never displayed or stored, and JSONL frames, queued events and accumulated adapter text are bounded.

The adapter tests exercise lifecycle, pre-ACK events, multi-message text, stale/foreign events, structured tools and plans, approvals and withdrawal, interruption, resume mismatch, protocol limits, startup timeout and process failure. Real-CLI verification is described above.


## CLI configuration and remote workspaces

`chatOptions` reads allowlisted metadata using Codex `model/list` + `config/read`, Claude stream-json `initialize` + `get_settings`, or OMP `models --json` and targeted `config get` commands. It never sends a model prompt and never returns credentials or raw configuration. Catalogs are cached per machine/provider/directory for one minute; Refresh CLI refreshes that workspace. Configuration discovery may initialize the CLI's normal plugins/hooks.

`chatConfigure` atomically merges a partial settings patch with the persisted record, using `expectedRevision` to reject stale writes. The response includes the new `settingsRevision`. Save progress and last-turn effective values are shown in the composer. Unknown fields and invalid provider-specific values reject. The manager rejects changes during running/approval turns and in closed sessions. Idle adapter processes are closed and resume on the next explicit send with the same native identity. Actual model/effort/permission fields reported by the runtime appear in the composer. The plugin does not edit global CLI configuration. Model/effort/permission menus support arrow navigation and Cmd/Ctrl+Shift+M/E/A while the conversation is focused.

Remote workspaces are stored in the fleet catalog with machine IDs; both grouping and ancestor tests include the machine. The same `/project` path on two hosts cannot share a group or receive the other's session. Directory completion is debounced and ignores stale responses when the path or host changes. It uses read-only directory queries over the existing OpenSSH configuration, never shell interpolation of user text. Only known hosts with BatchMode/StrictHostKeyChecking are used. Local auth and environment variables are not forwarded to remote CLI processes. Remote OMP sessions have private per-plugin/session directories.

The remote CLI management panel first calls `agentUpdatePlan` to identify the executable installation source and display its exact tested target and command. After an explicit click it runs a version-pinned npm/pnpm/Bun install, or the versioned Claude native installer. The server rechecks the installation fingerprint and rejects stale plan tokens. Compatible versions are left in place; unrecognized/standalone installations receive manual guidance. Jobs are scoped to machine/provider, shared by duplicate requests, bounded to two minutes and re-probed after completion. Active turns block updates; new runtime starts are blocked while that CLI updates. Refreshing the UI does not repeat an update. Status lives in the Host process; after a Host restart, inspect versions before retrying. Interactive installers may still require running the native command on the SSH host. No arbitrary command, package-manager choice, sudo or installer URL is accepted from the browser. Targets are Claude 2.1.318, Codex 0.167.0 and OMP 18.17.0. An update only succeeds when the executable resolves to the requested version and passes compatibility checks.

### Reference behaviors

- [Herdr connecting machines](https://herdr.dev/tui/docs/connecting-machines/): stable machine identity, machine-scoped workspaces, no credential copying, explicit updates and visible connection failures. Unlike Herdr's remote daemon, these structured sessions use owned stdio-over-SSH processes; a lost SSH connection interrupts the turn, and native transcript continuation requires an explicit new message.
- [T3 ProviderModelPicker](https://github.com/pingdotgg/t3code/blob/6577c6b6185167c0e502fa01f9e8e8f2dee6ff25/apps/web/src/components/chat/ProviderModelPicker.tsx): compact composer controls, searchable catalog, model-specific effort choices, viewport-safe popovers and keyboard navigation.
- [T3 model defaults](https://github.com/pingdotgg/t3code/blob/main/docs/user/composer.md#model-defaults) and [permissions](https://github.com/pingdotgg/t3code/blob/main/docs/user/permission-modes.md): distinguish unset native defaults from explicit thread choices, and expose each provider's actual permission behavior. This plugin keeps the CLI's own mode names instead of synthesizing identical behavior for different engines.

These are behavioral references; no upstream implementation code was copied.

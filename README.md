# DSH Remote Agents

An **English-default Workspace interface** with DSH, Claude Code and OMP sessions in one sidebar and content area, plus local/SSH machine and legacy terminal management. User messages are never translated or rewritten.

## What's new in 0.3.1

- Under each **Workspace**, choose **OMP / DSH / Claude Code → + New**. The session inherits that workspace's directory and opens immediately; no separate Session Workbench or second creation form.
- Agent logos distinguish sessions in the shared list and conversation header. **DSH** keeps its original conversation renderer and model configuration; **Claude Code / OMP** use structured chat with streaming text, tool calls/results, permission decisions and interruption—not terminal output disguised as chat.
- Native DSH semantic theme tokens, including light/dark mode, typography, compact controls and layout clearances.
- Native DSH rows keep live approval/question/plan-review warnings and unread-completion markers. Pending interaction takes precedence over running, and running takes precedence over completion reminders.
- Claude Agent SDK 0.3.318 and OMP RPC v2 adapters. Unavailable/incompatible CLIs are disabled, with no silent terminal fallback.
- Creating an external session does not start a process. Its first explicit message does. Backend identity is fixed per session; native drafts are preserved.
- Persistent transcripts, idempotent sends, explicit continuation after interruption, live-only approvals and bounded output.
- Pure-plugin integration replaces the Workspace browsing seat, without modifying DSH core. Metadata search, history filters and native session rename/fork/pin/archive actions are included; native tree/flat view options, drag ordering and workspace rename/delete controls are not mirrored by this replacement.

**Current scope:** structured external chat is local-only. Model switching, attachments, rich questions, cross-engine migration and a structured Codex adapter are not implemented. Unsupported dialogs are cancelled/denied rather than guessed. Native DSH conversation capabilities are unchanged; the replacement sidebar's limits are listed above.

See the [architecture, protocol references and capability boundaries](<docs/unified-chat.md>).

## Existing fleet features

Open **Machines & projects** for:

- Local machines and SSH aliases, explicit connection probes, project grouping.
- Codex, Claude Code, DSH TUI and shell processes in isolated tmux sessions.
- Bounded terminal snapshots, literal input, interrupt and confirmed stop.
- Persistent tmux sessions across SSH disconnects and plugin/Host restarts.
- Static Herdr machine/project import with preview and explicit confirmation, offline import CLI and the bundled `herdr-import` Skill. See the [import guide](<docs/herdr-import.md>) and [Skill](<skills/herdr-import/SKILL.md>).

This is not a full Herdr/T3 clone. There is no terminal emulation, live Herdr takeover, existing terminal discovery, Git worktree orchestration or inferred agent task status. In the legacy terminal view, `running` means the process is alive—not that an LLM task is finished.

## Requirements

- DSH **0.2.2-rc.1**; no runtime-version exemptions. Other DSH versions require revalidation.
- Node.js 22+ on the plugin Host.
- Structured Claude: installed and authenticated Claude Code ≥2.1.318 and <3.
- Structured OMP: installed and authenticated OMP ≥18.17 and <19; source-verified protocol version is 18.17.0 with RPC v2 negotiation.
- Legacy terminals additionally require tmux and, for remote machines, OpenSSH. Target machines must be macOS/Linux with tmux and the selected CLI.
- Absolute project paths on the respective host; remote tmux must be on its noninteractive SSH PATH.

The plugin uses owner-only exact Fetch routes on DSH's existing authenticated `/api` HTTP/IPC carrier. It does not start another Web server.

## Build and install

```sh
npm ci --ignore-scripts
npm test
npm run build
npm pack
```

Install the resulting package through the plugin manager of the **same profile as your running GUI**. For an explicitly selected `web` profile:

```sh
dsh plugin --profile web add /absolute/path/dsh-remote-agents-0.3.1.tgz
```

For the desktop application, use its plugin management entry rather than installing into an unrelated `web` profile. Refresh the existing GUI after the update; no automatic HMR is promised without a matching `dev:web` watcher.

Install the versioned **0.3.1** tarball for this Workspace revision. Repacking the older `0.3.0` tarball at its existing installed path can retain pnpm's old file integrity/cache; a new version and filename avoid that ambiguity.

The historical [v0.2.0 release](https://github.com/FrankieeW/dsh-remote-agents/releases/tag/v0.2.0) does **not** include unified chat. Build this revision for 0.3.1; an existing public release is not silently replaced.

Build artifacts contain a Host ESM entry and a DSH lazy client factory. React is shared with the Host. The pinned Claude SDK remains an ordinary runtime dependency rather than being embedded into the browser bundle.

## SSH setup

Use existing OpenSSH configuration for keys and jump hosts:

```sshconfig
Host dev-box
  HostName 192.0.2.10
  User developer
  Port 22
  IdentityFile ~/.ssh/id_ed25519
  IdentitiesOnly yes
```

Verify the host key and authentication yourself first:

```sh
ssh dev-box
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes dev-box 'tmux -V'
```

Then add the alias and use an absolute **remote** project path. The plugin uses `BatchMode=yes` and `StrictHostKeyChecking=yes`; it never accepts an unknown fingerprint, stores SSH passwords/private keys, installs remote software or automatically probes imported machines. Herdr imports can preserve safe separate user/port fields.

## Security and persistence

All operations require the DSH owner. **Tool/terminal access is not an OS sandbox** and can have the privileges of the corresponding local/SSH account. Do not share owner access with untrusted users.

### Structured conversations

See [permissions and storage](<docs/unified-chat.md#permissions-and-storage>) for precise CLI policy semantics and limits. Conversation messages/tool data are stored in mode-0600 files next to the fleet state. Live processes and approval callbacks are not serialized. Closing the browser does not stop them; closing a session or unloading the plugin denies pending approvals and stops its structured subprocesses. An interrupted turn is never automatically resent.

Only one live ChatManager may own a chat state directory; configure separate state paths for simultaneous profiles. Existing CLI policy grants can permit tools without a new dialog; the UI only answers actual live requests and never selects remembered approvals automatically.

### Legacy tmux terminals

- Dedicated tmux socket, random session IDs and ownership checks; no inspection or shutdown of unrelated default tmux sessions.
- Local argv execution and individually shell-quoted SSH parameters, with input validation and bounded operations.
- Terminal input is an execution interface, not a safe chat-only text field.
- Default fleet state: `~/.dsh/remote-agents/fleet.json`, respecting `DSH_HOME`. Override with `DSH_REMOTE_AGENTS_STATE` or Host option `statePath`.
- Fleet state uses atomic mode-0600 writes and a cross-instance lock. It stores machine/project metadata and launch arguments, not terminal transcripts. **Never put secrets in launch arguments.**
- Legacy tmux sessions intentionally survive plugin unload/restart. Stop is an explicit destructive operation.
- Failed startup/input is not automatically retried. If a process was created before a failure, inspect its recovery record before trying again.

## Verification

```sh
npm test
npm run build
# Optional real isolated tmux test; creates and cleans up only its own test session:
DSH_FLEET_SMOKE=1 node --test test/local-smoke.test.js
```

Tests use synthetic SDK events and fake subprocesses for unified chat. They cover protocol framing, completion correlation, text deduplication, permissions/cancellation, owned continuation, persistence, idempotency, owner-only routing, mixed Workspace grouping, catalog races, native pending/unread precedence and draft/request-ID preservation across content remounts and late acknowledgments. An isolated real DSH web profile was also exercised for direct OMP/Claude/native creation, mixed-list navigation, native/external draft preservation, history reload and light/dark rendering. Native status transitions and the deferred-ACK/remount race were additionally exercised in a browser fixture with synthetic sources. These checks do not validate provider login or send a real model prompt.

## Source map

- [Chat manager contract](<src/chat/types.md>) and [manager](<src/chat/manager.js>).
- [Claude adapter](<src/chat/claude.js>) and [OMP adapter](<src/chat/omp.js>).
- [Workspace browser](<src/client/WorkspaceSidebar.jsx>), [conversation content](<src/client/ChatWorkbench.jsx>) and [native entry integration](<src/client-entry.jsx>).
- [Fleet API](<src/core/API.md>), [Host entry](<src/index.js>) and [RPC](<src/rpc.js>).
- [Architecture and upstream references](<docs/unified-chat.md>).

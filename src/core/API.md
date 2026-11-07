# Core API (v1)

Dependency-free Node ESM. Import `{ FleetManager, FleetError, shellQuote }` from `src/core/index.js`.

```js
const fleet = new FleetManager({ statePath: '/absolute/private/directory/fleet.json' });
const state = await fleet.snapshot();
```

The Rust backend serves these operations as RPC methods of the same names (parameters as one object, e.g. `{agentId}`); the JavaScript `FleetManager` is the legacy reference in `test/reference/`. All operations are asynchronous. `statePath` is required; the host chooses its storage directory. Optional constructor parameters: `executor(file,args,options)`, `timeout=10000` ms, `maxBuffer=262144` bytes, `lockTimeout=15000` ms. The executor resolves `{stdout,stderr}` or rejects with an Error containing `code` (numeric process exit code) and optional `stderr`. Default is Node `execFile`, never `exec` or `shell:true`.

| Method | Result |
| --- | --- |
| `snapshot({readOnly=false}={})` | `{version:1,machines,agents,projects}`; stored states only, no processes/network; `readOnly:true` avoids initialization, locking, permission changes and writes |
| `addMachine({target\|host,user?,port?,name?,verify?})` | machine; `target` is an SSH destination: alias, `user@host`, `host:port`, `user@host:port`, `[v6]:port` or `ssh://user@host:port`. `name` defaults to the address. Adding the address of a removed machine restores it (same id, `restored:true`). `verify:true` saves only after SSH accepts a command and fails with the SSH error code otherwise. Duplicate addresses (host case-insensitive, IPv6 canonical) are `CONFLICT` |
| `updateMachine({machineId,name?,target?\|host,user?,port?})` | machine; renames and/or changes the address while keeping the id, so conversations and workspaces follow. Address changes are refused for `local`, while managed terminals are not stopped (`CONFLICT`), and while conversation turns, CLI updates or OMP configuration saves use the machine (`BUSY`). Requests already prepared against the old address (a send, conversation creation, CLI update or terminal start) fail with `CONFLICT` and can simply be retried; probe results from the old address are not recorded |
| `removeMachine(machineId)` | `{machineId,removed:true,retained,sessions}`; refused for `local`, while registered workspaces or unstopped terminal records use the machine (`CONFLICT`, naming them) and while turns, CLI updates or OMP saves run (`BUSY`). Stopped terminal records are deleted. When conversations reference the machine it is kept as a tombstone (`removedAt`, `retained:true`) so restoring it makes them usable again; otherwise the record is deleted |
| `restoreMachine(machineId)` | machine without `removedAt`; `CONFLICT` if another machine now uses the address |
| `probe({machineId='local'}\|{target})` | `{machineId,ok,checkedAt,ssh,tmux,clis,version?,error?,warning?}`. `ok` means SSH accepts a non-interactive command (always true locally). `ssh`/`tmux` are `{ok,code?,message?,version?}`; SSH codes: `HOST_KEY`, `HOST_KEY_CHANGED`, `AUTH`, `DNS`, `REFUSED`, `TIMEOUT`, `UNREACHABLE`, `SSH_CONFIG`, `SSH_FAILED`, `SHELL`. tmux `NOT_FOUND` only affects legacy terminals. `clis` lists Claude/Codex/OMP availability. A saved machine stores the result as `lastCheck`; a `target` probe saves nothing and skips CLI checks |
| `sshConfigHosts()` | `{hosts:[{alias,hostName?,user?,port?,machineId?,removed?}],warnings}`; concrete `Host` aliases from `$HOME/.ssh/config` and its `Include`s (wildcards only in file names), with the HostName/User/Port declared for them. Wildcard, negated and `Match` entries are skipped; ssh is never run, so `Match exec` commands are not triggered. `machineId` names the saved machine using the bare alias |
| `start({machineId='local',name,cwd,kind,args=[]})` | agent; absolute cwd; kind is `dsh`, `codex`, `claude`, `shell` |
| `read(agentId,{lines=200}={})` | `{agentId,output,status,truncated,diagnostic?,gone?}`; lines 1–2000 |
| `send(agentId,{text,enter=true})` | agent; literal single-line text (1–16384 chars), optional separate Enter |
| `send(agentId,{key})` | agent; whitelist: `C-c`, `C-d`, `Escape`, `Enter`, `Tab`, `Up`, `Down` |
| `interrupt(agentId)` | same as `send(agentId,{key:'C-c'})` |
| `stop(agentId)` | agent; destroys only the verified plugin session; repeat stop is idempotent. A session that tmux confirms no longer exists is marked stopped. Unverifiable ownership is `OWNERSHIP_UNVERIFIED`; an unreachable machine is `UNREACHABLE` |
| `forgetAgent({agentId,force?})` | `{agentId,forgotten:true}`; deletes the record without touching any process. Records that are not stopped require `force:true` |

Machine: `{id,name,type:'local'|'ssh',host?,user?,port?,removedAt?,lastCheck?}`. `lastCheck` is the stored probe summary `{checkedAt,ok,code?,message,ssh,tmux,clis}`; `removedAt` marks a tombstone that only keeps conversations resolvable. Operations on a removed machine fail with `MACHINE_REMOVED`. Local ID is `local`. Hosts allow alphanumeric/dot/underscore/hyphen aliases (starting alphanumeric) or IPv6; users match `[A-Za-z_][A-Za-z0-9_.-]{0,63}`; ports are integers 1–65535. No passwords or extra SSH options are accepted.

Project: `{id,name,machineId,cwd,source:'herdr'}`. Legacy state files without `projects` are migrated as an empty array on their next write. `workspaceRemove({workspaceId})` deletes a registration (files and conversations are kept); removing a machine with projects is refused rather than silently deleting mappings.

Agent: `{id,machineId,name,cwd,kind,args,session,sessionId?,owner,status,createdAt,updatedAt,stoppedAt?,diagnostic?}`. Timestamps are ISO 8601. IDs, session and owner are opaque and must not be constructed by callers.

`status` means **tmux pane lifecycle**, never model activity: `running`, `exited` (dead pane or explicitly stopped), `unknown` (unreachable, absent, output failure, or ownership unverifiable). No polling occurs automatically. `snapshot` does not refresh status; call `read`. A session is reported `exited` with `gone:true` only when tmux on a reachable machine confirms that no session with the exact name exists; connection and verification failures stay `unknown` with a diagnostic. `probe` does not infer agent status. The shell kind starts `sh -i`; dsh starts `dsh tui`; other kinds execute their executable name with shell-quoted args after interactive shell initialization. Keep `remain-on-exit` enabled so ended commands remain inspectable.

## Safety / persistence

- Each state file has a random namespace used with `tmux -L dsh-fleet-<namespace>`; user default tmux servers are never listed or controlled.
- Project-derived session names also contain random agent IDs. Creation obtains tmux's `$N` session ID; subsequent operations target that ID (pane/window targets append `:main`). Before capture/input/stop, both exact session name and `@dsh_fleet_owner` must match the persisted record, including after server restarts where IDs can be reused. Older records without `sessionId` resolve using the exact pane target `=session:main`; a verified inspection upgrades the record. Bare `=session` is deliberately not used for session-target commands.
- Commands are checked for preexisting sessions, then exclusively created. A recovery record is reserved before creation. Initialization failure retains that record with `unknown` status and reports socket/session identifiers; if the ownership marker could not be set, automated management refuses it. No blind cleanup is attempted.
- Remote operations use `ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=8 [-l user] [-p port] -- <host> "exec /bin/sh -c '<script>'"`. Wrapping the script keeps the account's login shell (bash, zsh, fish …) from interpreting it, so remote scripts always run under POSIX sh. The plugin never records passwords or disables host-key verification. SSH config/key setup is outside this API.
- Connection reuse is opt-in: Host option `sshMultiplexing: true` or environment `DSH_REMOTE_AGENTS_SSH_MULTIPLEX=1` adds `-o ControlMaster=auto -o ControlPath=<dir>/<hash> -o ControlPersist=60`. `<dir>` is `<state dir>/ssh`, or `/tmp/dsh-remote-agents-<uid>` when that path is too long for a Unix socket. It must be a real 0700 directory owned by the user, and anything else disables reuse. After a command times out, `ssh -O stop` retires the shared connection so new commands reconnect while running sessions continue. Claude Code SSH sessions keep their own connection. It is off by default because, after a network change, a dead shared connection can make commands to that machine time out until it is retired.
- tmux formats are `|`-separated: outside a UTF-8 locale tmux prints control characters such as tabs as `_`.
- State is atomically replaced using mode-0600 files and fsync before rename. Every change is a short transaction under an advisory `flock` on `fleet.json.writer.lock`, which the kernel releases if its holder dies, so a crash never leaves the state locked. Waiting is bounded (`STATE_LOCKED`). A `fleet.json.lock` left by older versions is unused and may be deleted. Keep the state in a trusted private directory. State contains prompts only if supplied as startup args; captured terminal text and sent text are not persisted.
- Commands have execution timeout and bounded stdout/stderr. On capture overflow, output is withheld and `truncated:true` with a diagnostic is returned. Successfully captured output is trimmed to the requested line count; `truncated` indicates known trimming, not whether older tmux history exists.
- Remote execution never runs inside a state transaction or holds a backend-wide lock, so a slow or unreachable machine delays only its own operations. Operations on one terminal record are serialized. Snapshot never launches remote operations or waits for them.
- `FleetError.code`: `INVALID_INPUT`, `INVALID_STATE`, `STATE_LOCKED`, `NOT_FOUND`, `CONFLICT`, `BUSY`, `MACHINE_REMOVED`, `UNREACHABLE`, `OWNERSHIP_UNVERIFIED`, `NOT_RUNNING`, `START_FAILED`, `OUTPUT_LIMIT`, plus the SSH codes listed under `probe` for `addMachine` with `verify`. Other OS/executor errors may propagate; the host should display sanitized `.message`.

## Static Herdr import

```js
const input = { machinesText, sessionText, projectMachineId: 'existing-fleet-machine-id' };
const preview = await fleet.previewHerdr(input);
// Display candidates and warnings; ask the user to confirm this exact plan.
const result = await fleet.importHerdr({ ...input, confirmation: preview.digest });
```

At least one of `machinesText` or `sessionText` is required. Each is UTF-8 JSON text of at most 1 MiB (2 MiB combined); they are text, not paths. The core never discovers or reads Herdr files, invokes Herdr, connects to hosts, probes programs or resumes any pane/agent during preview/import. `projectMachineId` is required whenever `sessionText` is present and must identify an **already existing**, not removed Fleet machine. There is no inferred local fallback; import machines first, then choose the target for a separate session import.

`previewHerdr` returns `{digest,machines,projects,warnings,summary}`:

- `machines`: `{name,host,user?,port?,action:'add'|'duplicate'}[]`.
- `projects`: `{name,cwd,machineId,action:'add'|'duplicate'}[]`.
- `warnings`: sanitized messages, never raw invalid targets, credentials or source fields.
- `summary`: `{machines,projects,duplicates}`; first two count **additions**, last counts all duplicates.
- `digest`: SHA-256 confirmation token binding the exact source texts (via hashes), explicit project target, sanitized plan/warnings, and existing machine/project configuration. Agent lifecycle changes, recorded connection tests (`lastCheck`) and ephemeral store namespaces are excluded.

`importHerdr` returns the preview plus `{imported:{machines,projects},importedMachineIds:string[],importedProjectIds:string[]}`. Added IDs correspond in order to `action:'add'` candidates. It recomputes preview under the exclusive state lock and rejects mismatched/missing confirmation with `STALE_PREVIEW`; preview again after any change. Validation uses `INVALID_IMPORT`. Import is additive, deduplicating machines by host (case-insensitive, canonical IPv6), user and port, and projects by machine ID/path; a removed machine counts as a duplicate with a warning to restore it; it never overwrites existing records. Retrying after success requires a fresh preview and imports zero duplicates. Source-sensitive fields are ignored and never persisted, but source text changes still invalidate confirmation.

`previewHerdr` is genuinely read-only: no parent directories, lock files, chmod, state initialization or business writes. Reads use the atomically replaced state snapshot. Confirmation prevents races with concurrent writers.

Supported official Herdr v0.9.5 persisted schemas:

- Machine catalog: `{version:1,selected_profile?:string|null,ssh:[{id,label,target,session,enabled}]}`; all profile fields required, up to 64 profiles. Source IDs are 32 lowercase hex, labels at most 128 UTF-8 bytes, session names 1–64 ASCII alphanumeric/dot/underscore/hyphen excluding `.` and `..`. Disabled or malformed/unsupported profiles are skipped with warnings. Targets support safe alias, `user@host`, and `ssh://user@host:port` (including IPv6); passwords, options, command strings, URI query/fragment/path and percent escapes are unsupported.
- Session snapshot: `{version:3,workspaces:[{identity_cwd,custom_name?,tabs:[{panes:{'0':{cwd}}}]}]}`. Each workspace's nonempty `identity_cwd` takes precedence. When absent/empty, only direct numeric pane keys in direct tabs are considered independent project candidates, with an explicit warning and normal deduplication. Invalid/relative paths are skipped; no recursive `cwd` search or `~` expansion. At most 1000 project candidates.
- Legacy/future versions are rejected rather than guessed. Catalog source location is normally `~/.local/state/herdr/client/endpoints.json` (`XDG_STATE_HOME` overrides the state root); sessions normally use `~/.config/herdr/session.json` or `sessions/<name>/session.json`. The caller must explicitly supply copied file text; these paths are documentation only.
- Herdr session selection does not migrate to the independent tmux backend. Profiles sharing a connection but differing in native session are duplicates with warnings. Commands, environment, credentials, history, `agent_resume`, `launch_argv`, `agent_session`, source IDs and native references are not imported.

Schema references: [catalog.rs](https://github.com/herdrdev/herdr/blob/v0.9.5/src/client/endpoint/catalog.rs), [snapshot.rs](https://github.com/herdrdev/herdr/blob/v0.9.5/src/persist/snapshot.rs).

Tests run using `node --test test/core/*.test.js test/import/*.test.js`; all execution is mocked, with no real SSH, agent, tmux or Herdr connection.

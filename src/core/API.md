# Core API (v1)

Dependency-free Node ESM. Import `{ FleetManager, FleetError, shellQuote }` from `src/core/index.js`.

```js
const fleet = new FleetManager({ statePath: '/absolute/private/directory/fleet.json' });
const state = await fleet.snapshot();
```

All operations are asynchronous. `statePath` is required; the host chooses its storage directory. Optional constructor parameters: `executor(file,args,options)`, `timeout=10000` ms, `maxBuffer=262144` bytes, `lockTimeout=15000` ms. The executor resolves `{stdout,stderr}` or rejects with an Error containing `code` (numeric process exit code) and optional `stderr`. Default is Node `execFile`, never `exec` or `shell:true`.

| Method | Result |
| --- | --- |
| `snapshot({readOnly=false}={})` | `{version:1,machines,agents,projects}`; stored states only, no processes/network; `readOnly:true` avoids initialization, locking, permission changes and writes |
| `addMachine({name,host,user?,port?})` | machine; host is a safe SSH alias/hostname or IP; optional user and numeric port are separate argv values |
| `removeMachine(machineId)` | `{machineId,removed:true}`; local and machines with imported projects cannot be removed; explicit stop required for every agent record; stopped records are also removed |
| `probe(machineId='local')` | `{machineId,ok,version? ,error?}`; tests SSH/tmux availability only |
| `start({machineId='local',name,cwd,kind,args=[]})` | agent; absolute cwd; kind is `dsh`, `codex`, `claude`, `shell` |
| `read(agentId,{lines=200}={})` | `{agentId,output,status,truncated,diagnostic?}`; lines 1–2000 |
| `send(agentId,{text,enter=true})` | agent; literal single-line text (1–16384 chars), optional separate Enter |
| `send(agentId,{key})` | agent; whitelist: `C-c`, `C-d`, `Escape`, `Enter`, `Tab`, `Up`, `Down` |
| `interrupt(agentId)` | same as `send(agentId,{key:'C-c'})` |
| `stop(agentId)` | agent; destroys only the verified plugin session; repeat stop is idempotent |

Machine: `{id,name,type:'local'|'ssh',host?,user?,port?}`. Local ID is `local`. Hosts allow alphanumeric/dot/underscore/hyphen aliases (starting alphanumeric) or IPv6; users match `[A-Za-z_][A-Za-z0-9_.-]{0,63}`; ports are integers 1–65535. No passwords or extra SSH options are accepted.

Project: `{id,name,machineId,cwd,source:'herdr'}`. Legacy state files without `projects` are migrated as an empty array on their next write. Project removal/editing is not exposed in this MVP; removing a machine with projects is refused rather than silently deleting mappings.

Agent: `{id,machineId,name,cwd,kind,args,session,sessionId?,owner,status,createdAt,updatedAt,stoppedAt?,diagnostic?}`. Timestamps are ISO 8601. IDs, session and owner are opaque and must not be constructed by callers.

`status` means **tmux pane lifecycle**, never model activity: `running`, `exited` (dead pane or explicitly stopped), `unknown` (unreachable, absent, output failure, or ownership unverifiable). No polling occurs automatically. `snapshot` does not refresh status; call `read`. A missing session is conservatively unknown, because it may be a connection or server failure. `probe` does not infer agent status. The shell kind starts `sh -i`; dsh starts `dsh tui`; other kinds execute their executable name with shell-quoted args after interactive shell initialization. Keep `remain-on-exit` enabled so ended commands remain inspectable.

## Safety / persistence

- Each state file has a random namespace used with `tmux -L dsh-fleet-<namespace>`; user default tmux servers are never listed or controlled.
- Project-derived session names also contain random agent IDs. Creation obtains tmux's `$N` session ID; subsequent operations target that ID (pane/window targets append `:main`). Before capture/input/stop, both exact session name and `@dsh_fleet_owner` must match the persisted record, including after server restarts where IDs can be reused. Older records without `sessionId` resolve using the exact pane target `=session:main`; a verified inspection upgrades the record. Bare `=session` is deliberately not used for session-target commands.
- Commands are checked for preexisting sessions, then exclusively created. A recovery record is reserved before creation. Initialization failure retains that record with `unknown` status and reports socket/session identifiers; if the ownership marker could not be set, automated management refuses it. No blind cleanup is attempted.
- Remote operations use `ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=8 [-l user] [-p port] -- <host> <shell-quoted-command>`. The plugin never records passwords or disables host-key verification. SSH config/key setup is outside this API.
- State is atomically replaced using mode-0600 files and fsync before rename. A sibling exclusive lock serializes multiple manager instances/processes. Lock acquisition is bounded; stale locks are **not automatically stolen**. An administrator must first establish no writer is running before removing one. Keep the state in a trusted private directory. State contains prompts only if supplied as startup args; captured terminal text and sent text are not persisted.
- Commands have execution timeout and bounded stdout/stderr. On capture overflow, output is withheld and `truncated:true` with a diagnostic is returned. Successfully captured output is trimmed to the requested line count; `truncated` indicates known trimming, not whether older tmux history exists.
- Methods on one state file are serialized, including remote execution. Snapshot never launches remote operations, but can wait behind an already-running operation on that file.
- `FleetError.code`: `INVALID_INPUT`, `INVALID_STATE`, `STATE_LOCKED`, `NOT_FOUND`, `CONFLICT`, `OWNERSHIP_UNVERIFIED`, `NOT_RUNNING`, `START_FAILED`, `OUTPUT_LIMIT`. Other OS/executor errors may propagate; the host should display sanitized `.message`.

## Static Herdr import

```js
const input = { machinesText, sessionText, projectMachineId: 'existing-fleet-machine-id' };
const preview = await fleet.previewHerdr(input);
// Display candidates and warnings; ask the user to confirm this exact plan.
const result = await fleet.importHerdr({ ...input, confirmation: preview.digest });
```

At least one of `machinesText` or `sessionText` is required. Each is UTF-8 JSON text of at most 1 MiB (2 MiB combined); they are text, not paths. The core never discovers or reads Herdr files, invokes Herdr, connects to hosts, probes programs or resumes any pane/agent during preview/import. `projectMachineId` is required whenever `sessionText` is present and must identify an **already existing** Fleet machine. There is no inferred local fallback; import machines first, then choose the target for a separate session import.

`previewHerdr` returns `{digest,machines,projects,warnings,summary}`:

- `machines`: `{name,host,user?,port?,action:'add'|'duplicate'}[]`.
- `projects`: `{name,cwd,machineId,action:'add'|'duplicate'}[]`.
- `warnings`: sanitized messages, never raw invalid targets, credentials or source fields.
- `summary`: `{machines,projects,duplicates}`; first two count **additions**, last counts all duplicates.
- `digest`: SHA-256 confirmation token binding the exact source texts (via hashes), explicit project target, sanitized plan/warnings, and existing machine/project configuration. Agent lifecycle changes and ephemeral store namespaces are excluded.

`importHerdr` returns the preview plus `{imported:{machines,projects},importedMachineIds:string[],importedProjectIds:string[]}`. Added IDs correspond in order to `action:'add'` candidates. It recomputes preview under the exclusive state lock and rejects mismatched/missing confirmation with `STALE_PREVIEW`; preview again after any change. Validation uses `INVALID_IMPORT`. Import is additive, deduplicating machines by exact host/user/port and projects by machine ID/path; it never overwrites existing records. Retrying after success requires a fresh preview and imports zero duplicates. Source-sensitive fields are ignored and never persisted, but source text changes still invalidate confirmation.

`previewHerdr` is genuinely read-only: no parent directories, lock files, chmod, state initialization or business writes. Reads use the atomically replaced state snapshot. Confirmation prevents races with concurrent writers.

Supported official Herdr v0.9.5 persisted schemas:

- Machine catalog: `{version:1,selected_profile?:string|null,ssh:[{id,label,target,session,enabled}]}`; all profile fields required, up to 64 profiles. Source IDs are 32 lowercase hex, labels at most 128 UTF-8 bytes, session names 1–64 ASCII alphanumeric/dot/underscore/hyphen excluding `.` and `..`. Disabled or malformed/unsupported profiles are skipped with warnings. Targets support safe alias, `user@host`, and `ssh://user@host:port` (including IPv6); passwords, options, command strings, URI query/fragment/path and percent escapes are unsupported.
- Session snapshot: `{version:3,workspaces:[{identity_cwd,custom_name?,tabs:[{panes:{'0':{cwd}}}]}]}`. Each workspace's nonempty `identity_cwd` takes precedence. When absent/empty, only direct numeric pane keys in direct tabs are considered independent project candidates, with an explicit warning and normal deduplication. Invalid/relative paths are skipped; no recursive `cwd` search or `~` expansion. At most 1000 project candidates.
- Legacy/future versions are rejected rather than guessed. Catalog source location is normally `~/.local/state/herdr/client/endpoints.json` (`XDG_STATE_HOME` overrides the state root); sessions normally use `~/.config/herdr/session.json` or `sessions/<name>/session.json`. The caller must explicitly supply copied file text; these paths are documentation only.
- Herdr session selection does not migrate to the independent tmux backend. Profiles sharing a connection but differing in native session are duplicates with warnings. Commands, environment, credentials, history, `agent_resume`, `launch_argv`, `agent_session`, source IDs and native references are not imported.

Schema references: [catalog.rs](https://github.com/herdrdev/herdr/blob/v0.9.5/src/client/endpoint/catalog.rs), [snapshot.rs](https://github.com/herdrdev/herdr/blob/v0.9.5/src/persist/snapshot.rs).

Tests run using `node --test test/core/*.test.js test/import/*.test.js`; all execution is mocked, with no real SSH, agent, tmux or Herdr connection.

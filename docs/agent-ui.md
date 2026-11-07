# Agent views and automatic titles

Available on `feat/rust-backend` starting with `0.5.0-alpha.1`. This document describes the development build, not the published 0.4.1 interface.

## Automatic conversation titles

An unnamed external session starts as **New conversation**. Its first user prompt supplies a local title immediately: terminal escape sequences and invisible controls are removed, whitespace is normalized, and the result is limited to five words and 40 UTF-8 bytes without splitting a character. The original message is unchanged. This is a deterministic first-prompt title; it does not make an additional model request.

Renaming a session or supplying a name at creation pins that name. Later messages, retries and restarts preserve it. **Use automatic title** in the session menu restores the saved first-prompt title; it is disabled when automatic naming is already active. The title seed survives transcript retention. Old generic `claude chat`, `codex chat` and `omp chat` titles are backfilled from retained history; old custom names remain manual.

Native DSH sessions continue to use DSH's own title service.

## Views by agent

| Agent | Views | Details |
| --- | --- | --- |
| Claude Code | Chat / Tools / To-dos | Recorded tools filter by files, commands and agent calls. The latest recorded to-do list has its own view. |
| Codex | Chat / Plan / Changes | Recorded plan steps and file-change events have separate views. Valid unified diff hunks use DSH's native colored diff component. |
| OMP | Chat / Tasks / Tools | Task phases are retained, with completed, active and pending items. Tools filter by files and commands; model entries retain provider information. |

Tabs support Left/Right, Home and End keys. Switching views keeps the composer and its draft, approval controls, settings and stop control mounted. Opening a different conversation returns to Chat. Suggested prompts in an empty conversation only fill the draft; sending remains explicit.

Settings retain each provider's actual permissions and reasoning choices. The labels distinguish Claude effort, Codex reasoning effort and OMP thinking level. No new view changes permissions or starts an agent process by itself.

## Recorded-data limits

These views summarize conversation records, not a live repository scan. Overview tool lists show retained previews in batches of 40. From alpha.3, each archived turn also exposes full-tool search and 16-record pagination; full values and JSONL export are available there. The task view displays the latest recognized list, including task updates after the first 16 calls. Missing task data is not interpreted as completion.

Codex changes show recorded patch hunks, not reconstructed full files. Malformed, headerless or unsupported patches retain their raw representation. When saved data was shortened, the view shows a notice and a route back to conversation history. Existing full-history loading remains in Chat.

## Desktop source references

The implementation was checked against the installed DSH `0.2.2-rc.1` sources:

- `dsh-session-title/lib/types/normalize.js` and `dsh-base/cordis.patch.yml`: normalized first-prompt fallback and the five-word / 40-byte fallback limits.
- `dsh-session-title/lib/types/index.js`: manual title protection.
- `dsh-client-ui-conversation/lib/client.js`, `ConversationSessionHeader`: native view-row layout and accessible tab semantics.
- `dsh-client-ui-tool/lib/types/client/tool/models/diff-card-model.d.ts`: native diff snippet shape.

The plugin uses DSH theme tokens and shared rendering primitives. It does not patch the desktop packages.

## OMP color accents (alpha.2)

OMP views add semantic colors within the native DSH layout: amber headings and commands, cyan paths and file reads, green edits/completed tasks, purple task tools and higher thinking levels, and red failed tools. Phase headers cycle through purple, cyan and amber; their status labels remain independent of that color. Model names use the pink accent of OMP's status line.

The palette follows the concepts in OMP's built-in `dark.json` and `light.json` themes (locally inspected npm source 16.3.12), with adjusted shades for readable DSH cards. It follows DSH's selected light/dark appearance and respects forced-color mode. Native Markdown syntax highlighting and diff colors are retained. These are web presentation accents, not an import of terminal ANSI output or the user's custom OMP theme. Other agents keep their existing colors.

## Validation

Rust and bridge regression tests cover title migration, Unicode bounds, manual rename, duplicate sends and restart persistence. React tests cover agent-specific tabs, draft retention, keyboard navigation, approval/stop controls, OMP phases and structured diff fallback. An isolated DSH web profile with synthetic conversations exercises the same client and Rust backend with native DSH components; no production conversations or provider credentials are used in that visual check.

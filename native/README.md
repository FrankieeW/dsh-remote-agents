# Rust backend

`main` (`0.5.0-alpha.5`) replaces the JavaScript business backend with a Rust sidecar. The frozen legacy JavaScript 0.4.1 release remains the npm `latest` channel until the Rust line is published as stable.

## Boundary

- `src/index.js`, `src/transport.js`, `src/native/client.js`: DSH registration, authenticated owner-only Fetch carrier, bounded stdio transport and native binary lifecycle.
- `src/native/claude-bridge.js`: the official Claude Agent SDK invocation and raw event/approval transport only. Rust validates settings, interprets events, owns conversation state, and decides how approvals are resolved. SSH command construction for the SDK runs through the Rust executable.
- `native/src/engine.rs`: RPC dispatch and coordination between session operations, CLI updates and shutdown.
- `chat.rs`, `common.rs`: persisted state, exclusive live ownership, atomic mode-0600 writes, idempotent admission, settings revisions, metadata, search/export and live-only approvals.
- `chat_commands.rs`: shared slash-command catalog, parsing, lifecycle checks, settings/metadata operations, export and atomic request-deduplicated fresh conversations. Commands run without a provider prompt; only model catalog discovery needs a CLI.
- `hosts.rs`, `fleet.rs`, `herdr.rs`: registered SSH hosts, directory browsing, dedicated tmux socket ownership, and static preview/confirmed import. No default tmux sessions or unrelated native conversations are controlled.
- `protocol.rs`, `runtimes.rs`, `providers.rs`: bounded framing, OMP v2 chunk assembly, native Codex app-server, Claude SDK events, lifecycle, model/configuration metadata and source-aware pinned updates.
- `history.rs`: indexes native OMP JSONL parent links and byte offsets, then reads only the selected records. It validates session/cwd identity and ordered prompt hashes. Provider envelopes and credential identifiers are excluded from responses.
- `omp_config.rs`: reads OMP role/model metadata, applies validated field-scoped YAML changes with conflict detection and backups, and keeps configured credentials out of browser responses. Local and SSH writes share the same validation.

There is no added HTTP server, no native-code download at runtime, and no silent fallback to the old JavaScript backend. Existing `version: 1` fleet/conversation files and native session identities are retained. Restarted in-flight turns become interrupted and require an explicit new message. The retained UI preview limits remain explicit; native OMP history is available on demand.

## Build and validate

```sh
npm ci --ignore-scripts
npm run check
npm run test:package
npm run test:smoke
```

`npm run build` compiles the Rust executable and the JavaScript UI/transport. `Cargo.lock` pins Rust dependencies. End users install a prebuilt npm package and do not need Cargo.

The existing JavaScript implementations now live only under `test/reference/` as contract oracles. Their tests are not evidence that the Rust implementation works. The Rust runtime has separate process-based integration tests, native unit tests, an installed-package test using the shipped binary and client factory, and a real isolated tmux lifecycle test. Test CLI replies and UI primitives are deterministic fixtures; live-provider checks are separate.

## Distribution

The `Native distribution` workflow builds and tests:

- macOS arm64 and x64 (deployment target macOS 11).
- Linux arm64 and x64 using musl targets, without a runtime glibc dependency.

Each artifact contains `<platform>-<arch>/backend`. The assembly job merges all four into `lib/native/`, restores executable permissions, packages with `npm pack --ignore-scripts`, and runs the installed-package test on that exact archive. Branch pushes and manual runs upload the archive for download. A `v<version>` tag push also publishes that verified archive to npm after checking that the tag matches the version inside the archive. The alpha package uses the `next` dist-tag from `publishConfig.tag`.

Configure a GitHub Actions trusted publisher in the npm settings for `dsh-remote-agents` using these values.

| Field | Value |
| --- | --- |
| Organization or user | `FrankieeW` |
| Repository | `dsh-remote-agents` |
| Workflow filename | `native-binaries.yml` |
| Environment name | Leave empty |
| Allowed actions | Enable `npm publish` |

The publish job uses a GitHub-hosted runner, Node.js 24, npm 11 and `id-token: write` for OIDC authentication. npm requires the first successful publish within two days of adding a trusted publisher. [npm trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/)

For a manual assembly after downloading the workflow artifacts:

```sh
npm run build
node scripts/assemble-native.mjs native-artifacts
npm pack --ignore-scripts
```

`DSH_NATIVE_TARGET` is a development/build setting, not a browser-controlled option. Supported values are `aarch64-apple-darwin`, `x86_64-apple-darwin`, `aarch64-unknown-linux-musl` and `x86_64-unknown-linux-musl`. A normal local build includes only the current platform. Installing it on another architecture fails with an actionable missing-binary error.

Finish active work before switching the desktop application to a different backend. Validation uses isolated state paths and never rewrites the running desktop profile.

On Electron hosts, the application executable is not used as a Node CLI. The
Rust Claude transport locates a standalone `node` via PATH and conventional
installation locations (or the trusted host's `nodeExecutable` override). This
requires Node.js 22+ for Claude's SDK bridge on desktop hosts; Codex and OMP do
not use that bridge. No extra desktop application is launched during discovery.

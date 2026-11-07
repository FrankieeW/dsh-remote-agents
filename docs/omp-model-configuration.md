# OMP model configuration (0.5.0-alpha.5)

Open the **Models** tab in an OMP conversation, or **Manage OMP roles and providers…** from its model settings. The editor is scoped to that conversation's machine and workspace. Configuration management is validated against OMP **18.18.x**; the older conversation compatibility range is unchanged.

Switching conversation tabs keeps staged configuration edits and the message draft. Save or discard configuration edits before using **Back to conversation**. Opening another conversation resets the editor to that conversation's machine and workspace.

## Model roles

The editor includes all 16 built-in roles and configured custom roles. Edit **OMP global defaults** or **This project overrides** for the conversation's workspace. Role selectors accept catalog models or OMP role aliases. The currently effective value comes from OMP's configuration CLI and is shown separately from the layer being edited. Direct alias cycles are rejected.

Global settings belong to the machine's active OMP profile, as reported by `omp config path`. Project edits target `<workspace>/.omp/config.yml`; missing assignments inherit global defaults. Existing environment, vendor-project or extra-config overlays may still take precedence. Default thinking, role cycle order and named model presets are editable. Preset application stages a draft; **Save role configuration** commits it.

Current-conversation model/thinking overrides remain in the conversation composer. They do not modify these shared configuration files. Active OMP turns owned by this plugin block shared configuration saves on that machine. Other native OMP clients may observe shared configuration changes through OMP's own file watching.

## Providers and custom models

Provider connections use the active profile's `models.yml` (or existing `models.yaml`). Manage endpoints, API protocols, authentication mode and model discovery. Configure custom models or add overrides for models selected from the catalog. The model form exposes input types, reasoning/tool support, context/output limits, thinking controls and prices.

The catalog includes all model kinds and supports provider, kind and text filters. It is read using `models --kind all --json --no-extensions`; extension discovery is intentionally disabled. Catalog discovery may contact configured model-list endpoints, but this editor sends no model prompt and does not run a model/credit test on save. If catalog resolution fails, parseable existing configuration remains editable.

Existing credentials are never returned to the browser. Choose **Keep unchanged**, set an environment variable reference, enter a new write-only key or explicitly remove the key. An existing bare credential is masked even if it looks like an environment variable name: it may actually be a literal key. Environment references must be set where OMP runs. OAuth sign-in and account storage remain managed by OMP; this editor does not import, export or edit OAuth tokens. Shell-command credentials can be preserved but cannot be newly entered here. Existing private endpoint components are hidden and preserved until the endpoint is explicitly replaced.

## Saving and preservation

- Saves are explicit and field-scoped. Each patch carries the selected file's revision; stale revisions fail without writing. Save errors keep the form draft. There is no automatic retry.
- YAML edits preserve other fields and comments outside the edited value. Replacing a model array or an individual structured value may reformat that value; unknown model/provider fields are retained. Unsupported alias-backed edit targets fail rather than being flattened.
- Files are written atomically with owner-only permissions. Existing files receive a sibling `*.dsh-backup-<UUID>` backup, also owner-only. Existing file symlinks are preserved and their resolved target is checked before writing. Backups are not automatically deleted.
- The file is read back after save. A later catalog-refresh failure is reported separately from a completed save. This is not a multi-file transaction: role configuration and provider/model definitions are saved separately.
- Local and registered SSH machines share validation. Remote file transfer uses stdin (not process arguments for credential values), a bounded read, conflict checks and an atomic replacement. Remote hosts need a POSIX shell, `realpath`, `base64` and `sha256sum` or `shasum`. Saving configuration never installs those utilities.

## Source references and verification

The implementation follows the pinned OMP [role definitions](https://github.com/can1357/oh-my-pi/blob/v18.18.0/packages/coding-agent/src/config/model-roles.ts), [model settings](https://github.com/can1357/oh-my-pi/blob/v18.18.0/packages/coding-agent/src/config/model-settings.ts), [provider/model schema](https://github.com/can1357/oh-my-pi/blob/v18.18.0/packages/coding-agent/src/config/models-config-schema-bundle.ts) and [config CLI scope behavior](https://github.com/can1357/oh-my-pi/blob/v18.18.0/packages/coding-agent/src/cli/config-cli.ts).

Rust tests cover credential projection, preservation, invalid values, alias cycles, symlink handling, stale writes and the remote transfer script. Component tests cover staged edits, scope/revision binding, credential preservation and conflict handling. An isolated OMP 18.18.0 profile verifies native CLI readback of project overrides and custom models. No production credentials, global role assignments or remote configurations are changed by those tests.

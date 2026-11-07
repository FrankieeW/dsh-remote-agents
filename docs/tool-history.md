# Complete tool history (0.5.0-alpha.3)

New Claude, Codex and OMP turns save every tool event received by the plugin into host-owned files under `tool-history/<session>/<assistant-message>/`, beside `conversations.json`. Local and SSH runtime events use the same archive. Inputs and results are stored as complete JSON values; streamed text is written without the old 4,096-character storage cutoff. These files use owner-only permissions and no browser-supplied paths.

The conversation snapshot remains small: its latest 16 tools have bounded previews, in call order. New calls replace the oldest preview, and restart or OMP-history recovery restores the same latest window. **Showing latest 16 of N tool calls** describes the view, not discarded data. **Browse saved tools** opens the archive from its first page and replaces the visible 16-call page, keeping DOM size bounded. **Read full input/result/text** pages through complete values in chunks up to 64 KiB, without splitting UTF-8 characters. Refresh archived pages explicitly to see newer tool state during a turn.

Search scans full stored input, result and streamed-text files, plus tool names. It uses a literal match (ASCII case-insensitive; other Unicode exact), including content beyond the preview. Search runs outside the conversation state lock so it does not block a running turn's event handling.

**Export full tools (JSONL)** downloads one record per tool in the selected turn, including complete input, result and streamed text. Export is available after that turn stops and does not use the search filter. The browser assembles a download from bounded RPC chunks; very large downloads still require browser memory. The existing conversation Markdown/JSON export remains a preview export and is not a substitute for this full-tool export.

## Existing OMP sessions

For an older local OMP turn, choose **Recover full tools from OMP**. The importer checks the native session identity, working directory, parent chain and ordered prompt hashes before copying complete tool inputs/results. It leaves the OMP original unchanged and marks the result as a recovered snapshot. Stop active plugin turns before recovery. Missing files, mismatched histories or files exceeding the native reader's 256 MiB indexing bound return an explicit error. Provider credential envelopes are not copied.

Older remote OMP records cannot be backfilled by this local reader. New SSH turns archive received events on the DSH host, even when the UI is closed. Events never delivered because an SSH connection broke cannot be reconstructed. Native protocol/frame limits still apply; the plugin cannot recover data the CLI itself omitted.

## Durability and limits

Full fields are saved separately from the bounded transcript JSON. Every write checks its result. A storage failure requests cancellation, exposes a persistent per-turn history error and prevents a successful completion status from hiding it. Restart reconciles previews with saved tool indexes. Interrupted records are identified as having no recorded completion.

Archives increase disk usage and are not silently pruned by the preview's 200-message retention. Request ownership receipts remain the authority for archive access, including turns outside the retained preview. There is no new automatic archive deletion. A full disk or an invalid archive is an error, not a fallback to silent truncation. The tool index has an explicit 8 MiB safety bound; individual provider transport bounds remain unchanged.

Assistant reply-text retention, conversation-count limits and the main sidebar's retained-message search are separate features and remain unchanged. The new search and full export operate on one turn's tools.

# Changelog

All notable changes to this project are documented here. The format follows Keep a Changelog and the project uses semantic versioning.

## [Unreleased]

### Added

- `/btw <question>`: a quick question answered in a separate, persistent side session per chat, kept out of the current work session and its queue.
- `surfaceHint` (default `true`): Telegram prompts are prefixed with `[surface: telegram]`, so an instruction file can apply channel-specific reply rules. Set it to `false` for untagged prompts.

### Changed

- `prompt.md` detects the OS first and gives Windows, macOS and Linux commands. `install` now prints the Linux linger and macOS login caveats.

## [2.0.0] - 2026-10-23

Complete rewrite of the gateway in strict TypeScript, keeping the v1 `config.json`, `state.json` and command surface compatible.

### Added

- Per-session prompt queue with position feedback, `/queue`, `/clear`, and a configurable depth.
- Exponential backoff with jitter for Telegram and OpenCode calls; Telegram 429 `retry_after` is honored.
- Single-instance lock (`gateway.lock`) with stale detection.
- Graceful shutdown on SIGINT/SIGTERM: in-flight work is aborted, permissions auto-denied, state flushed, lock released.
- Persistent Telegram offset with the same update never silently dropped.
- Message splitting at paragraph, line and code-fence boundaries, never inside a code block; oversized replies become `.md` documents.
- Markdown send with automatic plain-text fallback when Telegram rejects entities.
- OpenCode auto-reconnect: credentials and base URL are re-read on 401 and connection errors.
- `install`, `start`, `stop`, `restart`, `status`, `doctor` and `setup` subcommands (Windows scheduled task, systemd user unit, launchd agent).
- Live progress message, deleted when the answer arrives; `/verbose` for the tool feed.
- Inline keyboards with pagination for `/sessions` and `/active`.
- `/delete` with an inline confirmation step: owner-only, expires after 2 minutes, clears the chat selection and the cached list entry.
- Forum topic mode: one topic maps to one session.
- `/model`, `/agent`, `/compact`, `/undo`, `/redo`, `/diff`, `/todo`, `/cost`.
- Permission UX with risk labels, human summaries, configurable auto-deny, and post-decision message edits.
- Reply threading and per-topic session resolution.
- Inbound files and photos saved to `inbox/<chat>/`, size and type limited.
- Voice notes through a pluggable STT command; the transcript is echoed before it runs.
- `/sendfile` with an outbound path allowlist and size cap.
- Roles: `owner`, `operator`, `viewer`.
- `/lock` and `/unlock` kill switch; optional `GATEWAY_PIN`.
- Per-user rate limiting and an append-only JSONL audit log with rotation.
- Outbound secret redaction for tokens, keys, JWTs, private keys and `.env` assignments.
- `/schedule`, `/cron`, `/jobs`, `/cancel` with persisted jobs.
- `/health`, structured JSON logging, heartbeat file.
- Loopback-only optional webhook for local scripts and CI.
- Plugin hooks: `onPrompt`, `onReply`, `onPermission`.
- 37 unit tests, GitHub Actions CI, Dockerfile and docker-compose example.

### Changed

- Rewritten from a single `bridge.mjs` into typed modules. `bridge.mjs` remains as a shim to `dist/index.js`.
- Logs are JSON lines in `bridge.log`, rotated at 5 MB.
- `state.json` is versioned and migrates the v1 layout automatically.

### Fixed

- Permission deduplication now keys on the OpenCode request id.
- Stale permission prompts no longer accumulate.
- `notify.mjs` reads the same config path as the gateway.
- Emoji and glyphs removed from output.

## [1.0.0]

Initial working bridge: Telegram long polling, session switching, permission buttons, `/remember`.

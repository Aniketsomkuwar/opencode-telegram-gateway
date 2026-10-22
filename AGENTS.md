# AGENTS.md

Telegram gateway for local OpenCode sessions. TypeScript, ESM, **zero runtime dependencies**, outbound-only (long-poll Telegram + HTTP to local OpenCode). See `README.md` for features and `docs/opencode-api.md` for the OpenCode routes.

## Commands

```bash
npm run build      # tsc -> dist/ (required before run/test)
npm test           # runs build first, then node --test "test/*.test.ts"
npm run typecheck  # tsc --noEmit
npm run dev        # node --watch src/index.ts run (from source)
npm start          # node dist/index.js run
```

- CI (`.github/workflows/ci.yml`) runs `npm ci` -> `typecheck` -> `test` -> `npm audit --omit=dev --audit-level=high` on Node 22 and 24. Match that order locally.
- Runtime needs Node 20+; the test runner needs Node 22.18+ (native TS stripping). Do not promise a Node 20 test run.
- Tests import compiled code (`../dist/*.js`), so any unchanged test run needs a prior `npm run build`. To run one file: `npm run build && node --test test/turn.test.ts`.
- `tsconfig.json` `include` is `src/**/*.ts` only. **Test files are not typechecked** by `npm run typecheck`; a broken test only fails in `npm test`.

## Layout

- `src/index.ts` - CLI entrypoint. Commands: `run`, `install`, `start|stop|restart`, `status`, `doctor`, `setup`, `version`. Global flags `--home` / `GATEWAY_HOME`, `--force`.
- `src/gateway.ts` - the orchestrator: Telegram update loop, command dispatch, prompt turns, watch/scheduler wiring. Most behavior changes land here.
- `src/opencode.ts` / `src/telegram.ts` - the two HTTP clients.
- `src/config.ts` - config load/validate/env, path resolution. `src/state.ts` - persisted offset/chats/jobs (atomic writes). `src/queue.ts` - per-session FIFO. `src/permissions.ts` - approval cards, risk labels, timeout.
- `src/lifecycle.ts` - `install`/`setup`/`doctor`/service control (logon task, systemd, launchd).
- `bridge.mjs` - compat shim that just imports `dist/index.js`. `notify.mjs` - one-off owner message. Keep both working; scheduled tasks and docs reference `node bridge.mjs`.
- `deploy/windows-scheduled-task.ps1` - reference task definition; prefer `node dist/index.js install`.

## Config and runtime home

- Home defaults to `~/opencode-telegram` (`GATEWAY_HOME` or `--home` overrides). Holds `config.json`, `state.json`, log, `audit.jsonl`, `inbox/`. All are gitignored; never commit them.
- `config.example.json` is the documented shape. `TELEGRAM_BOT_TOKEN` overrides `botToken`; `GATEWAY_PIN` and `GATEWAY_WEBHOOK_SECRET` come from env only and are never written to disk.
- OpenCode URL/credentials are discovered (not configured) from `~/.config/opencode/service.json` plus `GET /api/info`, and re-read on 401/connection loss. Do not hardcode either.
- `dist/` is gitignored and rebuilt; never hand-edit it.

## Constraints (do not violate)

- **Outbound only.** Never add an inbound listener, port, tunnel, or firewall rule. The optional webhook is off by default and loopback-only.
- Never print, log, or commit the bot token or other secrets. Outbound text is run through `src/redact.ts`; keep it that way.
- Only one instance may run per home (`gateway.lock`). Starting a second exits with `another gateway is already running` - do not delete the lock unless the recorded pid is dead.
- The gateway prompts a session only when it is idle; it deliberately does not steer a running TUI turn.

## Editing gotchas

- Files are ESM with `.js` import specifiers pointing at TypeScript sources (NodeNext). Follow that convention; do not add extensionless imports.
- This repo is edited on Windows/PowerShell and previously shipped UTF-8 BOMs that had to be stripped (`git log`). Write files as UTF-8 **without** BOM; `src/index.ts` defensively strips a BOM when reading `package.json`.
- `forceConsistentCasingInFileNames` is on: import paths are case-sensitive in CI even when the local filesystem is not.

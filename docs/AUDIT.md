# Repo audit — opencode-telegram-gateway

Phase 0, STEP 0. Research only — no feature code written here. This document records the current state of the gateway so the phased plan has a factual baseline.

Repository: `E:\opencode telegram gateway` (public: `https://github.com/Aniketsomkuwar/opencode-telegram-gateway`, commit `4341679`).
OpenCode service: v2.1.2, local HTTP API at `http://127.0.0.1:45278` (also `192.168.1.9:45278`), Basic auth user `opencode`, password in `%USERPROFILE%\.config\opencode\service.json`.

## 1. Architecture (current)

A single Node.js script, `bridge.mjs`, plus a one-shot `notify.mjs` helper. Everything lives in one file:

- **Config load:** reads `config.json` (`botToken`, `allowedUserIds`, `ownerChatId`, `verbose`, `watchAll`, `notifyToolCalls`, `rememberScript`). Exits if missing or if the token is the placeholder.
- **OpenCode discovery:** reads `service.json` for the password, calls `GET /api/info` to discover the service URL (fallback `http://127.0.0.1:45278`), builds an `Authorization: Basic opencode:<password>` header.
- **Telegram polling:** `getUpdates` long polling (timeout 50s, `allowed_updates: ['message','callback_query']`) in an infinite loop, offset persisted to `state.json` (`__offset`).
- **Command dispatch:** `/start|/help`, `/ping`, `/sessions`, `/active`, `/use <n>`, `/new [title]`, `/newdir <path> [title]`, `/status`, `/stop`, `/remember <text>`, `/watch on|off`, `/ping`; any other text is a prompt sent to the current session.
- **Prompt execution:** `runPrompt()` POSTs to `/api/session/{id}/prompt`, then polls `GET /api/session/{id}/message?limit=100` every 1.5s until an `idle` message appears. While polling it also checks `GET /api/session/{id}/permission` and surfaces permission requests as inline buttons (Once / Always / Deny).
- **Output delivery:** final assistant text sent via `sendMessage`; tables converted to bullets; long text split at ~3800 chars; `sendChatAction: typing` heartbeats every 45s.
- **Background watcher:** `watchTick()` every 6s polls `GET /api/session/active` and sends a one-line "done" notice when a tracked session stops (only if `watchAll`).
- **Process model:** runs as Windows scheduled task `OpenCodeTelegramBridge` invoking `node.exe` directly (previous `cmd.exe` wrapper died with `^C`). Restarts up to 5 times on failure.
- **Config:** `config.json` is gitignored. `notify.mjs` reads from the same `config.json`.

### What is missing (by design, v1)

- No TypeScript, no tests, no CI, no Dockerfile.
- No config schema validation, no env var secret support.
- No delivery ledger, no heartbeat, no watchdog, no single-instance lock.
- No per-session queue, no pagination, no inline keyboards for session selection.
- No message splitting beyond a naive 3800-char cut; no code-fence awareness.
- No permission UX beyond raw action name + resources; no auto-deny timeout, no audit log.
- No secret redaction in outbound output.
- Telegram hard-coded; no adapter abstraction.

---

## 2. Failure modes

| # | Failure mode | Impact | Current handling |
|---|---|---|---|
| F1 | Two gateway instances poll the same bot token | Telegram returns HTTP 409 conflict; one instance silently stops receiving updates | None — we already hit this (`cmd` wrapper + scheduled task both running). |
| F2 | Gateway crashes mid-run | In-flight prompt's final reply is lost; `state.json` offset may be ahead of what was actually delivered | None — offset saved before delivery confirmed. |
| F3 | Telegram 429 rate limit | `getUpdates` or `sendMessage` fails; no backoff → tight error loop every 3s | Logs and sleeps 5s on non-ok; no `retry_after` honor. |
| F4 | OpenCode service restarts (new port/password) | `discover()` runs once at startup; subsequent API calls fail with 401/connection refused | None — `discover()` is one-shot. |
| F5 | Two prompts sent to the same OpenCode session concurrently | OpenCode rejects with session-busy; second prompt's output interleaves or is lost | None — no per-session queue; `busySessions` set exists but is only used to suppress watch notifications. |
| F6 | Reply longer than Telegram's ~4096 char limit | Message truncated or rejected | Naive split at 3800 chars, can cut inside code blocks or Markdown constructs. |
| F7 | Permission prompt sent but user never replies | Prompt stays in `pendingPerms` forever; memory grows; prompt reappears every poll cycle | None — `pendingPerms` never expires. |
| F8 | `state.json` corrupt or partial write | Gateway crashes on startup (`JSON.parse` throws) | None — no try/catch with fallback to empty state. |
| F9 | `rememberScript` missing or hangs | `/remember` rejects; error surfaced to user; `execFile` has 30s timeout | Partial — timeout exists, but no validation that script exists before invoking. |
| F10 | Scheduled task runs while a foreground instance is also running | Two instances → 409 conflict (same as F1) | None — task has no mutual exclusion. |

---

## 3. Security risks

| # | Risk | Severity | Current state |
|---|---|---|---|
| S1 | Bot token in `config.json` (gitignored, but on disk in plaintext) | High | Token readable by any process running as the user. |
| S2 | `allowedUserIds` is a single flat list — no tiers, no pairing | Medium | Any allowed user has full remote-control access including destructive tools. |
| S3 | OpenCode service binds to `0.0.0.0` (confirmed in `service.json`) | High | API reachable on LAN (`192.168.1.9:45278`) with Basic auth; anyone on Wi-Fi who guesses/finds the password has full agent control. |
| S4 | Permission buttons expose raw action name + resource paths | Low | No risk labels, no human summary, no auto-deny timeout, no audit of who approved what. |
| S5 | Outbound output may contain secrets (API keys, tokens, `.env` values) | High | No redaction; anything OpenCode prints is sent verbatim to Telegram. |
| S6 | `rememberScript` executes arbitrary command with user-supplied text | Medium | Script path from config; text passed as argument. PowerShell `-ExecutionPolicy Bypass`. |
| S7 | No rate limiting per user | Medium | A single allowed user can flood prompts; no protection against accidental or abusive loops. |
| S8 | `state.json` and `bridge.log` may contain prompts and output | Medium | Logs/appends to `bridge.log`; state contains session IDs and offset. Both gitignored but on disk. |

---

## 4. Race conditions

| # | Race | Consequence |
|---|---|---|
| R1 | Two `getUpdates` pollers for the same token | HTTP 409; Telegram terminates one session arbitrarily. |
| R2 | Two prompts to the same OpenCode session without waiting for `idle` | `SessionBusyError`; second prompt may be rejected or interleaved. |
| R3 | Offset saved to `state.json` before the reply is delivered | On crash, the update is considered consumed → the user's message is lost. |
| R4 | `watchTick()` and `runPrompt()` both read `activeIds()` concurrently | No shared state corruption (read-only), but inconsistent "done" notifications possible. |
| R5 | `pendingPerms` mutated while the poll loop iterates it | Minor; the spread `[...pendingPerms.values()]` creates a snapshot, so safe in practice. |

---

## 5. Telegram limits that can break it

| Limit | Value | Impact on us | Mitigation needed |
|---|---|---|---|
| Message text length | 4096 chars | Long OpenCode replies truncated/rejected | Smart split at paragraph/code-fence boundaries; offer `.md` file for very long output. |
| `getUpdates` long-poll timeout | max ~300s recommended; we use 50s | Fine, but more frequent reconnects than necessary | Could increase to ~100s for efficiency. |
| Rate limits | 429 with `retry_after` | Temporary 429s on burst | Honor `retry_after`; exponential backoff with jitter. |
| BotCommands menu cap | 100 commands (Hermes defaults to 60 for reliability) | We register 9 commands — within limit | Keep under 60. |
| MarkdownV2 escaping | Special chars `_ * [ ] ( ) ~ ` > # + - = | { } . !` must be escaped | We use `parse_mode:'Markdown'` (legacy) and a partial `esc()`; incomplete escaping can break rendering or be rejected. |
| Inline keyboard callback_data | 64 bytes max | Our `key:decision` keys are short — fine | Keep keys short. |
| Message edits | 4096 char limit; edit flood limits | Progress editing must be throttled | Throttle `editMessageText` (e.g., max once per 1-2s per chat). |

---

## 6. Tech debt

| Item | Detail |
|---|---|
| TD1 | Single-file `bridge.mjs` (~416 lines) — hard to test, no module separation. |
| TD2 | No config schema validation; missing keys produce undefined behavior at runtime. |
| TD3 | No env var support for the token; secret lives only in `config.json`. |
| TD4 | `notify.mjs` had a path bug (read `.opencode-telegram` but wrote `opencode-telegram`) — now fixed, but shows config-path drift risk. |
| TD5 | No tests of any kind. |
| TD6 | No CI, no lint, no typecheck. |
| TD7 | `watchAll` sends raw `✅ done` (now de-emoji'd) with no context; no opt-out per session. |
| TD8 | `/status` still used symbols (`▸`, `▶`, `○`) in one place — being removed in current fix commit. |
| TD9 | No graceful shutdown on SIGINT/SIGTERM — being added. |
| TD10 | No single-instance lock — 409 conflicts possible. |

---

## 7. OpenCode event-stream check (verified against running service)

Checked `/openapi.json`, `/v2/openapi.json`, `/swagger.json`, `/docs/openapi.json`, `/api/openapi.json` on the local service.

- `/openapi.json` and `/v2/openapi.json` return a valid OpenAPI spec with components and tags. The spec includes an `event` tag described as "Experimental event stream routes" and `Session.Inbox.*` schemas with a `delivery` enum of `"steer queue"` — suggesting OpenCode may expose an event stream / inbox delivery model.
- However, the paths enumeration returned 0 keys via the quick check, so the exact event-stream path and payload shape were not confirmed. Other candidate paths (`/api/openapi.json`, `/docs/openapi.json`, `/swagger.json`, `/api/swagger.json`) return 404 or HTML.

**Finding:** OpenCode *may* support an event stream (the `event` tag + `Session.Inbox` schemas are suggestive), but this is unverified. Message-stream polling (`GET /api/session/{id}/message`) remains the confirmed working transport. Do not replace polling with SSE/WebSocket until the `event` routes are enumerated and tested.

**Fallback plan:** Keep polling; add a `doctor` check that probes `/api/info` and the session message endpoint. If the event stream is confirmed later, Phase 5 can add it as an optional transport.

---

## 8. Referenced decisions (from Hermes comparison)

See `docs/HERMES-COMPARISON.md` for the full ADOPT/ADAPT/SKIP analysis. Key decisions carried into this audit:

- **ADOPT** `gateway install|start|stop|status|restart|ensure|setup` lifecycle.
- **ADOPT** per-home service naming to prevent service hijacking.
- **ADOPT** hidden `wscript`+`.vbs` launcher on Windows (fixes our `^C` console bug).
- **ADOPT** `doctor` command.
- **ADOPT** `setup` wizard with token validation via `getMe`.
- **ADOPT** flat `allowedUserIds` (backward compatible); **ADAPT** optional `adminUserIds` subset.
- **SKIP** DM pairing (single-user focus).
- **ADOPT** delivery ledger for at-least-once outbound delivery (Phase 3).
- **ADOPT** `gateway_state.json` heartbeat + stale detection (Phase 2).
- **ADAPT** event-loop watchdog — our scheduled task already restarts; add heartbeat file instead.
- **SKIP** SIGUSR2 stack dump (Windows-focused project).
- **ADOPT** adapter interface (Telegram first, Discord/Slack later) — define in Phase 1, implement in Phase 5.
- **ADOPT** forum topics mode (Telegram DM topics → one session per topic).

---

## 9. Phased plan (proposed)

| Phase | Focus | Effort |
|---|---|---|
| Phase 0 | Research & audit (this doc + `docs/HERMES-COMPARISON.md`) | S |
| Phase 1 | Reliability foundation (offset persistence, backoff+429, single-instance lock, graceful shutdown, per-session queue `/queue`/`/clear`, 4096-char smart splitting, safe Markdown with plain-text fallback, auto-reconnect, timeouts everywhere, `gateway install|start|stop|status|ensure`, `doctor`) | M |
| Phase 2 | UX (live progress editing, inline keyboards + pagination, forum topics mode, `/model`, `/agent`, `/compact`, `/undo`, `/redo`, `/diff`, `/todo`, `/cost`, permission UX with risk labels + auto-deny, reply threading, setup wizard) | M |
| Phase 3 | Media & input (inbound files/photos, voice notes via pluggable STT, outbound file send button + path allowlist) | M |
| Phase 4 | Security (env var secrets, config schema validation, roles owner/operator/viewer, PIN/TOTP re-auth, `/lock` kill switch, per-user rate limiting, append-only audit log with rotation, output secret redaction, bind-address warning, threat model update) | M |
| Phase 5 | Automation & ops (`/schedule`, `/cron`, `/jobs`, `/cancel`, localhost-only webhook trigger, completion notifications with duration/cost, `/health`, structured JSON logging, platform adapter interface, plugin hooks `onPrompt`/`onReply`/`onPermission`) | L |
| Phase 6 | Quality bar (TypeScript strict, tests with mock Telegram + mock OpenCode servers >80% core coverage, GitHub Actions CI, Dockerfile + docker-compose, README rewrite, `CHANGELOG.md`, semver) | L |

**Acceptance criteria (from plan):**
- Kill and restart mid-run: no duplicate or lost messages.
- 3 prompts quickly to one session: queue in order with feedback.
- 20k-char reply arrives intact (split or as file) with no broken formatting.
- Forum topic maps to its own session, runs concurrently with other topics.
- Permission request shows clear summary, times out safely, is audit-logged.
- Secret in OpenCode output never reaches Telegram unredacted.
- `doctor` reports bad token, unreachable OpenCode service, non-local bind.
- CI green; `git status` shows no secrets or state files.

---

## 10. Immediate next step

Show `docs/HERMES-COMPARISON.md`, `docs/AUDIT.md`, and this plan for approval. No feature code is written until approved. Then proceed phase by phase, running tests after each phase, updating docs, and giving a short summary after each phase.

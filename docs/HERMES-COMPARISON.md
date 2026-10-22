# Hermes Agent comparison --- reference for opencode-telegram-gateway

Source studied: Nous Research Hermes Agent (MIT License). Docs pages reviewed:
- https://hermes-agent.nousresearch.com/docs/user-guide/messaging/
- https://hermes-agent.nousresearch.com/docs/user-guide/messaging/telegram
- https://hermes-agent.nousresearch.com/docs/developer-guide/architecture
- https://hermes-agent.nousresearch.com/docs/reference/cli-commands

License note: Hermes is MIT. We may borrow ideas and patterns, but we never copy Hermes code verbatim and never add it as a dependency (per the project's non-negotiable constraints).

This document is Phase 0 research only. No feature code is written here.

---

## 1. Service lifecycle

### What Hermes does

Hermes exposes a unified `hermes gateway` CLI with subcommands:

| Subcommand | Behavior |
|---|---|
| `gateway run` | Run the gateway in the foreground (recommended for WSL/Docker/Termux). |
| `gateway install` | Install as a user service (Linux systemd, macOS launchd, Windows Task Scheduler). `--system` for a boot-time system service on Linux. `--force` regenerates a drifted unit/task. |
| `gateway start` / `stop` / `restart` | Start, stop, or restart the installed service. `restart` is drain-aware (SIGUSR1 --- refuse new turns --- wait for in-flight work --- exit --- supervisor relaunches). |
| `gateway status` | Check service status, including registration drift vs. the current template (compares owned settings only). |
| `gateway ensure` | Discover or start the active profile's session runtime without installing a service or replacing an existing owner. Emits JSON (`state`, `reason_code`, optional `endpoint`). Exit 0 = ready; other codes = refusal/deadline, never permission to start a replacement. |
| `gateway setup` | Interactive messaging-platform setup wizard. |

Key production patterns observed:

- **Each `HERMES_HOME` gets its own service name** (`hermes-gateway` for default, `hermes-gateway-<hash>` for others). Multiple installations coexist without colliding.
- **Install refuses to overwrite a unit belonging to a different home** unless `--force` is passed, preventing one gateway from hijacking another's service.
- **Windows uses a hidden `wscript` + `.vbs` launcher** specifically so the task never inherits a console that `CTRL_CLOSE_EVENT` could kill (this is directly relevant to our earlier `^C` failure with `cmd.exe`).
- **macOS launchd plist is static** --- PATH changes after install require re-running `install`; launchd runs the gateway through `/usr/bin/osascript` to satisfy Local Network Privacy.
- **`Restart=always` / `RestartForceExitStatus`** on systemd; Windows relies on the gateway's own in-process restart path because the launcher exits immediately.
- **SIGUSR2 stack dump** --- `kill -USR2 <pid>` appends every thread's stack to a faulthandler log and keeps running (no restart needed to inspect a stall).
- **Event-loop watchdog** --- an out-of-loop probe thread checks the async loop every 30s; after 3 consecutive missed probes it dumps stacks, stamps `gateway_state.json` as `degraded`, and exits 75 so the supervisor restarts it. A `heartbeat stale` notice appears if `gateway_state.json` isn't refreshed for >120s.

### Proposed subcommands for our gateway

| Subcommand | Maps to Hermes | Notes |
|---|---|---|
| `gateway run` | `gateway run` | Foreground, for Docker/WSL/Termux. |
| `gateway install` | `gateway install` | Register logon task (Windows) / user service (Linux/macOS). `--system` for system boot-time service. `--force` to regenerate a drifted unit/task. |
| `gateway start` / `stop` / `restart` | `gateway start|stop|restart` | `restart` drain-aware where the supervisor supports it. |
| `gateway status` | `gateway status` | Report running state, PID, last heartbeat, config drift warning. |
| `gateway ensure` | `gateway ensure` | Non-installing runtime probe returning JSON. |
| `gateway setup` | `gateway setup` | Interactive config wizard (see section 3). |

**Decision: ADOPT.** Our gateway already uses a Windows scheduled task; Hermes' template-drift detection and per-home service naming are directly applicable and solve problems we hit (`cmd` wrapper `^C`, single-instance, template drift).

---

## 2. Diagnostics --- `doctor`

### What Hermes does

Hermes has `hermes doctor` which diagnoses config and dependency issues. It warns about:
- Legacy `session_reset` settings that no longer apply.
- Outdated installed systemd units vs. current template.
- Config drift requiring `install --force`.

### Proposed `doctor` for our gateway

A `doctor` command that checks, in order, and reports PASS/WARN/FAIL with remediation hints:

| Check | What it verifies | Fail --- remediation |
|---|---|---|
| Node version | `node --version` >= 20 | Upgrade Node (uses `AbortSignal.timeout`, global `fetch`). |
| Config validity | `config.json` exists and parses as JSON; required keys present | Copy `config.example.json` to `config.json`, fill `botToken`. |
| Bot token format | `botToken` matches `^\d+:[A-Za-z0-9_-]{35,}$` and is not the placeholder | Reissue via @BotFather. |
| Telegram reachability | `GET https://api.telegram.org/bot<token>/getMe` returns ok | Check network/proxy; token may be revoked. |
| OpenCode service reachability | Discover `service.json`, read password, `GET /api/info` returns version | Start OpenCode service once. |
| OpenCode auth | Basic auth with `opencode:<password>` succeeds on `/api/info` | Reset password in `service.json` if 401. |
| `config.json` file permissions | File is not world-readable (Windows: ACL restricted to owner) | Tighten ACL / move off shared drive. |
| Service bind address | `service.json` `hostname` is `127.0.0.1` or unset | Set `"hostname": "127.0.0.1"` unless LAN access is intended. |
| Single-instance lock | No stale lock file / no other gateway polling this token | Remove stale lock or stop the other instance. |

**Decision: ADOPT.** Doctor is low-risk, high-value, and directly addresses the startup failures we've already seen (bad token, wrong bind address, missing service).

---

## 3. Setup flow

### What Hermes does

`hermes setup [model|tts|terminal|gateway|tools|agent] [--non-interactive] [--quick] [--reset] [--portal]`:
- First run launches a full interactive wizard.
- Returning user drops into a reconfigure wizard where every prompt shows the current value as default (Enter to keep).
- `--quick` prompts only for missing/unset items.
- `--non-interactive` uses defaults/env values without prompts.
- `--portal` one-shot OAuth into Nous Portal.

For Telegram specifically (`hermes gateway setup`): walks through arrow-key platform selection, asks for bot token and allowed user IDs, writes config, offers to start/restart the gateway.

### Proposed `setup` wizard for our gateway

An interactive `setup` command (PowerShell-friendly, since our primary platform is Windows) that:

1. Detects whether `config.json` already exists.
2. If missing: prompts for bot token (from @BotFather) and allowed user IDs (from @userinfobot), writes `config.json`, validates the token via `getMe`, confirms the allowed ID can reach the bot.
3. If present: reconfigure wizard showing current values as defaults; Enter keeps, new value replaces.
4. Validates OpenCode service is reachable (`GET /api/info`) before finishing.
5. Offers to register the scheduled task (`gateway install`) and start it.
6. `--non-interactive` for CI/automated installs; `--quick` to only prompt missing items.

**Decision: ADOPT.** This directly addresses the onboarding friction we had (manually editing `config.json`, no token validation at setup time).

---

## 4. Access control

### What Hermes does

- **Safe default:** gateway denies all users not on an allowlist or paired via DM.
- Allowlists via env vars per platform: `TELEGRAM_ALLOWED_USERS=123456789,987654321` or generic `GATEWAY_ALLOWED_USERS`.
- `GATEWAY_ALLOW_ALL_USERS=true` explicitly allows all (not recommended for bots with terminal access).
- **DM Pairing:** unknown users get a one-time pairing code when they DM the bot; operator approves with `hermes pairing approve <platform> <code>`. Codes expire after 1 hour, are rate-limited, cryptographically random.
- **Admin vs. user split** per scope (DM vs group/channel):
  - Admin: full access to all slash commands.
  - Regular user: restricted to explicitly enabled slash commands (`/help`, `/whoami` always allowed).
- Configured per platform per scope: `allow_from`, `allow_admin_from`, `user_allowed_commands`.
- `/whoami` shows active scope, tier, and allowed commands.

### What we have

`allowedUserIds` array in `config.json` --- a single flat allowlist with no tiers, no pairing, no scope distinction.

### Recommended improvements

| Improvement | Reason |
|---|---|
| Keep flat `allowedUserIds` as the base (backward compatible) | Don't break existing single-user installs. |
| Add optional `adminUserIds` subset for config-changing commands (`/watch`, `/setup`, doctor) | Matches Hermes admin/user split without complexity. |
| Optional DM pairing for onboarding new users without editing config | Hermes pairing is a strong UX pattern; SKIP for Phase 1 (adds state), ADOPT later if multi-user is needed. |
| Secrets via env vars (`TELEGRAM_BOT_TOKEN`) with config fallback | Hermes uses `.env`; ADOPT in Phase 4. |
| Rate-limit pairing codes and expire after 1 hour | Hermes practice; defer to multi-user phase. |

**Decision: ADOPT (flat allowlist + optional admin split), ADAPT (env var fallback), SKIP (DM pairing for now --- single-user focus).**

---

## 5. Session storage and unattended running

### What Hermes does

- **Delivery ledger (`state.db`, SQLite):** durable record around each platform send. At-least-once semantics:
  - Send never started --- redelivered as-is on next boot.
  - Mid-send when crashed --- redelivered with a visible "Recovered reply --- may be a duplicate" prefix (ambiguity labeled, never silently resent).
  - Flood control (Telegram 429) --- retry after penalty; restart during penalty adopts the stored reply without re-running the agent.
  - Bounded: 3 attempts, 24-hour freshness, then abandoned. Delivered rows pruned after 7 days.
- **Sessions persist across messages** until explicit `/new` or `/reset`; no idle/daily auto-reset.
- **`gateway_state.json`:** heartbeat (`updated_at` refreshed every 60s housekeeping tick), `gateway_state` (`stopped`/`degraded`), `exit_reason`. Status renders stale heartbeat if >120s old.
- **Event-loop watchdog:** exits 75 on loop stall; supervisor restarts.
- **Background sessions (`/bg`):** separate agent instance, isolated session, result delivered to same chat with "Background task complete" / "Background task failed".
- **Per-chat concurrency:** updates from different chats run concurrently (pool of 32); same chat runs sequentially in arrival order.

### What we have

`state.json` stores `__offset` and per-user `sessionId`. No delivery ledger, no heartbeat, no watchdog, no background sessions, no per-chat concurrency (we poll sequentially).

### Recommended improvements

| Improvement | Phase | Reason |
|---|---|---|
| Persist Telegram `offset` in `state.json` (already partially done --- `__offset`) | 1 | Critical: restarts must not replay or drop updates. |
| Delivery ledger for outbound messages | 3 | At-least-once prevents lost replies on crash --- core production requirement. |
| `gateway_state.json` heartbeat + stale detection | 2 | Lets `doctor`/`status` distinguish "running but stuck" from "not running". |
| Watchdog / supervisor restart | 1 (scheduled task already restarts) | Our Windows task restarts on failure; adequate for now. |
| Background sessions (`/bg`) | 3 | High-value UX; deferred. |

**Decision: ADOPT offset persistence and heartbeat in Phase 1; ADOPT delivery ledger in Phase 3.**

---

## 6. Multi-platform design (adapter interface)

### What Hermes does

- One `GatewayRunner` process hosts **25+ platform adapters** (Telegram, Discord, Slack, WhatsApp, Signal, SMS, Email, Home Assistant, Mattermost, Matrix, DingTalk, Feishu, WeCom, Weixin, BlueBubbles, QQ, Yuanbao, Teams, LINE, ntfy, IRC, Buzz, SimpleX, Raft, etc.).
- Each adapter: receives messages --- routes through a per-chat session store --- dispatches to the `AIAgent`.
- Platform capability matrix (voice, images, files, threads, reactions, typing, streaming) negotiated per platform.
- `hermes send` talks directly to platform REST endpoints for one-shot messages (no gateway needed for bot-token platforms).
- One bot token per gateway instance; do not reuse the same token in multiple running gateways (Telegram rejects concurrent polling).
- Forum topics mode: one topic --- one session, isolated conversation history per topic.

### What we have

A single `bridge.mjs` with Telegram hard-coded throughout (polling loop, `sendMessage`, `getUpdates`, inline keyboards). No adapter abstraction.

### Proposed adapter interface

```
interface PlatformAdapter {
  name: string
  capabilities: Capability[]  // voice, images, files, threads, reactions, typing, streaming
  start(): Promise<void>      // begin polling/listening
  stop(): Promise<void>       // graceful shutdown
  send(chatId, text, opts): Promise<MessageId>
  edit(messageId, text): Promise<void>
  sendButtons(chatId, text, buttons): Promise<void>
  sendFile(chatId, path, caption): Promise<void>
  handleIncoming(update): IncomingMessage[]  // normalize to common shape
}
```

Core (session store, permission queue, OpenCode client, message splitting, redaction) stays platform-agnostic. Telegram is the first adapter; Discord/Slack can be added later by implementing the interface without touching core.

**Decision: ADOPT.** This is the cleanest path to "many platforms later without rewriting the core." Defer implementation to Phase 5; define the interface in Phase 1 so the core is built adapter-agnostic from the start.

---

## ADOPT / ADAPT / SKIP summary

| Area | Hermes idea | Decision | One-line reason |
|---|---|---|---|
| Service lifecycle | `gateway install|start|stop|status|restart|ensure|setup` | ADOPT | Solves our Windows-task and template-drift problems directly. |
| Per-home service naming | ADOPT | Prevents one gateway hijacking another's service. |
| `wscript`+`.vbs` hidden launcher (Windows) | ADOPT | Fixes the `^C` console-inheritance bug we already hit. |
| `doctor` command | ADOPT | Low-risk, high-value startup validation we lack. |
| `setup` wizard | ADOPT | Reduces onboarding friction; validates token at setup time. |
| Flat allowlist `allowedUserIds` | ADOPT | Backward compatible with existing single-user installs. |
| Optional `adminUserIds` split | ADAPT | Hermes admin/user tier is valuable; add as opt-in subset. |
| DM pairing | SKIP | Single-user focus; adds state complexity not needed yet. |
| Secrets via env vars | ADOPT | Hermes `.env` pattern; move token out of `config.json` in Phase 4. |
| Delivery ledger (`state.db`) | ADOPT | At-least-once delivery is a core production requirement. |
| `gateway_state.json` heartbeat | ADOPT | Distinguishes "stuck" from "stopped". |
| Event-loop watchdog / exit 75 | ADAPT | Our scheduled task already restarts; keep task-based restart, add heartbeat file. |
| SIGUSR2 stack dump | SKIP | Windows-focused project; not applicable. |
| Background sessions (`/bg`) | ADOPT | High-value UX; defer to Phase 3. |
| Per-chat concurrency (pool 32) | ADAPT | Relevant if multi-user; defer. |
| Adapter interface | ADOPT | Enables Discord/Slack later without rewriting core; define in Phase 1. |
| Silence tokens (`[SILENT]`) | SKIP | Not relevant to remote-control UX. |
| Forum topics mode | ADOPT | Headline Phase 2 feature (one topic = one session). |
| Config-driven `dm_topics` | SKIP | Too complex for Phase 1; user-driven `/topic` is enough. |

These ADOPT and ADAPT items are folded into the phased plan below.

---

## OpenCode API findings (verified against running service)

- `GET /api/info` returns `{version, pid, urls, paths, capabilities}` --- used for service discovery.
- OpenAPI spec at `/openapi.json` (and `/v2/openapi.json`) is valid and includes an `event` tag ("Experimental event stream routes") and `Session.Inbox.*` schemas with `delivery: "steer queue"` --- suggesting OpenCode may support an event stream. The full paths object was not enumerated (returned 0 keys via the quick check), so this needs deeper investigation before replacing message polling.
- Confirmed working endpoints used by the bridge: `POST /api/session`, `POST /api/session/{id}/prompt`, `GET /api/session/{id}/message`, `GET /api/session/active`, `GET|POST /api/session/{id}/permission`, `POST /api/session/{id}/permission/{id}/reply`, `POST /api/session/{id}/interrupt`.
- No SSE/WebSocket confirmed yet --- message-stream polling remains the transport until the `event` routes are verified.

---

## Proposed phased plan

Effort estimates are relative (S = small ~1-2 days, M = medium ~3-5 days, L = large ~1-2 weeks).

| Phase | Focus | Key deliverables | Effort |
|---|---|---|---|
| **Phase 0** | Research & audit | `docs/HERMES-COMPARISON.md`, `docs/AUDIT.md`, phased plan | S |
| **Step 0** | Repo audit | Failure modes, race conditions, Telegram limits, tech debt recorded in `docs/AUDIT.md` | S |
| **Phase 1** | Reliability foundation | Offset persistence, exponential backoff + 429 handling, single-instance lock, graceful shutdown, per-session prompt queue (`/queue`, `/clear`), smart message splitting at 4096, safe Markdown with plain-text fallback, auto-reconnect on service restart, timeouts everywhere, `gateway install|start|stop|status|ensure`, `doctor` | M |
| **Phase 2** | UX | Live progress editing, inline keyboards with pagination, forum topics mode (Telegram), `/model`, `/agent`, `/compact`, `/undo`, `/redo`, `/diff`, `/todo`, `/cost`, permission UX with risk labels + auto-deny timeout, reply threading, setup wizard | M |
| **Phase 3** | Media & input | Inbound files/photos, voice notes via pluggable STT, outbound file send button with path allowlist | M |
| **Phase 4** | Security | Env var secrets, config schema validation, roles (owner/operator/viewer), PIN/TOTP re-auth, `/lock` kill switch, per-user rate limiting, append-only audit log with rotation, output secret redaction, bind-address warning, threat model update | M |
| **Phase 5** | Automation & ops | `/schedule`, `/cron`, `/jobs`, `/cancel`, localhost-only webhook trigger, completion notifications with duration/cost, `/health`, `/status`, structured JSON logging, platform adapter interface, plugin hooks | L |
| **Phase 6** | Quality bar | TypeScript migration (strict), tests with mock Telegram + mock OpenCode servers (>80% core coverage), GitHub Actions CI, Dockerfile + docker-compose, README rewrite with quickstart/command reference/troubleshooting/FAQ, `CHANGELOG.md`, semantic versioning | L |

**Immediate next step:** Review `docs/HERMES-COMPARISON.md`, `docs/AUDIT.md`, and this plan, then approve before any feature code is written.

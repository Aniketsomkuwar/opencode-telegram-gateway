<p align="center">
  <img src="docs/hero.png" alt="OpenCode Telegram Gateway" width="100%">
</p>

<h1 align="center">opencode-telegram-gateway</h1>

<p align="center">
  Drive your OpenCode sessions from Telegram. Outbound only: no open ports, no tunnels, no reverse proxy.
</p>

<p align="center">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue.svg">
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg">
  <img alt="runtime deps" src="https://img.shields.io/badge/runtime%20dependencies-0-success.svg">
  <img alt="tests" src="https://img.shields.io/badge/tests-43%20passing-success.svg">
  <img alt="typescript" src="https://img.shields.io/badge/TypeScript-strict-3178c6.svg">
  <img alt="ci" src="https://img.shields.io/badge/CI-GitHub%20Actions-2088ff.svg">
</p>

---

## What it is

A small, dependency-free TypeScript service that puts your OpenCode sessions on Telegram. It long-polls Telegram, talks to the local OpenCode HTTP API, and behaves as a second client on the same session store as the TUI or desktop app: the same conversation, from your phone.

```
Telegram  <-- long poll / send -->  gateway  <-- HTTP + Basic auth -->  OpenCode service
 (cloud)        outbound only      (this repo)                        (127.0.0.1:45278)
```

Nothing listens for inbound traffic. The gateway dials out to `api.telegram.org` and to `127.0.0.1`. That is the whole point: remote control without exposing your machine. It also means the phone and the host never need to share a network. Your phone reaches the gateway through Telegram, so home WiFi, office WiFi and mobile data all behave the same.

## Highlights

- **Queue, don't collide.** Prompts queue per session, run in order, and report their position. OpenCode never sees two concurrent prompts.
- **Answer only.** You get the assistant reply. Tool chatter and progress stay hidden unless you ask for them with `/verbose on`.
- **Safe delivery.** Replies are split at paragraph and code-fence boundaries, or sent as a `.md` document when long. Tables become readable bullets.
- **Permission cards.** Approval requests arrive as buttons with a risk label (read only, changes files, high risk) and auto-deny after a timeout.
- **Roles.** Owner, operator, viewer. Only the owner approves "Always", changes config, or deletes sessions.
- **Kill switch.** `/lock` stops the queue, denies pending approvals, and refuses prompts until `/unlock`.
- **Secrets stay in.** Outbound text is scrubbed of tokens, API keys, JWTs, private keys and `.env` assignments before it reaches Telegram.
- **Everything is audited.** Append-only JSONL with rotation: prompts, approvals, deletions, config changes.
- **Survives restarts.** Atomic state, a single-instance lock, backoff with jitter, and OpenCode re-discovery on 401 or connection loss.

## Quick start

You need Node 20+, a running OpenCode service, and a bot token from [@BotFather](https://t.me/BotFather).

It runs on Windows, macOS and Linux. On macOS or Linux, the recommended install path is the [agent prompt](#install-with-an-ai-agent) below: it detects the OS and sets up the correct service (a `systemd --user` unit on Linux, a launchd agent on macOS).

```bash
git clone https://github.com/Aniketsomkuwar/opencode-telegram-gateway
cd opencode-telegram-gateway
npm install
npm run build

npm run setup      # wizard: validates the token with getMe and writes config.json
npm run doctor     # checks Node, config, token, OpenCode, file permissions, bind address
npm start          # foreground run
```

Send `/start` to your bot from an allowlisted account. When you are happy:

```bash
node dist/index.js install     # logon task (Windows), systemd user unit (Linux), launchd (macOS)
node dist/index.js start
node dist/index.js status
```

## Install with an AI agent

**macOS and Linux: install with this prompt.** Paste [`prompt.md`](prompt.md) into Claude Code, Codex, Cursor, Gemini CLI, Aider or any agent that can run shell commands on the machine hosting OpenCode. The prompt starts by detecting the OS, then uses the matching shell, permission commands, log commands and service manager, so you do not have to translate the Windows examples by hand.

That prompt tells the agent to check prerequisites, validate your bot token with `getMe`, build, run `doctor`, prove the round trip, register the service, and report exactly which commands changed your machine. It also forbids the two things that cause real damage: printing your token and opening an inbound port.

## Commands

**Sessions**

| Command | What it does |
|---|---|
| `/sessions [page]` | Paged list with inline buttons; `>` marks the current, `+` marks running |
| `/use <n\|id>` | Switch the current session |
| `/delete <n\|id>` | Delete a session after a confirmation card; owner only |
| `/active` | Only running sessions |
| `/new [title]` | New session |
| `/newdir <path> [title]` | New session bound to a folder |
| `/status` | Session, model, agent, cost, lock, queue |

**Work**

| Command | What it does |
|---|---|
| plain text | Prompt for the current session |
| `/queue`, `/clear` | Queue depth, or drop what is waiting |
| `/stop` | Interrupt the current turn |
| `/model [n]`, `/agent [n]` | List and switch by number or id |
| `/compact` | Compact the session context |
| `/undo`, `/redo` | Revert the last turn (files included), or re-run the last prompt |
| `/diff [file]` | Changed files, or the patch as a `.patch` file |
| `/todo`, `/cost` | Latest todo list, session tokens and cost |
| `/btw <question>` | Quick side question in a separate session; leaves the work session untouched |

**Ops and automation**

| Command | What it does |
|---|---|
| `/health`, `/ping` | Uptime, OpenCode version and URL, queue depth, pending approvals, last error |
| `/help`, `/commands`, `/whoami` | Command list; your user id, role and chat |
| `/verbose on\|off` | Progress line and live tool feed |
| `/watch on\|off` | Completion ping when any session finishes |
| `/schedule in 10m <text>` | Run a prompt later (`at 09:30` also works) |
| `/cron "*/30 * * * *" <text>` | Recurring prompt, persisted across restarts |
| `/jobs`, `/cancel <id>` | Manage scheduled jobs |
| `/sendfile <path>` | Send a file back, restricted by an allowlist |
| `/remember <text>` | Append a note through your own script |
| `/lock`, `/unlock [pin]` | Kill switch |
| `/role <id> owner\|operator\|viewer` | Owner only |
| `/audit [n]` | Owner only, recent audit entries |

Roles: `viewer` reads, `operator` prompts and approves once, `owner` does everything. The first id in `allowedUserIds` is the owner unless `ownerUserIds` says otherwise.

## Configuration

`config.json` lives in `~/opencode-telegram`. `GATEWAY_HOME` or `--home` moves it.

| Key | Default | Purpose |
|---|---|---|
| `botToken` | required | BotFather token. `TELEGRAM_BOT_TOKEN` overrides it and keeps it off disk |
| `allowedUserIds` | `[]` | Allowlist. Empty denies everyone |
| `ownerUserIds` | first allowed | Owners |
| `roles` | `{}` | Explicit owner / operator / viewer per user id |
| `ownerChatId` | first allowed | Where pings and scheduled results go |
| `verbose` | `false` | Progress line plus tool feed |
| `progress` | `false` | Progress line only |
| `watchAll` | `false` | Ping when any session finishes |
| `serviceUrl`, `servicePort` | auto, `45278` | Pin the OpenCode endpoint |
| `permissionTimeoutSeconds` | `300` | Auto-deny after this long |
| `promptTimeoutMinutes` | `45` | Stop waiting for a reply |
| `queueLimit` | `20` | Per-session queue depth |
| `maxMessageChars` | `4000` | Split threshold, max 4096 |
| `redact` | `true` | Scrub credentials from outbound text |
| `rateLimit.perMinute` | `20` | Per-user inbound limit |
| `inbound` | on, 20 MB | Files and photos saved to `inbox/<chat>/` |
| `outbound.allowedRoots` | `[]` | `/sendfile` allowlist. Empty means any path |
| `stt.command` | none | Local transcription command for voice notes |
| `rememberScript` | none | Called with `-Text` / `--text` for `/remember` |
| `plugin` | none | Module with `onPrompt`, `onReply`, `onPermission` |
| `audit` | `audit.jsonl`, 5 MB x 5 | Audit trail and rotation |
| `webhook` | off | Loopback-only trigger, see `SECURITY.md` |

Secrets: `TELEGRAM_BOT_TOKEN`, `GATEWAY_PIN`, `GATEWAY_WEBHOOK_SECRET`. None of them are ever written to the repository.

## How it works

- **Discovery.** Credentials come from `~/.config/opencode/service.json`; the base URL from `GET /api/info`. Both are re-read on 401 or connection failure, so restarting OpenCode needs no action from you.
- **Queue.** One runner per session, FIFO, capped. `/queue` and `/clear` work because the queue is ours, not the server's.
- **Completion.** The gateway snapshots the idle marker before prompting and waits for a newer one, reading the newest message page so long sessions behave.
- **Splitting.** Paragraph, then line, then space boundaries; a cut inside a code fence closes and reopens it.
- **Operations.** Single-instance lock with stale detection, graceful shutdown, heartbeat file, JSON logs with rotation, `doctor` for the whole chain.

## Persistent memory

The gateway carries prompts; it does not carry what the assistant knows. That lives in the brain, and the brain should outlive every project and every session. Pair the gateway with [opencode-brain](https://github.com/Aniketsomkuwar/opencode-brain): plain Markdown loaded through the `instructions` array in `opencode.json`, with `tools/remember.mjs` appending dated entries.

Point `rememberScript` at `opencode-brain/tools/remember.mjs` and `/remember <text>` from Telegram writes straight into the journal. `.js` and `.mjs` scripts are run with the current Node binary, so no PowerShell is needed.

## Deployment

- **npm:** `node dist/index.js install|start|stop|restart|status`. The installer picks the platform's service manager: a logon task on Windows, a `systemd --user` unit on Linux, a launchd agent on macOS.
- **Linux:** `systemctl --user enable --now opencode-telegram-gateway`. On an unattended machine also run `loginctl enable-linger $USER`, otherwise the unit stops at logout.
- **macOS:** the LaunchAgent runs while the user is logged in and restarts on crash, but not after a logout.
- **Docker:** `docker compose up -d --build`. No ports are published; mount `~/.config/opencode/service.json` read-only and set `OPENCODE_SERVICE_URL` (see `docker-compose.yml`).
- **CI:** GitHub Actions runs typecheck, tests and an audit of runtime dependencies on Node 22 and 24.

## Documentation

| File | Contents |
|---|---|
| `docs/opencode-api.md` | Verified OpenCode routes, payloads, permissions, and the SSE note |
| `SECURITY.md` | Threat model, roles, kill switch, deployment guidance |
| `CHANGELOG.md` | Release history |
| `docs/AUDIT.md` | The original reliability audit and which findings are now closed |
| `docs/HERMES-COMPARISON.md` | Design comparison feeding the phased plan |
| `AGENTS.md` | Orientation for AI coding agents working in this repo |

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `another gateway is already running` | A second instance holds `gateway.lock`. Check `status`; delete the lock only if the pid is dead |
| Bot silent, log shows 409 | The same token is polled elsewhere, often an old `node bridge.mjs` or a duplicate task |
| `opencode rejected credentials` | `service.json` changed, or `serviceUrl` points at the wrong host |
| No reply in a long session | Fixed in 2.0.0: completion is detected from the newest message page. Upgrade |
| Prompt ignored while the TUI is busy | By design: the gateway waits for the session to go idle rather than steering a running turn |
| `doctor` warns about a non-loopback bind | Set `"hostname": "127.0.0.1"` in `~/.config/opencode/service.json` |
| Service stops after logout | Linux: `loginctl enable-linger $USER`. macOS: the LaunchAgent only runs while you are logged in |
| Service dies after a Node upgrade | nvm, Volta or asdf moved the binary; re-run `node dist/index.js install` |

## FAQ

**Does it open a port?** No. Every connection is outbound. The optional webhook is off by default and refuses anything but loopback.

**Can I use it from another network, like my phone on mobile data?** Yes, and that is the normal way to use it. Your phone talks to Telegram and the gateway talks to Telegram; the two never connect to each other, so NAT, a changing IP and cellular data change nothing. The only requirement is that the host stays awake, online and logged in, since a sleeping laptop stops polling.

**Can I use it next to the TUI or desktop app?** Yes, they are separate clients on the same sessions. Avoid typing into the same session from two clients at once.

**What happens if it restarts mid-run?** The Telegram offset is persisted after handling, so an update can replay once but never disappears. The queue is in memory and is lost.

**Is there an event stream?** OpenCode exposes one at `GET /api/event`. It is recorded in `docs/opencode-api.md` and not used yet; polling is the verified transport.

## Development

```bash
npm run dev        # run from source with watch
npm run build      # tsc to dist/
npm test           # build and run the node:test suite
npm run typecheck
```

Layout: `src/config.ts` (validation and env), `src/state.ts` (offset, chats, jobs), `src/queue.ts` (per-session FIFO), `src/telegram.ts` and `src/opencode.ts` (clients), `src/permissions.ts` (cards, risk, timeout), `src/gateway.ts` (orchestration and commands), `src/lifecycle.ts` (install, doctor, setup), `src/hooks.ts` (plugin points).

Tests need Node 22.18+ for native TypeScript stripping. The runtime needs Node 20+.

## License

MIT. See `LICENSE` and `SECURITY.md`.

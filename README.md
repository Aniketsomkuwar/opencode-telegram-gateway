# opencode-telegram-gateway

Control your OpenCode sessions from Telegram. One bot, many sessions, no inbound ports and no tunnels: the gateway only makes outbound calls to `api.telegram.org` and to your local OpenCode service.

## Quick start (2 minutes)

Prerequisites: Node 20 or newer, a running OpenCode service, and a bot token from [@BotFather](https://t.me/BotFather).

```bash
git clone https://github.com/Aniketsomkuwar/opencode-telegram-gateway
cd opencode-telegram-gateway
npm install
npm run build
npm run setup          # asks for token and user id, validates the token
npm run doctor         # checks Node, config, token, OpenCode, permissions, bind
npm start              # foreground run
```

Then send `/start` to your bot from the allowlisted account.

To run it as a service:

```bash
node dist/index.js install     # Windows logon task, systemd user unit, or launchd
node dist/index.js start
node dist/index.js status
node dist/index.js stop
```

`npm start` is a convenience alias for `node dist/index.js run`.

## What it does

- Plain text sent to the bot becomes a prompt in the currently selected session. The final assistant reply is delivered; tool chatter stays hidden unless you enable it.
- `/sessions` shows sessions with inline buttons and pagination. `/use 3` or a button switches.
- If a session is busy, prompts queue in order and the bot tells you the position.
- Long replies are split at paragraph and code-fence boundaries, or sent as a `.md` document when very long.
- Permission requests arrive as inline buttons with a risk label (read only, changes files, high risk) and auto-deny after a configurable timeout.
- Forum topics map one topic to one session, so several sessions run concurrently in one supergroup.
- Secrets that look like tokens, keys or `.env` values are redacted before anything is sent to Telegram.
- Every mutating action lands in an append-only audit log.

## Commands

| Command | Purpose |
|---|---|
| `/start`, `/help`, `/commands` | Command list |
| `/ping` | Health check |
| `/health` | Uptime, OpenCode reachability, queue depth, pending permissions, last error |
| `/sessions [page]` | Session list with buttons |
| `/active` | Only running sessions |
| `/use <n\|id>` | Switch the current session |
| `/delete <n\|id>` | Delete a session after confirming; owner only, clears the chat selection |
| `/new [title]` | New session |
| `/newdir <path> [title]` | New session in a project folder |
| `/status` | Current session, model, agent, cost, lock and queue state |
| `/queue`, `/clear` | Queued prompts and how to drop them |
| `/stop` | Interrupt the current run |
| `/model [n]` | List models, then switch by number or `provider/model` |
| `/agent [n]` | List agents, then switch by number or id |
| `/compact` | Compact the session context |
| `/undo` | Revert the last turn (files included) |
| `/redo` | Re-run the last prompt |
| `/diff [file]` | Changed files, or the patch as a file |
| `/todo` | Latest todo list from the session |
| `/cost` | Tokens and cost |
| `/schedule in 10m <text>` | Run a prompt later (`at 09:30` also works) |
| `/cron "*/30 * * * *" <text>` | Recurring prompt |
| `/jobs`, `/cancel <id>` | Manage scheduled jobs |
| `/verbose on\|off` | Live progress and tool feed |
| `/watch on\|off` | Completion pings for every session |
| `/remember <text>` | Append a note through `rememberScript` |
| `/sendfile <path>` | Send a file back (allowlisted roots) |
| `/lock`, `/unlock [pin]` | Kill switch: deny prompts and approvals |
| `/role <id> owner\|operator\|viewer` | Owner only |
| `/audit [n]` | Owner only, recent audit entries |

Roles: `viewer` can read (sessions, status, cost, diff, todo), `operator` can prompt and approve once, `owner` can approve "Always", change config and lock the bot. The first allowed user id is the owner unless `ownerUserIds` says otherwise.

## Configuration

`config.json` lives in `~/opencode-telegram` by default. `GATEWAY_HOME` or `--home` moves it.

| Key | Default | Meaning |
|---|---|---|
| `botToken` | required | BotFather token. `TELEGRAM_BOT_TOKEN` overrides it and is the recommended place in production |
| `allowedUserIds` | `[]` | Allowlist. Empty denies everyone |
| `ownerUserIds` | first allowed | Users with the `owner` role |
| `roles` | `{}` | Explicit `owner` / `operator` / `viewer` per user id |
| `ownerChatId` | first allowed | Where completion pings go |
| `verbose` | `false` | Tool feed and always-on progress message |
| `progress` | `true` | Live progress after 4 seconds, removed when the answer lands |
| `watchAll` | `false` | Ping when any session finishes |
| `servicePort` | `45278` | Fallback OpenCode port when `/api/info` is unreachable |
| `serviceUrl` | auto | Pin the OpenCode base URL |
| `logLevel` | `info` | `debug`, `info`, `warn`, `error` |
| `permissionTimeoutSeconds` | `300` | Auto-deny after this long |
| `promptTimeoutMinutes` | `45` | Stop waiting for a reply |
| `queueLimit` | `20` | Per-session queue depth |
| `maxMessageChars` | `4000` | Split threshold, max 4096 |
| `redact` | `true` | Mask credentials in outbound text |
| `rateLimit.perMinute` | `20` | Per-user inbound limit |
| `rememberScript` | none | `.ps1`, `.js`/`.mjs` or executable called with `-Text`/`--text` |
| `plugin` | none | Module with `onPrompt`, `onReply`, `onPermission` hooks |
| `inbound` | on, 20 MB | Files and photos are downloaded to `inbox/<chat>/` |
| `outbound.allowedRoots` | `[]` | Allowlist for `/sendfile`; empty means any path |
| `stt.command` | none | Local transcription command, receives the audio path |
| `audit` | `audit.jsonl` | Rotation size and file count |
| `webhook` | off | Loopback-only trigger, see below |

Secrets: the token may stay in `config.json` or move to `TELEGRAM_BOT_TOKEN`. `GATEWAY_PIN` protects `/unlock`, `GATEWAY_WEBHOOK_SECRET` protects the webhook. None of them are ever written to the repository.

## How it works

```
Telegram  <-- long poll / send -->  gateway  <-- HTTP + Basic auth -->  OpenCode service
```

- Outbound long polling only. No webhook, no port forwarding.
- The gateway is a second client on the same session store as the TUI, so both can drive the same conversation.
- OpenCode credentials come from `~/.config/opencode/service.json`; the gateway re-reads them on 401 or connection failure, so a restarted service is picked up automatically.
- A single-instance lock prevents two gateways polling the same bot (Telegram answers 409 otherwise).
- State (`state.json`) stores the Telegram offset, per-chat session choice, topic map and jobs. Writes are atomic.
- Retries use exponential backoff with jitter; Telegram 429 `retry_after` is honored.

## Optional webhook (opt-in, loopback only)

Set `webhook.enabled` and `GATEWAY_WEBHOOK_SECRET`, then:

```bash
curl -X POST http://127.0.0.1:45888/notify -H "x-gateway-secret: $GATEWAY_WEBHOOK_SECRET" -d '{"text":"build finished"}'
```

It only binds to `127.0.0.1`; the gateway refuses to start otherwise. Anything reachable by a local process can send messages, so keep the secret out of shared scripts.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `another gateway is already running` | A second instance holds `gateway.lock`. Use `status`, stop the duplicate, or delete a stale lock |
| Bot silent, log shows 409 | Same token polled elsewhere, often an old `node bridge.mjs` or a leftover task |
| `opencode rejected credentials` | `service.json` changed; the gateway reloads it, but a wrong `serviceUrl` also causes this |
| `/sessions` empty | The service is bound elsewhere or has no sessions for this location |
| Permission buttons do nothing | Requests expire after `permissionTimeoutSeconds`; send a new prompt |
| Long answer truncated | Raise `maxMessageChars` or use `/diff file`; parts are numbered |
| `doctor` reports non-loopback bind | Set `"hostname": "127.0.0.1"` in `~/.config/opencode/service.json` |

## FAQ

**Does this open a port?** No. All traffic is outbound. The optional webhook is off by default and loopback-only.

**Can I use it with the desktop app or TUI at the same time?** Yes. They are separate clients on the same sessions. Keep only one client typing into a session at a time to avoid interleaved prompts.

**Is Telegram the only front end?** It is the only implemented adapter. The core is platform-agnostic; the adapter boundary is documented in `docs/HERMES-COMPARISON.md`.

**Where is the OpenCode API documented?** `docs/opencode-api.md`, verified against a running 2.1.2 service.

**What happens on restart mid-run?** The offset is persisted after handling, so an update may replay once but never disappears. The prompt may need re-sending; the queue is in memory.

## Development

```bash
npm run dev        # run from source with watch
npm run build      # tsc to dist/
npm test           # build + node:test suite
npm run typecheck
```

Layout: `src/config.ts` (validation), `src/state.ts` (offset and chats), `src/queue.ts` (per-session FIFO), `src/telegram.ts` and `src/opencode.ts` (clients), `src/permissions.ts` (buttons, risk, timeout), `src/gateway.ts` (orchestration and commands), `src/lifecycle.ts` (install, doctor, setup), `src/hooks.ts` (plugin points).

## License

MIT. See `SECURITY.md` for the threat model.

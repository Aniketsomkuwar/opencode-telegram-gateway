# Security

## What this software can do

The gateway forwards Telegram messages into an OpenCode session. OpenCode can read and write files and run shell commands. Anyone who controls the bot effectively controls the machine it runs on, within the permissions OpenCode grants. Treat the bot token like an SSH key.

## Threat model

| Risk | Mitigation |
|---|---|
| Stranger messages the bot | `allowedUserIds` allowlist; an empty list denies everyone |
| Allowed user is compromised | Roles: `viewer` is read-only, `operator` can prompt, only `owner` can approve Always, change config or lock |
| Token leaked in a chat, screenshot or commit | Revoke with BotFather; `config.json` is gitignored; `TELEGRAM_BOT_TOKEN` keeps it off disk |
| API reachable from the LAN | `doctor` warns when OpenCode advertises a non-loopback URL; bind it to `127.0.0.1` in `service.json` |
| Agent runs destructive commands unattended | Configure OpenCode permissions so `bash`, `edit` and `write` ask; requests arrive with a risk label and auto-deny after the timeout |
| Prompt or output contains a secret | Outbound text is redacted (tokens, API keys, JWTs, private keys, `.env` assignments) before it reaches Telegram |
| Someone spams prompts | Per-user rate limit, per-session queue cap, `/lock` kill switch |
| An unattended run goes rogue | `/stop`, `/lock`, prompt timeouts, and the audit log |
| Local process abuses the webhook | Webhook is off by default, binds to loopback only, and requires `GATEWAY_WEBHOOK_SECRET` |
| Audit trail is missing or tampered with | Append-only JSONL, rotated, readable through `/audit` (owner only) |

## Roles

- `owner`: every command, "Always" approvals, `/lock`, `/role`, `/audit`, `/delete`.
- `operator`: prompts, once-only approvals, read commands.
- `viewer`: read-only commands, no prompts, no approvals.

The first entry in `allowedUserIds` (or `ownerUserIds`) is the owner unless `roles` says otherwise.

## Kill switch

`/lock` stops the queue, denies pending and future permissions, and refuses prompts until `/unlock`. If `GATEWAY_PIN` is set, `/unlock` requires it.

## Deployment guidance

- Run as an unprivileged user.
- Prefer `TELEGRAM_BOT_TOKEN` over a token inside `config.json`.
- Keep `config.json` readable only by its owner. `doctor` checks this: on Windows it looks for `Everyone` or `BUILTIN\Users` in `icacls`, on POSIX it checks the mode for group/world bits.
- Do not expose the OpenCode service port through a reverse proxy or a tunnel.
- Do not commit `config.json`, `state.json`, `audit.jsonl`, `gateway.state.json`, `inbox/`, or any `*.log`.
- Rotate the token if it has ever appeared in a transcript, issue, screenshot or shell history.

## Known limits

- The queue and pending permissions are in memory. A restart loses queued prompts; the in-flight prompt may need to be re-sent.
- Redaction is pattern based. It catches common credential shapes, not every possible secret.
- The OpenCode API uses Basic auth over plain HTTP on loopback. Anything that can read `service.json` can drive the service.
- The gateway cannot enforce OpenCode-side permissions; it only relays them. Configure OpenCode itself.

## Reporting a vulnerability

Open a private security advisory on the repository, or contact the maintainer directly. Do not open a public issue containing a live token or exploit details.

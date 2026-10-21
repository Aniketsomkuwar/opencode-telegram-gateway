# Security

## What this software can do

The gateway forwards messages from Telegram into an OpenCode session. OpenCode can read and write files and run shell commands. Anyone who controls the bot effectively controls the machine it runs on, within the permissions OpenCode grants.

Treat the bot token like an SSH key.

## Threat model

| Risk | Mitigation |
|---|---|
| Someone else messages the bot | `allowedUserIds` allowlist; empty list denies everyone |
| Token leaked in a chat, screenshot or commit | Revoke with BotFather immediately; `config.json` is gitignored |
| API reachable from the LAN | Bind OpenCode to `127.0.0.1` in `service.json` |
| Agent runs destructive commands unattended | Configure OpenCode permissions so `bash`, `edit` and `write` ask; approve from Telegram |
| Logs contain prompts | `bridge.log` stays local and is gitignored |
| Telegram account compromised | Revoke the token; the allowlist is tied to the user ID, not the device |

## Deployment guidance

- Run as an unprivileged user.
- Do not expose the OpenCode service port through a reverse proxy.
- Do not commit `config.json`, `state.json`, `*.log`, or any file containing a token.
- Rotate the token if it has ever appeared in a transcript, issue, screenshot or shell history.

## Reporting a vulnerability

Open a private security advisory on the repository, or contact the maintainer directly. Do not open a public issue containing a live token or exploit details.

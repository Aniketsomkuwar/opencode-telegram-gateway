# opencode-telegram-gateway

Drive [OpenCode](https://opencode.ai) from Telegram. One bot, many sessions, no inbound ports.

The gateway runs on the same machine as the OpenCode service, talks to it over its local HTTP API, and polls Telegram for updates. Your laptop or server initiates every connection, so there is nothing to expose to the internet, no tunnel and no port forwarding.

This is an unofficial community project. It is not affiliated with OpenCode or Telegram.

## Features

- Plain text goes to the current session; replies come back as one Telegram message.
- Session management: list, switch, create, create in a directory, interrupt.
- Permission prompts become inline buttons (Allow once, Always, Deny).
- Quiet by default: no per-tool chatter, no session-title prefixes, no completion pings.
- Optional completion notices for other running sessions.
- Markdown tables are converted to readable bullets, long replies are split safely.
- Single-user allowlist; anyone else is ignored.
- Survives restarts as a systemd service or a Windows scheduled task.
- No dependencies. Node 20 or newer, standard library only.

## Requirements

- OpenCode v2 with its local service running (`opencode` creates `~/.config/opencode/service.json`).
- Node.js 20+ (uses global `fetch` and `AbortSignal.timeout`).
- A Telegram bot token from [@BotFather](https://t.me/BotFather).

## Install

```bash
git clone https://github.com/Aniketsomkuwar/opencode-telegram-gateway.git
cd opencode-telegram-gateway
cp config.example.json config.json
```

Edit `config.json`:

```json
{
  "botToken": "123456:ABC...",
  "allowedUserIds": [123456789],
  "ownerChatId": 123456789
}
```

Get your numeric Telegram ID from [@userinfobot](https://t.me/userinfobot). `allowedUserIds` is an allowlist: if it is empty, the bot answers nobody. `ownerChatId` is where notices and `/watch` output go; it can be the same as your user ID.

Start it:

```bash
npm start
```

Then open your bot in Telegram and send `/start`.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `botToken` | required | Telegram bot token |
| `allowedUserIds` | `[]` | Numeric Telegram user IDs allowed to control the bot |
| `ownerChatId` | first allowed user | Chat for notices and watch output |
| `verbose` | `false` | Send a line per tool call. Off by default |
| `notifyToolCalls` | `false` | Legacy alias for `verbose` |
| `watchAll` | `false` | Send one completion notice when another session finishes |
| `serviceUrl` | discovered | Override the OpenCode API URL |
| `servicePort` | `45278` | Fallback port when discovery fails |
| `rememberScript` | unset | Script invoked by `/remember`; see below |

`config.json`, `state.json` and `*.log` are gitignored and must never be committed.

## Commands

| Command | Action |
|---|---|
| any text | Run in the current session, or create one if none is selected |
| `/sessions` | List sessions with running state |
| `/use <n>` | Switch to session number `n` |
| `/active` | Running sessions only |
| `/new [title]` | Create a session |
| `/newdir <path> [title]` | Create a session in a project directory |
| `/status` | Current session, model info, cost, watch state |
| `/stop` | Interrupt the current run |
| `/remember <text>` | Append a note through `rememberScript` |
| `/watch on\|off` | Completion notices for other sessions |
| `/ping` | Health check |

### `/remember`

Point `rememberScript` at any executable you want to capture notes with. A `.ps1` file is invoked through PowerShell with `-Text` and `-Tag`; a `.js`/`.mjs` file is invoked with Node; anything else is executed directly with `--text` and `--tag`. If the key is absent, `/remember` replies that it is not configured.

## Run it permanently

### Linux (systemd)

```bash
mkdir -p ~/.config/systemd/user
cp deploy/opencode-telegram-gateway.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now opencode-telegram-gateway
journalctl --user -u opencode-telegram-gateway -f
```

### Windows (scheduled task)

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy\windows-scheduled-task.ps1
```

The script registers a logon task that calls `node.exe` directly. Do not wrap the command in `cmd.exe`: the wrapper inherits a console and the task dies with `Ctrl+C`.

## Security

Read this before you put it on a machine you care about.

- **The bot is remote code execution.** It drives an agent that can run shell commands. Keep `allowedUserIds` to accounts you control.
- **Keep the service local.** If `~/.config/opencode/service.json` binds to `0.0.0.0`, the API is reachable from your LAN. Set `"hostname": "127.0.0.1"` unless you need otherwise.
- **Transcripts and tokens.** A bot token pasted into a chat is compromised. Regenerate it with BotFather if that happens.
- **Permissions.** The gateway surfaces OpenCode permission requests as buttons. Configure OpenCode so destructive tools ask rather than run.
- **No secrets in the repo.** `config.json` is gitignored. Verify with `git status` before committing.

See `SECURITY.md` for the threat model and reporting.

## How it works

- `GET /api/info` locates the service; the password comes from `service.json` and is sent as HTTP Basic auth.
- Session creation, prompts, messages, permissions and interrupts use the documented v2 API.
- Telegram is polled with `getUpdates` long polling; replies are sent with `sendMessage`.
- Tool lines are opt-in; the final assistant text is the only thing sent by default.

## Limitations

- One Telegram user per running instance. Multiple users are not isolated from each other.
- No attachment upload or download.
- Markdown rendering is Telegram's subset; tables become bullet lists on purpose.
- The bridge must run on the same machine as the OpenCode service, or reach it over the network with `serviceUrl`.

## License

MIT. See `LICENSE`.

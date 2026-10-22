# opencode-telegram-gateway

Drive [OpenCode](https://opencode.ai) from Telegram. One bot, many sessions, no inbound ports.

## What this tool is about

OpenCode is a powerful local AI coding agent, but it normally runs in a terminal on one machine. If you are away from that machine, you cannot talk to it.

This gateway turns your Telegram bot into a remote control for OpenCode. You message the bot; the bot sends your text to OpenCode; OpenCode replies; the bot sends that reply back to you. It runs on the same laptop or server where OpenCode is installed, and it only makes outbound connections — so you do not open any ports, run no tunnels, and expose nothing to the internet.

This is an unofficial community project. It is not affiliated with OpenCode or Telegram.

## What it does

| You do | The gateway does |
|---|---|
| Send any message in Telegram | Runs it as a prompt in your current OpenCode session |
| Send `/sessions` | Lists every session, with running state |
| Send `/use <n>` | Switches to session number `n` |
| Send `/active` | Lists running sessions only, numbered |
| Send `/stop` | Interrupts the current run |
| Send `/remember <text>` | Appends a dated note to your memory journal |
| Receive a reply | Get OpenCode's final answer as one Telegram message |
| OpenCode asks permission (edit, write, shell…) | Get an inline button: Once / Always / Deny |

In short: Telegram is a second client on the same session store as your OpenCode terminal. Both devices can drive the same conversation, one message at a time.

## How it does it

1. **Locate the service.** On startup it reads `~/.config/opencode/service.json` for the Basic-auth password, and calls `GET /api/info` to find the OpenCode service URL (fallback: `http://127.0.0.1:45278`).
2. **Authenticate.** Every API call to OpenCode uses HTTP Basic auth with user `opencode` and the password from `service.json`.
3. **Poll Telegram.** It calls `getUpdates` with long polling (50 second timeout). Your laptop initiates every connection to Telegram; nothing listens inbound.
4. **Run your prompt.** When you send text, it POSTs to `/api/session/{id}/prompt`. It then polls the message stream until OpenCode returns an `idle` result, at which point the assistant's final text is sent back to you as one Telegram message.
5. **Handle permissions.** If OpenCode asks for permission on a tool call, the gateway sends you an inline button (Once / Always / Deny) and relays your choice back via `/api/session/{id}/permission/{id}/reply`.
6. **Stay quiet by default.** No per-tool chatter, no session-title prefixes, no completion pings. You get exactly one message — OpenCode's answer — unless you opt in with `/watch on` or `verbose: true`.

### Data flow

```
You (Telegram) ──┐
                 ▼
         gateway polls getUpdates
                 ▼
         POST /api/session/{id}/prompt  (OpenCode local API)
                 ▼
         OpenCode works, may ask permission
         gateway sends Once / Always / Deny buttons
                 ▼
         assistant final text
                 ▼
         sendMessage back to you (Telegram)
```

## Requirements

- OpenCode v2 with its local service running (`opencode` creates `~/.config/opencode/service.json`).
- Node.js 20 or newer (uses global `fetch` and `AbortSignal.timeout`).
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
| `/active` | Running sessions only, numbered for `/use` |
| `/new [title]` | Create a session |
| `/newdir <path> [title]` | Create a session in a project folder |
| `/status` | Current session, model info, cost, watch state |
| `/stop` | Interrupt the current run |
| `/remember <text>` | Append a note through `rememberScript` |
| `/watch on\|off` | Completion pings from ALL sessions |
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

## Limitations

- One Telegram user per running instance. Multiple users are not isolated from each other.
- No attachment upload or download.
- Markdown rendering is Telegram's subset; tables become bullet lists on purpose.
- The bridge must run on the same machine as the OpenCode service, or reach it over the network with `serviceUrl`.

## License

MIT. See `LICENSE`.

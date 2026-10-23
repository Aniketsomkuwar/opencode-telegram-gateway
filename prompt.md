# Install prompt for an AI agent

Copy everything below the line into Claude Code, Codex, Cursor, Gemini CLI, Aider or any agent that can run shell commands on the machine that runs OpenCode. Replace the three placeholders before sending, or let the agent ask you for them.

---

You are installing `opencode-telegram-gateway` on my machine. It is a small TypeScript service that lets me control my local OpenCode sessions from Telegram. Work step by step, run the commands yourself, and report what happened at the end. Do not invent steps and do not skip the verification.

The gateway itself is cross-platform. Your job is to use the right commands for the operating system you detect, not to assume bash.

## Inputs

- Bot token from BotFather: `<BOT_TOKEN>`
- My Telegram user id: `<USER_ID>`
- Folder to install into (default `<HOME>/opencode-telegram-gateway`): `<INSTALL_DIR>`

If any of these is missing, ask me for it before starting.

## Hard rules

1. Never print the bot token, never echo it into a log, never commit it. If you write it to a file, that file must be covered by `.gitignore`.
2. Do not open, forward or expose any inbound port. This project is outbound only. If you find yourself adding a firewall rule or a tunnel, stop.
3. Ask before installing something that runs at logon or boot, and before changing my shell profile or PATH.
4. Do not modify OpenCode's own settings, sessions or config unless I explicitly ask.
5. Use the shell that matches the OS: PowerShell on Windows, sh or bash on macOS and Linux. Never run bash-only syntax on Windows.
6. If a command fails, show me the real error output, do not paper over it.

## Step 0: detect the environment

Run the block for the OS you are on and remember the values. Every later step depends on this.

Windows, in PowerShell:

```powershell
[System.Environment]::OSVersion.VersionString
$env:PROCESSOR_ARCHITECTURE
node --version
(Get-Command node).Source
```

macOS or Linux:

```bash
uname -srm
node --version
command -v node
```

Write down three things: the OS, the Node version (must be 20 or newer), and the absolute path to the node binary. The service installer hardcodes that path, so if Node comes from nvm, Volta or asdf, note it and tell me at the end.

Do not hand-write a service file. `node dist/index.js install` already picks `schtasks` on Windows, `systemd --user` on Linux and `launchd` on macOS.

## Step 1: check prerequisites

```bash
node --version        # must be 20 or newer
git --version
```

If Node is missing or too old, ask before installing it. Typical commands:

- Windows, PowerShell: `winget install OpenJS.NodeJS.LTS`
- macOS: `brew install node`, or your existing nvm setup
- Linux: your distribution's package for `nodejs` and `npm`

Then confirm the OpenCode service is running and reachable:

```bash
opencode service status
```

If that subcommand does not exist on this install, check that `~/.config/opencode/service.json` exists and ask me to start OpenCode once. The gateway discovers the service URL and credentials from that file and `GET /api/info`, so do not hardcode either.

## Step 2: get the code and build

```bash
git clone https://github.com/Aniketsomkuwar/opencode-telegram-gateway "<INSTALL_DIR>"
cd "<INSTALL_DIR>"
npm install
npm run build
```

There are no runtime dependencies; `typescript` and `@types/node` are dev only. Avoid an install path containing spaces, because the installer resolves its entry point from the module URL and can mis-handle percent-encoded spaces.

## Step 3: configure

Run the wizard and give it the token and my user id:

```bash
node dist/index.js setup --home "<INSTALL_DIR>"
```

It validates the token with Telegram `getMe` before writing `config.json`. If you prefer to write the file yourself, copy `config.example.json` to `config.json`, set `botToken`, `allowedUserIds: [<USER_ID>]` and `ownerChatId: <USER_ID>`, then restrict permissions to the current user:

Windows, PowerShell:

```powershell
icacls ".\config.json" /inheritance:r /grant:r "$env:USERNAME:F"
```

macOS or Linux:

```bash
chmod 600 config.json
```

Prefer the environment for secrets when you can: `TELEGRAM_BOT_TOKEN` overrides the token in the file.

## Step 4: verify before running it as a service

```bash
node dist/index.js doctor --home "<INSTALL_DIR>"
```

Every check should be PASS. The only acceptable warning is a non-loopback OpenCode bind. If you see that, tell me to set `"hostname": "127.0.0.1"` in `~/.config/opencode/service.json`, because it exposes my agent API to the local network. On macOS and Linux, a `config permissions` warning means the mode is group or world readable; the fix is `chmod 600 config.json`.

Then run it in the foreground once and watch the log for 20 seconds:

```bash
node dist/index.js run --home "<INSTALL_DIR>"
```

Expect a line with the bot username and an OpenCode version. Stop it with Ctrl+C.

## Step 5: run it as a service

Ask me first, then:

```bash
node dist/index.js install --home "<INSTALL_DIR>"
node dist/index.js start --home "<INSTALL_DIR>"
node dist/index.js status --home "<INSTALL_DIR>"
```

What that means per OS:

- Windows: a scheduled task that starts at logon. It runs only while I am logged in; a lock screen is fine, a sign-out is not.
- Linux: a `systemd --user` unit. Enable it with `systemctl --user enable --now opencode-telegram-gateway`. It stops at logout unless lingering is on, so for an unattended machine run `loginctl enable-linger $USER` once.
- macOS: a launchd LaunchAgent in `~/Library/LaunchAgents`. It runs while I am logged in and restarts on crash, but not after a logout.

Never register a second copy: the gateway holds a single-instance lock and Telegram returns HTTP 409 if two processes poll the same token.

## Step 6: prove it end to end

Ask me to send `/ping` and then a trivial prompt such as `reply with the word ok` to the bot. Then check the log and audit file.

Windows, PowerShell:

```powershell
Get-Content "<INSTALL_DIR>\bridge.log" -Tail 20   # JSON lines, "gateway starting" and the inbound message
Get-Content "<INSTALL_DIR>\audit.jsonl" -Tail 20  # prompt.enqueue and prompt.finish for my prompt
```

macOS or Linux:

```bash
tail -n 20 "<INSTALL_DIR>/bridge.log"
tail -n 20 "<INSTALL_DIR>/audit.jsonl"
```

A prompt that never reaches `prompt.finish` means the run did not complete; report the log lines instead of guessing.

## Step 7: tell me what is optional

Summarise these briefly and let me choose, do not enable them unasked:

- `/sessions`, `/use`, `/new`, `/delete`, `/btw` for session control
- Roles: `/role <id> owner|operator|viewer`
- `/lock` kill switch, optional `GATEWAY_PIN`
- Inbound files and voice notes (`inbound`, `stt.command`)
- `/sendfile` with `outbound.allowedRoots`
- `/schedule` and `/cron`
- Loopback-only webhook, off by default
- Plugin hooks `onPrompt`, `onReply`, `onPermission`
- Docker instead of npm, see `docker-compose.yml`

## Step 8: report back

Give me, in this order:

1. OS, architecture, install directory, Node version and node path, `doctor` result.
2. Whether it installed as a service, the service or task name, and for Linux whether lingering is enabled.
3. The exact commands you ran that changed my machine.
4. Anything that failed, with the real error text.
5. What is still optional and how to turn it on.

## Troubleshooting you may hit

| Symptom | Cause and fix |
|---|---|
| `another gateway is already running` | A second instance holds `gateway.lock`. Check `status`; delete the lock only if that pid is dead |
| `botToken is still the placeholder` | `config.json` was not updated, or `TELEGRAM_BOT_TOKEN` is empty |
| Telegram returns 409 | The same token is polled by another process, often an old `node bridge.mjs` or a duplicate task |
| `opencode rejected credentials` | `service.json` changed, or `serviceUrl` points at the wrong host |
| `doctor` warns about a non-loopback bind | Bind OpenCode to `127.0.0.1` in `~/.config/opencode/service.json` |
| Service runs, then dies at logout | Linux: `loginctl enable-linger $USER`. macOS: the LaunchAgent only runs while you are logged in |
| Service dies after a Node upgrade | nvm, Volta or asdf moved the Node binary. Re-run `node dist/index.js install` |
| `entry point not found` | Install path has spaces, or `dist/` is missing. Rebuild, and prefer a path without spaces |
| Nothing arrives in Telegram | Confirm the task is running and `gateway.state.json` shows `"status": "running"` |

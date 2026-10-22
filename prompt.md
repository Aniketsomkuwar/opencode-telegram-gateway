# Install prompt for an AI agent

Copy everything below the line into Claude Code, Codex, Cursor, Gemini CLI, Aider or any agent that can run shell commands on the machine that runs OpenCode. Replace the three placeholders before sending, or let the agent ask you for them.

---

You are installing `opencode-telegram-gateway` on my machine. It is a small TypeScript service that lets me control my local OpenCode sessions from Telegram. Work step by step, run the commands yourself, and report what happened at the end. Do not invent steps and do not skip the verification.

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
5. If a command fails, show me the real error output, do not paper over it.

## Step 1: check prerequisites

```bash
node --version        # must be 20 or newer
git --version
```

Then confirm the OpenCode service is running and reachable:

```bash
opencode service status
```

If it is not running, tell me to start OpenCode once, then continue. On its own, the gateway discovers the service URL and credentials from `~/.config/opencode/service.json` and `GET /api/info`, so do not hardcode either.

## Step 2: get the code and build

```bash
git clone https://github.com/Aniketsomkuwar/opencode-telegram-gateway "<INSTALL_DIR>"
cd "<INSTALL_DIR>"
npm install
npm run build
```

There are no runtime dependencies; `typescript` and `@types/node` are dev only.

## Step 3: configure

Run the wizard and give it the token and my user id:

```bash
node dist/index.js setup --home "<INSTALL_DIR>"
```

It validates the token with Telegram `getMe` before writing `config.json`. If you prefer to write the file yourself, copy `config.example.json` to `config.json`, set `botToken`, `allowedUserIds: [<USER_ID>]` and `ownerChatId: <USER_ID>`, then restrict permissions (`chmod 600 config.json`, or on Windows `icacls config.json /inheritance:r /grant:r "%USERNAME%:F"`).

Prefer the environment for secrets when you can: `TELEGRAM_BOT_TOKEN` overrides the token in the file.

## Step 4: verify before running it as a service

```bash
node dist/index.js doctor --home "<INSTALL_DIR>"
```

Every check should be PASS. The only acceptable warning is a non-loopback OpenCode bind, and if you see that, tell me to set `"hostname": "127.0.0.1"` in `~/.config/opencode/service.json` because it exposes my agent API to the local network.

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

That registers a logon task on Windows, a systemd user unit on Linux, or a launchd agent on macOS. Never register a second copy: the gateway holds a single-instance lock and Telegram returns HTTP 409 if two processes poll the same token.

## Step 6: prove it end to end

Ask me to send `/ping` and then a trivial prompt such as `reply with the word ok` to the bot. Then check:

```bash
tail -n 20 "<INSTALL_DIR>/bridge.log"        # JSON lines, "gateway starting" and the inbound message
tail -n 20 "<INSTALL_DIR>/audit.jsonl"       # prompt.enqueue and prompt.finish for my prompt
```

A prompt that never reaches `prompt.finish` means the run did not complete; report the log lines instead of guessing.

## Step 7: tell me what is optional

Summarise these briefly and let me choose, do not enable them unasked:

- `/sessions`, `/use`, `/new`, `/delete` for session control
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

1. Install directory, Node version, `doctor` result.
2. Whether it installed as a service, and the service or task name.
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
| Nothing arrives in Telegram | Confirm the task is running and `gateway.state.json` shows `"status": "running"` |

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig, resolvePaths, validateTokenShape, ConfigError, type Config } from './config.js';
import { lockStatus } from './lock.js';
import { OpencodeClient } from './opencode.js';
import { TelegramClient } from './telegram.js';
import { Logger } from './logger.js';
import { errorMessage, short } from './util.js';

export const DEFAULT_SERVICE_NAME = 'OpenCodeTelegramBridge';

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';

function distEntry(): string {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
  const candidate = path.join(root, 'dist', 'index.js');
  return fs.existsSync(candidate) ? candidate : path.join(root, 'src', 'index.ts');
}

export function projectRoot(): string {
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  return path.resolve(here, '..');
}

export function entryPoint(): string {
  return distEntry();
}

function runPowerShell(script: string): { ok: boolean; out: string } {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return { ok: result.status === 0, out: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
}

function serviceName(): string {
  return process.env.GATEWAY_SERVICE_NAME?.trim() || DEFAULT_SERVICE_NAME;
}

function nodePath(): string {
  return process.execPath;
}

export function installService(home: string, force = false): void {
  const entry = path.resolve(distEntry());
  if (!fs.existsSync(entry)) throw new Error(`entry point not found: ${entry}; run npm run build first`);
  const name = serviceName();

  if (isWindows) {
    const argument = `"${entry}" run`;
    const script = [
      `$name = '${name}'`,
      `$existing = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue`,
      `if ($existing -and -not ${force ? '$true' : '$false'}) { Write-Output 'exists'; exit 3 }`,
      `$action = New-ScheduledTaskAction -Execute '${nodePath()}' -Argument '${argument}' -WorkingDirectory '${home}'`,
      `$trigger = New-ScheduledTaskTrigger -AtLogOn`,
      `$settings = New-ScheduledTaskSettingsSet -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable`,
      `Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Description 'OpenCode Telegram gateway' -Force | Out-Null`,
      `Write-Output 'installed'`,
    ].join('; ');
    const result = runPowerShell(script);
    if (/exists/.test(result.out) && !result.ok) {
      throw new Error(`task ${name} already exists; re-run install with --force to replace it`);
    }
    if (!result.ok) throw new Error(`install failed: ${result.out}`);
    console.log(`installed Windows scheduled task ${name}`);
    console.log(`entry ${entry}`);
    return;
  }

  if (isMac) {
    const label = `dev.opencode.telegram.gateway`;
    const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${nodePath()}</string><string>${entry}</string><string>run</string></array>
<key>WorkingDirectory</key><string>${home}</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${path.join(home, 'service.log')}</string>
<key>StandardErrorPath</key><string>${path.join(home, 'service.log')}</string>
</dict></plist>`;
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    if (fs.existsSync(plistPath) && !force) throw new Error(`${plistPath} exists; re-run with --force`);
    fs.writeFileSync(plistPath, plist);
    spawnSync('launchctl', ['unload', plistPath], { windowsHide: true });
    const loaded = spawnSync('launchctl', ['load', plistPath], { encoding: 'utf8' });
    if (loaded.status !== 0) throw new Error(`launchctl load failed: ${loaded.stderr}`);
    console.log(`installed launch agent ${label}`);
    console.log('the agent runs while this user is logged in; it stops at logout');
    return;
  }

  const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
  const unitPath = path.join(unitDir, 'opencode-telegram-gateway.service');
  fs.mkdirSync(unitDir, { recursive: true });
  if (fs.existsSync(unitPath) && !force) throw new Error(`${unitPath} exists; re-run with --force`);
  fs.writeFileSync(
    unitPath,
    `[Unit]
Description=OpenCode Telegram gateway
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${home}
ExecStart=${nodePath()} ${entry} run
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
`,
  );
  const reload = spawnSync('systemctl', ['--user', 'daemon-reload'], { encoding: 'utf8' });
  if (reload.status !== 0) console.warn(`systemctl daemon-reload failed: ${reload.stderr}`);
  console.log(`installed systemd unit ${unitPath}`);
  console.log('enable it with: systemctl --user enable --now opencode-telegram-gateway');
  console.log('for an unattended machine: loginctl enable-linger $USER (otherwise it stops at logout)');
}

export function serviceAction(action: 'start' | 'stop' | 'restart' | 'status'): void {
  const name = serviceName();
  if (isWindows) {
    const script =
      action === 'status'
        ? `$t = Get-ScheduledTask -TaskName '${name}' -ErrorAction SilentlyContinue; if (-not $t) { 'not installed'; exit 4 }; $i = Get-ScheduledTaskInfo -TaskName '${name}'; "state=$($t.State) last=$($i.LastRunTime) result=$($i.LastTaskResult)"`
        : action === 'start'
          ? `Start-ScheduledTask -TaskName '${name}'; 'started'`
          : action === 'stop'
            ? `Stop-ScheduledTask -TaskName '${name}'; 'stopped'`
            : `Stop-ScheduledTask -TaskName '${name}' -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 800; Start-ScheduledTask -TaskName '${name}'; 'restarted'`;
    const result = runPowerShell(script);
    console.log(result.out || (result.ok ? 'ok' : 'failed'));
    if (!result.ok && action !== 'status') process.exitCode = 1;
    return;
  }

  if (isMac) {
    const label = 'dev.opencode.telegram.gateway';
    const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
    const command = action === 'stop' ? 'unload' : action === 'restart' ? 'kickstart' : action === 'start' ? 'load' : 'list';
    const args = action === 'restart' ? ['kickstart', '-k', `gui/${process.getuid?.() ?? 501}/${label}`] : [command, plistPath];
    const result = spawnSync('launchctl', args, { encoding: 'utf8' });
    console.log(result.stdout.trim() || result.stderr.trim() || (result.status === 0 ? 'ok' : 'failed'));
    return;
  }

  const unit = 'opencode-telegram-gateway.service';
  if (action === 'status') {
    const result = spawnSync('systemctl', ['--user', 'status', unit, '--no-pager'], { encoding: 'utf8' });
    console.log(result.stdout.trim() || result.stderr.trim());
    return;
  }
  const result = spawnSync('systemctl', ['--user', action, unit], { encoding: 'utf8' });
  console.log(result.stdout.trim() || result.stderr.trim() || (result.status === 0 ? 'ok' : 'failed'));
  if (result.status !== 0) process.exitCode = 1;
}

export async function runDoctor(home: string): Promise<number> {
  const checks: Check[] = [];
  const paths = resolvePaths(home);

  const major = Number(process.versions.node.split('.')[0]);
  checks.push({
    name: 'node version',
    status: major >= 20 ? 'pass' : 'fail',
    detail: `v${process.versions.node}`,
    fix: major >= 20 ? undefined : 'install Node 20 or newer',
  });

  let config: Config | null = null;
  if (!fs.existsSync(paths.config)) {
    checks.push({ name: 'config file', status: 'fail', detail: `${paths.config} missing`, fix: 'run: opencode-telegram-gateway setup' });
  } else {
    try {
      config = loadConfig(home).config;
      checks.push({ name: 'config file', status: 'pass', detail: paths.config });
    } catch (error) {
      checks.push({ name: 'config file', status: 'fail', detail: short(errorMessage(error), 300), fix: 'fix the listed fields' });
    }
  }

  if (config) {
    const tokenProblem = validateTokenShape(config.botToken);
    checks.push({
      name: 'bot token shape',
      status: tokenProblem ? 'fail' : 'pass',
      detail: tokenProblem ?? 'looks valid',
      fix: tokenProblem ? 'get a token from @BotFather' : undefined,
    });
    checks.push({
      name: 'allowlist',
      status: config.allowedUserIds.length ? 'pass' : 'warn',
      detail: config.allowedUserIds.length ? `${config.allowedUserIds.length} user(s)` : 'empty; every message is denied',
      fix: config.allowedUserIds.length ? undefined : 'add your user id to allowedUserIds',
    });

    if (tokenProblem) {
      checks.push({ name: 'telegram', status: 'fail', detail: 'skipped: token invalid' });
    } else {
      const logger = new Logger({ level: 'error', mirror: false });
      const telegram = new TelegramClient(config.botToken, logger);
      try {
        const me = await telegram.getMe();
        checks.push({ name: 'telegram', status: 'pass', detail: `@${me.username ?? me.id}` });
      } catch (error) {
        checks.push({ name: 'telegram', status: 'fail', detail: short(errorMessage(error), 200), fix: 'check network access to api.telegram.org' });
      }
    }

    const opencode = new OpencodeClient({ serviceUrl: config.serviceUrl, servicePort: config.servicePort, logger: new Logger({ level: 'error', mirror: false }) });
    try {
      const info = await opencode.info();
      checks.push({ name: 'opencode', status: 'pass', detail: `v${info.version} at ${opencode.baseUrl}` });
      const external = info.urls.filter((url) => !/127\.0\.0\.1|localhost|\[::1\]/.test(url));
      checks.push({
        name: 'opencode bind',
        status: external.length ? 'warn' : 'pass',
        detail: external.length ? `reachable beyond loopback: ${external.join(', ')}` : 'loopback only',
        fix: external.length ? 'set hostname to 127.0.0.1 in ~/.config/opencode/service.json' : undefined,
      });
    } catch (error) {
      checks.push({ name: 'opencode', status: 'fail', detail: short(errorMessage(error), 200), fix: 'start the OpenCode service once' });
    }

    if (isWindows) {
      const result = spawnSync('icacls', [paths.config], { encoding: 'utf8', windowsHide: true });
      const permissive = /Everyone|BUILTIN\\Users|AUTHORITY\\Authenticated Users/i.test(result.stdout ?? '');
      checks.push({
        name: 'config permissions',
        status: permissive ? 'warn' : 'pass',
        detail: permissive ? 'other users may read config.json' : 'restricted',
        fix: permissive ? `icacls "${paths.config}" /inheritance:r /grant:r "%USERNAME%:F"` : undefined,
      });
    } else {
      const mode = fs.statSync(paths.config).mode & 0o777;
      const permissive = (mode & 0o077) !== 0;
      checks.push({
        name: 'config permissions',
        status: permissive ? 'warn' : 'pass',
        detail: permissive ? `mode ${mode.toString(8)} is group/world readable` : `mode ${mode.toString(8)}`,
        fix: permissive ? `chmod 600 ${paths.config}` : undefined,
      });
    }

    const lock = lockStatus(path.join(home, 'gateway.lock'));
    checks.push({
      name: 'instance lock',
      status: lock.held ? 'warn' : 'pass',
      detail: lock.held ? `gateway running (pid ${lock.info?.pid})` : lock.stale ? 'stale lock' : 'free',
      fix: lock.stale ? `delete ${path.join(home, 'gateway.lock')}` : undefined,
    });

    const heartbeatPath = path.join(home, 'gateway.state.json');
    if (fs.existsSync(heartbeatPath)) {
      try {
        const heartbeat = JSON.parse(fs.readFileSync(heartbeatPath, 'utf8')) as { status?: string; updatedAt?: number };
        const age = Date.now() - (heartbeat.updatedAt ?? 0);
        checks.push({
          name: 'heartbeat',
          status: heartbeat.status === 'running' && age < 120_000 ? 'pass' : 'warn',
          detail: `${heartbeat.status ?? '?'}, ${Math.round(age / 1000)}s ago`,
          fix: heartbeat.status === 'running' && age > 120_000 ? 'gateway may be stuck; check the log' : undefined,
        });
      } catch {
        checks.push({ name: 'heartbeat', status: 'warn', detail: 'unreadable gateway.state.json' });
      }
    }

    if (isWindows) {
      const result = runPowerShell(`$t = Get-ScheduledTask -TaskName '${serviceName()}' -ErrorAction SilentlyContinue; if ($t) { $t.State } else { 'not installed' }`);
      checks.push({
        name: 'service',
        status: /not installed/.test(result.out) ? 'warn' : 'pass',
        detail: result.out || 'unknown',
        fix: /not installed/.test(result.out) ? 'run: opencode-telegram-gateway install' : undefined,
      });
    }
  }

  const icon = (status: CheckStatus): string => (status === 'pass' ? 'PASS' : status === 'warn' ? 'WARN' : 'FAIL');
  for (const check of checks) {
    console.log(`${icon(check.status)}  ${check.name}: ${check.detail}`);
    if (check.fix) console.log(`      fix: ${check.fix}`);
  }
  const failures = checks.filter((check) => check.status === 'fail').length;
  const warnings = checks.filter((check) => check.status === 'warn').length;
  console.log(`\n${checks.length - failures - warnings} pass, ${warnings} warn, ${failures} fail`);
  return failures ? 1 : 0;
}

export async function runSetup(home: string): Promise<void> {
  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const paths = resolvePaths(home);
  fs.mkdirSync(paths.home, { recursive: true });

  let existing: Record<string, unknown> = {};
  if (fs.existsSync(paths.config)) {
    try {
      existing = JSON.parse(fs.readFileSync(paths.config, 'utf8')) as Record<string, unknown>;
      console.log(`existing config found at ${paths.config}; Enter keeps each value`);
    } catch {
      console.log('existing config is not valid JSON; it will be replaced');
    }
  }

  const ask = async (question: string, fallback: string, secret = false): Promise<string> => {
    const answer = await rl.question(`${question}${fallback ? ` [${secret ? 'kept' : fallback}]` : ''}: `);
    return answer.trim() || fallback;
  };

  const currentToken = typeof existing.botToken === 'string' ? existing.botToken : '';
  const token = await ask('bot token from @BotFather', currentToken, true);
  const allowedDefault = Array.isArray(existing.allowedUserIds) ? existing.allowedUserIds.join(',') : '';
  const allowedRaw = await ask('allowed Telegram user ids, comma separated', allowedDefault);
  const allowed = allowedRaw
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);
  const ownerDefault = String(existing.ownerChatId ?? allowed[0] ?? '');
  const ownerChat = Number(await ask('owner chat id for notifications', ownerDefault));
  const serviceDefault = String(existing.serviceUrl ?? '');
  const serviceUrl = await ask('OpenCode service URL (blank = auto discover)', serviceDefault);
  rl.close();

  const tokenProblem = validateTokenShape(token);
  if (tokenProblem) {
    console.error(`invalid token: ${tokenProblem}`);
    process.exitCode = 1;
    return;
  }
  if (!allowed.length) {
    console.error('at least one allowed user id is required');
    process.exitCode = 1;
    return;
  }

  const logger = new Logger({ level: 'error', mirror: false });
  const telegram = new TelegramClient(token, logger);
  try {
    const me = await telegram.getMe();
    console.log(`token valid for @${me.username ?? me.id}`);
  } catch (error) {
    console.error(`token check failed: ${short(errorMessage(error), 200)}`);
    process.exitCode = 1;
    return;
  }

  const config = {
    ...existing,
    botToken: token,
    allowedUserIds: allowed,
    ownerChatId: Number.isFinite(ownerChat) && ownerChat > 0 ? ownerChat : allowed[0],
    verbose: existing.verbose ?? false,
    watchAll: existing.watchAll ?? false,
    progress: existing.progress ?? true,
    ...(serviceUrl ? { serviceUrl } : {}),
  };
  fs.writeFileSync(paths.config, `${JSON.stringify(config, null, 2)}\n`);
  if (isWindows) {
    spawnSync('icacls', [paths.config, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:F`], { windowsHide: true });
  } else {
    fs.chmodSync(paths.config, 0o600);
  }
  console.log(`wrote ${paths.config}`);
  console.log('next: opencode-telegram-gateway doctor, then install and start');
}

export function printStatusLine(home: string): void {
  const paths = resolvePaths(home);
  const lock = lockStatus(path.join(home, 'gateway.lock'));
  console.log(lock.held ? `gateway running (pid ${lock.info?.pid})` : 'gateway not running');
  console.log(`home ${paths.home}`);
  console.log(`config ${fs.existsSync(paths.config) ? 'present' : 'missing'}`);
}

export { ConfigError };

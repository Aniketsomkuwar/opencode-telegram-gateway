#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, defaultHome, resolvePaths, ConfigError } from './config.js';
import { Logger } from './logger.js';
import { AuditLog } from './audit.js';
import { InstanceLock, LockHeldError } from './lock.js';
import { Gateway } from './gateway.js';
import { errorMessage, short } from './util.js';
import { installService, serviceAction, runDoctor, runSetup, printStatusLine, DEFAULT_SERVICE_NAME } from './lifecycle.js';

interface Args {
  command: string;
  home: string;
  force: boolean;
  rest: string[];
}

function parseArgs(argv: string[]): Args {
  let command = 'run';
  let home = defaultHome();
  let force = false;
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] as string;
    if (arg === '--home' || arg === '-H') {
      home = argv[++index] ?? home;
      continue;
    }
    if (arg.startsWith('--home=')) {
      home = arg.slice('--home='.length);
      continue;
    }
    if (arg === '--force' || arg === '-f') {
      force = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      command = 'help';
      continue;
    }
    if (arg === '--version' || arg === '-v') {
      command = 'version';
      continue;
    }
    if (arg.startsWith('-')) {
      rest.push(arg);
      continue;
    }
    if (command === 'run' && !argv.slice(0, index).some((value) => !value.startsWith('-'))) command = arg;
    else rest.push(arg);
  }
  return { command, home: path.resolve(home), force, rest };
}

const HELP = `opencode-telegram-gateway

Usage:
  opencode-telegram-gateway run            run in the foreground
  opencode-telegram-gateway install        register the service (logon task / systemd / launchd)
  opencode-telegram-gateway start|stop|restart
  opencode-telegram-gateway status
  opencode-telegram-gateway doctor         diagnose config, token, OpenCode, permissions
  opencode-telegram-gateway setup          interactive config wizard
  opencode-telegram-gateway version

Options:
  --home <dir>    gateway home (default ~/opencode-telegram or GATEWAY_HOME)
  --force         replace an existing service definition
  --help, --version
`;

async function runGateway(home: string): Promise<void> {
  const paths = resolvePaths(home);
  fs.mkdirSync(paths.home, { recursive: true });

  let loaded;
  try {
    loaded = loadConfig(home);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  const { config } = loaded;
  const logger = new Logger({ file: paths.log, level: config.logLevel, mirror: true });
  const audit = new AuditLog(config.audit.file, config.audit.maxBytes, config.audit.keep, logger);

  for (const warning of (config.raw.__warnings as string[] | undefined) ?? []) logger.warn(warning);

  const lock = new InstanceLock(paths.home);
  try {
    lock.acquire();
  } catch (error) {
    if (error instanceof LockHeldError) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const gateway = new Gateway(config, paths, logger, audit);
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('signal received', { signal });
    const force = setTimeout(() => {
      logger.error('shutdown timed out; exiting');
      lock.release();
      process.exit(1);
    }, 15_000);
    force.unref();
    try {
      await gateway.stop(signal);
    } catch (error) {
      logger.error('shutdown error', { error: errorMessage(error) });
    } finally {
      lock.release();
      audit.write({ action: 'gateway.stop', detail: signal });
      clearTimeout(force);
      process.exit(0);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled rejection', { error: short(errorMessage(reason), 300) });
  });
  process.on('uncaughtException', (error) => {
    logger.error('uncaught exception', { error: short(errorMessage(error), 300) });
    void shutdown('uncaughtException');
  });

  try {
    await gateway.start();
    audit.write({ action: 'gateway.start', detail: `pid ${process.pid}` });
  } catch (error) {
    logger.error('start failed', { error: errorMessage(error) });
    lock.release();
    console.error(`start failed: ${errorMessage(error)}`);
    process.exitCode = 1;
    return;
  }

  // Keep the process alive even if every internal handle is unref'd.
  setInterval(() => undefined, 1 << 30);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case 'run':
      return runGateway(args.home);
    case 'install':
      installService(args.home, args.force);
      return;
    case 'start':
    case 'stop':
    case 'restart':
    case 'status': {
      if (args.command === 'status' && args.rest.includes('--local')) {
        printStatusLine(args.home);
        return;
      }
      if (args.command === 'status') {
        printStatusLine(args.home);
        console.log('');
      }
      serviceAction(args.command === 'restart' ? 'restart' : args.command);
      return;
    }
    case 'doctor': {
      const code = await runDoctor(args.home);
      process.exitCode = code;
      return;
    }
    case 'setup':
      return runSetup(args.home);
    case 'version': {
      const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8').replace(/^\uFEFF/, '')) as { version?: string };
      console.log(pkg.version ?? '0.0.0');
      return;
    }
    case 'help':
    default:
      console.log(HELP);
      if (args.command !== 'help') process.exitCode = 1;
      return;
  }
}

void main().catch((error) => {
  console.error(`fatal: ${errorMessage(error)}`);
  process.exitCode = 1;
});

export { DEFAULT_SERVICE_NAME };

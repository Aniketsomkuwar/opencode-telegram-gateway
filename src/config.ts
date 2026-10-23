import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Role } from './types.js';
import { levelFromString, type LogLevel } from './logger.js';
import { atomicWriteFile, parseBoolean, parseNumber } from './util.js';

export interface SttConfig {
  /** External command that receives the audio path as its last argument and prints the transcript. */
  command?: string;
  args?: string[];
  timeoutMs?: number;
}

export interface InboundConfig {
  enabled: boolean;
  maxBytes: number;
}

export interface OutboundConfig {
  allowedRoots: string[];
  maxBytes: number;
}

export interface WebhookConfig {
  enabled: boolean;
  host: string;
  port: number;
  secretEnv: string;
}

export interface AuditConfig {
  file: string;
  maxBytes: number;
  keep: number;
}

export interface Config {
  botToken: string;
  allowedUserIds: number[];
  ownerUserIds: number[];
  roles: Record<string, Role>;
  ownerChatId?: number;
  verbose: boolean;
  watchAll: boolean;
  notifyToolCalls: boolean;
  progress: boolean;
  /** Prefix Telegram prompts with [surface: telegram] so channel-aware instruction files can route. */
  surfaceHint: boolean;
  rememberScript?: string;
  /** Optional plugin module with onPrompt/onReply/onPermission hooks. */
  plugin?: string;
  serviceUrl?: string;
  servicePort: number;
  logLevel: LogLevel;
  permissionTimeoutSeconds: number;
  promptTimeoutMinutes: number;
  queueLimit: number;
  maxMessageChars: number;
  redact: boolean;
  stt?: SttConfig;
  inbound: InboundConfig;
  outbound: OutboundConfig;
  webhook: WebhookConfig;
  audit: AuditConfig;
  rateLimitPerMinute: number;
  /** PIN required for "always" approvals and /lock unlock. Read from GATEWAY_PIN, never stored in config.json. */
  pin?: string;
  /** Raw object as read from disk, so unknown keys survive a save. */
  raw: Record<string, unknown>;
}

export interface Paths {
  home: string;
  config: string;
  state: string;
  log: string;
  audit: string;
  inboxRoot: string;
}

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Invalid configuration:\n- ${problems.join('\n- ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

const TOKEN_PATTERN = /^\d{6,}:[A-Za-z0-9_-]{30,}$/;

export function defaultHome(): string {
  return process.env.GATEWAY_HOME?.trim() || path.join(os.homedir(), 'opencode-telegram');
}

export function resolvePaths(home = defaultHome()): Paths {
  const resolved = path.resolve(home);
  return {
    home: resolved,
    config: path.join(resolved, 'config.json'),
    state: path.join(resolved, 'state.json'),
    log: path.join(resolved, 'bridge.log'),
    audit: path.join(resolved, 'audit.jsonl'),
    inboxRoot: path.join(resolved, 'inbox'),
  };
}

function toIdArray(value: unknown): number[] {
  if (Array.isArray(value)) {
    return value.map((item) => Number(item)).filter((item) => Number.isFinite(item) && item > 0);
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => Number(item.trim()))
      .filter((item) => Number.isFinite(item) && item > 0);
  }
  if (typeof value === 'number') return [value];
  return [];
}

export function loadConfig(home = defaultHome()): { config: Config; paths: Paths } {
  const paths = resolvePaths(home);
  if (!fs.existsSync(paths.config)) {
    throw new ConfigError([
      `missing ${paths.config}`,
      'copy config.example.json to config.json, or run: opencode-telegram-gateway setup',
    ]);
  }

  let raw: Record<string, unknown>;
  try {
    const text = fs.readFileSync(paths.config, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('root must be an object');
    raw = parsed as Record<string, unknown>;
  } catch (error) {
    throw new ConfigError([`${paths.config} is not valid JSON: ${(error as Error).message}`]);
  }

  const problems: string[] = [];
  const problemsRaw: string[] = [];

  const envToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const botToken = (envToken || String(raw.botToken ?? '')).trim();
  if (!botToken) problems.push('botToken is empty (set it in config.json or TELEGRAM_BOT_TOKEN)');
  else if (botToken.includes('PASTE_')) problems.push('botToken is still the placeholder; get a token from @BotFather');
  else if (!TOKEN_PATTERN.test(botToken)) {
    problemsRaw.push('botToken does not look like <digits>:<35+ chars>; verify it with @BotFather');
  }

  const envAllowed = process.env.TELEGRAM_ALLOWED_USERS ?? process.env.GATEWAY_ALLOWED_USERS;
  const allowedUserIds = toIdArray(envAllowed ?? raw.allowedUserIds);
  if (!allowedUserIds.length) problemsRaw.push('allowedUserIds is empty; every message will be denied');

  const ownerUserIds = toIdArray(raw.ownerUserIds);
  const roles: Record<string, Role> = {};
  if (raw.roles && typeof raw.roles === 'object') {
    for (const [key, value] of Object.entries(raw.roles as Record<string, unknown>)) {
      const role = String(value).toLowerCase();
      if (role === 'owner' || role === 'operator' || role === 'viewer') roles[key] = role;
      else problems.push(`roles.${key} must be owner, operator or viewer`);
    }
  }
  const ownerSource = ownerUserIds.length ? ownerUserIds : allowedUserIds.slice(0, 1);
  for (const id of ownerSource) roles[String(id)] ??= 'owner';

  const ownerChat = raw.ownerChatId ?? (process.env.GATEWAY_OWNER_CHAT_ID ? Number(process.env.GATEWAY_OWNER_CHAT_ID) : undefined);

  const inboundRaw = (raw.inbound ?? {}) as Record<string, unknown>;
  const outboundRaw = (raw.outbound ?? {}) as Record<string, unknown>;
  const webhookRaw = (raw.webhook ?? {}) as Record<string, unknown>;
  const auditRaw = (raw.audit ?? {}) as Record<string, unknown>;

  const config: Config = {
    botToken,
    allowedUserIds,
    ownerUserIds: ownerSource,
    roles,
    ownerChatId: ownerChat === undefined || ownerChat === null ? undefined : Number(ownerChat),
    verbose: parseBoolean(raw.verbose, false),
    watchAll: parseBoolean(raw.watchAll, false),
    notifyToolCalls: parseBoolean(raw.notifyToolCalls, false),
    progress: parseBoolean(raw.progress, false),
    surfaceHint: parseBoolean(raw.surfaceHint, true),
    rememberScript: typeof raw.rememberScript === 'string' ? raw.rememberScript : undefined,
    plugin: typeof raw.plugin === 'string' ? raw.plugin : undefined,
    serviceUrl: typeof raw.serviceUrl === 'string' ? raw.serviceUrl : process.env.OPENCODE_SERVICE_URL,
    servicePort: parseNumber(raw.servicePort ?? process.env.OPENCODE_SERVICE_PORT, 45278),
    logLevel: levelFromString(raw.logLevel ?? process.env.GATEWAY_LOG_LEVEL, 'info'),
    permissionTimeoutSeconds: parseNumber(raw.permissionTimeoutSeconds, 300),
    promptTimeoutMinutes: parseNumber(raw.promptTimeoutMinutes, 45),
    queueLimit: parseNumber(raw.queueLimit, 20),
    maxMessageChars: parseNumber(raw.maxMessageChars, 4000),
    redact: parseBoolean(raw.redact, true),
    stt: typeof raw.stt === 'object' && raw.stt !== null ? (raw.stt as SttConfig) : undefined,
    inbound: {
      enabled: parseBoolean(inboundRaw.enabled, true),
      maxBytes: parseNumber(inboundRaw.maxBytes, 20 * 1024 * 1024),
    },
    outbound: {
      allowedRoots: Array.isArray(outboundRaw.allowedRoots) ? outboundRaw.allowedRoots.map(String) : [],
      maxBytes: parseNumber(outboundRaw.maxBytes, 50 * 1024 * 1024),
    },
    webhook: {
      enabled: parseBoolean(webhookRaw.enabled, false),
      host: String(webhookRaw.host ?? '127.0.0.1'),
      port: parseNumber(webhookRaw.port, 45888),
      secretEnv: String(webhookRaw.secretEnv ?? 'GATEWAY_WEBHOOK_SECRET'),
    },
    audit: {
      file: String(auditRaw.file ?? paths.audit),
      maxBytes: parseNumber(auditRaw.maxBytes, 5 * 1024 * 1024),
      keep: parseNumber(auditRaw.keep, 5),
    },
    rateLimitPerMinute: parseNumber((raw.rateLimit as Record<string, unknown> | undefined)?.perMinute, 20),
    pin: process.env.GATEWAY_PIN?.trim() || undefined,
    raw,
  };

  if (config.permissionTimeoutSeconds < 10) problems.push('permissionTimeoutSeconds must be at least 10');
  if (config.queueLimit < 1) problems.push('queueLimit must be at least 1');
  if (config.maxMessageChars < 500 || config.maxMessageChars > 4096) {
    problems.push('maxMessageChars must be between 500 and 4096');
  }
  if (config.webhook.enabled && !['127.0.0.1', '::1', 'localhost'].includes(config.webhook.host)) {
    problems.push('webhook.host must stay on localhost; the gateway promises no inbound exposure');
  }
  if (config.webhook.enabled && !process.env[config.webhook.secretEnv]) {
    problems.push(`webhook.enabled requires ${config.webhook.secretEnv} to be set`);
  }

  if (problems.length) throw new ConfigError(problems);
  for (const warning of problemsRaw) {
    // Warnings are surfaced by `doctor`; the gateway still starts.
    config.raw.__warnings = [...((config.raw.__warnings as string[]) ?? []), warning];
  }
  return { config, paths };
}

/** Persist a partial patch without dropping unknown keys. */
export function saveConfig(config: Config, patch: Record<string, unknown>, home = defaultHome()): void {
  const merged = { ...config.raw, ...patch };
  delete (merged as Record<string, unknown>).__warnings;
  atomicWriteFile(resolvePaths(home).config, `${JSON.stringify(merged, null, 2)}\n`);
  config.raw = merged;
}

export function validateTokenShape(token: string): string | null {
  if (!token) return 'botToken is empty';
  if (token.includes('PASTE_')) return 'botToken is the placeholder value';
  if (!TOKEN_PATTERN.test(token)) return 'botToken does not look like <digits>:<35+ chars>';
  return null;
}



import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AgentInfo,
  FileDiffInfo,
  MessageInfo,
  ModelInfo,
  PermissionRequest,
  SessionInfo,
} from './types.js';
import { retry, sleep, errorMessage } from './util.js';
import type { Logger } from './logger.js';

export interface OpencodeOptions {
  serviceUrl?: string;
  servicePort: number;
  logger: Logger;
  timeoutMs?: number;
}

export class OpencodeError extends Error {  readonly status: number;
  readonly body: string;
  constructor(message: string, status: number, body = '') {
    super(message);
    this.name = 'OpencodeError';
    this.status = status;
    this.body = body;
  }
}

export interface IdleBaseline {
  count: number;
  at: number;
}

/** Snapshot the idle markers before a prompt so a new one can be detected. */
export function idleBaselineOf(messages: MessageInfo[]): IdleBaseline {
  const idles = messages.filter((message) => message.type === 'idle');
  let at = 0;
  for (const idle of idles) at = Math.max(at, idle.time?.created ?? 0);
  return { count: idles.length, at };
}

/**
 * A turn is done when an idle marker newer than the baseline exists.
 * Time is the reliable signal; count is the fallback for payloads without it.
 */
export function turnCompleted(messages: MessageInfo[], baseline: IdleBaseline): MessageInfo | null {
  const idles = messages.filter((message) => message.type === 'idle');
  const newest = idles[idles.length - 1];
  if (!newest) return null;
  const created = newest.time?.created ?? 0;
  if (created > baseline.at) return newest;
  if (!created && idles.length > baseline.count) return newest;
  return null;
}

function isRetryable(error: unknown): boolean {
  if (error instanceof OpencodeError) return error.status === 429 || error.status >= 500 || error.status === 0;
  return true;
}

function servicePath(): string {
  return path.join(os.homedir(), '.config', 'opencode', 'service.json');
}

export class OpencodeClient {
  private base: string | null = null;
  private auth: string | null = null;
  private readonly options: OpencodeOptions;
  private readonly logger: Logger;
  private lastDiscovery = 0;
  private cachedInfo: { version: string; urls: string[]; pid?: number } | null = null;

  constructor(options: OpencodeOptions) {
    this.options = options;
    this.logger = options.logger;
  }

  get baseUrl(): string | null {
    return this.base;
  }

  get version(): string | null {
    return this.cachedInfo?.version ?? null;
  }

  get allUrls(): string[] {
    return this.cachedInfo?.urls ?? [];
  }

  /** Re-read service.json and /api/info. Called at startup, on 401, and on connection errors. */
  discover(force = false): void {
    if (!force && this.base && Date.now() - this.lastDiscovery < 5_000) return;
    const file = servicePath();
    if (!fs.existsSync(file)) {
      throw new OpencodeError(`missing ${file}; start the OpenCode service once`, 0);
    }
    const password = (JSON.parse(fs.readFileSync(file, 'utf8')) as { password?: string }).password;
    if (!password) throw new OpencodeError(`${file} has no password field`, 0);
    this.auth = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
    this.base = (this.options.serviceUrl ?? `http://127.0.0.1:${this.options.servicePort}`).replace(/\/$/, '');
    this.lastDiscovery = Date.now();
  }

  private async requestRaw<T>(method: string, route: string, body?: unknown, timeoutMs = 30_000, signal?: AbortSignal): Promise<T> {
    if (!this.base || !this.auth) this.discover(true);
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (signal) signals.push(signal);
    const combined = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    let response: Response;
    try {
      response = await fetch(`${this.base}${route}`, {
        method,
        headers: {
          Authorization: this.auth as string,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: combined,
      });
    } catch (error) {
      throw new OpencodeError(`cannot reach OpenCode at ${this.base}: ${errorMessage(error)}`, 0);
    }
    const text = await response.text();
    if (response.status === 401 || response.status === 403) {
      this.discover(true);
      throw new OpencodeError(`OpenCode rejected credentials (${response.status})`, response.status, text.slice(0, 200));
    }
    if (!response.ok) {
      throw new OpencodeError(`${method} ${route} -> ${response.status} ${text.slice(0, 300)}`, response.status, text);
    }
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new OpencodeError(`invalid JSON from ${route}`, response.status, text.slice(0, 200));
    }
  }

  async api<T>(method: string, route: string, body?: unknown, options: { timeoutMs?: number; signal?: AbortSignal; attempts?: number } = {}): Promise<T> {
    return retry(
      async () => {
        try {
          return await this.requestRaw<T>(method, route, body, options.timeoutMs ?? this.options.timeoutMs ?? 30_000, options.signal);
        } catch (error) {
          if (error instanceof OpencodeError && error.status === 0) {
            try {
              this.discover(true);
            } catch {
              /* keep original error */
            }
          }
          throw error;
        }
      },
      {
        attempts: options.attempts ?? 4,
        baseMs: 400,
        maxMs: 8_000,
        signal: options.signal,
        retryable: isRetryable,
        onRetry: (error, attempt, delay) =>
          this.logger.warn('opencode retry', { attempt, delay, error: errorMessage(error) }),
      },
    );
  }

  async info(): Promise<{ version: string; urls: string[]; pid?: number }> {
    const info = await this.api<{ version: string; urls: string[]; pid?: number }>('GET', '/api/info', undefined, { attempts: 2 });
    this.cachedInfo = info;
    if (!this.options.serviceUrl && info.urls?.length) {
      const local = info.urls.find((url) => url.includes('127.0.0.1') || url.includes('localhost'));
      this.base = (local ?? info.urls[0] as string).replace(/\/$/, '');
    }
    return info;
  }

  async sessions(limit = 30): Promise<SessionInfo[]> {
    const response = await this.api<{ data: SessionInfo[] }>('GET', `/api/session?limit=${limit}`);
    return response.data ?? [];
  }

  async activeSessions(): Promise<string[]> {
    const response = await this.api<{ data: Record<string, unknown> }>('GET', '/api/session/active');
    return Object.keys(response.data ?? {});
  }

  async session(sessionId: string): Promise<SessionInfo | null> {
    try {
      const response = await this.api<{ data: SessionInfo }>('GET', `/api/session/${sessionId}`, undefined, { attempts: 2 });
      return response.data;
    } catch (error) {
      if (error instanceof OpencodeError && error.status === 404) return null;
      throw error;
    }
  }

  async createSession(input: { title?: string; directory?: string }): Promise<SessionInfo> {
    const body: Record<string, unknown> = { title: input.title ?? 'telegram session' };
    if (input.directory) body.location = { directory: input.directory };
    const response = await this.api<{ data: SessionInfo }>('POST', '/api/session', body);
    return response.data;
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.api('DELETE', `/api/session/${sessionId}`);
  }

  async messages(sessionId: string, limit = 100): Promise<MessageInfo[]> {
    // Newest page first, then reversed: `order=asc` returns the oldest messages,
    // which hides the current turn's idle marker in long sessions.
    const response = await this.api<{ data: MessageInfo[] }>('GET', `/api/session/${sessionId}/message?limit=${limit}&order=desc`);
    return (response.data ?? []).slice().reverse();
  }

  async prompt(sessionId: string, text: string, files: Array<{ uri: string; name?: string }> = []): Promise<void> {
    const body: Record<string, unknown> = { text };
    if (files.length) body.files = files;
    await this.api('POST', `/api/session/${sessionId}/prompt`, body, { timeoutMs: 60_000 });
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.api('POST', `/api/session/${sessionId}/interrupt`, {});
  }

  async pendingPermissions(sessionId: string): Promise<PermissionRequest[]> {
    const response = await this.api<{ data: PermissionRequest[] }>('GET', `/api/session/${sessionId}/permission`, undefined, { attempts: 2 });
    return response.data ?? [];
  }

  async replyPermission(sessionId: string, requestId: string, decision: 'once' | 'always' | 'reject'): Promise<void> {
    await this.api('POST', `/api/session/${sessionId}/permission/${requestId}/reply`, { decision });
  }

  async models(): Promise<ModelInfo[]> {
    const response = await this.api<{ data: ModelInfo[] }>('GET', '/api/model');
    return response.data ?? [];
  }

  async agents(): Promise<AgentInfo[]> {
    const response = await this.api<{ data: AgentInfo[] }>('GET', '/api/agent');
    return response.data ?? [];
  }

  async setModel(sessionId: string, model: { id: string; providerID: string; variant?: string }): Promise<void> {
    await this.api('POST', `/api/session/${sessionId}/model`, { model });
  }

  async setAgent(sessionId: string, agent: string): Promise<void> {
    await this.api('POST', `/api/session/${sessionId}/agent`, { agent });
  }

  async compact(sessionId: string): Promise<void> {
    await this.api('POST', `/api/session/${sessionId}/compact`, {}, { timeoutMs: 120_000 });
  }

  async diff(sessionId: string): Promise<FileDiffInfo[]> {
    const response = await this.api<{ data: FileDiffInfo[] }>('GET', `/api/session/${sessionId}/diff`);
    return response.data ?? [];
  }

  async stageRevert(sessionId: string, messageId: string, files = true): Promise<void> {
    await this.api('POST', `/api/session/${sessionId}/revert/stage`, { messageID: messageId, files });
  }

  async commitRevert(sessionId: string): Promise<void> {
    await this.api('POST', `/api/session/${sessionId}/revert/commit`, {});
  }

  async clearRevert(sessionId: string): Promise<void> {
    await this.api('DELETE', `/api/session/${sessionId}/revert`);
  }

  /** Poll until the session reports one more idle message than `idleBefore`. */
  async waitForIdle(
    sessionId: string,
    baseline: IdleBaseline,
    options: {
      timeoutMs: number;
      signal?: AbortSignal;
      pollMs?: number;
      onTick?: (messages: MessageInfo[]) => void | Promise<void>;
    },
  ): Promise<{ messages: MessageInfo[]; outcome: string | null; timedOut: boolean }> {
    const started = Date.now();
    const pollMs = options.pollMs ?? 1500;
    while (true) {
      if (Date.now() - started > options.timeoutMs) {
        return { messages: await this.messages(sessionId), outcome: 'timeout', timedOut: true };
      }
      let messages: MessageInfo[] = [];
      try {
        messages = await this.messages(sessionId);
      } catch (error) {
        this.logger.warn('message poll failed', { error: errorMessage(error) });
        await sleep(pollMs, options.signal).catch(() => undefined);
        continue;
      }
      await options.onTick?.(messages);
      const idle = turnCompleted(messages, baseline);
      if (idle) {
        return { messages, outcome: idle.outcome ?? null, timedOut: false };
      }
      await sleep(pollMs, options.signal).catch(() => undefined);
      if (options.signal?.aborted) {
        return { messages, outcome: 'interrupted', timedOut: false };
      }
    }
  }
}

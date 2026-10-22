import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const nowMs = (): number => Date.now();

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function jitter(ms: number, factor = 0.25): number {
  const spread = ms * factor;
  return Math.max(0, Math.round(ms - spread + Math.random() * spread * 2));
}

export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  maxMs?: number;
  signal?: AbortSignal;
  retryable?: (error: unknown) => boolean;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function retryAfterMsOf(error: unknown): number | null {
  if (error && typeof error === 'object' && 'retryAfterMs' in error) {
    const value = (error as { retryAfterMs?: unknown }).retryAfterMs;
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

/**
 * Exponential backoff with jitter. Honors an explicit retryAfterMs on the error
 * (Telegram 429) instead of guessing.
 */
export async function retry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 5;
  const baseMs = options.baseMs ?? 500;
  const maxMs = options.maxMs ?? 30_000;
  const retryable = options.retryable ?? (() => true);
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !retryable(error)) throw error;
      const override = retryAfterMsOf(error);
      const delay = override ?? Math.min(maxMs, baseMs * 2 ** (attempt - 1));
      const wait = override ?? jitter(delay);
      options.onRetry?.(error, attempt, wait);
      await sleep(wait, options.signal);
    }
  }
  throw lastError;
}

export function short(value: unknown, limit = 150): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

export function ago(timestamp: number | undefined): string {
  if (!timestamp) return '?';
  const seconds = Math.max(0, (Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

export function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Legacy Markdown escaping used by the original bridge (parse_mode: Markdown). */
export function escapeMarkdown(text: unknown): string {
  return String(text ?? '').replace(/[*_`[\]]/g, (character) => `\\${character}`);
}

function escapeHtml(text: unknown): string {
  return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export { escapeHtml };

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function randomId(prefix = ''): string {
  return `${prefix}${crypto.randomBytes(6).toString('hex')}`;
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** Atomic write: temp file in the same directory, then rename. Retries on Windows sharing violations. */
export function atomicWriteFile(file: string, data: string): void {
  ensureDir(path.dirname(file));
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, data);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.renameSync(temp, file);
      return;
    } catch (error) {
      if (attempt === 4) {
        try {
          fs.copyFileSync(temp, file);
          fs.unlinkSync(temp);
          return;
        } catch {
          throw error;
        }
      }
      const end = Date.now() + 50;
      while (Date.now() < end) {
        /* small busy wait; rename is not async friendly here */
      }
    }
  }
}

export function parseBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  }
  return fallback;
}

export function parseNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function splitWords(text: string, limit = 64): string[] {
  return text.split(/\s+/).filter(Boolean).slice(0, limit);
}

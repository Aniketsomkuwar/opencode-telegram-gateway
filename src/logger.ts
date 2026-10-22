import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from './util.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  file?: string;
  level?: LogLevel;
  maxBytes?: number;
  keep?: number;
  /** Also mirror to stderr (default true for warn and error). */
  mirror?: boolean;
}

export class Logger {
  private readonly file?: string;
  private readonly maxBytes: number;
  private readonly keep: number;
  private readonly mirror: boolean;
  private level: LogLevel;

  constructor(options: LoggerOptions = {}) {
    this.file = options.file;
    this.level = options.level ?? 'info';
    this.maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
    this.keep = options.keep ?? 3;
    this.mirror = options.mirror ?? true;
    if (this.file) ensureDir(path.dirname(this.file));
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  getLevel(): LogLevel {
    return this.level;
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.write('debug', message, fields);
  }

  info(message: string, fields?: Record<string, unknown>): void {
    this.write('info', message, fields);
  }

  warn(message: string, fields?: Record<string, unknown>): void {
    this.write('warn', message, fields);
  }

  error(message: string, fields?: Record<string, unknown>): void {
    this.write('error', message, fields);
  }

  private write(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (ORDER[level] < ORDER[this.level]) return;
    const record = { ts: new Date().toISOString(), level, msg: message, ...fields };
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      line = JSON.stringify({ ts: record.ts, level, msg: message });
    }
    if (this.file) {
      try {
        fs.appendFileSync(this.file, `${line}\n`);
        this.rotateIfNeeded();
      } catch {
        /* logging must never break the gateway */
      }
    }
    if (this.mirror && ORDER[level] >= ORDER.warn) {
      process.stderr.write(`${line}\n`);
    }
    if (!this.file && ORDER[level] >= ORDER.info) {
      process.stdout.write(`${line}\n`);
    }
  }

  private rotateIfNeeded(): void {
    if (!this.file) return;
    let size = 0;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return;
    }
    if (size < this.maxBytes) return;
    for (let index = this.keep; index >= 1; index--) {
      const source = index === 1 ? this.file : `${this.file}.${index - 1}`;
      const target = `${this.file}.${index}`;
      try {
        if (fs.existsSync(source)) {
          if (fs.existsSync(target)) fs.unlinkSync(target);
          fs.renameSync(source, target);
        }
      } catch {
        /* ignore */
      }
    }
  }
}

export function levelFromString(value: unknown, fallback: LogLevel = 'info'): LogLevel {
  const normalized = String(value ?? '').toLowerCase();
  if (normalized === 'debug' || normalized === 'info' || normalized === 'warn' || normalized === 'error') {
    return normalized;
  }
  if (normalized === 'warning') return 'warn';
  return fallback;
}

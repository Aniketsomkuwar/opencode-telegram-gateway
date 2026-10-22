import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from './util.js';
import type { Logger } from './logger.js';

export interface AuditEvent {
  actor?: string | number;
  action: string;
  detail?: string;
  meta?: Record<string, unknown>;
}

/** Append-only JSONL audit trail with size-based rotation. */
export class AuditLog {
  private readonly file: string;
  private readonly maxBytes: number;
  private readonly keep: number;
  private readonly logger?: Logger;

  constructor(file: string, maxBytes = 5 * 1024 * 1024, keep = 5, logger?: Logger) {
    this.file = file;
    this.maxBytes = maxBytes;
    this.keep = keep;
    this.logger = logger;
    ensureDir(path.dirname(this.file));
  }

  write(event: AuditEvent): void {
    const record = { ts: new Date().toISOString(), ...event };
    try {
      fs.appendFileSync(this.file, `${JSON.stringify(record)}\n`);
      this.rotateIfNeeded();
    } catch (error) {
      this.logger?.warn('audit write failed', { error: (error as Error).message });
    }
  }

  tail(limit = 20): string[] {
    try {
      const lines = fs.readFileSync(this.file, 'utf8').trim().split('\n').filter(Boolean);
      return lines.slice(-limit);
    } catch {
      return [];
    }
  }

  private rotateIfNeeded(): void {
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

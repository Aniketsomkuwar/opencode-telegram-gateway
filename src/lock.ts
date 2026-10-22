import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteFile, ensureDir } from './util.js';

export interface LockInfo {
  pid: number;
  host: string;
  startedAt: number;
}

export class LockHeldError extends Error {
  readonly holder: LockInfo;
  constructor(holder: LockInfo) {
    super(`another gateway is already running (pid ${holder.pid} on ${holder.host}, since ${new Date(holder.startedAt).toISOString()})`);
    this.name = 'LockHeldError';
    this.holder = holder;
  }
}

function isAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

export function readLock(lockPath: string): LockInfo | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as Partial<LockInfo>;
    if (typeof parsed.pid !== 'number') return null;
    return { pid: parsed.pid, host: String(parsed.host ?? '?'), startedAt: Number(parsed.startedAt ?? 0) };
  } catch {
    return null;
  }
}

export function lockStatus(lockPath: string): { held: boolean; info: LockInfo | null; stale: boolean } {
  const info = readLock(lockPath);
  if (!info) return { held: false, info: null, stale: false };
  const alive = info.host === os.hostname() ? isAlive(info.pid) : true;
  return { held: alive, info, stale: !alive };
}

export class InstanceLock {
  readonly file: string;
  private acquired = false;

  constructor(home: string) {
    this.file = path.join(home, 'gateway.lock');
  }

  acquire(): void {
    ensureDir(path.dirname(this.file));
    const status = lockStatus(this.file);
    if (status.held && status.info) throw new LockHeldError(status.info);
    const info: LockInfo = { pid: process.pid, host: os.hostname(), startedAt: Date.now() };
    atomicWriteFile(this.file, JSON.stringify(info));
    this.acquired = true;
  }

  release(): void {
    if (!this.acquired) return;
    const info = readLock(this.file);
    if (info && info.pid === process.pid) {
      try {
        fs.unlinkSync(this.file);
      } catch {
        /* ignore */
      }
    }
    this.acquired = false;
  }
}

import type { QueueJob } from './types.js';
import { randomId } from './util.js';
import type { Logger } from './logger.js';

interface Entry {
  job: QueueJob;
  run: (job: QueueJob) => Promise<void>;
}

export interface EnqueueResult {
  position: number;
  queued: boolean;
  ahead: number;
}

/**
 * One runner per OpenCode session, FIFO, plus a global cap.
 * OpenCode rejects concurrent prompts on the same session, so this is the only
 * place that decides when a prompt is allowed to start.
 */
export class SessionQueue {
  private readonly pending = new Map<string, Entry[]>();
  private readonly busy = new Set<string>();
  private readonly limitPerSession: number;
  private readonly logger: Logger;
  private stopped = false;
  private active = 0;

  constructor(limitPerSession: number, logger: Logger) {
    this.limitPerSession = Math.max(1, limitPerSession);
    this.logger = logger;
  }

  enqueue(sessionId: string, job: Omit<QueueJob, 'id' | 'enqueuedAt'>, run: (job: QueueJob) => Promise<void>): EnqueueResult {
    if (this.stopped) throw new Error('gateway is shutting down');
    const queue = this.pending.get(sessionId) ?? [];
    const ahead = queue.length + (this.busy.has(sessionId) ? 1 : 0);
    if (ahead >= this.limitPerSession) throw new Error(`queue full (${this.limitPerSession}) for this session`);
    const entry: Entry = { job: { ...job, id: randomId('q_'), enqueuedAt: Date.now() }, run };
    queue.push(entry);
    this.pending.set(sessionId, queue);
    const result: EnqueueResult = { position: ahead + 1, queued: ahead > 0, ahead };
    void this.drain(sessionId);
    return result;
  }

  private async drain(sessionId: string): Promise<void> {
    if (this.busy.has(sessionId) || this.stopped) return;
    const queue = this.pending.get(sessionId);
    const entry = queue?.shift();
    if (!entry) {
      this.pending.delete(sessionId);
      return;
    }
    this.busy.add(sessionId);
    this.active++;
    try {
      await entry.run(entry.job);
    } catch (error) {
      this.logger.error('queued job failed', { sessionId, error: (error as Error).message });
    } finally {
      this.busy.delete(sessionId);
      this.active--;
      if (queue && queue.length) void this.drain(sessionId);
      else this.pending.delete(sessionId);
    }
  }

  cancel(sessionId: string): number {
    const queue = this.pending.get(sessionId);
    if (!queue?.length) return 0;
    const count = queue.length;
    this.pending.delete(sessionId);
    return count;
  }

  cancelAll(): number {
    let count = 0;
    for (const queue of this.pending.values()) count += queue.length;
    this.pending.clear();
    return count;
  }

  depth(sessionId: string): number {
    return (this.pending.get(sessionId)?.length ?? 0) + (this.busy.has(sessionId) ? 1 : 0);
  }

  snapshot(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [sessionId, queue] of this.pending) result[sessionId] = queue.length + (this.busy.has(sessionId) ? 1 : 0);
    for (const sessionId of this.busy) result[sessionId] ??= 1;
    return result;
  }

  get activeCount(): number {
    return this.active;
  }

  isBusy(sessionId: string): boolean {
    return this.busy.has(sessionId);
  }

  positions(sessionId: string): string[] {
    return (this.pending.get(sessionId) ?? []).map((entry) => entry.job.id);
  }

  stop(): void {
    this.stopped = true;
    this.pending.clear();
  }
}

import type { ScheduledJob } from './types.js';
import { randomId } from './util.js';

const MINUTE = 60_000;

/** "in 10m", "in 2h", "at 09:30", "at 2026-10-24T09:30". Returns epoch ms or an error string. */
export function parseWhen(input: string, now = Date.now()): { at: number } | { error: string } {
  const text = input.trim().toLowerCase();
  const relative = /^in\s+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hours?|s|sec|seconds?)$/.exec(text);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2] as string;
    const multiplier = unit.startsWith('h') ? 3_600_000 : unit.startsWith('s') ? 1000 : MINUTE;
    return { at: now + amount * multiplier };
  }
  const clock = /^at\s+(\d{1,2}):(\d{2})$/.exec(text);
  if (clock) {
    const date = new Date(now);
    date.setHours(Number(clock[1]), Number(clock[2]), 0, 0);
    if (date.getTime() <= now) date.setDate(date.getDate() + 1);
    return { at: date.getTime() };
  }
  const iso = /^at\s+(\d{4}-\d{2}-\d{2})[t ](\d{2}:\d{2})/.exec(text);
  if (iso) {
    const date = new Date(`${iso[1]}T${iso[2]}:00`);
    if (Number.isNaN(date.getTime())) return { error: 'could not parse that date' };
    return { at: date.getTime() };
  }
  return { error: 'use "in 10m", "in 2h", "at 09:30" or "at 2026-10-24T09:30"' };
}

interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
}

function parseField(field: string, min: number, max: number): Set<number> | null {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const stepMatch = /^(\*|\d+(?:-\d+)?)\/(\d+)$/.exec(part);
    if (stepMatch) {
      const step = Number(stepMatch[2]);
      if (!step) return null;
      const range = stepMatch[1] === '*' ? [min, max] : (stepMatch[1] as string).split('-').map(Number);
      const start = range[0] as number;
      const end = range[1] ?? max;
      for (let value = start; value <= end; value += step) values.add(value);
      continue;
    }
    const rangeMatch = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = rangeMatch[2] ? Number(rangeMatch[2]) : start;
      if (start < min || end > max || start > end) return null;
      for (let value = start; value <= end; value++) values.add(value);
      continue;
    }
    if (part === '*') {
      for (let value = min; value <= max; value++) values.add(value);
      continue;
    }
    return null;
  }
  return values.size ? values : null;
}

export function parseCron(expression: string): CronFields | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dayOfMonthRaw, month, dayOfWeekRaw] = parts as [string, string, string, string, string];
  const minuteSet = parseField(minute, 0, 59);
  const hourSet = parseField(hour, 0, 23);
  const domSet = parseField(dayOfMonthRaw, 1, 31);
  const monthSet = parseField(month, 1, 12);
  const dowSet = parseField(dayOfWeekRaw.replace(/7/g, '0'), 0, 6);
  if (!minuteSet || !hourSet || !domSet || !monthSet || !dowSet) return null;
  return { minute: minuteSet, hour: hourSet, dayOfMonth: domSet, month: monthSet, dayOfWeek: dowSet };
}

export function nextCronRun(expression: string, from = Date.now()): number | null {
  const fields = parseCron(expression);
  if (!fields) return null;
  const date = new Date(from);
  date.setSeconds(0, 0);
  date.setMinutes(date.getMinutes() + 1);
  const limit = from + 366 * 24 * 60 * MINUTE;
  while (date.getTime() < limit) {
    if (
      fields.month.has(date.getMonth() + 1) &&
      fields.dayOfMonth.has(date.getDate()) &&
      fields.dayOfWeek.has(date.getDay()) &&
      fields.hour.has(date.getHours()) &&
      fields.minute.has(date.getMinutes())
    ) {
      return date.getTime();
    }
    date.setMinutes(date.getMinutes() + 1);
  }
  return null;
}

export interface SchedulerCallbacks {
  run: (job: ScheduledJob) => Promise<void>;
  persist: () => void;
}

export class Scheduler {
  private jobs: ScheduledJob[] = [];
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly callbacks: SchedulerCallbacks) {}

  load(jobs: ScheduledJob[]): void {
    this.jobs = jobs;
  }

  list(): ScheduledJob[] {
    return [...this.jobs];
  }

  add(job: Omit<ScheduledJob, 'id' | 'createdAt'>): ScheduledJob {
    const created: ScheduledJob = { ...job, id: randomId('j_'), createdAt: Date.now() };
    this.jobs.push(created);
    this.callbacks.persist();
    return created;
  }

  remove(id: string): boolean {
    const before = this.jobs.length;
    this.jobs = this.jobs.filter((job) => job.id !== id && !job.id.startsWith(id));
    if (this.jobs.length !== before) this.callbacks.persist();
    return this.jobs.length !== before;
  }

  clear(): number {
    const count = this.jobs.length;
    this.jobs = [];
    this.callbacks.persist();
    return count;
  }

  start(tickMs = 15_000): void {
    if (this.running) return;
    this.running = true;
    const tick = async (): Promise<void> => {
      if (!this.running) return;
      const now = Date.now();
      for (const job of [...this.jobs]) {
        if (job.nextRun > now) continue;
        try {
          await this.callbacks.run(job);
        } catch {
          /* the runner logs its own failures */
        }
        job.lastRun = now;
        if (job.kind === 'every' || job.kind === 'cron') {
          if (job.kind === 'cron') {
            const next = nextCronRun(job.spec, now);
            if (next === null) {
              this.remove(job.id);
              continue;
            }
            job.nextRun = next;
          } else {
            const interval = Number(job.spec);
            job.nextRun = now + (Number.isFinite(interval) && interval > 0 ? interval : 60_000);
          }
        } else {
          this.remove(job.id);
        }
      }
      this.callbacks.persist();
    };
    this.timer = setInterval(() => void tick(), tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

import fs from 'node:fs';
import type { ChatState, ScheduledJob } from './types.js';
import { atomicWriteFile, ensureDir } from './util.js';
import path from 'node:path';
import type { Logger } from './logger.js';

export interface StateFile {
  version: 2;
  offset: number;
  chats: Record<string, ChatState>;
  jobs: ScheduledJob[];
  updatedAt: number;
}

function emptyState(): StateFile {
  return { version: 2, offset: 0, chats: {}, jobs: [], updatedAt: Date.now() };
}

/**
 * Tolerant loader with a v1 -> v2 migration.
 * v1 stored `__offset` plus one top-level key per user id (`{ sessionId, lastList }`).
 */
export function migrateState(input: unknown): StateFile {
  const state = emptyState();
  if (!input || typeof input !== 'object' || Array.isArray(input)) return state;
  const raw = input as Record<string, unknown>;

  const offset = Number(raw.__offset ?? raw.offset ?? 0);
  if (Number.isFinite(offset) && offset >= 0) state.offset = offset;

  const chatsSource =
    raw.chats && typeof raw.chats === 'object' && !Array.isArray(raw.chats)
      ? (raw.chats as Record<string, unknown>)
      : raw;

  for (const [key, value] of Object.entries(chatsSource)) {
    if (key.startsWith('__')) continue;
    if (key === 'version' || key === 'jobs' || key === 'updatedAt' || key === 'chats') continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    if (!('sessionId' in entry) && !('lastList' in entry) && !('locked' in entry) && !('topics' in entry) && !('btwSessionId' in entry)) continue;
    state.chats[key] = {
      sessionId: typeof entry.sessionId === 'string' ? entry.sessionId : null,
      lastList: Array.isArray(entry.lastList) ? entry.lastList.map(String) : undefined,
      locked: entry.locked === true ? true : undefined,
      topics:
        entry.topics && typeof entry.topics === 'object' && !Array.isArray(entry.topics)
          ? Object.fromEntries(Object.entries(entry.topics as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
          : undefined,
      lastPrompt: typeof entry.lastPrompt === 'string' ? entry.lastPrompt : undefined,
      btwSessionId: typeof entry.btwSessionId === 'string' ? entry.btwSessionId : undefined,
    };
  }

  if (Array.isArray(raw.jobs)) {
    state.jobs = raw.jobs.filter((job): job is ScheduledJob => {
      if (!job || typeof job !== 'object') return false;
      const candidate = job as Partial<ScheduledJob>;
      return typeof candidate.id === 'string' && typeof candidate.text === 'string' && typeof candidate.chatId === 'number';
    });
  }
  return state;
}

export class StateStore {
  readonly file: string;
  private state: StateFile;
  private timer: NodeJS.Timeout | null = null;
  private readonly logger?: Logger;

  constructor(file: string, logger?: Logger) {
    this.file = file;
    this.logger = logger;
    this.state = this.load();
  }

  private load(): StateFile {
    if (!fs.existsSync(this.file)) return emptyState();
    try {
      return migrateState(JSON.parse(fs.readFileSync(this.file, 'utf8').replace(/^\uFEFF/, '')));
    } catch (error) {
      const backup = `${this.file}.corrupt.${Date.now()}`;
      try {
        fs.copyFileSync(this.file, backup);
      } catch {
        /* ignore */
      }
      this.logger?.error('state file unreadable; started fresh', { error: (error as Error).message, backup });
      return emptyState();
    }
  }

  get offset(): number {
    return this.state.offset;
  }

  set offset(value: number) {
    if (value > this.state.offset) {
      this.state.offset = value;
      this.scheduleSave();
    }
  }

  get jobs(): ScheduledJob[] {
    return this.state.jobs;
  }

  set jobs(jobs: ScheduledJob[]) {
    this.state.jobs = jobs;
    this.scheduleSave();
  }

  chat(chatId: number | string): ChatState {
    const key = String(chatId);
    this.state.chats[key] ??= { sessionId: null };
    return this.state.chats[key];
  }

  peekChat(chatId: number | string): ChatState | undefined {
    return this.state.chats[String(chatId)];
  }

  /** Reverse lookup for forum topics. */
  chatForTopic(topicId: number): { chatId: string; state: ChatState } | undefined {
    for (const [chatId, chat] of Object.entries(this.state.chats)) {
      if (chat.topics && chat.topics[String(topicId)]) return { chatId, state: chat };
    }
    return undefined;
  }

  snapshot(): StateFile {
    return { ...this.state, updatedAt: Date.now() };
  }

  scheduleSave(delayMs = 200): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, delayMs);
    this.timer.unref?.();
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      ensureDir(path.dirname(this.file));
      atomicWriteFile(this.file, `${JSON.stringify(this.snapshot(), null, 2)}\n`);
    } catch (error) {
      this.logger?.error('failed to write state', { error: (error as Error).message });
    }
  }
}

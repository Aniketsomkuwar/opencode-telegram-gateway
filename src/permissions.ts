import type { PermissionDecision, PermissionRequest } from './types.js';
import { randomId, short } from './util.js';
import type { Logger } from './logger.js';

export type Risk = 'low' | 'medium' | 'high';

export interface PendingPermission {
  key: string;
  sessionId: string;
  requestId: string;
  chatId: number;
  messageId?: number;
  action: string;
  resources: string[];
  risk: Risk;
  createdAt: number;
  timer: NodeJS.Timeout;
}

export interface DecideContext {
  permission: PendingPermission;
  decision: PermissionDecision;
  userId?: number;
  reason: 'user' | 'timeout' | 'shutdown' | 'lock';
}

export function riskOf(action: string, resources: string[]): Risk {
  const text = `${action} ${resources.join(' ')}`.toLowerCase();
  if (/\b(bash|shell|exec|spawn|terminal|run|command|pty)\b/.test(text)) return 'high';
  if (/\b(write|edit|patch|delete|remove|move|rename|chmod|mkdir|apply)\b/.test(text)) return 'medium';
  if (/\b(read|list|glob|grep|search|fetch|web|view|stat)\b/.test(text)) return 'low';
  return 'medium';
}

export function summarisePermission(request: Pick<PermissionRequest, 'action' | 'resources' | 'message'>, cwd?: string): string {
  const risk = riskOf(request.action, request.resources);
  const label = risk === 'high' ? 'HIGH RISK' : risk === 'medium' ? 'CHANGES FILES' : 'READ ONLY';
  const lines = [`[${label}] ${request.action}`];
  const resource = request.resources[0];
  if (resource) lines.push(short(resource.replace(/\s+/g, ' '), 300));
  if (request.resources.length > 1) lines.push(`+${request.resources.length - 1} more`);
  if (request.message && request.message !== resource) lines.push(short(request.message, 160));
  if (cwd) lines.push(`in ${short(cwd, 160)}`);
  return lines.join('\n');
}

const CALLBACK_PREFIX = 'p';

export function permissionCallbackKey(): string {
  return randomId('');
}

export function encodeCallback(key: string, decision: PermissionDecision): string {
  return `${CALLBACK_PREFIX}:${key}:${decision}`;
}

export function decodeCallback(data: string): { key: string; decision: PermissionDecision } | null {
  const match = /^p:([a-f0-9]{6,16}):(once|always|reject)$/.exec(data);
  if (!match) return null;
  return { key: match[1] as string, decision: match[2] as PermissionDecision };
}

export interface BrokerOptions {
  timeoutSeconds: number;
  logger: Logger;
  onDecision: (context: DecideContext) => Promise<void> | void;
}

/** Tracks permission requests, enforces the auto-deny timeout, and dedupes retries. */
export class PermissionBroker {
  private readonly pending = new Map<string, PendingPermission>();
  private readonly byRequest = new Map<string, string>();
  private readonly options: BrokerOptions;
  private disposed = false;

  constructor(options: BrokerOptions) {
    this.options = options;
  }

  isTracked(requestId: string): boolean {
    return this.byRequest.has(requestId);
  }

  register(request: PermissionRequest, chatId: number): PendingPermission {
    const key = permissionCallbackKey();
    const risk = riskOf(request.action, request.resources);
    const timer = setTimeout(() => {
      void this.resolve(key, 'reject', { reason: 'timeout' });
    }, Math.max(10_000, this.options.timeoutSeconds * 1000));
    timer.unref?.();
    const permission: PendingPermission = {
      key,
      sessionId: request.sessionID,
      requestId: request.id,
      chatId,
      action: request.action,
      resources: request.resources ?? [],
      risk,
      createdAt: Date.now(),
      timer,
    };
    this.pending.set(key, permission);
    this.byRequest.set(request.id, key);
    return permission;
  }

  attachMessage(key: string, messageId: number): void {
    const permission = this.pending.get(key);
    if (permission) permission.messageId = messageId;
  }

  get(key: string): PendingPermission | undefined {
    return this.pending.get(key);
  }

  list(): PendingPermission[] {
    return [...this.pending.values()];
  }

  async resolve(
    key: string,
    decision: PermissionDecision,
    options: { userId?: number; reason?: DecideContext['reason'] } = {},
  ): Promise<PendingPermission | null> {
    const permission = this.pending.get(key);
    if (!permission) return null;
    clearTimeout(permission.timer);
    this.pending.delete(key);
    this.byRequest.delete(permission.requestId);
    await this.options.onDecision({
      permission,
      decision,
      userId: options.userId,
      reason: options.reason ?? 'user',
    });
    return permission;
  }

  /** Auto-deny everything, used on shutdown and by /lock. */
  async rejectAll(reason: DecideContext['reason']): Promise<number> {
    const keys = [...this.pending.keys()];
    for (const key of keys) await this.resolve(key, 'reject', { reason });
    return keys.length;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const permission of this.pending.values()) clearTimeout(permission.timer);
    this.pending.clear();
    this.byRequest.clear();
  }
}

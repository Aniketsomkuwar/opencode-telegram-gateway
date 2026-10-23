import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Config, Paths } from './config.js';
import { saveConfig } from './config.js';
import type { AuditLog } from './audit.js';
import type { Logger } from './logger.js';
import { OpencodeClient, idleBaselineOf } from './opencode.js';
import { TelegramClient, TelegramError } from './telegram.js';
import type { InlineButton, TelegramMessage, TelegramUpdate } from './telegram.js';
import { SessionQueue } from './queue.js';
import { PermissionBroker, decodeCallback, encodeCallback, summarisePermission, type DecideContext } from './permissions.js';
import { StateStore } from './state.js';
import { Scheduler, nextCronRun, parseWhen } from './scheduler.js';
import { redactSecrets } from './redact.js';
import { formatForTelegram, escapeMd } from './markdown.js';
import type { ChatState, MessageInfo, Role, SessionInfo } from './types.js';
import { atomicWriteFile, duration, errorMessage, randomId, short } from './util.js';
import { applyPromptHook, applyReplyHook, loadHooks, type GatewayHooks } from './hooks.js';

interface UpdateContext {
  chatId: number;
  userId: number;
  threadId?: number;
  replyTo?: number;
  role: Role;
}

interface PromptRequest {
  ctx: UpdateContext;
  text: string;
  files: Array<{ uri: string; name?: string }>;
  /** Target a specific session instead of the chat's current one (used by /btw). */
  sessionId?: string;
  /** Side question: do not overwrite the work session's lastPrompt. */
  side?: boolean;
}

const VIEWER_COMMANDS = new Set(['/start', '/help', '/commands', '/ping', '/sessions', '/active', '/status', '/cost', '/diff', '/todo', '/health', '/queue', '/whoami']);

export class Gateway {
  private readonly config: Config;
  private readonly paths: Paths;
  private readonly logger: Logger;
  private readonly audit: AuditLog;
  private readonly telegram: TelegramClient;
  private readonly opencode: OpencodeClient;
  private readonly state: StateStore;
  private readonly queue: SessionQueue;
  private readonly permissions: PermissionBroker;
  private readonly scheduler: Scheduler;
  private readonly abort = new AbortController();
  private readonly startedAt = Date.now();
  private readonly lastModels = new Map<string, string[]>();
  private readonly lastAgents = new Map<string, string[]>();
  private readonly messageSessions = new Map<number, string>();
  private readonly rate = new Map<number, number[]>();
  private readonly inFlight = new Set<string>();
  private heartbeat: NodeJS.Timeout | null = null;
  private watchTimer: NodeJS.Timeout | null = null;
  private hooks: GatewayHooks = {};
  private readonly watchTrack = new Map<string, { title: string; since: number; gone: number }>();
  private readonly deletions = new Map<string, { sessionId: string; chatId: number; threadId?: number; timer: NodeJS.Timeout }>();
  private webhookServer: import('node:http').Server | null = null;
  private lastError: string | null = null;
  private stopping = false;
  private botId: number | null = null;

  constructor(config: Config, paths: Paths, logger: Logger, audit: AuditLog) {
    this.config = config;
    this.paths = paths;
    this.logger = logger;
    this.audit = audit;
    this.telegram = new TelegramClient(config.botToken, logger);
    this.opencode = new OpencodeClient({
      serviceUrl: config.serviceUrl,
      servicePort: config.servicePort,
      logger,
    });
    this.state = new StateStore(paths.state, logger);
    this.queue = new SessionQueue(config.queueLimit, logger);
    this.scheduler = new Scheduler({
      run: (job) => this.runScheduledJob(job),
      persist: () => {
        this.state.jobs = this.scheduler.list();
      },
    });
    this.permissions = new PermissionBroker({
      timeoutSeconds: config.permissionTimeoutSeconds,
      logger,
      onDecision: (context) => this.applyPermissionDecision(context),
    });
  }

  get sessionQueue(): SessionQueue {
    return this.queue;
  }

  get opencodeClient(): OpencodeClient {
    return this.opencode;
  }

  async start(): Promise<void> {
    const me = await this.telegram.getMe();
    this.botId = me.id;
    this.logger.info('gateway starting', {
      bot: me.username ?? me.id,
      allowed: this.config.allowedUserIds.length,
      home: this.paths.home,
    });

    await this.telegram.deleteWebhook().catch((error) => this.logger.warn('deleteWebhook failed', { error: errorMessage(error) }));
    await this.telegram.setMyCommands(this.commandMenu()).catch(() => undefined);

    try {
      const info = await this.opencode.info();
      this.logger.info('opencode reachable', { version: info.version, urls: info.urls });
      const external = info.urls.filter((url) => !/127\.0\.0\.1|localhost|\[::1\]/.test(url));
      if (external.length) {
        this.logger.warn('opencode is reachable beyond loopback', { urls: external });
        this.audit.write({ action: 'startup.nonlocal-bind', detail: external.join(', ') });
      }
    } catch (error) {
      this.lastError = errorMessage(error);
      this.logger.error('opencode unreachable at startup; will retry', { error: this.lastError });
    }

    this.scheduler.load(this.state.jobs);
    this.scheduler.start();
    this.hooks = await loadHooks(this.config.plugin, this.logger);
    this.startWatch();
    this.startHeartbeat();
    await this.startWebhook();

    this.state.flush();
    void this.pollLoop();
  }

  async stop(reason = 'shutdown'): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.logger.info('gateway stopping', { reason });
    this.abort.abort(new Error(reason));
    this.scheduler.stop();
    this.queue.stop();
    await this.permissions.rejectAll('shutdown').catch(() => undefined);
    this.permissions.dispose();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
    for (const pending of this.deletions.values()) clearTimeout(pending.timer);
    this.deletions.clear();
    await new Promise<void>((resolve) => {
      if (!this.webhookServer) return resolve();
      this.webhookServer.close(() => resolve());
    });
    this.state.flush();
    this.writeHeartbeat('stopped', reason);
  }

  // ---------------------------------------------------------------- polling

  private async pollLoop(): Promise<void> {
    let offset = this.state.offset;
    let failures = 0;
    while (!this.abort.signal.aborted) {
      try {
        const updates = await this.telegram.getUpdates(offset, 50, this.abort.signal);
        failures = 0;
        for (const update of updates) {
          if (this.abort.signal.aborted) break;
          await this.handleUpdate(update).catch((error) => {
            this.lastError = errorMessage(error);
            this.logger.error('update handler failed', { error: this.lastError });
          });
          // Persist after handling: a crash may replay one update, never lose one.
          offset = Math.max(offset, update.update_id + 1);
          this.state.offset = offset;
          this.state.flush();
        }
      } catch (error) {
        if (this.abort.signal.aborted) break;
        failures++;
        this.lastError = errorMessage(error);
        const wait = Math.min(60_000, 1000 * 2 ** Math.min(failures, 6));
        this.logger.warn('poll failed', { failures, wait, error: this.lastError });
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) return this.handleCallback(update.callback_query);
    const message = update.message ?? update.edited_message;
    if (!message) return;
    return this.handleMessage(message);
  }

  // ---------------------------------------------------------------- access

  private roleFor(userId: number): Role {
    return this.config.roles[String(userId)] ?? 'operator';
  }

  private isAllowed(userId: number): boolean {
    return this.config.allowedUserIds.includes(userId) || this.config.ownerUserIds.includes(userId);
  }

  private rateLimited(userId: number): boolean {
    const now = Date.now();
    const window = (this.rate.get(userId) ?? []).filter((stamp) => now - stamp < 60_000);
    window.push(now);
    this.rate.set(userId, window);
    return window.length > this.config.rateLimitPerMinute;
  }

  private sessionRef(chatId: number, threadId?: number): { get: () => string | null; set: (sessionId: string | null) => void } {
    const chat = this.state.chat(chatId);
    if (!threadId) {
      return {
        get: () => chat.sessionId,
        set: (sessionId) => {
          chat.sessionId = sessionId;
          this.state.scheduleSave();
        },
      };
    }
    chat.topics ??= {};
    const key = String(threadId);
    return {
      get: () => chat.topics?.[key] ?? null,
      set: (sessionId) => {
        if (!chat.topics) chat.topics = {};
        if (sessionId) chat.topics[key] = sessionId;
        else delete chat.topics[key];
        this.state.scheduleSave();
      },
    };
  }

  private async handleMessage(message: TelegramMessage): Promise<void> {
    if (!message.from || message.from.is_bot) return;
    const chatId = message.chat.id;
    const userId = message.from.id;
    const threadId = message.is_topic_message ? message.message_thread_id : undefined;

    if (!this.isAllowed(userId)) {
      if (!this.config.allowedUserIds.length) {
        await this.telegram
          .sendFormatted(chatId, `User id ${userId}. Add it to allowedUserIds in config.json and restart.`, { messageThreadId: threadId })
          .catch(() => undefined);
      }
      this.audit.write({ actor: userId, action: 'access.denied', detail: `chat ${chatId}` });
      return;
    }

    if (this.rateLimited(userId)) {
      await this.telegram.sendFormatted(chatId, 'rate limited; wait a minute', { messageThreadId: threadId }).catch(() => undefined);
      return;
    }

    const ctx: UpdateContext = {
      chatId,
      userId,
      threadId,
      replyTo: message.reply_to_message?.message_id,
      role: this.roleFor(userId),
    };

    const text = (message.text ?? message.caption ?? '').trim();
    if (message.voice || message.audio) return this.handleVoice(ctx, message, text);
    if (message.document || message.photo?.length) return this.handleAttachment(ctx, message, text);
    if (!text) return;

    this.logger.info('inbound', { userId, chatId, threadId, text: short(text, 80) });

    if (text.startsWith('/')) {
      const [rawCommand, ...rest] = text.split(/\s+/);
      const command = (rawCommand ?? '').toLowerCase();
      const argument = text.slice(rawCommand.length).trim();
      return this.handleCommand(ctx, command, argument, rest.length ? rest : []);
    }

    return this.enqueuePrompt({ ctx, text, files: [] });
  }

  private async handleCallback(callback: TelegramUpdate['callback_query'] & object): Promise<void> {
    if (!callback) return;
    const userId = callback.from.id;
    const data = callback.data ?? '';
    const chatId = callback.message?.chat.id;
    if (!this.isAllowed(userId)) {
      await this.telegram.answerCallbackQuery(callback.id, 'denied').catch(() => undefined);
      return;
    }
    const role = this.roleFor(userId);

    const permission = decodeCallback(data);
    if (permission) {
      if (permission.decision === 'always' && role !== 'owner') {
        await this.telegram.answerCallbackQuery(callback.id, 'only the owner can approve Always', true).catch(() => undefined);
        return;
      }
      const pending = this.permissions.get(permission.key);
      if (!pending) {
        await this.telegram.answerCallbackQuery(callback.id, 'expired').catch(() => undefined);
        return;
      }
      await this.telegram.answerCallbackQuery(callback.id, permission.decision).catch(() => undefined);
      await this.permissions.resolve(permission.key, permission.decision, { userId, reason: 'user' });
      return;
    }

    if ((data.startsWith('d:') || data.startsWith('x:')) && chatId) {
      if (data.startsWith('d:') && role !== 'owner') {
        await this.telegram.answerCallbackQuery(callback.id, 'owner only', true).catch(() => undefined);
        return;
      }
      const key = data.slice(2);
      const pending = this.deletions.get(key);
      if (!pending || pending.chatId !== chatId) {
        await this.telegram.answerCallbackQuery(callback.id, 'expired').catch(() => undefined);
        return;
      }
      clearTimeout(pending.timer);
      this.deletions.delete(key);
      if (data.startsWith('x:')) {
        await this.telegram.answerCallbackQuery(callback.id, 'cancelled').catch(() => undefined);
        if (callback.message) {
          await this.telegram.editMessageText(chatId, callback.message.message_id, 'Deletion cancelled').catch(() => undefined);
        }
        return;
      }
      try {
        this.queue.cancel(pending.sessionId);
        this.watchTrack.delete(pending.sessionId);
        await this.opencode.deleteSession(pending.sessionId);
      } catch (error) {
        this.logger.error('session delete failed', { sessionId: pending.sessionId, error: errorMessage(error) });
        await this.telegram.answerCallbackQuery(callback.id, 'delete failed', true).catch(() => undefined);
        if (callback.message) {
          await this.telegram
            .editMessageText(chatId, callback.message.message_id, `delete failed: ${short(errorMessage(error), 300)}`)
            .catch(() => undefined);
        }
        return;
      }
      const ref = this.sessionRef(chatId, pending.threadId);
      if (ref.get() === pending.sessionId) ref.set(null);
      const chat = this.state.chat(chatId);
      if (chat.lastList) chat.lastList = chat.lastList.filter((id) => id !== pending.sessionId);
      this.state.scheduleSave();
      this.audit.write({ actor: userId, action: 'session.delete', detail: pending.sessionId });
      await this.telegram.answerCallbackQuery(callback.id, 'deleted').catch(() => undefined);
      if (callback.message) {
        await this.telegram.editMessageText(chatId, callback.message.message_id, `deleted ${pending.sessionId}`).catch(() => undefined);
      }
      return;
    }

    if (data.startsWith('u:') && chatId) {      const sessionId = data.slice(2);
      const session = await this.opencode.session(sessionId).catch(() => null);
      if (!session) {
        await this.telegram.answerCallbackQuery(callback.id, 'session gone').catch(() => undefined);
        return;
      }
      this.sessionRef(chatId, callback.message?.message_thread_id).set(session.id);
      this.audit.write({ actor: userId, action: 'session.use', detail: session.id });
      await this.telegram.answerCallbackQuery(callback.id, 'switched').catch(() => undefined);
      if (callback.message) {
        await this.telegram
          .editMessageText(chatId, callback.message.message_id, `Current Terminal\n${escapeMd(short(session.title ?? '', 60))}\n${session.location?.directory ?? ''}`)
          .catch(() => undefined);
      }
      return;
    }

    if (data.startsWith('s:') && chatId && callback.message) {
      const page = Number.parseInt(data.slice(2), 10) || 0;
      const rendered = await this.renderSessions(chatId, callback.message.message_thread_id, page);
      await this.telegram.editMessageText(chatId, callback.message.message_id, rendered.text, { replyMarkup: rendered.keyboard }).catch(() => undefined);
      await this.telegram.answerCallbackQuery(callback.id).catch(() => undefined);
      return;
    }

    await this.telegram.answerCallbackQuery(callback.id, 'unknown action').catch(() => undefined);
  }

  // ---------------------------------------------------------------- commands

  private commandMenu(): Array<{ command: string; description: string }> {
    return [
      { command: 'sessions', description: 'list sessions' },
      { command: 'use', description: 'switch session' },
      { command: 'delete', description: 'delete a session' },
      { command: 'active', description: 'running sessions' },
      { command: 'new', description: 'new session' },
      { command: 'status', description: 'current session' },
      { command: 'stop', description: 'interrupt the run' },
      { command: 'queue', description: 'queued prompts' },
      { command: 'model', description: 'switch model' },
      { command: 'agent', description: 'switch agent' },
      { command: 'diff', description: 'files changed' },
      { command: 'cost', description: 'tokens and cost' },
      { command: 'compact', description: 'compact context' },
      { command: 'undo', description: 'revert last turn' },
      { command: 'redo', description: 're-run last prompt' },
      { command: 'todo', description: 'current todo list' },
      { command: 'btw', description: 'quick side question' },
      { command: 'schedule', description: 'run later' },
      { command: 'jobs', description: 'scheduled jobs' },
      { command: 'health', description: 'gateway health' },
      { command: 'lock', description: 'block all prompts' },
      { command: 'verbose', description: 'progress and tool feed' },
      { command: 'remember', description: 'save a note' },
    ];
  }

  private helpText(role: Role): string {
    const lines = [
      'Remote control for OpenCode.',
      'Plain text runs in the current session.',
      '',
      '/sessions - list sessions',
      '/use <n|id> - switch session',
      '/delete <n|id> - delete a session (confirmed, owner)',
      '/active - running sessions',
      '/new [title] - new session',
      '/newdir <path> [title] - new session in a folder',
      '/status - current session',
      '/queue - queued prompts, /clear drops them',
      '/stop - interrupt the run',
      '/model [n] - switch model',
      '/agent [n] - switch agent',
      '/diff [file] - changed files',
      '/cost - tokens and cost',
      '/compact - compact context',
      '/undo - revert the last turn',
      '/redo - re-run the last prompt',
      '/todo - latest todo list',
      '/btw <question> - quick side question, separate session',
      '/schedule in 10m <text> - run later',
      '/jobs - scheduled jobs, /cancel <id>',
      '/health - gateway health',
      '/verbose on|off - live progress',
      '/remember <text> - save a note',
      '/watch on|off - completion pings',
      '/ping - health check',
    ];
    if (role === 'owner') {
      lines.push('/lock, /unlock - kill switch', '/role <id> owner|operator|viewer', '/audit [n] - recent audit entries');
    }
    return lines.join('\n');
  }

  private async handleCommand(ctx: UpdateContext, command: string, argument: string, _words: string[]): Promise<void> {
    const reply = (text: string, keyboard?: InlineButton[][]): Promise<void> =>
      this.telegram
        .sendFormatted(ctx.chatId, text, { messageThreadId: ctx.threadId, replyMarkup: keyboard ? { inline_keyboard: keyboard } : undefined })
        .then(() => undefined)
        .catch((error) => {
          this.logger.warn('reply failed', { error: errorMessage(error) });
        });

    if (ctx.role === 'viewer' && !VIEWER_COMMANDS.has(command)) {
      return reply('viewer role: read-only commands only');
    }

    const chat = this.state.chat(ctx.chatId);
    const ref = this.sessionRef(ctx.chatId, ctx.threadId);

    switch (command) {
      case '/start':
      case '/help':
      case '/commands':
        return reply(this.helpText(ctx.role));

      case '/whoami':
        return reply(`user ${ctx.userId}\nrole ${ctx.role}\nchat ${ctx.chatId}${ctx.threadId ? ` topic ${ctx.threadId}` : ''}`);

      case '/ping': {
        const version = this.opencode.version ?? '?';
        return reply(`pong - OpenCode ${version}`);
      }

      case '/health':
        return reply(await this.healthText());

      case '/sessions': {
        const page = Math.max(0, Number.parseInt(argument, 10) || 0);
        const rendered = await this.renderSessions(ctx.chatId, ctx.threadId, page);
        return reply(rendered.text, rendered.keyboard);
      }

      case '/active': {
        const all = await this.opencode.sessions(50).catch(() => []);
        const running = new Set(await this.opencode.activeSessions().catch(() => []));
        const list = all.filter((session) => running.has(session.id));
        if (!list.length) return reply('nothing running');
        chat.lastList = list.map((session) => session.id);
        this.state.scheduleSave();
        return reply(this.renderSessionList(list, ref.get() ?? null, 'running'));
      }

      case '/use': {
        const session = await this.resolveSessionId(ctx.chatId, argument);
        if (!session) return reply('usage: /sessions then /use <number>');
        ref.set(session.id);
        this.audit.write({ actor: ctx.userId, action: 'session.use', detail: session.id });
        return reply(`Current Terminal\n${escapeMd(short(session.title ?? '', 60))}\n${session.location?.directory ?? ''}`);
      }

      case '/delete': {
        if (ctx.role !== 'owner') return reply('owner only');
        const session = await this.resolveSessionId(ctx.chatId, argument);
        if (!session) return reply('usage: /sessions then /delete <number>');
        const running = await this.opencode.activeSessions().catch(() => [] as string[]);
        const isCurrent = ref.get() === session.id;
        const key = randomId('');
        const timer = setTimeout(() => {
          if (!this.deletions.delete(key)) return;
          void this.telegram
            .sendFormatted(ctx.chatId, `delete confirmation for ${session.id} expired`, { messageThreadId: ctx.threadId })
            .catch(() => undefined);
        }, 120_000);
        timer.unref?.();
        this.deletions.set(key, { sessionId: session.id, chatId: ctx.chatId, threadId: ctx.threadId, timer });
        const lines = [
          `delete "${short(session.title ?? session.id, 60)}"?`,
          session.location?.directory ?? '',
          isCurrent ? 'this is the current session for this chat' : '',
          running.includes(session.id) ? 'it is running; deletion will abort it' : '',
          'this cannot be undone',
        ].filter(Boolean);
        return reply(lines.join('\n'), [
          [
            { text: 'Delete', callback_data: `d:${key}` },
            { text: 'Cancel', callback_data: `x:${key}` },
          ],
        ]);
      }

      case '/new': {
        const created = await this.opencode.createSession({ title: argument || `telegram ${new Date().toISOString().slice(0, 16)}` });
        ref.set(created.id);
        this.audit.write({ actor: ctx.userId, action: 'session.create', detail: created.id });
        return reply(`new session ${created.id}`);
      }

      case '/newdir': {
        const quoted = /^"([^"]+)"\s*(.*)$/.exec(argument) ?? /^(\S+)\s*(.*)$/.exec(argument);
        if (!quoted) return reply('usage: /newdir C:/path [title]');
        const directory = quoted[1] as string;
        const created = await this.opencode.createSession({ title: quoted[2] || 'telegram session', directory });
        ref.set(created.id);
        return reply(`new session ${created.id}\nin ${directory}`);
      }

      case '/status': {
        const lines = [`OpenCode ${this.opencode.version ?? '?'}`, `service ${this.opencode.baseUrl ?? 'unknown'}`];
        const sessionId = ref.get();
        if (sessionId) {
          const session = await this.opencode.session(sessionId);
          if (session) {
            const running = new Set(await this.opencode.activeSessions().catch(() => []));
            lines.push(`${session.id} ${running.has(session.id) ? 'running' : 'idle'}`);
            lines.push(escapeMd(short(session.title ?? '', 80)));
            lines.push(session.location?.directory ?? '');
            lines.push(`model ${session.model?.id ?? '?'} - agent ${session.agent ?? '?'}`);
            lines.push(`tokens ${(session.tokens?.input ?? 0) + (session.tokens?.output ?? 0)} - $${(session.cost ?? 0).toFixed(4)}`);
            const queued = this.queue.depth(session.id);
            if (queued) lines.push(`queued ${queued}`);
          } else lines.push('session missing; /sessions');
        } else lines.push('no session yet; /sessions or /new');
        lines.push(`watch ${this.config.watchAll ? 'on' : 'off'} - verbose ${this.config.verbose ? 'on' : 'off'} - lock ${chat.locked ? 'on' : 'off'}`);
        return reply(lines.join('\n'));
      }

      case '/stop': {
        const sessionId = ref.get();
        if (!sessionId) return reply('no session');
        this.queue.cancel(sessionId);
        await this.opencode.interrupt(sessionId);
        this.audit.write({ actor: ctx.userId, action: 'session.interrupt', detail: sessionId });
        return reply('interrupted');
      }

      case '/queue': {
        const sessionId = ref.get();
        if (!sessionId) return reply('no session');
        const depth = this.queue.depth(sessionId);
        if (!depth) return reply('queue empty');
        return reply(`${depth} item(s) for ${sessionId}\n/clear drops the waiting ones`);
      }

      case '/clear': {
        const sessionId = ref.get();
        if (!sessionId) return reply('no session');
        const removed = this.queue.cancel(sessionId);
        return reply(removed ? `cleared ${removed}` : 'nothing queued');
      }

      case '/verbose': {
        if (argument !== 'on' && argument !== 'off') return reply(`verbose is ${this.config.verbose ? 'on' : 'off'}\nusage: /verbose on|off`);
        this.config.verbose = argument === 'on';
        this.config.progress = this.config.verbose;
        saveConfig(this.config, { verbose: this.config.verbose, progress: this.config.progress }, this.paths.home);
        return reply(`verbose ${argument}`);
      }

      case '/watch': {
        if (argument !== 'on' && argument !== 'off') return reply(`watch is ${this.config.watchAll ? 'on' : 'off'}\nusage: /watch on|off`);
        this.config.watchAll = argument === 'on';
        saveConfig(this.config, { watchAll: this.config.watchAll }, this.paths.home);
        return reply(`watch ${argument}`);
      }

      case '/model': {
        const sessionId = ref.get();
        if (!sessionId) return reply('no session');
        const models = await this.opencode.models();
        if (!argument) {
          const scope = models.filter((model) => model.status !== 'deprecated').slice(0, 20);
          this.lastModels.set(String(ctx.chatId), scope.map((model) => `${model.providerID}/${model.id}`));
          return reply(
            ['models:', ...scope.map((model, index) => `${index + 1}. ${model.providerID}/${model.id}${model.name ? ` - ${model.name}` : ''}`), '', '/model <number> or /model <provider/model>'].join('\n'),
          );
        }
        const cached = this.lastModels.get(String(ctx.chatId)) ?? [];
        const numeric = Number.parseInt(argument, 10);
        const target = Number.isFinite(numeric) && numeric > 0 ? cached[numeric - 1] : argument;
        if (!target) return reply('run /model first, then /model <number>');
        const [providerID, ...rest] = target.split('/');
        const id = rest.join('/');
        if (!providerID || !id) return reply('usage: /model <provider/model>');
        await this.opencode.setModel(sessionId, { id, providerID });
        this.audit.write({ actor: ctx.userId, action: 'session.model', detail: target });
        return reply(`model ${target}`);
      }

      case '/agent': {
        const sessionId = ref.get();
        if (!sessionId) return reply('no session');
        const agents = (await this.opencode.agents()).filter((agent) => !agent.hidden && agent.mode !== 'subagent');
        if (!argument) {
          this.lastAgents.set(String(ctx.chatId), agents.map((agent) => agent.id));
          return reply(['agents:', ...agents.map((agent, index) => `${index + 1}. ${agent.id}${agent.description ? ` - ${short(agent.description, 60)}` : ''}`), '', '/agent <number|id>'].join('\n'));
        }
        const cached = this.lastAgents.get(String(ctx.chatId)) ?? [];
        const numeric = Number.parseInt(argument, 10);
        const target = Number.isFinite(numeric) && numeric > 0 ? cached[numeric - 1] : argument;
        if (!target) return reply('run /agent first, then /agent <number>');
        await this.opencode.setAgent(sessionId, target);
        this.audit.write({ actor: ctx.userId, action: 'session.agent', detail: target });
        return reply(`agent ${target}`);
      }

      case '/compact': {
        const sessionId = ref.get();
        if (!sessionId) return reply('no session');
        await this.opencode.compact(sessionId);
        this.audit.write({ actor: ctx.userId, action: 'session.compact', detail: sessionId });
        return reply('compacting');
      }

      case '/cost': {
        const sessionId = ref.get();
        if (!sessionId) return reply('no session');
        const session = await this.opencode.session(sessionId);
        if (!session) return reply('session gone');
        const tokens = session.tokens ?? {};
        return reply(
          [
            `cost $${(session.cost ?? 0).toFixed(4)}`,
            `input ${tokens.input ?? 0} output ${tokens.output ?? 0} reasoning ${tokens.reasoning ?? 0}`,
            `cache read ${tokens.cache?.read ?? 0} write ${tokens.cache?.write ?? 0}`,
          ].join('\n'),
        );
      }

      case '/diff':
        return this.sendDiff(ctx, ref.get(), argument);

      case '/todo': {
        const sessionId = ref.get();
        if (!sessionId) return reply('no session');
        const messages = await this.opencode.messages(sessionId, 200);
        const todos = [...messages].reverse().flatMap((message) => message.content ?? []).filter((part) => part.type === 'tool' && /todo/i.test(part.name ?? ''));
        if (!todos.length) return reply('no todo list in this session');
        const latest = todos[0];
        const output = typeof latest?.state?.output === 'string' ? latest.state.output : JSON.stringify(latest?.state?.output ?? latest?.state?.input ?? {});
        return reply(short(output, 3500));
      }

      case '/undo': {
        const sessionId = ref.get();
        if (!sessionId) return reply('no session');
        const messages = await this.opencode.messages(sessionId, 100);
        const lastUser = [...messages].reverse().find((message) => message.type === 'user');
        if (!lastUser) return reply('nothing to undo');
        await this.opencode.stageRevert(sessionId, lastUser.id, true);
        await this.opencode.commitRevert(sessionId);
        this.audit.write({ actor: ctx.userId, action: 'session.undo', detail: `${sessionId} ${lastUser.id}` });
        return reply('reverted the last turn');
      }

      case '/redo': {
        const sessionId = ref.get();
        if (!sessionId) return reply('no session');
        const messages = await this.opencode.messages(sessionId, 100);
        const lastUser = [...messages].reverse().find((message) => message.type === 'user');
        const previous = chat.lastPrompt ?? this.userText(lastUser);
        if (!previous) return reply('nothing to redo');
        return this.enqueuePrompt({ ctx, text: previous, files: [] });
      }

      case '/btw': {
        if (!argument) return reply('usage: /btw <question>');
        const sessionId = await this.ensureBtwSession(ctx);
        return this.enqueuePrompt({ ctx, text: argument, files: [], sessionId, side: true });
      }

      case '/remember': {
        if (!this.config.rememberScript) return reply('remember is not configured; set rememberScript');
        if (!argument) return reply('usage: /remember <text>');
        const saved = await this.runRemember(argument);
        this.audit.write({ actor: ctx.userId, action: 'remember', detail: short(argument, 120) });
        return reply(`saved - ${short(saved, 200)}`);
      }

      case '/schedule':
      case '/cron':
        return this.handleSchedule(ctx, command, argument, reply);

      case '/jobs': {
        const jobs = this.scheduler.list().filter((job) => job.chatId === ctx.chatId);
        if (!jobs.length) return reply('no jobs');
        return reply(
          jobs
            .map(
              (job) =>
                `${job.id} ${job.kind} ${job.spec} - next ${new Date(job.nextRun).toLocaleString()}${job.sessionId ? ` - ${job.sessionId}` : ''}`,
            )
            .join('\n'),
        );
      }

      case '/cancel': {
        if (!argument) return reply('usage: /cancel <job id>');
        return reply(this.scheduler.remove(argument) ? 'cancelled' : 'job not found');
      }

      case '/lock': {
        if (ctx.role !== 'owner') return reply('owner only');
        chat.locked = true;
        this.state.scheduleSave();
        this.queue.cancelAll();
        await this.permissions.rejectAll('lock');
        this.audit.write({ actor: ctx.userId, action: 'lock.enable' });
        return reply('locked: prompts and approvals are denied');
      }

      case '/unlock': {
        if (ctx.role !== 'owner') return reply('owner only');
        if (this.config.pin) {
          if (!argument) return reply('PIN required: /unlock <pin>');
          const input = Buffer.from(argument);
          const expected = Buffer.from(this.config.pin);
          const same = input.length === expected.length && input.every((byte, index) => byte === expected[index]);
          if (!same) {
            this.audit.write({ actor: ctx.userId, action: 'lock.unlock-failed' });
            return reply('wrong PIN');
          }
        }
        chat.locked = false;
        this.state.scheduleSave();
        this.audit.write({ actor: ctx.userId, action: 'lock.disable' });
        return reply('unlocked');
      }

      case '/role': {
        if (ctx.role !== 'owner') return reply('owner only');
        const [idRaw, roleRaw] = argument.split(/\s+/);
        const id = Number(idRaw);
        if (!id || !roleRaw || !['owner', 'operator', 'viewer'].includes(roleRaw)) return reply('usage: /role <user id> owner|operator|viewer');
        this.config.roles[String(id)] = roleRaw as Role;
        saveConfig(this.config, { roles: this.config.roles }, this.paths.home);
        this.audit.write({ actor: ctx.userId, action: 'role.set', detail: `${id} ${roleRaw}` });
        return reply(`user ${id} is ${roleRaw}`);
      }

      case '/audit': {
        if (ctx.role !== 'owner') return reply('owner only');
        const limit = Math.min(50, Number.parseInt(argument, 10) || 10);
        const rows = this.audit.tail(limit);
        return reply(rows.length ? rows.join('\n') : 'audit log empty');
      }

      case '/sendfile':
        return this.sendFile(ctx, argument, reply);

      default:
        return reply(`unknown command ${command}; /help`);
    }
  }

  // ---------------------------------------------------------------- rendering

  private async resolveSessionId(chatId: number, argument: string): Promise<SessionInfo | null> {
    const chat = this.state.chat(chatId);
    const ids = chat.lastList ?? (await this.opencode.sessions(30)).map((session) => session.id);
    const numeric = Number.parseInt(argument, 10);
    let sessionId: string | undefined;
    if (Number.isFinite(numeric) && numeric > 0) sessionId = ids[numeric - 1];
    else if (argument) sessionId = ids.find((id) => id === argument) ?? ids.find((id) => id.startsWith(argument));
    if (!sessionId) return null;
    return this.opencode.session(sessionId);
  }

  private renderSessionList(sessions: SessionInfo[], current: string | null, heading: string): string {
    const rows = sessions.map((session, index) => {
      const mark = session.id === current ? '>' : ' ';
      return `${mark}${index + 1}. ${short(session.title ?? '(untitled)', 60)}\n   ${short(session.location?.directory ?? '', 70)}`;
    });
    return `${heading} (${sessions.length})\n\n${rows.join('\n')}\n\n/use <number> to switch`;
  }

  private async renderSessions(chatId: number, threadId: number | undefined, page: number): Promise<{ text: string; keyboard: InlineButton[][] }> {
    const all = await this.opencode.sessions(50).catch(() => [] as SessionInfo[]);
    const running = new Set(await this.opencode.activeSessions().catch(() => []));
    const current = this.sessionRef(chatId, threadId).get();
    const pageSize = 6;
    const pages = Math.max(1, Math.ceil(all.length / pageSize));
    const safePage = Math.min(Math.max(0, page), pages - 1);
    const slice = all.slice(safePage * pageSize, safePage * pageSize + pageSize);
    const chat = this.state.chat(chatId);
    chat.lastList = all.map((session) => session.id);
    this.state.scheduleSave();

    const lines = slice.map((session, index) => {
      const number = safePage * pageSize + index + 1;
      const mark = session.id === current ? '>' : ' ';
      const dot = running.has(session.id) ? '+' : '-';
      return `${mark}${dot} ${number}. ${short(session.title ?? '(untitled)', 46)}\n    ${short(session.location?.directory ?? '', 60)}`;
    });
    const buttons: InlineButton[] = slice.map((session, index) => ({
      text: `${safePage * pageSize + index + 1}${running.has(session.id) ? '*' : ''}`,
      callback_data: `u:${session.id}`,
    }));
    const keyboard: InlineButton[][] = [];
    for (let index = 0; index < buttons.length; index += 3) keyboard.push(buttons.slice(index, index + 3));
    if (pages > 1) {
      const nav: InlineButton[] = [];
      if (safePage > 0) nav.push({ text: 'prev', callback_data: `s:${safePage - 1}` });
      nav.push({ text: `${safePage + 1}/${pages}`, callback_data: `s:${safePage}` });
      if (safePage < pages - 1) nav.push({ text: 'next', callback_data: `s:${safePage + 1}` });
      keyboard.push(nav);
    }
    return {
      text: `Sessions (${all.length}, ${running.size} running)\n\n${lines.join('\n')}\n\n/use <number> to switch`,
      keyboard,
    };
  }

  private async healthText(): Promise<string> {
    let opencode = 'unreachable';
    try {
      const info = await this.opencode.info();
      opencode = `${info.version}${this.opencode.baseUrl ? ` at ${this.opencode.baseUrl}` : ''}`;
    } catch (error) {
      opencode = `unreachable (${short(errorMessage(error), 100)})`;
    }
    const depth = Object.values(this.queue.snapshot()).reduce((sum, value) => sum + value, 0);
    return [
      `uptime ${duration(Date.now() - this.startedAt)}`,
      `opencode ${opencode}`,
      `queue ${depth}`,
      `jobs ${this.scheduler.list().length}`,
      `pending permissions ${this.permissions.list().length}`,
      `last error ${this.lastError ? short(this.lastError, 160) : 'none'}`,
      `bot @${this.telegram.botUsername ?? '?'}`,
    ].join('\n');
  }

  private userText(message: MessageInfo | undefined): string | null {
    if (!message) return null;
    const parts = (message.content ?? []).filter((part) => part.type === 'text').map((part) => part.text ?? '');
    const text = parts.join('\n').trim();
    return text || null;
  }

  // ---------------------------------------------------------------- prompts

  private async ensureSession(ctx: UpdateContext, seed: string): Promise<string> {
    const ref = this.sessionRef(ctx.chatId, ctx.threadId);
    const existing = ref.get();
    if (existing) {
      const session = await this.opencode.session(existing).catch(() => null);
      if (session) return session.id;
      ref.set(null);
    }
    const created = await this.opencode.createSession({ title: short(seed || 'telegram session', 60) });
    ref.set(created.id);
    this.audit.write({ actor: ctx.userId, action: 'session.create', detail: created.id });
    return created.id;
  }

  /**
   * A side session for /btw. It is created once per chat and reused, so side
   * questions keep their own context without touching the work session.
   */
  private async ensureBtwSession(ctx: UpdateContext): Promise<string> {
    const chat = this.state.chat(ctx.chatId);
    if (chat.btwSessionId) {
      const existing = await this.opencode.session(chat.btwSessionId).catch(() => null);
      if (existing) return existing.id;
      chat.btwSessionId = undefined;
    }
    const created = await this.opencode.createSession({ title: 'btw: side questions' });
    chat.btwSessionId = created.id;
    this.state.scheduleSave();
    this.audit.write({ actor: ctx.userId, action: 'session.create', detail: created.id, meta: { btw: true } });
    return created.id;
  }

  private async enqueuePrompt(request: PromptRequest): Promise<void> {
    const { ctx } = request;
    if (this.state.chat(ctx.chatId).locked) {
      await this.telegram.sendFormatted(ctx.chatId, 'locked; /unlock first', { messageThreadId: ctx.threadId }).catch(() => undefined);
      return;
    }
    if (ctx.role === 'viewer') {
      await this.telegram.sendFormatted(ctx.chatId, 'viewer role: prompts are disabled', { messageThreadId: ctx.threadId }).catch(() => undefined);
      return;
    }

    let text = request.text.trim();
    if (!text) return;
    const sessionId = request.sessionId ?? (await this.ensureSession(ctx, text));
    text = await applyPromptHook(this.hooks, { text, sessionId, userId: ctx.userId, chatId: ctx.chatId }, this.logger);
    if (!request.side) {
      this.state.chat(ctx.chatId).lastPrompt = text;
      this.state.scheduleSave();
    }

    const result = this.queue.enqueue(
      sessionId,
      { chatId: ctx.chatId, userId: ctx.userId, sessionId, text, files: request.files.map((file) => file.uri) },
      async (job) => this.runPrompt(job.chatId, job.userId, job.sessionId, job.text, request.files, ctx),
    );

    this.audit.write({ actor: ctx.userId, action: 'prompt.enqueue', detail: short(text, 160), meta: { sessionId, position: result.position } });
    if (result.queued) {
      await this.telegram
        .sendFormatted(ctx.chatId, `queued, position ${result.position} (${result.ahead} ahead)`, { messageThreadId: ctx.threadId })
        .catch(() => undefined);
    }
  }

  private async runPrompt(
    chatId: number,
    userId: number,
    sessionId: string,
    text: string,
    files: Array<{ uri: string; name?: string }>,
    ctx: UpdateContext,
  ): Promise<void> {
    const started = Date.now();
    const stopTyping = this.telegram.startTyping(chatId, ctx.threadId);
    let progressMessageId: number | null = null;
    let lastProgressAt = 0;
    let lastProgressText = '';
    const showProgress = this.config.progress || this.config.verbose;
    const seenTools = new Set<string>();
    const inFlightKey = `${sessionId}:${randomId('')}`;
    this.inFlight.add(inFlightKey);

    try {
      await this.waitForSessionIdle(sessionId);
      const before = await this.opencode.messages(sessionId, 100).catch(() => [] as MessageInfo[]);
      const baseline = idleBaselineOf(before);
      for (const message of before) {
        for (const part of message.content ?? []) if (part.type === 'tool' && part.id) seenTools.add(part.id);
      }

      try {
        const surfaced = this.surface(text);
        await this.opencode.prompt(sessionId, surfaced, files);
      } catch (error) {
        if (files.length) {
          this.logger.warn('prompt with attachments failed; retrying text only', { error: errorMessage(error) });
          await this.opencode.prompt(sessionId, `${this.surface(text)}\n\n(attachments were not accepted by the service)`, []);
        } else throw error;
      }

      const timeoutMs = this.config.promptTimeoutMinutes * 60_000;
      const result = await this.opencode.waitForIdle(sessionId, baseline, {
        timeoutMs,
        onTick: async (messages) => {
          await this.surfacePermissions(sessionId, chatId, ctx.threadId);
          if (!showProgress) return;
          const now = Date.now();
          if (now - started < 4000) return;
          if (now - lastProgressAt < 2000) return;
          const state = describeProgress(messages);
          if (!this.config.verbose && state === lastProgressText) return;
          lastProgressAt = now;
          lastProgressText = state;
          const body = `${state}\n${duration(now - started)}`;
          if (!progressMessageId) {
            const sent = await this.telegram
              .sendMessage(chatId, body, { messageThreadId: ctx.threadId, disablePreview: true })
              .catch(() => null);
            progressMessageId = sent?.message_id ?? null;
          } else {
            await this.telegram.editMessageText(chatId, progressMessageId, body).catch(() => undefined);
          }
          if (this.config.verbose) await this.feedTools(chatId, ctx.threadId, messages, seenTools);
        },
      });

      if (result.timedOut) {
        await this.replyLong(chatId, ctx.threadId, `still running after ${this.config.promptTimeoutMinutes}m; left running locally. /status for details.`);
        return;
      }

      const lastAssistant = [...result.messages].reverse().find((message) => message.type === 'assistant');
      const output = this.assistantText(lastAssistant);
      if (output) {
        const hooked = await applyReplyHook(this.hooks, { text: output, sessionId, chatId }, this.logger);
        await this.replyLong(chatId, ctx.threadId, hooked);
      } else if (result.outcome && result.outcome !== 'succeeded') await this.replyLong(chatId, ctx.threadId, `(${result.outcome})`);

      this.audit.write({
        actor: userId,
        action: 'prompt.finish',
        detail: short(text, 100),
        meta: { sessionId, ms: Date.now() - started, outcome: result.outcome },
      });
    } catch (error) {
      this.lastError = errorMessage(error);
      this.logger.error('prompt failed', { sessionId, error: this.lastError });
      await this.replyLong(chatId, ctx.threadId, `error: ${short(errorMessage(error), 400)}`);
    } finally {
      stopTyping();
      this.inFlight.delete(inFlightKey);
      if (progressMessageId) await this.telegram.deleteMessage(chatId, progressMessageId).catch(() => undefined);
    }
  }

  /**
   * Another client (TUI, desktop app) may be running this session. Posting into a
   * busy session steers that turn and breaks completion tracking, so wait first.
   */
  private async waitForSessionIdle(sessionId: string, maxMs = 120_000): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < maxMs) {
      const active = await this.opencode.activeSessions().catch(() => [] as string[]);
      if (!active.includes(sessionId)) return;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    this.logger.warn('session is still active in another client; posting anyway', { sessionId });
  }

  private assistantText(message: MessageInfo | undefined): string | null {
    if (!message) return null;
    const text = (message.content ?? [])
      .filter((part) => part.type === 'text')
      .map((part) => part.text ?? '')
      .join('\n')
      .trim();
    return text || null;
  }

  private async feedTools(chatId: number, threadId: number | undefined, messages: MessageInfo[], seen: Set<string>): Promise<void> {
    for (const message of messages) {
      for (const part of message.content ?? []) {
        if (part.type !== 'tool' || !part.id || seen.has(part.id)) continue;
        const status = part.state?.status;
        if (status !== 'completed' && status !== 'error') continue;
        seen.add(part.id);
        const detail =
          status === 'error'
            ? short(part.state?.error?.message ?? 'failed', 160)
            : short(
                (part.state?.input?.command as string) ??
                  (part.state?.input?.filePath as string) ??
                  (part.state?.input?.description as string) ??
                  '',
                140,
              );
        await this.telegram
          .sendFormatted(chatId, `[tool] ${short(part.name ?? '', 40)}${detail ? `: ${detail}` : ''}`, { messageThreadId: threadId })
          .catch(() => undefined);
      }
    }
  }

  private async replyLong(chatId: number, threadId: number | undefined, raw: string): Promise<void> {
    const formatted = formatForTelegram(raw);
    const { text, hits } = redactSecrets(formatted, this.config.redact);
    if (hits.length) this.audit.write({ action: 'redact.outbound', detail: hits.join(',') });
    const limit = Math.min(4000, this.config.maxMessageChars);
    if (text.length > 12_000) {
      const name = `reply-${new Date().toISOString().replace(/[:.]/g, '-')}.md`;
      await this.telegram
        .sendDocument(chatId, name, text, `long reply, ${text.length} chars - first lines below`)
        .catch(async () => {
          await this.telegram.sendLong(chatId, text.slice(0, 4000), { messageThreadId: threadId }, limit);
        });
      await this.telegram.sendLong(chatId, short(text, 1200), { messageThreadId: threadId }, limit).catch(() => undefined);
      return;
    }
    await this.telegram.sendLong(chatId, text, { messageThreadId: threadId }, limit);
  }

  // ---------------------------------------------------------------- permissions

  private async surfacePermissions(sessionId: string, chatId: number, threadId: number | undefined): Promise<void> {
    let requests;
    try {
      requests = await this.opencode.pendingPermissions(sessionId);
    } catch {
      return;
    }
    for (const request of requests) {
      if (this.permissions.isTracked(request.id)) continue;
      const session = await this.opencode.session(sessionId).catch(() => null);
      const cwd = session?.location?.directory;
      const pending = this.permissions.register(request, chatId);
      const body = summarisePermission(request, cwd);
      const keyboard = [
        [
          { text: 'Once', callback_data: encodeCallback(pending.key, 'once') },
          { text: 'Always', callback_data: encodeCallback(pending.key, 'always') },
          { text: 'Deny', callback_data: encodeCallback(pending.key, 'reject') },
        ],
      ];
      const sent = await this.telegram
        .sendMessage(chatId, `${body}\n\nauto-denies in ${this.config.permissionTimeoutSeconds}s`, {
          messageThreadId: threadId,
          replyMarkup: { inline_keyboard: keyboard },
        })
        .catch(() => null);
      if (sent) this.permissions.attachMessage(pending.key, sent.message_id);
      this.audit.write({
        actor: 'system',
        action: 'permission.request',
        detail: `${request.action} ${short(request.resources.join(' '), 160)}`,
        meta: { sessionId, requestId: request.id, risk: pending.risk },
      });
    }
  }

  private async applyPermissionDecision(context: DecideContext): Promise<void> {
    const { permission, decision, userId, reason } = context;
    try {
      await this.opencode.replyPermission(permission.sessionId, permission.requestId, decision);
    } catch (error) {
      this.logger.warn('permission reply failed', { error: errorMessage(error) });
    }
    const label = decision === 'reject' ? 'Denied' : decision === 'always' ? 'Approved (always)' : 'Approved (once)';
    const who = reason === 'timeout' ? 'timeout' : reason === 'lock' ? 'lock' : reason === 'shutdown' ? 'shutdown' : `user ${userId ?? '?'}`;
    if (permission.messageId) {
      await this.telegram
        .editMessageText(permission.chatId, permission.messageId, `${summarisePermission({ action: permission.action, resources: permission.resources })} - ${label} (${who})`)
        .catch(() => undefined);
      await this.telegram.editMessageReplyMarkup(permission.chatId, permission.messageId, { inline_keyboard: [] }).catch(() => undefined);
    }
    this.audit.write({
      actor: userId ?? 'system',
      action: 'permission.decide',
      detail: `${decision} by ${who}`,
      meta: { sessionId: permission.sessionId, requestId: permission.requestId, action: permission.action, risk: permission.risk },
    });
    if (this.hooks.onPermission) {
      try {
        await this.hooks.onPermission({
          sessionId: permission.sessionId,
          action: permission.action,
          resources: permission.resources,
          decision,
          userId,
        });
      } catch (error) {
        this.logger.warn('onPermission hook failed', { error: errorMessage(error) });
      }
    }
  }

  // ---------------------------------------------------------------- schedule

  private async handleSchedule(
    ctx: UpdateContext,
    command: string,
    argument: string,
    reply: (text: string) => Promise<void>,
  ): Promise<void> {
    if (!argument) return reply('usage: /schedule in 10m <prompt> | /schedule at 09:30 <prompt> | /cron "*/30 * * * *" <prompt>');
    const sessionId = this.sessionRef(ctx.chatId, ctx.threadId).get() ?? (await this.ensureSession(ctx, argument));
    if (command === '/cron') {
      const match = /^"([^"]+)"\s+([\s\S]+)$/.exec(argument) ?? /^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+([\s\S]+)$/.exec(argument);
      if (!match) return reply('usage: /cron "*/30 * * * *" <prompt>');
      const expression = match[1] as string;
      const next = nextCronRun(expression);
      if (next === null) return reply('invalid cron expression');
      const job = this.scheduler.add({ kind: 'cron', spec: expression, chatId: ctx.chatId, userId: ctx.userId, sessionId, text: match[2] as string, nextRun: next });
      this.audit.write({ actor: ctx.userId, action: 'job.create', detail: `${job.id} cron ${expression}` });
      return reply(`job ${job.id} every ${expression}, next ${new Date(next).toLocaleString()}`);
    }
    const when = /^(in\s+\S+|at\s+\S+)\s+([\s\S]+)$/.exec(argument);
    if (!when) return reply('usage: /schedule in 10m <prompt>');
    const parsed = parseWhen(when[1] as string);
    if ('error' in parsed) return reply(parsed.error);
    const job = this.scheduler.add({ kind: 'at', spec: when[1] as string, chatId: ctx.chatId, userId: ctx.userId, sessionId, text: when[2] as string, nextRun: parsed.at });
    this.audit.write({ actor: ctx.userId, action: 'job.create', detail: `${job.id} at ${new Date(parsed.at).toISOString()}` });
    return reply(`job ${job.id} at ${new Date(parsed.at).toLocaleString()}`);
  }

  private async runScheduledJob(job: import('./types.js').ScheduledJob): Promise<void> {
    const ctx: UpdateContext = { chatId: job.chatId, userId: job.userId, role: this.roleFor(job.userId) };
    if (this.state.chat(job.chatId).locked) {
      this.logger.warn('job skipped: chat locked', { job: job.id });
      return;
    }
    const started = Date.now();
    try {
      const sessionId = job.sessionId || (await this.ensureSession(ctx, job.text));
      await this.waitForSessionIdle(sessionId);
      const before = await this.opencode.messages(sessionId, 100).catch(() => [] as MessageInfo[]);
      const baseline = idleBaselineOf(before);
      await this.opencode.prompt(sessionId, this.surface(job.text), []);
      const result = await this.opencode.waitForIdle(sessionId, baseline, { timeoutMs: this.config.promptTimeoutMinutes * 60_000 });
      const output = this.assistantText([...result.messages].reverse().find((message) => message.type === 'assistant'));
      const head = `[scheduled ${job.id}] ${duration(Date.now() - started)}`;
      await this.replyLong(job.chatId, undefined, output ? `${head}\n\n${output}` : head);
    } catch (error) {
      await this.replyLong(job.chatId, undefined, `[scheduled ${job.id}] failed: ${short(errorMessage(error), 300)}`);
    }
  }

  // ---------------------------------------------------------------- media

  private inboxDir(chatId: number): string {
    const dir = path.join(this.paths.inboxRoot, String(chatId));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private async downloadTelegramFile(fileId: string, suggestedName: string, chatId: number): Promise<{ filePath: string; size: number }> {
    const file = await this.telegram.getFile(fileId);
    const size = file.file_size ?? 0;
    if (size > this.config.inbound.maxBytes) throw new Error(`file is ${size} bytes, limit is ${this.config.inbound.maxBytes}`);
    if (!file.file_path) throw new Error('Telegram did not return a file path');
    const safeName = suggestedName.replace(/[^\w.-]+/g, '_').slice(-80) || `file-${Date.now()}`;
    const target = path.join(this.inboxDir(chatId), `${Date.now()}-${safeName}`);
    const buffer = await this.telegram.downloadFile(file.file_path);
    fs.writeFileSync(target, buffer);
    return { filePath: target, size: buffer.length };
  }

  private async handleAttachment(ctx: UpdateContext, message: TelegramMessage, caption: string): Promise<void> {
    if (ctx.role === 'viewer') {
      await this.telegram.sendFormatted(ctx.chatId, 'viewer role: uploads are disabled', { messageThreadId: ctx.threadId });
      return;
    }
    if (!this.config.inbound.enabled) {
      await this.telegram.sendFormatted(ctx.chatId, 'inbound files are disabled in config', { messageThreadId: ctx.threadId });
      return;
    }
    try {
      const document = message.document;
      const photo = message.photo?.[message.photo.length - 1];
      const fileId = document?.file_id ?? photo?.file_id;
      const name = document?.file_name ?? (photo ? `photo-${message.message_id}.jpg` : 'file');
      if (!fileId) return;
      const { filePath, size } = await this.downloadTelegramFile(fileId, name, ctx.chatId);
      const text = caption ? `${caption}\n\nAttached file: ${filePath}` : `Attached file: ${filePath}`;
      this.audit.write({ actor: ctx.userId, action: 'media.inbound', detail: `${short(name, 60)} ${size}b` });
      await this.enqueuePrompt({ ctx, text, files: [{ uri: `file://${filePath}`, name: path.basename(filePath) }] });
    } catch (error) {
      await this.telegram.sendFormatted(ctx.chatId, `upload failed: ${short(errorMessage(error), 300)}`, { messageThreadId: ctx.threadId });
    }
  }

  private async handleVoice(ctx: UpdateContext, message: TelegramMessage, caption: string): Promise<void> {
    if (ctx.role === 'viewer') return;
    const voice = message.voice ?? message.audio;
    if (!voice) return;
    if (!this.config.stt?.command) {
      await this.telegram.sendFormatted(ctx.chatId, 'voice notes need stt.command in config.json', { messageThreadId: ctx.threadId });
      return;
    }
    try {
      const { filePath } = await this.downloadTelegramFile(voice.file_id, 'voice.ogg', ctx.chatId);
      const transcript = await this.transcribe(filePath);
      if (!transcript) {
        await this.telegram.sendFormatted(ctx.chatId, 'transcript was empty', { messageThreadId: ctx.threadId });
        return;
      }
      await this.telegram.sendFormatted(ctx.chatId, `transcript: ${transcript}`, { messageThreadId: ctx.threadId });
      await this.enqueuePrompt({ ctx, text: caption ? `${caption}\n${transcript}` : transcript, files: [] });
    } catch (error) {
      await this.telegram.sendFormatted(ctx.chatId, `transcription failed: ${short(errorMessage(error), 300)}`, { messageThreadId: ctx.threadId });
    }
  }

  private transcribe(filePath: string): Promise<string> {
    const stt = this.config.stt;
    if (!stt?.command) return Promise.resolve('');
    return new Promise((resolve, reject) => {
      const child = spawn(stt.command as string, [...(stt.args ?? []), filePath], { windowsHide: true });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => child.kill(), stt.timeoutMs ?? 120_000);
      child.stdout.on('data', (chunk) => (stdout += String(chunk)));
      child.stderr.on('data', (chunk) => (stderr += String(chunk)));
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error(stderr.trim() || `stt exited ${code}`));
        else resolve(stdout.trim());
      });
    });
  }

  private async sendFile(ctx: UpdateContext, argument: string, reply: (text: string) => Promise<void>): Promise<void> {
    if (!argument) return reply('usage: /sendfile <absolute path>');
    const target = path.resolve(argument);
    const roots = this.config.outbound.allowedRoots.map((root) => path.resolve(root));
    if (roots.length && !roots.some((root) => target === root || target.startsWith(`${root}${path.sep}`))) {
      return reply('path is outside outbound.allowedRoots');
    }
    try {
      const stat = fs.statSync(target);
      if (!stat.isFile()) return reply('not a file');
      if (stat.size > this.config.outbound.maxBytes) return reply(`file is ${stat.size} bytes, limit is ${this.config.outbound.maxBytes}`);
      const content = fs.readFileSync(target);
      await this.telegram.sendDocument(ctx.chatId, path.basename(target), content);
      this.audit.write({ actor: ctx.userId, action: 'file.outbound', detail: target, meta: { bytes: stat.size } });
    } catch (error) {
      return reply(`send failed: ${short(errorMessage(error), 200)}`);
    }
  }

  private async sendDiff(ctx: UpdateContext, sessionId: string | null, argument: string): Promise<void> {
    if (!sessionId) {
      await this.telegram.sendFormatted(ctx.chatId, 'no session', { messageThreadId: ctx.threadId });
      return;
    }
    const diff = await this.opencode.diff(sessionId);
    if (!diff.length) {
      await this.telegram.sendFormatted(ctx.chatId, 'no changes', { messageThreadId: ctx.threadId });
      return;
    }
    if (argument === 'file' || argument === 'patch') {
      const patch = diff.map((file) => `--- ${file.file}\n${file.patch}`).join('\n\n');
      await this.telegram.sendDocument(ctx.chatId, `diff-${sessionId}.patch`, patch, `${diff.length} file(s)`);
      return;
    }
    const lines = diff.map((file) => `${file.status} ${file.file} +${file.additions} -${file.deletions}`);
    await this.telegram.sendFormatted(ctx.chatId, `changes (${diff.length})\n\n${lines.join('\n')}\n\n/diff file for the patch`, {
      messageThreadId: ctx.threadId,
    });
  }

  private runRemember(text: string): Promise<string> {
    const script = this.config.rememberScript as string;
    const extension = path.extname(script).toLowerCase();
    let command: string;
    let args: string[];
    if (extension === '.ps1') {
      command = 'powershell.exe';
      args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Text', text, '-Tag', 'telegram'];
    } else if (extension === '.js' || extension === '.mjs') {
      command = process.execPath;
      args = [script, '--text', text, '--tag', 'telegram'];
    } else {
      command = script;
      args = ['--text', text, '--tag', 'telegram'];
    }
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { windowsHide: true, timeout: 30_000 });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => (stdout += String(chunk)));
      child.stderr.on('data', (chunk) => (stderr += String(chunk)));
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `exit ${code}`))));
    });
  }

  // ---------------------------------------------------------------- surfaces

  /** Tag Telegram-originated prompts so a brain's channel rules can apply. */
  private surface(text: string): string {
    return this.config.surfaceHint ? `[surface: telegram]\n\n${text}` : text;
  }

  // ---------------------------------------------------------------- webhook + heartbeat

  private async startWebhook(): Promise<void> {
    if (!this.config.webhook.enabled) return;
    const secret = process.env[this.config.webhook.secretEnv] ?? '';
    const http = await import('node:http');
    const server = http.createServer((request, response) => {
      const respond = (status: number, body: unknown): void => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(body));
      };
      if (request.headers['x-gateway-secret'] !== secret) return respond(401, { error: 'unauthorized' });
      if (request.method !== 'POST') return respond(405, { error: 'method not allowed' });
      let body = '';
      request.on('data', (chunk) => {
        body += String(chunk);
        if (body.length > 1_000_000) request.destroy();
      });
      request.on('end', () => {
        void (async () => {
          try {
            const payload = JSON.parse(body || '{}') as { text?: string; sessionId?: string; title?: string };
            const chatId = this.config.ownerChatId ?? this.config.ownerUserIds[0];
            if (!chatId) return respond(400, { error: 'no owner chat configured' });
            if (payload.sessionId && payload.text) {
              const ctx: UpdateContext = { chatId, userId: this.config.ownerUserIds[0] ?? 0, role: 'owner' };
              await this.enqueuePrompt({ ctx, text: payload.text, files: [] });
              return respond(202, { queued: true });
            }
            await this.telegram.sendFormatted(chatId, payload.text ? `[webhook] ${payload.text}` : '[webhook] ping');
            this.audit.write({ action: 'webhook.received', detail: short(payload.text ?? 'ping', 120) });
            return respond(200, { sent: true });
          } catch (error) {
            return respond(400, { error: errorMessage(error) });
          }
        })();
      });
    });
    await new Promise<void>((resolve) => server.listen(this.config.webhook.port, this.config.webhook.host, () => resolve()));
    this.webhookServer = server;
    this.logger.info('webhook listening', { host: this.config.webhook.host, port: this.config.webhook.port });
  }

  /** Completion pings for every running session, not just this chat's. Off unless watchAll. */
  private startWatch(): void {
    if (!this.config.watchAll) return;
    this.watchTimer = setInterval(() => {
      void (async () => {
        const chatId = this.config.ownerChatId ?? this.config.allowedUserIds[0];
        if (!chatId) return;
        try {
          const running = new Set(await this.opencode.activeSessions());
          for (const [sessionId, record] of [...this.watchTrack]) {
            if (!running.has(sessionId) && !this.queue.isBusy(sessionId)) {
              record.gone += 1;
              if (record.gone < 2) continue;
              this.watchTrack.delete(sessionId);
              await this.telegram
                .sendFormatted(chatId, `done: ${short(record.title, 60)} (${duration(Date.now() - record.since)})`)
                .catch(() => undefined);
            } else record.gone = 0;
          }
          for (const sessionId of running) {
            if (this.watchTrack.has(sessionId)) continue;
            const session = await this.opencode.session(sessionId).catch(() => null);
            this.watchTrack.set(sessionId, { title: session?.title ?? sessionId, since: Date.now(), gone: 0 });
          }
        } catch (error) {
          this.logger.debug('watch tick failed', { error: errorMessage(error) });
        }
      })();
    }, 15_000);
    this.watchTimer.unref?.();
  }

  private startHeartbeat(): void {    this.writeHeartbeat('running');
    this.heartbeat = setInterval(() => this.writeHeartbeat('running'), 30_000);
    this.heartbeat.unref?.();
  }

  private writeHeartbeat(status: string, reason?: string): void {
    try {
      atomicWriteFile(
        path.join(this.paths.home, 'gateway.state.json'),
        JSON.stringify(
          {
            status,
            reason,
            pid: process.pid,
            startedAt: this.startedAt,
            updatedAt: Date.now(),
            bot: this.telegram.botUsername,
            queue: this.queue.snapshot(),
            pendingPermissions: this.permissions.list().length,
            lastError: this.lastError,
          },
          null,
          2,
        ),
      );
    } catch {
      /* heartbeat is advisory */
    }
  }
}

function describeProgress(messages: MessageInfo[]): string {
  const last = messages[messages.length - 1];
  if (!last) return 'thinking';
  if (last.type === 'idle') return 'finishing';
  const tools = (last.content ?? []).filter((part) => part.type === 'tool');
  const running = tools.find((part) => part.state?.status === 'running');
  if (running) {
    const name = running.name ?? 'tool';
    const input = running.state?.input ?? {};
    const detail = (input.command as string) ?? (input.filePath as string) ?? (input.path as string) ?? '';
    return detail ? `${name}: ${short(detail, 90)}` : `running ${name}`;
  }
  const text = (last.content ?? []).find((part) => part.type === 'text' && part.text);
  if (text?.text) return `writing: ${short(text.text, 90)}`;
  return 'thinking';
}





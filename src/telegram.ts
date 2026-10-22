import type { Logger } from './logger.js';
import { splitMessage } from './split.js';
import { retry, sleep, errorMessage, short } from './util.js';

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
  is_forum?: boolean;
  title?: string;
}

export interface TelegramDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_size?: number;
  width?: number;
  height?: number;
}

export interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  date: number;
  text?: string;
  caption?: string;
  message_thread_id?: number;
  is_topic_message?: boolean;
  reply_to_message?: TelegramMessage;
  document?: TelegramDocument;
  photo?: TelegramPhotoSize[];
  voice?: { file_id: string; mime_type?: string; file_size?: number; duration?: number };
  audio?: { file_id: string; mime_type?: string; file_size?: number };
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  data?: string;
  message?: TelegramMessage;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface InlineButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface SendOptions {
  parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML';
  replyMarkup?: object;
  messageThreadId?: number;
  replyToMessageId?: number;
  disablePreview?: boolean;
}

export class TelegramError extends Error {
  readonly status: number;
  readonly description: string;
  retryAfterMs?: number;
  constructor(status: number, description: string, retryAfterMs?: number) {
    super(`Telegram ${status}: ${description}`);
    this.name = 'TelegramError';
    this.status = status;
    this.description = description;
    this.retryAfterMs = retryAfterMs;
  }
}

function isRetryable(error: unknown): boolean {
  if (error instanceof TelegramError) {
    if (error.status === 429 || error.status >= 500 || error.status === 409) return true;
    if (/ECONN|ETIMEDOUT|EAI_AGAIN|fetch failed/i.test(error.description)) return true;
    return false;
  }
  return true;
}

export class TelegramClient {
  private readonly token: string;
  private readonly logger: Logger;
  private readonly apiBase: string;
  private username: string | null = null;

  constructor(token: string, logger: Logger, apiBase = 'https://api.telegram.org') {
    this.token = token;
    this.logger = logger;
    this.apiBase = apiBase.replace(/\/$/, '');
  }

  get botUsername(): string | null {
    return this.username;
  }

  private url(method: string): string {
    return `${this.apiBase}/bot${this.token}/${method}`;
  }

  async call<T = Record<string, unknown>>(
    method: string,
    payload: Record<string, unknown> = {},
    options: { attempts?: number; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    return retry(
      async () => {
        const signals = [AbortSignal.timeout(options.timeoutMs ?? 60_000)];
        if (options.signal) signals.push(options.signal);
        const combined = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
        let response: Response;
        try {
          response = await fetch(this.url(method), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: combined,
          });
        } catch (error) {
          throw new TelegramError(0, errorMessage(error));
        }
        const text = await response.text();
        let parsed: { ok?: boolean; result?: unknown; description?: string; parameters?: { retry_after?: number } } = {};
        try {
          parsed = JSON.parse(text) as typeof parsed;
        } catch {
          throw new TelegramError(response.status, `invalid JSON: ${text.slice(0, 120)}`);
        }
        if (parsed.ok) return parsed.result as T;
        const retryAfter = parsed.parameters?.retry_after ? parsed.parameters.retry_after * 1000 : undefined;
        throw new TelegramError(response.status, parsed.description ?? short(text, 200), retryAfter);
      },
      {
        attempts: options.attempts ?? 5,
        baseMs: 600,
        maxMs: 30_000,
        signal: options.signal,
        retryable: isRetryable,
        onRetry: (error, attempt, delay) => {
          if (method === 'getUpdates' && error instanceof TelegramError && error.status === 409) {
            this.logger.error('another process is polling this bot token (409); stop it', { attempt });
          } else {
            this.logger.warn('telegram retry', { method, attempt, delay, error: errorMessage(error) });
          }
        },
      },
    );
  }

  async getMe(): Promise<{ id: number; username?: string; is_bot: boolean }> {
    const me = await this.call<{ id: number; username?: string }>('getMe', {}, { attempts: 2 });
    this.username = me.username ?? null;
    return { ...me, is_bot: true };
  }

  async deleteWebhook(): Promise<void> {
    await this.call('deleteWebhook', { drop_pending_updates: false });
  }

  async setMyCommands(commands: Array<{ command: string; description: string }>): Promise<void> {
    await this.call('setMyCommands', { commands: commands.slice(0, 60) });
  }

  async getUpdates(offset: number, timeoutSeconds: number, signal?: AbortSignal): Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>(
      'getUpdates',
      { offset, timeout: timeoutSeconds, allowed_updates: ['message', 'callback_query'] },
      { timeoutMs: (timeoutSeconds + 15) * 1000, signal, attempts: 3 },
    );
  }

  async sendMessage(chatId: number, text: string, options: SendOptions = {}): Promise<TelegramMessage> {
    return this.call<TelegramMessage>('sendMessage', this.messagePayload(chatId, text, options));
  }

  private messagePayload(chatId: number, text: string, options: SendOptions): Record<string, unknown> {
    return {
      chat_id: chatId,
      text,
      ...(options.parseMode ? { parse_mode: options.parseMode } : {}),
      ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
      ...(options.messageThreadId ? { message_thread_id: options.messageThreadId } : {}),
      ...(options.replyToMessageId ? { reply_parameters: { message_id: options.replyToMessageId, allow_sending_without_reply: true } } : {}),
      ...(options.disablePreview ? { link_preview_options: { is_disabled: true } } : {}),
    };
  }

  /** Send with Markdown, fall back to plain text when Telegram rejects the entities. */
  async sendFormatted(chatId: number, text: string, options: SendOptions = {}): Promise<TelegramMessage> {
    if (!options.parseMode) return this.sendMessage(chatId, text, options);
    try {
      return await this.sendMessage(chatId, text, options);
    } catch (error) {
      if (error instanceof TelegramError && error.status === 400 && /entit|parse|markdown|unsupported start tag/i.test(error.description)) {
        this.logger.warn('markdown rejected; sending plain text', { description: error.description });
        return this.sendMessage(chatId, text, { ...options, parseMode: undefined });
      }
      throw error;
    }
  }

  /** Split at safe boundaries and send every part, numbering them. */
  async sendLong(chatId: number, text: string, options: SendOptions = {}, limit = 4000): Promise<void> {
    const reserve = text.length > limit ? 16 : 0;
    const parts = splitMessage(text, Math.max(200, limit - reserve));
    if (parts.length === 1 && parts[0] === text && text.length <= limit) {
      await this.sendFormatted(chatId, parts[0] as string, options);
      return;
    }
    const total = parts.length;
    for (let index = 0; index < total; index++) {
      const suffix = total > 1 ? `\n\n(${index + 1}/${total})` : '';
      await this.sendFormatted(chatId, `${parts[index]}${suffix}`, options);
    }
  }

  async deleteMessage(chatId: number, messageId: number): Promise<void> {
    try {
      await this.call('deleteMessage', { chat_id: chatId, message_id: messageId }, { attempts: 2 });
    } catch {
      /* the message may already be gone */
    }
  }
  async editMessageText(chatId: number, messageId: number, text: string, options: SendOptions = {}): Promise<void> {
    try {
      await this.call('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text,
        ...(options.parseMode ? { parse_mode: options.parseMode } : {}),
        ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
        ...(options.disablePreview ? { link_preview_options: { is_disabled: true } } : {}),
      });
    } catch (error) {
      if (error instanceof TelegramError && error.status === 400 && /not modified/i.test(error.description)) return;
      throw error;
    }
  }

  async editMessageReplyMarkup(chatId: number, messageId: number, replyMarkup: Record<string, unknown>): Promise<void> {
    try {
      await this.call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: replyMarkup });
    } catch (error) {
      this.logger.debug('edit markup failed', { error: errorMessage(error) });
    }
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string, showAlert = false): Promise<void> {
    await this.call('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
      ...(showAlert ? { show_alert: true } : {}),
    });
  }

  sendChatAction(chatId: number, action = 'typing', messageThreadId?: number): Promise<unknown> {
    return this.call('sendChatAction', {
      chat_id: chatId,
      action,
      ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
    });
  }

  async sendDocument(chatId: number, filename: string, content: Buffer | string, caption?: string): Promise<TelegramMessage> {
    const form = new FormData();
    form.set('chat_id', String(chatId));
    if (caption) form.set('caption', caption.slice(0, 1000));
    form.set('document', new Blob([content]), filename);
    let response: Response;
    try {
      response = await fetch(this.url('sendDocument'), { method: 'POST', body: form, signal: AbortSignal.timeout(120_000) });
    } catch (error) {
      throw new TelegramError(0, errorMessage(error));
    }
    const parsed = (await response.json()) as { ok?: boolean; result?: TelegramMessage; description?: string };
    if (!parsed.ok) throw new TelegramError(response.status, parsed.description ?? 'sendDocument failed');
    return parsed.result as TelegramMessage;
  }

  async getFile(fileId: string): Promise<{ file_id: string; file_size?: number; file_path?: string }> {
    return this.call('getFile', { file_id: fileId });
  }

  async downloadFile(filePath: string): Promise<Buffer> {
    const response = await fetch(`${this.apiBase}/file/bot${this.token}/${filePath}`, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new TelegramError(response.status, `download failed: ${response.statusText}`);
    return Buffer.from(await response.arrayBuffer());
  }

  /** Keep a typing indicator alive until the returned function is called. */
  startTyping(chatId: number, messageThreadId?: number): () => void {
    let stopped = false;
    const tick = (): void => {
      if (stopped) return;
      void this.sendChatAction(chatId, 'typing', messageThreadId).catch(() => undefined);
    };
    tick();
    const timer = setInterval(tick, 4500);
    timer.unref?.();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }
}

export async function waitForTelegram(chatId: number): Promise<void> {
  // Reserved for future flapping protection; kept separate from the client on purpose.
  await sleep(0);
  void chatId;
}


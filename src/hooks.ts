import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Logger } from './logger.js';
import { errorMessage } from './util.js';

export interface PromptHookContext {
  text: string;
  sessionId: string;
  userId: number;
  chatId: number;
}

export interface ReplyHookContext {
  text: string;
  sessionId: string;
  chatId: number;
}

export interface PermissionHookContext {
  sessionId: string;
  action: string;
  resources: string[];
  decision: string;
  userId?: number;
}

export interface GatewayHooks {
  onPrompt?: (context: PromptHookContext) => Promise<string | void> | string | void;
  onReply?: (context: ReplyHookContext) => Promise<string | void> | string | void;
  onPermission?: (context: PermissionHookContext) => Promise<void> | void;
}

/** Load an optional user plugin. A broken plugin must never take the gateway down. */
export async function loadHooks(modulePath: string | undefined, logger: Logger): Promise<GatewayHooks> {
  if (!modulePath) return {};
  try {
    const resolved = path.isAbsolute(modulePath) ? modulePath : path.resolve(process.cwd(), modulePath);
    const loaded = (await import(pathToFileURL(resolved).href)) as GatewayHooks & { default?: GatewayHooks };
    const hooks = (loaded.default ?? loaded) as GatewayHooks;
    logger.info('plugin loaded', { path: resolved, hooks: Object.keys(hooks).filter((key) => typeof (hooks as Record<string, unknown>)[key] === 'function') });
    return hooks;
  } catch (error) {
    logger.error('plugin failed to load', { path: modulePath, error: errorMessage(error) });
    return {};
  }
}

export async function applyPromptHook(hooks: GatewayHooks, context: PromptHookContext, logger: Logger): Promise<string> {
  if (!hooks.onPrompt) return context.text;
  try {
    const result = await hooks.onPrompt(context);
    return typeof result === 'string' && result.trim() ? result : context.text;
  } catch (error) {
    logger.warn('onPrompt hook failed', { error: errorMessage(error) });
    return context.text;
  }
}

export async function applyReplyHook(hooks: GatewayHooks, context: ReplyHookContext, logger: Logger): Promise<string> {
  if (!hooks.onReply) return context.text;
  try {
    const result = await hooks.onReply(context);
    return typeof result === 'string' && result.trim() ? result : context.text;
  } catch (error) {
    logger.warn('onReply hook failed', { error: errorMessage(error) });
    return context.text;
  }
}

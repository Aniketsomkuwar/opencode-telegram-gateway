export type Role = 'owner' | 'operator' | 'viewer';

export interface ChatState {
  /** Currently selected OpenCode session for this chat. */
  sessionId: string | null;
  /** Last rendered session list, used by /use <n>. */
  lastList?: string[];
  /** /lock state: when true every prompt and mutating command is denied. */
  locked?: boolean;
  /** Forum topic id -> OpenCode session id. */
  topics?: Record<string, string>;
  /** Last prompt, used by /redo. */
  lastPrompt?: string;
  /** Side session used by /btw, kept separate from the work session. */
  btwSessionId?: string;
}

export interface QueueJob {
  id: string;
  chatId: number;
  userId: number;
  sessionId: string;
  text: string;
  files: string[];
  enqueuedAt: number;
}

export interface ScheduledJob {
  id: string;
  kind: 'at' | 'every' | 'cron';
  spec: string;
  chatId: number;
  userId: number;
  sessionId: string;
  text: string;
  nextRun: number;
  createdAt: number;
  lastRun?: number;
}

export interface ModelRef {
  id: string;
  providerID: string;
  variant?: string;
}

export interface ModelInfo {
  id: string;
  modelID?: string;
  providerID: string;
  name?: string;
  canonical?: string;
  status?: string;
  variants?: Array<{ id?: string; name?: string }>;
  cost?: Array<{ input?: number; output?: number }>;
}

export interface AgentInfo {
  id: string;
  name?: string;
  mode?: 'primary' | 'subagent' | 'all';
  hidden?: boolean;
  description?: string;
}

export interface SessionInfo {
  id: string;
  title?: string;
  parentID?: string;
  agent?: string;
  model?: ModelRef;
  cost?: number;
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
  outcome?: 'succeeded' | 'failed' | 'interrupted';
  time?: { created?: number; updated?: number; idle?: number };
  location?: { directory?: string };
  revert?: { messageID?: string; files?: unknown[] };
}

export interface MessagePart {
  type: string;
  id?: string;
  text?: string;
  name?: string;
  state?: { status?: string; input?: Record<string, unknown>; error?: { message?: string }; output?: unknown };
}

export interface MessageInfo {
  id: string;
  type: string;
  time?: { created?: number };
  content?: MessagePart[];
  outcome?: 'succeeded' | 'failed' | 'interrupted';
  error?: { message?: string };
}

export interface PermissionRequest {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
  save?: string[];
  metadata?: Record<string, unknown>;
  message?: string;
}

export interface FileDiffInfo {
  file: string;
  patch: string;
  additions: number;
  deletions: number;
  status: 'added' | 'deleted' | 'modified';
}

export interface ApiEnvelope<T> {
  data: T;
}

export type PermissionDecision = 'once' | 'always' | 'reject';

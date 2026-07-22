import { Hono } from 'hono';
import type { Context } from 'hono';
import { extractFlexAltText } from '../utils/flex-alt-text.js';
import {
  getOperators,
  getOperatorById,
  createOperator,
  updateOperator,
  deleteOperator,
  getChats,
  getChatById,
  createChat,
  getFriendById,
  getLineAccountById,
  updateChat,
  jstNow,
} from '@line-crm/db';
import type { Env } from '../index.js';
import {
  isSecondaryOnlySupportStaff,
  supportCaseVisibilitySql,
  type SupportAccessStaff,
} from '../services/support-access.js';
import { requireRole } from '../middleware/role-guard.js';
import {
  canUseManualLineSend,
  isLineCaptureOnly,
  isLineManualSendEnabled,
} from '../services/line-capture-only.js';
import { getLineSendSafetyBlock, type LineSendSafetyBlock } from '../services/line-safety.js';
import {
  normalizeInternalReactionEmoji,
  summarizeInternalReactions,
  toggleInternalReaction,
} from '../services/internal-message-reactions.js';
import {
  mentionTargetsMatchBody,
  mentionStaffIdsForMessages,
  parseMentionStaffIds,
  recordInternalMessageMentions,
  resolveMentionStaffTargets,
} from '../services/internal-message-mentions.js';
import {
  appendInternalMessageEvent,
  latestInternalMessageEvents,
  projectInternalMessage,
  type InternalMessageEventRow,
} from '../services/internal-message-events.js';
import { kickWebPushNotifications } from './app-notifications.js';
import {
  getActiveScheduledChatMessages,
  serializeScheduledChatMessage,
  type ScheduledChatMessagePart,
  type ScheduledChatMessageRow,
} from '../services/scheduled-chat-messages.js';
import { syncFollowerPage } from '../services/follower-sync.js';

const chats = new Hono<Env>();

const OPERATOR_ID_MAX_LENGTH = 128;
const OPERATOR_NAME_MAX_LENGTH = 120;
const OPERATOR_EMAIL_MAX_LENGTH = 254;
const OPERATOR_ROLE_MAX_LENGTH = 64;
const CHAT_ID_MAX_LENGTH = 128;
const CHAT_CURSOR_MAX_LENGTH = 64;
const CHAT_FOLLOWER_CURSOR_MAX_LENGTH = 1024;
const CHAT_SEARCH_MAX_LENGTH = 120;
const CHAT_NOTES_MAX_LENGTH = 4096;
const CHAT_INTERNAL_MESSAGE_MAX_LENGTH = 5000;
const CHAT_INTERNAL_MENTION_MAX = 20;
const CHAT_INTERNAL_MENTION_MAX_LENGTH = 80;
const CHAT_SCHEDULE_MAX_DAYS = 90;
const CHAT_SCHEDULE_MIN_LEAD_MS = 60 * 1000;
const VISIBLE_ASCII_PATTERN = /^[!-~]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CHAT_STATUSES = new Set(['unread', 'in_progress', 'resolved', 'long_term']);
const LINE_CONTENT_API_BASE = 'https://api-data.line.me/v2/bot/message';
const CHAT_MEDIA_MESSAGE_TYPES = new Set(['image', 'file', 'video', 'audio']);

function currentStaff(c: { get: (key: 'staff') => SupportAccessStaff | undefined }): SupportAccessStaff {
  return c.get('staff') ?? { id: 'system', name: 'system', role: 'staff' };
}

function parseChatIdempotencyKey(raw: string | undefined): ValueResult<string | null> {
  if (raw === undefined) return { ok: true, value: null };
  const value = raw.trim();
  if (!UUID_PATTERN.test(value)) return { ok: false, error: 'Invalid Idempotency-Key' };
  return { ok: true, value: value.toLowerCase() };
}

async function ensureChatFriendAccess(c: Context<Env>, friendId: string): Promise<Response | null> {
  if (isSecondaryOnlySupportStaff(currentStaff(c))) {
    return c.json({ success: false, error: 'Chat not found' }, 404);
  }
  if (await getFriendById(c.env.DB, friendId)) return null;
  return c.json({ success: false, error: 'Chat not found' }, 404);
}

function clampLoadingSeconds(value: number | undefined): number {
  const n = Number.isFinite(value) ? Math.floor(value as number) : 5;
  return Math.min(60, Math.max(5, n));
}

function clampMessageLimit(raw: string | undefined): number {
  const n = Number(raw ?? 1000);
  if (!Number.isFinite(n)) return 1000;
  return Math.max(1, Math.min(1000, Math.floor(n)));
}

async function startLoadingAnimation(
  accessToken: string,
  chatId: string,
  loadingSeconds: number,
): Promise<void> {
  const response = await fetch('https://api.line.me/v2/bot/chat/loading/start', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ chatId, loadingSeconds }),
  });

  if (!response.ok) {
    throw lineHttpError(response.status);
  }
}

type ChatLike = {
  id: string;
  friend_id: string;
  operator_id: string | null;
  status: string;
  is_long_term?: number;
  notes: string | null;
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
};

type ChatInternalMessageRow = {
  id: string;
  friend_id: string;
  line_account_id: string | null;
  parent_id: string | null;
  body: string;
  mentions: string;
  reactions?: string | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
};

type SupportCaseForChat = {
  id: string;
  title: string;
  status: string;
};

type ActiveSupportCaseForChat = {
  id: string;
  title: string;
  status: string;
  priority: string;
  escalation_assignee: string | null;
  latest_escalation_status: string | null;
  updated_at: string;
};

type ChatSendBody = {
  messageType?: string;
  content: string;
  supportCaseId?: string;
  lineAccountId?: string | null;
  markAsRead?: boolean;
  quoteMessageId?: string;
};
type ChatScheduleBody = {
  scheduledAt: string;
  messages: ScheduledChatMessagePart[];
  supportCaseId?: string;
  lineAccountId?: string | null;
};
type ExternalOutgoingBody = {
  content: string;
};
type ChatInternalMessageBody = {
  body: string;
  parentId?: string;
  mentions: string[];
  mentionStaffIds: string[];
};
type ChatTypingStatusBody = { active: boolean };
type ChatDeletedMessageResponse = { messageId: string; deletedAt: string };

type OperatorCreateBody = { name: string; email: string; role?: string };
type OperatorUpdateBody = Partial<{ name: string; email: string; role: string; isActive: boolean }>;
type ChatStatus = 'unread' | 'in_progress' | 'resolved' | 'long_term';
type ChatListQuery = {
  status?: ChatStatus;
  operatorId?: string;
  lineAccountId?: string;
  unansweredOnly: boolean;
  search?: string;
};
type ChatCreateInput = { friendId: string; operatorId?: string; lineAccountId?: string };
type ChatUpdateInput = Partial<{ operatorId: string | null; status: ChatStatus; notes: string | null }>;
type ChatDetailQuery = { messageLimit: number; beforeCreatedAt?: string; beforeId?: string };
type ChatFollowerSyncInput = { lineAccountId: string; start?: string };
type ValueResult<T> = { ok: true; value: T } | { ok: false; error: string };
type ChatRouteError = Error & { status?: number };
type LineSentMessageResponse = {
  sentMessages?: Array<{ id?: string | number; quoteToken?: string }>;
};

function chatRouteErrorKind(err: unknown): string {
  if (err instanceof TypeError) return 'network_error';
  if (err instanceof Error && typeof (err as ChatRouteError).status === 'number') {
    return `${err.name || 'error'}_${(err as ChatRouteError).status}`;
  }
  const lineStatus = lineApiErrorStatus(err);
  if (lineStatus != null) return `line_http_status_${lineStatus}`;
  if (err instanceof Error) return err.name || 'error';
  return typeof err;
}

function initialMarkAsReadResult(requested: boolean): MarkAsReadResult {
  return {
    requested,
    marked: false,
    reason: requested ? 'no_token' : 'not_requested',
    messageId: null,
    markedAt: null,
  };
}

function lineHttpError(status: number): ChatRouteError {
  const err = new Error('line_http_error') as ChatRouteError;
  err.name = 'LineHttpError';
  err.status = status;
  return err;
}

function lineApiErrorStatus(err: unknown): number | null {
  if (err instanceof Error && typeof (err as ChatRouteError).status === 'number') {
    return (err as ChatRouteError).status ?? null;
  }
  if (!(err instanceof Error)) return null;
  const match = err.message.match(/^LINE API error:\s+(\d{3})\b/);
  return match ? Number(match[1]) : null;
}

function manualLineSendFailureMessage(err: unknown): string {
  const status = lineApiErrorStatus(err);
  if (err instanceof TypeError) {
    return 'LINEへの接続に失敗しました。少し時間を置いてもう一度送信してください。';
  }
  if (status === 400) {
    return 'LINE送信に失敗しました。送信先ユーザーまたはメッセージ内容をLINE側が受け付けませんでした。';
  }
  if (status === 401 || status === 403) {
    return 'LINE送信に失敗しました。LINEチャネルのアクセストークンまたはMessaging API権限を確認してください。';
  }
  if (status === 429) {
    return 'LINE送信に失敗しました。送信数の上限または一時的な制限に達しています。時間を置いて再送してください。';
  }
  if (status != null) {
    return `LINE送信に失敗しました。LINE APIでエラーが返されました (${status})。`;
  }
  return 'LINE送信に失敗しました。もう一度お試しください。';
}

function extractLineSentMessageId(result: unknown): string | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const sentMessages = (result as LineSentMessageResponse).sentMessages;
  if (!Array.isArray(sentMessages) || sentMessages.length === 0) return null;
  const id = sentMessages[0]?.id;
  if (typeof id === 'string' && id.trim()) return id.trim();
  if (typeof id === 'number' && Number.isFinite(id)) return String(id);
  return null;
}

function extractLineSentQuoteToken(result: unknown): string | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const sentMessages = (result as LineSentMessageResponse).sentMessages;
  if (!Array.isArray(sentMessages) || sentMessages.length === 0) return null;
  const quoteToken = sentMessages[0]?.quoteToken;
  return typeof quoteToken === 'string' && quoteToken.trim() ? quoteToken.trim() : null;
}

function lineSafetyBlockedResponse(c: Context<Env>, block: LineSendSafetyBlock): Response {
  return c.json({ success: false, error: block.message, lineSafety: block }, 423);
}

type ChatMediaMessageRow = {
  id: string;
  friend_id: string;
  message_type: string;
  content: string;
  line_account_id: string | null;
  friend_line_account_id: string | null;
};

type StoredLineMediaPayload = {
  lineMessageId: string;
  fileName: string | null;
  mimeType: string | null;
};

function safeJsonRecord(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function firstStringValue(record: Record<string, unknown> | null, keys: string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function parseStoredLineMediaPayload(row: ChatMediaMessageRow): StoredLineMediaPayload | null {
  if (!CHAT_MEDIA_MESSAGE_TYPES.has(row.message_type)) return null;
  const parsed = safeJsonRecord(row.content);
  const lineMessageId = firstStringValue(parsed, ['lineMessageId', 'line_message_id', 'messageId', 'message_id']);
  if (!lineMessageId) return null;
  return {
    lineMessageId,
    fileName: firstStringValue(parsed, ['fileName', 'filename', 'name']),
    mimeType: firstStringValue(parsed, ['mimeType', 'mime_type', 'contentType', 'content_type']),
  };
}

function fallbackMimeType(messageType: string, fileName: string | null): string {
  if (messageType === 'image') return 'image/jpeg';
  if (messageType === 'video') return 'video/mp4';
  if (messageType === 'audio') return 'audio/mpeg';
  if (fileName && /\.pdf$/i.test(fileName)) return 'application/pdf';
  return 'application/octet-stream';
}

function defaultMediaFileName(row: ChatMediaMessageRow, payload: StoredLineMediaPayload): string {
  if (payload.fileName) return payload.fileName;
  if (row.message_type === 'image') return 'line-image.jpg';
  if (row.message_type === 'video') return 'line-video.mp4';
  if (row.message_type === 'audio') return 'line-audio.m4a';
  return 'line-file';
}

function encodeRfc5987Value(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

async function resolveLineAccessTokenByAccount(
  db: D1Database,
  accountId: string | null,
  defaultAccessToken: string,
): Promise<string> {
  if (!accountId) return defaultAccessToken;
  const account = await getLineAccountById(db, accountId);
  return account?.channel_access_token || defaultAccessToken;
}

type ChatMessageType = 'text' | 'flex' | 'image';

type NormalizedChatSendPayload =
  | { messageType: 'text'; content: string }
  | { messageType: 'flex'; content: string; flexContents: Record<string, unknown> }
  | {
    messageType: 'image';
    content: string;
    image: {
      originalContentUrl: string;
      previewImageUrl: string;
    };
  };

type ChatSendFriend = {
  id: string;
  line_account_id?: string | null;
};

type ChatQuoteTargetRow = {
  id: string;
  direction: string;
  quote_token: string | null;
  deleted_at: string | null;
};

type MarkAsReadResult = {
  requested: boolean;
  marked: boolean;
  reason: 'not_requested' | 'no_token' | 'line_error' | null;
  messageId: string | null;
  markedAt: string | null;
};

type ChatMarkAsReadResponse = {
  markAsRead: MarkAsReadResult;
  status: string | null;
  markedMessageId: string | null;
  markedAt: string | null;
  updatedAt: string;
};

type ChatTypingRow = {
  staff_id: string;
  staff_name: string;
  updated_at: string;
  expires_at: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJsonBody(c: { req: { json(): Promise<unknown> } }): Promise<unknown | null> {
  return c.req.json().catch(() => null);
}

function parseRequiredString(
  raw: unknown,
  label: string,
  maxLength: number,
  pattern?: RegExp,
): ValueResult<string> {
  if (typeof raw !== 'string') return { ok: false, error: `${label} must be a string` };
  const value = raw.trim();
  if (!value) return { ok: false, error: `${label} is required` };
  if (value.length > maxLength) return { ok: false, error: `${label} is too long` };
  if (pattern && !pattern.test(value)) return { ok: false, error: `${label} is invalid` };
  return { ok: true, value };
}

function parseOptionalString(
  raw: unknown,
  label: string,
  maxLength: number,
  pattern?: RegExp,
): ValueResult<string | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  return parseRequiredString(raw, label, maxLength, pattern);
}

function parseOperatorPathId(raw: unknown): ValueResult<string> {
  return parseRequiredString(raw, 'operatorId', OPERATOR_ID_MAX_LENGTH, VISIBLE_ASCII_PATTERN);
}

function parseOptionalVisibleString(raw: unknown, label: string, maxLength: number): ValueResult<string | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== 'string') return { ok: false, error: `${label} must be a string` };
  const value = raw.trim();
  if (!value) return { ok: true, value: undefined };
  if (value.length > maxLength) return { ok: false, error: `${label} is too long` };
  if (!VISIBLE_ASCII_PATTERN.test(value)) return { ok: false, error: `${label} is invalid` };
  return { ok: true, value };
}

function parseOptionalSearchString(raw: unknown, label: string, maxLength: number): ValueResult<string | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== 'string') return { ok: false, error: `${label} must be a string` };
  const value = raw.trim().replace(/\s+/g, ' ');
  if (!value) return { ok: true, value: undefined };
  if (value.length > maxLength) return { ok: false, error: `${label} is too long` };
  if (/[\u0000-\u001F\u007F]/.test(value)) return { ok: false, error: `${label} is invalid` };
  return { ok: true, value };
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function parseOptionalNullableVisibleString(
  raw: unknown,
  label: string,
  maxLength: number,
): ValueResult<string | null | undefined> {
  if (raw === null) return { ok: true, value: null };
  return parseOptionalVisibleString(raw, label, maxLength);
}

function parseOptionalNullableText(
  raw: unknown,
  label: string,
  maxLength: number,
): ValueResult<string | null | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: `${label} must be a string` };
  const value = raw.trim();
  if (value.length > maxLength) return { ok: false, error: `${label} is too long` };
  return { ok: true, value };
}

function parseChatPathId(raw: unknown): ValueResult<string> {
  return parseRequiredString(raw, 'chatId', CHAT_ID_MAX_LENGTH, VISIBLE_ASCII_PATTERN);
}

function parseChatStatus(raw: unknown): ValueResult<ChatStatus | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== 'string') return { ok: false, error: 'status must be a string' };
  const value = raw.trim();
  if (!value) return { ok: true, value: undefined };
  if (!CHAT_STATUSES.has(value)) return { ok: false, error: 'status is invalid' };
  return { ok: true, value: value as ChatStatus };
}

function parseChatTypingStatusBody(raw: unknown): ValueResult<ChatTypingStatusBody> {
  if (!isRecord(raw)) return { ok: false, error: 'payload must be an object' };
  if (typeof raw.active !== 'boolean') return { ok: false, error: 'active must be a boolean' };
  return { ok: true, value: { active: raw.active } };
}

function parseBooleanFlag(raw: unknown, label: string): ValueResult<boolean> {
  if (raw === undefined || raw === null) return { ok: true, value: false };
  if (typeof raw !== 'string') return { ok: false, error: `${label} must be a string` };
  const value = raw.trim();
  if (!value || value === '0' || value === 'false') return { ok: true, value: false };
  if (value === '1' || value === 'true') return { ok: true, value: true };
  return { ok: false, error: `${label} is invalid` };
}

function parseOptionalCursor(raw: unknown): ValueResult<string | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== 'string') return { ok: false, error: 'beforeCreatedAt must be a string' };
  const value = raw.trim();
  if (!value) return { ok: true, value: undefined };
  if (value.length > CHAT_CURSOR_MAX_LENGTH) return { ok: false, error: 'beforeCreatedAt is too long' };
  if (!value.includes('T') || !Number.isFinite(new Date(value).getTime())) {
    return { ok: false, error: 'beforeCreatedAt is invalid' };
  }
  return { ok: true, value };
}

function parseChatListQuery(searchParams: URLSearchParams): ValueResult<ChatListQuery> {
  const status = parseChatStatus(searchParams.get('status'));
  if (!status.ok) return status;
  const operatorId = parseOptionalVisibleString(searchParams.get('operatorId'), 'operatorId', OPERATOR_ID_MAX_LENGTH);
  if (!operatorId.ok) return operatorId;
  const lineAccountId = parseOptionalVisibleString(searchParams.get('lineAccountId'), 'lineAccountId', CHAT_ID_MAX_LENGTH);
  if (!lineAccountId.ok) return lineAccountId;
  const unansweredOnly = parseBooleanFlag(searchParams.get('unansweredOnly'), 'unansweredOnly');
  if (!unansweredOnly.ok) return unansweredOnly;
  const search = parseOptionalSearchString(searchParams.get('q') ?? searchParams.get('search'), 'q', CHAT_SEARCH_MAX_LENGTH);
  if (!search.ok) return search;
  return {
    ok: true,
    value: {
      status: status.value,
      operatorId: operatorId.value,
      lineAccountId: lineAccountId.value,
      unansweredOnly: unansweredOnly.value,
      search: search.value,
    },
  };
}

function parseChatFollowerSyncBody(raw: unknown): ValueResult<ChatFollowerSyncInput> {
  if (!isRecord(raw)) return { ok: false, error: 'Invalid payload' };
  const lineAccountId = parseRequiredString(
    raw.lineAccountId,
    'lineAccountId',
    CHAT_ID_MAX_LENGTH,
    VISIBLE_ASCII_PATTERN,
  );
  if (!lineAccountId.ok) return lineAccountId;
  const start = parseOptionalVisibleString(
    raw.start,
    'start',
    CHAT_FOLLOWER_CURSOR_MAX_LENGTH,
  );
  if (!start.ok) return start;
  return { ok: true, value: { lineAccountId: lineAccountId.value, start: start.value } };
}

function parseChatDetailQuery(searchParams: URLSearchParams): ValueResult<ChatDetailQuery> {
  const beforeCreatedAt = parseOptionalCursor(searchParams.get('beforeCreatedAt') ?? searchParams.get('before'));
  if (!beforeCreatedAt.ok) return beforeCreatedAt;
  const beforeId = parseOptionalVisibleString(searchParams.get('beforeId'), 'beforeId', CHAT_ID_MAX_LENGTH);
  if (!beforeId.ok) return beforeId;
  if (beforeId.value && !beforeCreatedAt.value) {
    return { ok: false, error: 'beforeCreatedAt is required when beforeId is provided' };
  }
  return {
    ok: true,
    value: {
      messageLimit: clampMessageLimit(searchParams.get('messageLimit') ?? undefined),
      beforeCreatedAt: beforeCreatedAt.value,
      beforeId: beforeId.value,
    },
  };
}

function parseOperatorCreateBody(raw: unknown): ValueResult<OperatorCreateBody> {
  if (!isRecord(raw)) return { ok: false, error: 'Invalid payload' };
  const name = parseRequiredString(raw.name, 'name', OPERATOR_NAME_MAX_LENGTH);
  if (!name.ok) return name;
  const email = parseRequiredString(raw.email, 'email', OPERATOR_EMAIL_MAX_LENGTH, EMAIL_PATTERN);
  if (!email.ok) return email;
  const role = parseOptionalString(raw.role, 'role', OPERATOR_ROLE_MAX_LENGTH, VISIBLE_ASCII_PATTERN);
  if (!role.ok) return role;
  return { ok: true, value: { name: name.value, email: email.value, role: role.value } };
}

function parseOperatorUpdateBody(raw: unknown): ValueResult<OperatorUpdateBody> {
  if (!isRecord(raw)) return { ok: false, error: 'Invalid payload' };
  const name = parseOptionalString(raw.name, 'name', OPERATOR_NAME_MAX_LENGTH);
  if (!name.ok) return name;
  const email = parseOptionalString(raw.email, 'email', OPERATOR_EMAIL_MAX_LENGTH, EMAIL_PATTERN);
  if (!email.ok) return email;
  const role = parseOptionalString(raw.role, 'role', OPERATOR_ROLE_MAX_LENGTH, VISIBLE_ASCII_PATTERN);
  if (!role.ok) return role;
  if (raw.isActive !== undefined && typeof raw.isActive !== 'boolean') {
    return { ok: false, error: 'isActive must be a boolean' };
  }
  const value = {
    name: name.value,
    email: email.value,
    role: role.value,
    isActive: raw.isActive as boolean | undefined,
  };
  if (Object.values(value).every((entry) => entry === undefined)) {
    return { ok: false, error: 'At least one field is required' };
  }
  return { ok: true, value };
}

function parseChatCreateBody(raw: unknown): ValueResult<ChatCreateInput> {
  if (!isRecord(raw)) return { ok: false, error: 'Invalid payload' };
  const friendId = parseRequiredString(raw.friendId, 'friendId', CHAT_ID_MAX_LENGTH, VISIBLE_ASCII_PATTERN);
  if (!friendId.ok) return friendId;
  const operatorId = parseOptionalNullableVisibleString(raw.operatorId, 'operatorId', OPERATOR_ID_MAX_LENGTH);
  if (!operatorId.ok) return operatorId;
  const lineAccountId = parseOptionalNullableVisibleString(raw.lineAccountId, 'lineAccountId', CHAT_ID_MAX_LENGTH);
  if (!lineAccountId.ok) return lineAccountId;
  return {
    ok: true,
    value: {
      friendId: friendId.value,
      operatorId: operatorId.value ?? undefined,
      lineAccountId: lineAccountId.value ?? undefined,
    },
  };
}

function parseChatUpdateBody(raw: unknown): ValueResult<ChatUpdateInput> {
  if (!isRecord(raw)) return { ok: false, error: 'Invalid payload' };
  const operatorId = parseOptionalNullableVisibleString(raw.operatorId, 'operatorId', OPERATOR_ID_MAX_LENGTH);
  if (!operatorId.ok) return operatorId;
  const status = parseChatStatus(raw.status);
  if (!status.ok) return status;
  const notes = parseOptionalNullableText(raw.notes, 'notes', CHAT_NOTES_MAX_LENGTH);
  if (!notes.ok) return notes;
  const value = {
    operatorId: operatorId.value,
    status: status.value,
    notes: notes.value,
  };
  if (Object.values(value).every((entry) => entry === undefined)) {
    return { ok: false, error: 'At least one field is required' };
  }
  return { ok: true, value };
}

function parseChatSendBody(raw: unknown): ValueResult<ChatSendBody> {
  if (!isRecord(raw)) return { ok: false, error: 'Invalid payload' };
  if (raw.messageType !== undefined && typeof raw.messageType !== 'string') {
    return { ok: false, error: 'messageType must be a string' };
  }
  if (typeof raw.content !== 'string') return { ok: false, error: 'content must be a string' };
  if (raw.markAsRead !== undefined && typeof raw.markAsRead !== 'boolean') {
    return { ok: false, error: 'markAsRead must be a boolean' };
  }
  const supportCaseId = parseOptionalVisibleString(raw.supportCaseId, 'supportCaseId', CHAT_ID_MAX_LENGTH);
  if (!supportCaseId.ok) return supportCaseId;
  const lineAccountId = parseOptionalNullableVisibleString(raw.lineAccountId, 'lineAccountId', CHAT_ID_MAX_LENGTH);
  if (!lineAccountId.ok) return lineAccountId;
  const quoteMessageId = parseOptionalVisibleString(raw.quoteMessageId, 'quoteMessageId', CHAT_ID_MAX_LENGTH);
  if (!quoteMessageId.ok) return quoteMessageId;
  return {
    ok: true,
    value: {
      messageType: raw.messageType,
      content: raw.content,
      supportCaseId: supportCaseId.value,
      lineAccountId: lineAccountId.value ?? undefined,
      markAsRead: raw.markAsRead === true,
      quoteMessageId: quoteMessageId.value,
    },
  };
}

function parseChatScheduleBody(raw: unknown, now = new Date()): ValueResult<ChatScheduleBody> {
  if (!isRecord(raw)) return { ok: false, error: 'Invalid payload' };
  if (typeof raw.scheduledAt !== 'string') return { ok: false, error: 'scheduledAt must be a string' };
  const scheduledTime = new Date(raw.scheduledAt.trim()).getTime();
  if (!Number.isFinite(scheduledTime)) return { ok: false, error: 'scheduledAt is invalid' };
  if (scheduledTime < now.getTime() + CHAT_SCHEDULE_MIN_LEAD_MS) {
    return { ok: false, error: '予約日時は1分以上先を指定してください' };
  }
  if (scheduledTime > now.getTime() + CHAT_SCHEDULE_MAX_DAYS * 24 * 60 * 60 * 1000) {
    return { ok: false, error: `予約日時は${CHAT_SCHEDULE_MAX_DAYS}日以内で指定してください` };
  }
  if (!Array.isArray(raw.messages) || raw.messages.length === 0 || raw.messages.length > 5) {
    return { ok: false, error: 'messages must contain between 1 and 5 items' };
  }

  const messages: ScheduledChatMessagePart[] = [];
  for (const item of raw.messages) {
    const parsed = parseChatSendBody(item);
    if (!parsed.ok) return parsed;
    if (parsed.value.quoteMessageId) {
      return { ok: false, error: '返信指定中のメッセージは予約送信できません' };
    }
    const normalized = normalizeChatSendPayload(parsed.value);
    if (!normalized.ok) return normalized;
    if (normalized.payload.messageType !== 'text' && normalized.payload.messageType !== 'image') {
      return { ok: false, error: '予約送信はテキストと画像に対応しています' };
    }
    messages.push({
      messageType: normalized.payload.messageType,
      content: normalized.payload.content,
    });
  }

  const supportCaseId = parseOptionalVisibleString(raw.supportCaseId, 'supportCaseId', CHAT_ID_MAX_LENGTH);
  if (!supportCaseId.ok) return supportCaseId;
  const lineAccountId = parseOptionalNullableVisibleString(raw.lineAccountId, 'lineAccountId', CHAT_ID_MAX_LENGTH);
  if (!lineAccountId.ok) return lineAccountId;
  return {
    ok: true,
    value: {
      scheduledAt: new Date(scheduledTime).toISOString(),
      messages,
      supportCaseId: supportCaseId.value,
      lineAccountId: lineAccountId.value,
    },
  };
}

function parseExternalOutgoingBody(raw: unknown): ValueResult<ExternalOutgoingBody> {
  if (!isRecord(raw)) return { ok: false, error: 'body must be an object' };
  if (typeof raw.content !== 'string') return { ok: false, error: 'content must be a string' };
  const content = raw.content.trim();
  if (!content) return { ok: false, error: 'content is required' };
  if (content.length > 5000) return { ok: false, error: 'content is too long' };
  return { ok: true, value: { content } };
}

function parseMentionNames(raw: unknown, body: string): ValueResult<string[]> {
  const extractFromBody = () => {
    const names = new Set<string>();
    for (const match of body.matchAll(/@([^@\s　,、]+)/g)) {
      const name = match[1]?.trim();
      if (name) names.add(name.slice(0, CHAT_INTERNAL_MENTION_MAX_LENGTH));
      if (names.size >= CHAT_INTERNAL_MENTION_MAX) break;
    }
    return Array.from(names);
  };

  if (raw === undefined || raw === null) return { ok: true, value: extractFromBody() };
  if (!Array.isArray(raw)) return { ok: false, error: 'mentions must be an array' };
  if (raw.length > CHAT_INTERNAL_MENTION_MAX) return { ok: false, error: 'mentions is too long' };
  const names = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') return { ok: false, error: 'mentions must contain strings' };
    const value = item.trim();
    if (!value) continue;
    if (value.length > CHAT_INTERNAL_MENTION_MAX_LENGTH) return { ok: false, error: 'mention is too long' };
    names.add(value);
  }
  return { ok: true, value: Array.from(names) };
}

function parseChatInternalMessageBody(raw: unknown): ValueResult<ChatInternalMessageBody> {
  if (!isRecord(raw)) return { ok: false, error: 'Invalid payload' };
  const body = parseRequiredString(raw.body, 'body', CHAT_INTERNAL_MESSAGE_MAX_LENGTH);
  if (!body.ok) return body;
  const parentId = parseOptionalVisibleString(raw.parentId, 'parentId', CHAT_ID_MAX_LENGTH);
  if (!parentId.ok) return parentId;
  const mentions = parseMentionNames(raw.mentions, body.value);
  if (!mentions.ok) return mentions;
  const mentionStaffIds = parseMentionStaffIds(raw.mentionStaffIds, CHAT_INTERNAL_MENTION_MAX);
  if (!mentionStaffIds.ok) return mentionStaffIds;
  return {
    ok: true,
    value: {
      body: body.value,
      parentId: parentId.value,
      mentions: mentions.value,
      mentionStaffIds: mentionStaffIds.value,
    },
  };
}

function parseInternalMessageBaseVersion(raw: unknown): ValueResult<number> {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    return { ok: false, error: 'baseVersion must be a non-negative integer' };
  }
  return { ok: true, value };
}

function parseStoredMentions(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function serializeChatInternalMessage(
  row: ChatInternalMessageRow,
  staff: SupportAccessStaff = { id: 'system', name: 'system', role: 'staff' },
  mentionStaffIds: string[] = [],
  event?: InternalMessageEventRow,
) {
  const projected = projectInternalMessage(row, event, staff);
  return {
    id: row.id,
    friendId: row.friend_id,
    lineAccountId: row.line_account_id,
    parentId: row.parent_id,
    body: projected.body,
    mentions: projected.mentions,
    mentionStaffIds: event?.action === 'edit' ? projected.mentionStaffIds : projected.isDeleted ? [] : mentionStaffIds,
    reactions: summarizeInternalReactions(row.reactions, staff),
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    createdAt: row.created_at,
    version: projected.version,
    editedAt: projected.editedAt,
    deletedAt: projected.deletedAt,
    deletedByName: projected.deletedByName,
    isDeleted: projected.isDeleted,
    canEdit: projected.canEdit,
    canDelete: projected.canDelete,
  };
}

function serializeActiveSupportCaseForChat(row: ActiveSupportCaseForChat | null) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    priority: row.priority,
    escalationAssignee: row.escalation_assignee,
    latestEscalationStatus: row.latest_escalation_status,
    updatedAt: row.updated_at,
  };
}

function publicChatStatus(status: string | null | undefined, isLongTerm: number | null | undefined): ChatStatus {
  if (isLongTerm === 1) return 'long_term';
  if (status === 'unread' || status === 'in_progress' || status === 'resolved') return status;
  return 'resolved';
}

function activeSupportCaseConditions(staff: SupportAccessStaff, caseAlias = 'sc'): { sql: string; binds: unknown[] } {
  const conditions = [
    `${caseAlias}.friend_id IS NOT NULL`,
    `${caseAlias}.status != 'resolved'`,
  ];
  const binds: unknown[] = [];
  const visibility = supportCaseVisibilitySql(staff, caseAlias, 'se_active_scope');
  if (visibility.sql) {
    conditions.push(visibility.sql);
    binds.push(...visibility.binds);
  }
  return {
    sql: conditions.join(' AND '),
    binds,
  };
}

async function getActiveSupportCaseForFriend(
  db: D1Database,
  friendId: string,
  staff: SupportAccessStaff,
): Promise<ActiveSupportCaseForChat | null> {
  const activeConditions = activeSupportCaseConditions(staff, 'sc');
  return db
    .prepare(
      `SELECT
         sc.id,
         sc.title,
         sc.status,
         sc.priority,
         sc.escalation_assignee,
         (
           SELECT se.status
           FROM support_escalations se
           WHERE se.case_id = sc.id
             AND se.status != 'closed'
           ORDER BY se.updated_at DESC, se.created_at DESC
           LIMIT 1
         ) AS latest_escalation_status,
         sc.updated_at
       FROM support_cases sc
       WHERE sc.friend_id = ?
         AND ${activeConditions.sql}
       ORDER BY
         CASE
           WHEN sc.status IN ('waiting_secondary', 'escalated') THEN 0
           WHEN sc.status IN ('secondary_answered', 'customer_reply', 'waiting_primary') THEN 1
           ELSE 2
         END,
         sc.updated_at DESC
       LIMIT 1`,
    )
    .bind(friendId, ...activeConditions.binds)
    .first<ActiveSupportCaseForChat>();
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeChatSendPayload(
  body: ChatSendBody,
): { ok: true; payload: NormalizedChatSendPayload } | { ok: false; error: string } {
  const messageType = body.messageType?.trim() || 'text';
  if (messageType !== 'text' && messageType !== 'flex' && messageType !== 'image') {
    return { ok: false, error: 'messageType must be text, flex, or image' };
  }

  if (typeof body.content !== 'string' || !body.content.trim()) {
    return { ok: false, error: 'content is required' };
  }

  const content = body.content.trim();
  if (messageType === 'text') {
    return { ok: true, payload: { messageType, content } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { ok: false, error: `${messageType} content must be valid JSON` };
  }

  if (messageType === 'flex') {
    if (!isRecord(parsed) || (parsed.type !== 'bubble' && parsed.type !== 'carousel')) {
      return { ok: false, error: 'flex content must be a bubble or carousel JSON object' };
    }
    return { ok: true, payload: { messageType, content, flexContents: parsed } };
  }

  if (!isRecord(parsed)) {
    return { ok: false, error: 'image content must be a JSON object' };
  }
  const originalContentUrl = parsed.originalContentUrl;
  const previewImageUrl = parsed.previewImageUrl;
  if (
    typeof originalContentUrl !== 'string' ||
    typeof previewImageUrl !== 'string' ||
    !isHttpsUrl(originalContentUrl) ||
    !isHttpsUrl(previewImageUrl)
  ) {
    return { ok: false, error: 'image content must include HTTPS originalContentUrl and previewImageUrl' };
  }

  return {
    ok: true,
    payload: {
      messageType,
      content,
      image: { originalContentUrl, previewImageUrl },
    },
  };
}

async function getSupportCaseForChat(
  db: D1Database,
  staff: SupportAccessStaff,
  caseId: string,
  lineAccountId: string,
  friendId: string,
): Promise<SupportCaseForChat | null> {
  const conditions = ['sc.id = ?', 'sc.line_account_id = ?', 'sc.friend_id = ?'];
  const binds: unknown[] = [caseId, lineAccountId, friendId];
  const visibility = supportCaseVisibilitySql(staff, 'sc', 'se_chat_send_scope');
  if (visibility.sql) {
    conditions.push(visibility.sql);
    binds.push(...visibility.binds);
  }

  return db
    .prepare(`SELECT sc.id, sc.title, sc.status FROM support_cases sc WHERE ${conditions.join(' AND ')}`)
    .bind(...binds)
    .first<SupportCaseForChat>();
}

async function validateSupportCaseForSend(
  c: Context<Env>,
  staff: SupportAccessStaff,
  friend: ChatSendFriend,
  body: Pick<ChatSendBody, 'supportCaseId' | 'lineAccountId'>,
): Promise<
  | { ok: true; supportCase: SupportCaseForChat | null; supportLineAccountId: string }
  | { ok: false; response: Response }
> {
  const supportCaseId = body.supportCaseId?.trim();
  const supportLineAccountId = body.lineAccountId?.trim() || friend.line_account_id || '';
  let supportCase: SupportCaseForChat | null = null;

  if (supportCaseId) {
    if (!supportLineAccountId) {
      return {
        ok: false,
        response: c.json({ success: false, error: 'lineAccountId is required for support case event' }, 400),
      };
    }
    supportCase = await getSupportCaseForChat(
      c.env.DB,
      staff,
      supportCaseId,
      supportLineAccountId,
      friend.id,
    );
    if (!supportCase) {
      return { ok: false, response: c.json({ success: false, error: 'support case not found' }, 404) };
    }
    if (supportCase.status === 'resolved') {
      return {
        ok: false,
        response: c.json({ success: false, error: '完了済み案件は再オープンしてから顧客返信を送信してください' }, 400),
      };
    }
  }

  return { ok: true, supportCase, supportLineAccountId };
}

async function resolveQuoteTargetForSend(
  db: D1Database,
  friendId: string,
  quoteMessageId: string | undefined,
  messageType: ChatMessageType,
): Promise<ValueResult<{ id: string; quoteToken: string } | null>> {
  const targetId = quoteMessageId?.trim();
  if (!targetId) return { ok: true, value: null };
  if (messageType !== 'text') {
    return { ok: false, error: '返信機能はテキスト送信時だけ使えます' };
  }

  const row = await db
    .prepare(
      `SELECT id, direction, quote_token, deleted_at
       FROM messages_log
       WHERE id = ?
         AND friend_id = ?
         AND (delivery_type IS NULL OR delivery_type != 'test')
       LIMIT 1`,
    )
    .bind(targetId, friendId)
    .first<ChatQuoteTargetRow>();
  if (!row) return { ok: false, error: '返信元メッセージが見つかりません' };
  if (row.deleted_at) return { ok: false, error: '取り消し済みメッセージには返信できません' };
  if (row.direction !== 'incoming') {
    return { ok: false, error: '顧客から届いたメッセージだけ返信元にできます' };
  }
  if (!row.quote_token) {
    return { ok: false, error: 'このメッセージはLINEの返信対象にできません。新しく届いたメッセージでお試しください' };
  }
  return { ok: true, value: { id: row.id, quoteToken: row.quote_token } };
}

async function addSupportReplyEvent(
  db: D1Database,
  supportCase: SupportCaseForChat,
  staff: SupportAccessStaff,
  params: {
    chatId: string;
    friendId: string;
    lineAccountId: string;
    messageId: string;
    messageType: string;
    content: string;
    previousStatus: string;
    nextStatus: string | null;
    statusUpdateApplied: boolean;
    createdAt: string;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO support_case_events
       (id, case_id, event_type, actor_id, actor_name, body, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      `${params.messageId}:customer_reply_sent`,
      supportCase.id,
      'customer_reply_sent',
      staff.id,
      staff.name,
      'チャットで顧客返信を送信しました',
      JSON.stringify({
        chatId: params.chatId,
        friendId: params.friendId,
        lineAccountId: params.lineAccountId,
        messageId: params.messageId,
        messageType: params.messageType,
        contentPreview: params.content.slice(0, 200),
        previousStatus: params.previousStatus,
        nextStatus: params.nextStatus,
        statusUpdateApplied: params.statusUpdateApplied,
      }),
      params.createdAt,
    )
    .run();
}

async function markSupportCaseCustomerReply(
  db: D1Database,
  supportCase: SupportCaseForChat,
  staff: SupportAccessStaff,
  lineAccountId: string,
  now: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE support_cases
       SET status = 'customer_reply',
           updated_by = ?,
           updated_at = ?
       WHERE id = ? AND line_account_id = ? AND status != 'resolved'`,
    )
    .bind(staff.id, now, supportCase.id, lineAccountId)
    .run();
  const changes = Number((result as { meta?: { changes?: unknown } }).meta?.changes ?? 0);
  return changes > 0;
}

// id は chats.id もしくは friend.id のどちらか。friend.id のときは chats 行を遅延作成する。
// push / broadcast / scenario 配信だけを受けた友だちもチャット画面に現れるため、ここで lazy create が必要。
// 新規作成する場合は status='resolved' にし、last_message_at は messages_log の実際の最終時刻を使う
// （jstNow を入れると一覧並び順が壊れるため）。
async function resolveOrCreateChat(db: D1Database, id: string): Promise<ChatLike | null> {
  const existing = await getChatById(db, id);
  if (existing) return existing as ChatLike;
  const friend = await getFriendById(db, id);
  if (!friend) return null;
  const byFriend = await db
    .prepare(`SELECT * FROM chats WHERE friend_id = ? ORDER BY created_at ASC LIMIT 1`)
    .bind(friend.id)
    .first<ChatLike>();
  if (byFriend) return byFriend;

  const lastMsg = await db
    .prepare(
      `SELECT MAX(created_at) AS last
       FROM messages_log
       WHERE friend_id = ?
         AND (delivery_type IS NULL OR delivery_type != 'test')
         AND deleted_at IS NULL`,
    )
    .bind(friend.id)
    .first<{ last: string | null }>();
  const newId = crypto.randomUUID();
  const now = jstNow();
  const lastMessageAt = lastMsg?.last ?? null;
  // 同時実行で二重挿入されないように WHERE NOT EXISTS で原子挿入。挿入結果に関わらず最古行を返して収束。
  await db
    .prepare(
      `INSERT INTO chats (id, friend_id, status, last_message_at, created_at, updated_at)
       SELECT ?, ?, 'resolved', ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM chats WHERE friend_id = ?)`,
    )
    .bind(newId, friend.id, lastMessageAt, now, now, friend.id)
    .run();
  return (await db
    .prepare(`SELECT * FROM chats WHERE friend_id = ? ORDER BY created_at ASC LIMIT 1`)
    .bind(friend.id)
    .first<ChatLike>())!;
}

async function resolveExistingChatOrFriend(
  db: D1Database,
  id: string,
): Promise<{ chat: ChatLike | null; friendId: string } | null> {
  const existing = await getChatById(db, id);
  if (existing) return { chat: existing as ChatLike, friendId: existing.friend_id };

  const friend = await getFriendById(db, id);
  if (!friend) return null;

  const byFriend = await db
    .prepare(`SELECT * FROM chats WHERE friend_id = ? ORDER BY created_at DESC LIMIT 1`)
    .bind(friend.id)
    .first<ChatLike>();
  return { chat: byFriend, friendId: friend.id };
}

async function resolveFriendAndAccessToken(
  db: D1Database,
  friendId: string,
  defaultAccessToken: string,
) {
  const friend = await getFriendById(db, friendId);
  if (!friend) {
    return { friend: null, accessToken: defaultAccessToken };
  }

  if (!friend.line_account_id) {
    return { friend, accessToken: defaultAccessToken };
  }

  const account = await getLineAccountById(db, friend.line_account_id);
  if (!account) {
    return { friend, accessToken: defaultAccessToken };
  }

  return { friend, accessToken: account.channel_access_token };
}

function jstTimestampAfterMs(ms: number): string {
  return new Date(Date.now() + 9 * 60 * 60_000 + ms).toISOString().replace('Z', '').slice(0, 23);
}

async function cleanupExpiredChatTyping(db: D1Database, now: string): Promise<void> {
  await db
    .prepare(`DELETE FROM chat_typing_status WHERE expires_at <= ?`)
    .bind(now)
    .run();
}

async function getChatTypingParticipants(
  db: D1Database,
  chatId: string,
  staff: SupportAccessStaff,
  now: string,
): Promise<Array<{ staffId: string; staffName: string; updatedAt: string }>> {
  await cleanupExpiredChatTyping(db, now);
  const rows = await db
    .prepare(
      `SELECT staff_id, staff_name, updated_at, expires_at
       FROM chat_typing_status
       WHERE chat_id = ?
         AND expires_at > ?
         AND staff_id != ?
       ORDER BY updated_at DESC
       LIMIT 5`,
    )
    .bind(chatId, now, staff.id)
    .all<ChatTypingRow>();
  return rows.results.map((row) => ({
    staffId: row.staff_id,
    staffName: row.staff_name,
    updatedAt: row.updated_at,
  }));
}

type LatestIncomingReadMessage = {
  id: string;
  mark_as_read_token: string | null;
  marked_as_read_at: string | null;
};

async function getLatestIncomingReadMessage(
  db: D1Database,
  friendId: string,
): Promise<LatestIncomingReadMessage | null> {
  const row = await db
    .prepare(
      `SELECT id, mark_as_read_token, marked_as_read_at
       FROM messages_log
       WHERE friend_id = ?
         AND direction = 'incoming'
         AND deleted_at IS NULL
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
    )
    .bind(friendId)
    .first<LatestIncomingReadMessage>();
  return row ?? null;
}

async function markLatestIncomingAsRead(
  db: D1Database,
  lineClient: { markMessagesAsRead(markAsReadToken: string): Promise<unknown> },
  friendId: string,
  requested: boolean | undefined,
  actorId?: string | null,
): Promise<MarkAsReadResult> {
  const result = initialMarkAsReadResult(requested === true);
  if (!result.requested) return result;

  const latest = await getLatestIncomingReadMessage(db, friendId);
  if (!latest) return result;
  if (latest.marked_as_read_at) {
    return {
      requested: true,
      marked: true,
      reason: null,
      messageId: latest.id,
      markedAt: latest.marked_as_read_at,
    };
  }
  if (!latest.mark_as_read_token) {
    return { ...result, messageId: latest.id };
  }

  try {
    await lineClient.markMessagesAsRead(latest.mark_as_read_token);
    const markedAt = jstNow();
    await db
      .prepare(
        `UPDATE messages_log
         SET marked_as_read_at = ?,
             marked_as_read_by = ?
         WHERE id = ?`,
      )
      .bind(markedAt, actorId ?? null, latest.id)
      .run();
    return { requested: true, marked: true, reason: null, messageId: latest.id, markedAt };
  } catch (err) {
    console.error(`mark-as-read failed: ${chatRouteErrorKind(err)}`);
    return { requested: true, marked: false, reason: 'line_error', messageId: latest.id, markedAt: null };
  }
}

// ========== オペレーターCRUD ==========

chats.get('/api/operators', requireRole('owner', 'admin'), async (c) => {
  try {
    const items = await getOperators(c.env.DB);
    return c.json({
      success: true,
      data: items.map((o) => ({
        id: o.id,
        name: o.name,
        email: o.email,
        role: o.role,
        isActive: Boolean(o.is_active),
        createdAt: o.created_at,
        updatedAt: o.updated_at,
      })),
    });
  } catch (err) {
    console.error(`GET /api/operators error: ${chatRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

chats.post('/api/operators', requireRole('owner', 'admin'), async (c) => {
  try {
    const parsed = parseOperatorCreateBody(await readJsonBody(c));
    if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);
    const item = await createOperator(c.env.DB, parsed.value);
    return c.json({ success: true, data: { id: item.id, name: item.name, email: item.email, role: item.role } }, 201);
  } catch (err) {
    console.error(`POST /api/operators error: ${chatRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

chats.put('/api/operators/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = parseOperatorPathId(c.req.param('id'));
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const parsed = parseOperatorUpdateBody(await readJsonBody(c));
    if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);
    await updateOperator(c.env.DB, id.value, parsed.value);
    const updated = await getOperatorById(c.env.DB, id.value);
    if (!updated) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({ success: true, data: { id: updated.id, name: updated.name, email: updated.email, role: updated.role, isActive: Boolean(updated.is_active) } });
  } catch (err) {
    console.error(`PUT /api/operators/:id error: ${chatRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

chats.delete('/api/operators/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = parseOperatorPathId(c.req.param('id'));
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    await deleteOperator(c.env.DB, id.value);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error(`DELETE /api/operators/:id error: ${chatRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ========== チャットCRUD ==========

chats.post('/api/chats/sync-followers', requireRole('owner', 'admin'), async (c) => {
  try {
    const parsed = parseChatFollowerSyncBody(await readJsonBody(c));
    if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);

    const account = await getLineAccountById(c.env.DB, parsed.value.lineAccountId);
    if (!account || !account.is_active) {
      return c.json({ success: false, error: 'LINEアカウントが見つかりません' }, 404);
    }

    const { LineClient } = await import('@line-crm/line-sdk');
    const result = await syncFollowerPage(
      c.env.DB,
      new LineClient(account.channel_access_token),
      account.id,
      parsed.value.start,
    );
    return c.json({ success: true, data: result });
  } catch (err) {
    const status = lineApiErrorStatus(err);
    if (status === 403) {
      return c.json({
        success: false,
        error: 'LINE友だち一覧の取得には認証済みアカウントまたはプレミアムアカウントが必要です',
      }, 403);
    }
    console.error(`POST /api/chats/sync-followers error: ${chatRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'LINE友だち一覧の同期に失敗しました' }, 502);
  }
});

chats.get('/api/chats', async (c) => {
  try {
    const parsed = parseChatListQuery(new URL(c.req.url).searchParams);
    if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);
    const { status, operatorId, lineAccountId, unansweredOnly, search } = parsed.value;
    const staff = currentStaff(c);
    if (isSecondaryOnlySupportStaff(staff)) {
      return c.json({ success: false, error: '二次対応専用権限では顧客チャットを閲覧できません' }, 403);
    }

    const activeCaseConditions = activeSupportCaseConditions(staff, 'sc');
    const activeCaseAccountClause = lineAccountId ? 'AND sc.line_account_id = ?' : '';
    const activeCaseBinds = lineAccountId
      ? [...activeCaseConditions.binds, lineAccountId]
      : [...activeCaseConditions.binds];
    // List everyone who has any message history, any chats row, OR is currently following.
    // The third source makes follow-only users available for an operator-initiated first message.
    // Historical message/chat sources remain, so unfollowed customers and their logs do not disappear.
    //
    // recent_msg CTE で friend_id ごとに最新の messages_log 行をひとつ取得し、本文 preview と
    // direction (incoming/outgoing) を一覧に出す。
    //
    // パフォーマンス対策:
    //   1. lineAccountId 指定時は scoped_friends CTE で先に対象 friend を絞ってから messages_log
    //      を ranking する (アカ別 inbox が他アカの履歴をスキャンしないように)。
    //   2. content は text のみ先頭 200 文字まで切り詰めて返す (flex/image など raw JSON を返すと
    //      broadcast 後の rows で multi-MB レスポンスになる)。
    const accountFilterSql = lineAccountId
      ? `friend_id IN (SELECT id FROM friends WHERE line_account_id = ?)`
      : `1=1`;
    let sql = `
      WITH activity AS (
        SELECT friend_id, MAX(created_at) AS last_message_at
        FROM messages_log
        WHERE (delivery_type IS NULL OR delivery_type != 'test')
          AND deleted_at IS NULL
          AND ${accountFilterSql}
        GROUP BY friend_id
        UNION ALL
        SELECT friend_id, last_message_at
        FROM chats
        WHERE ${accountFilterSql}
        UNION ALL
        SELECT id AS friend_id, created_at AS last_message_at
        FROM friends
        WHERE is_following = 1
          ${lineAccountId ? 'AND line_account_id = ?' : ''}
      ),
      deduped AS (
        SELECT friend_id, MAX(last_message_at) AS last_message_at
        FROM activity
        GROUP BY friend_id
      ),
      -- preview は **常に最新メッセージ** を表示する。postback (rich menu tap) も含む。
      -- preview text と displayed time を揃えるための単純化 (incoming を優先すると
      -- 「最新は postback だが preview は古い text」の time mismatch が起きるため)。
      -- 注: postback.data が opaque な JSON token だと一覧で人間には読めない値が出るが、
      -- それは admin が rich menu の postback.data を人間向け文言にすべき config 問題。
      -- (LINE 仕様: postback.displayText は admin が設定可能、それを data に揃えるのが推奨)
      ranked_any AS (
        SELECT friend_id,
          CASE WHEN message_type = 'text' THEN SUBSTR(content, 1, 200) ELSE NULL END AS content,
          direction, message_type, created_at,
          ROW_NUMBER() OVER (PARTITION BY friend_id ORDER BY created_at DESC) AS rn
        FROM messages_log
        WHERE (delivery_type IS NULL OR delivery_type != 'test')
          AND deleted_at IS NULL
          AND ${accountFilterSql}
      ),
      recent_msg AS (
        SELECT
          friend_id,
          content,
          direction,
          message_type,
          created_at AS preview_at
        FROM ranked_any
        WHERE rn = 1
      ),
      last_human_reply AS (
        SELECT friend_id, MAX(created_at) AS last_human_reply_at
        FROM messages_log
        WHERE direction = 'outgoing'
          AND source IN ('manual', 'scheduled_manual', 'line_official')
          AND (delivery_type IS NULL OR delivery_type != 'test')
          AND deleted_at IS NULL
          AND ${accountFilterSql}
        GROUP BY friend_id
      ),
      ranked_customer_message AS (
        SELECT friend_id, id, created_at,
          ROW_NUMBER() OVER (PARTITION BY friend_id ORDER BY created_at DESC, id DESC) AS rn
        FROM messages_log
        WHERE direction = 'incoming'
          AND message_type != 'postback'
          AND (delivery_type IS NULL OR delivery_type != 'test')
          AND deleted_at IS NULL
          AND ${accountFilterSql}
      ),
      latest_customer_message AS (
        SELECT friend_id, id, created_at
        FROM ranked_customer_message
        WHERE rn = 1
      ),
      latest_confirmation AS (
        SELECT friend_id, confirmed_message_id, confirmed_message_at
        FROM (
          SELECT friend_id, confirmed_message_id, confirmed_message_at,
            ROW_NUMBER() OVER (
              PARTITION BY friend_id
              ORDER BY confirmed_message_at DESC, confirmed_message_id DESC, created_at DESC
            ) AS rn
          FROM chat_confirmation_events
          WHERE staff_id = ?
        ) ranked_confirmation
        WHERE rn = 1
      ),
      active_support_cases AS (
        SELECT *
        FROM (
          SELECT
            sc.friend_id,
            sc.id,
            sc.title,
            sc.status,
            sc.priority,
            sc.escalation_assignee,
            (
              SELECT se.status
              FROM support_escalations se
              WHERE se.case_id = sc.id
                AND se.status != 'closed'
              ORDER BY se.updated_at DESC, se.created_at DESC
              LIMIT 1
            ) AS latest_escalation_status,
            sc.updated_at,
            ROW_NUMBER() OVER (
              PARTITION BY sc.friend_id
              ORDER BY
                CASE
                  WHEN sc.status IN ('waiting_secondary', 'escalated') THEN 0
                  WHEN sc.status IN ('secondary_answered', 'customer_reply', 'waiting_primary') THEN 1
                  ELSE 2
                END,
                sc.updated_at DESC
            ) AS rn
          FROM support_cases sc
          WHERE ${activeCaseConditions.sql}
            ${activeCaseAccountClause}
        ) ranked_support
        WHERE rn = 1
      )
      SELECT
        f.id AS id,
        f.id AS friend_id,
        f.display_name,
        f.picture_url,
        f.line_user_id,
        f.line_account_id,
        c.operator_id,
        CASE
          WHEN COALESCE(c.is_long_term, 0) = 1 THEN 'long_term'
          ELSE COALESCE(c.status, 'resolved')
        END AS status,
        c.notes,
        -- last_message_at は preview メッセージの時刻に揃える (一覧 row の時刻表示と preview が
        -- 別メッセージを指す mismatch を防ぐ)。preview が無い (chats 行のみ存在) ケースは
        -- d.last_message_at にフォールバック。
        COALESCE(rm.preview_at, c.last_message_at) AS last_message_at,
        rm.content AS last_message_content,
        rm.direction AS last_message_direction,
        rm.message_type AS last_message_type,
        lhr.last_human_reply_at,
        lcm.id AS latest_customer_message_id,
        lcm.created_at AS latest_customer_message_at,
        CASE
          WHEN lcm.id IS NOT NULL AND lc.confirmed_message_id = lcm.id THEN 1
          ELSE 0
        END AS is_confirmed,
        lc.confirmed_message_at,
        ac.id AS support_case_id,
        ac.title AS support_case_title,
        ac.status AS support_case_status,
        ac.priority AS support_case_priority,
        ac.escalation_assignee AS support_case_escalation_assignee,
        ac.latest_escalation_status AS support_case_latest_escalation_status,
        ac.updated_at AS support_case_updated_at,
        COALESCE(c.created_at, f.created_at) AS created_at,
        COALESCE(c.updated_at, f.updated_at) AS updated_at
      FROM deduped d
      INNER JOIN friends f ON f.id = d.friend_id
      LEFT JOIN chats c ON c.id = (
        SELECT id FROM chats WHERE friend_id = f.id ORDER BY created_at DESC LIMIT 1
      )
      LEFT JOIN recent_msg rm ON rm.friend_id = f.id
      LEFT JOIN last_human_reply lhr ON lhr.friend_id = f.id
      LEFT JOIN latest_customer_message lcm ON lcm.friend_id = f.id
      LEFT JOIN latest_confirmation lc ON lc.friend_id = f.id
      LEFT JOIN active_support_cases ac ON ac.friend_id = f.id
    `;
    // CTE 内 placeholder は SQL 登場順に積む: accountFilterSql 3 箇所 + following friend source → active cases.
    const ctePrebindings: unknown[] = lineAccountId
      ? [lineAccountId, lineAccountId, lineAccountId, lineAccountId, lineAccountId, lineAccountId, staff.id, ...activeCaseBinds]
      : [staff.id, ...activeCaseBinds];
    const conditions: string[] = [];
    const bindings: unknown[] = [];

    if (status) {
      if (status === 'long_term') {
        conditions.push('COALESCE(c.is_long_term, 0) = 1');
      } else {
        conditions.push(`COALESCE(c.is_long_term, 0) = 0 AND COALESCE(c.status, 'resolved') = ?`);
        bindings.push(status);
      }
    }
    if (operatorId) {
      conditions.push('c.operator_id = ?');
      bindings.push(operatorId);
    }
    if (lineAccountId) {
      conditions.push('f.line_account_id = ?');
      bindings.push(lineAccountId);
    }
    if (search) {
      const pattern = `%${escapeLikePattern(search)}%`;
      conditions.push(`(
        f.display_name LIKE ? ESCAPE '\\'
        OR f.line_user_id LIKE ? ESCAPE '\\'
        OR json_extract(f.metadata, '$.customerNumber') LIKE ? ESCAPE '\\'
        OR json_extract(f.metadata, '$.customer_number') LIKE ? ESCAPE '\\'
        OR json_extract(f.metadata, '$.companyName') LIKE ? ESCAPE '\\'
        OR json_extract(f.metadata, '$.company_name') LIKE ? ESCAPE '\\'
        OR json_extract(f.metadata, '$.contactName') LIKE ? ESCAPE '\\'
        OR json_extract(f.metadata, '$.contact_name') LIKE ? ESCAPE '\\'
        OR json_extract(f.metadata, '$.storeName') LIKE ? ESCAPE '\\'
        OR json_extract(f.metadata, '$.store_name') LIKE ? ESCAPE '\\'
        OR rm.content LIKE ? ESCAPE '\\'
        OR ac.title LIKE ? ESCAPE '\\'
        OR c.notes LIKE ? ESCAPE '\\'
      )`);
      bindings.push(pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern);
    }
    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY d.last_message_at DESC';

	    // CTE 内 placeholder → 外側 WHERE placeholder の順に bind する
    const allBindings = [...ctePrebindings, ...bindings];
    const stmt = allBindings.length > 0
      ? c.env.DB.prepare(sql).bind(...allBindings)
      : c.env.DB.prepare(sql);
    const result = await stmt.all();

    const { getChatReplyRequirements } = await import('../services/unanswered-inbox.js');
    const replyRequirements = await getChatReplyRequirements(
      c.env.DB,
      result.results.map((ch: Record<string, unknown>) => String(ch.friend_id)),
      staff,
    );

    let data = result.results.map((ch: Record<string, unknown>) => {
      const replyRequirement = replyRequirements.get(String(ch.friend_id));
      return {
      id: ch.id as string,
      friendId: ch.friend_id,
      friendName: ch.display_name || '名前なし',
      friendPictureUrl: ch.picture_url || null,
      operatorId: ch.operator_id,
      status: ch.status,
      notes: ch.notes,
      lastMessageAt: ch.last_message_at,
      lastMessageContent: ch.last_message_content || null,
      lastMessageDirection: ch.last_message_direction || null,
      lastMessageType: ch.last_message_type || null,
      lastHumanReplyAt: ch.last_human_reply_at || null,
      latestCustomerMessageId: ch.latest_customer_message_id || null,
      latestCustomerMessageAt: ch.latest_customer_message_at || null,
      isConfirmed: Number(ch.is_confirmed ?? 0) === 1,
      confirmedMessageAt: ch.confirmed_message_at || null,
      needsReply: replyRequirement?.needsReply ?? false,
      lastUnansweredAt: replyRequirement?.lastUnansweredIncomingAt ?? null,
      activeSupportCase: ch.support_case_id ? {
        id: ch.support_case_id,
        title: ch.support_case_title,
        status: ch.support_case_status,
        priority: ch.support_case_priority,
        escalationAssignee: ch.support_case_escalation_assignee,
        latestEscalationStatus: ch.support_case_latest_escalation_status,
        updatedAt: ch.support_case_updated_at,
      } : null,
      createdAt: ch.created_at,
      updatedAt: ch.updated_at,
      };
    });

    if (unansweredOnly) {
      data = data.filter((row) => row.needsReply);
    }

    return c.json({ success: true, data });
  } catch (err) {
    console.error(`GET /api/chats error: ${chatRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

chats.get('/api/chats/messages/:messageId/media', async (c) => {
  try {
    const messageId = parseChatPathId(c.req.param('messageId'));
    if (!messageId.ok) return c.json({ success: false, error: messageId.error }, 400);

    const row = await c.env.DB
      .prepare(
        `SELECT
           ml.id,
           ml.friend_id,
           ml.message_type,
           ml.content,
           ml.line_account_id,
           f.line_account_id AS friend_line_account_id
         FROM messages_log ml
         LEFT JOIN friends f ON f.id = ml.friend_id
         WHERE ml.id = ?
         LIMIT 1`,
      )
      .bind(messageId.value)
      .first<ChatMediaMessageRow>();
    if (!row) return c.json({ success: false, error: 'Media not found' }, 404);

    const denied = await ensureChatFriendAccess(c, row.friend_id);
    if (denied) return denied;

    const payload = parseStoredLineMediaPayload(row);
    if (!payload) {
      return c.json({ success: false, error: 'Media metadata is not available' }, 404);
    }

    const accountId = row.line_account_id || row.friend_line_account_id;
    const accessToken = await resolveLineAccessTokenByAccount(c.env.DB, accountId, c.env.LINE_CHANNEL_ACCESS_TOKEN);
    const lineResponse = await fetch(`${LINE_CONTENT_API_BASE}/${encodeURIComponent(payload.lineMessageId)}/content`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!lineResponse.ok) {
      const status = lineResponse.status === 404 ? 404 : 502;
      return c.json({ success: false, error: 'Media content is not available from LINE' }, status);
    }

    const contentType =
      lineResponse.headers.get('Content-Type')?.split(';')[0].trim() ||
      payload.mimeType ||
      fallbackMimeType(row.message_type, payload.fileName);
    const fileName = defaultMediaFileName(row, payload);
    const headers = new Headers();
    headers.set('Content-Type', contentType);
    headers.set('Cache-Control', 'private, max-age=300');
    headers.set('Content-Disposition', `inline; filename*=UTF-8''${encodeRfc5987Value(fileName)}`);
    const contentLength = lineResponse.headers.get('Content-Length');
    if (contentLength) headers.set('Content-Length', contentLength);

    return new Response(lineResponse.body, { status: 200, headers });
  } catch (err) {
    console.error(`GET /api/chats/messages/:messageId/media error: ${chatRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

chats.get('/api/chats/:id', async (c) => {
  try {
    const id = parseChatPathId(c.req.param('id'));
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const query = parseChatDetailQuery(new URL(c.req.url).searchParams);
    if (!query.ok) return c.json({ success: false, error: query.error }, 400);
    const rawId = id.value;

    // id は chats.id または friend.id のどちらでもOK。
    // 優先順: chats.id 一致 → friend.id のとき chats.friend_id 最新行 → 何も無ければ friend のみで synthetic
    let chatRow = await getChatById(c.env.DB, rawId);
    let friendId: string | null = null;

    if (!chatRow) {
      const friendRow = await getFriendById(c.env.DB, rawId);
      if (!friendRow) return c.json({ success: false, error: 'Chat not found' }, 404);
      friendId = friendRow.id;
      // 同じ friend に紐づく chats 行があれば採用（lazy-create 後の再読みで status/notes を拾うため）
      const existing = await c.env.DB
        .prepare(`SELECT * FROM chats WHERE friend_id = ? ORDER BY created_at DESC LIMIT 1`)
        .bind(friendRow.id)
        .first<{ id: string; friend_id: string; operator_id: string | null; status: string; is_long_term: number; notes: string | null; last_message_at: string | null; created_at: string; updated_at: string }>();
      if (existing) {
        chatRow = existing as Awaited<ReturnType<typeof getChatById>>;
      }
    }

    const resolvedFriendId = chatRow?.friend_id ?? friendId!;
    const denied = await ensureChatFriendAccess(c, resolvedFriendId);
    if (denied) return denied;

    // 公開 ID は常に friend_id に統一する（lazy-create で ID が変わるのを防ぐため）。
    const responseId = resolvedFriendId;
    const operatorId = chatRow?.operator_id ?? null;
    const status = publicChatStatus(chatRow?.status, chatRow?.is_long_term);
    const notes = chatRow?.notes ?? null;
    const lastMessageAt = chatRow?.last_message_at ?? null;
    const createdAt = chatRow?.created_at ?? null;

    const friend = await c.env.DB
      .prepare(`SELECT display_name, picture_url, line_user_id, line_account_id FROM friends WHERE id = ?`)
      .bind(resolvedFriendId)
      .first<{ display_name: string | null; picture_url: string | null; line_user_id: string; line_account_id: string | null }>();

    // 新しい順で1件多く取り、昇順に戻す。初回は従来どおり最新1000件を返し、
    // beforeCreatedAt/beforeId がある場合だけ古い履歴をページングする。
    const { messageLimit, beforeCreatedAt, beforeId } = query.value;
    const messageWhere = [
      'friend_id = ?',
      `(delivery_type IS NULL OR delivery_type != 'test')`,
    ];
    const messageBinds: unknown[] = [resolvedFriendId];
    if (beforeCreatedAt && beforeId) {
      messageWhere.push(`(created_at < ? OR (created_at = ? AND id < ?))`);
      messageBinds.push(beforeCreatedAt, beforeCreatedAt, beforeId);
    } else if (beforeCreatedAt) {
      messageWhere.push(`created_at < ?`);
      messageBinds.push(beforeCreatedAt);
    }

    const messages = await c.env.DB
      .prepare(
        `SELECT id, friend_id, direction, message_type, content, source, quote_token, quoted_message_id, marked_as_read_at, marked_as_read_by, deleted_at, deleted_reason, sent_by_staff_id, sent_by_staff_name, created_at
         FROM messages_log
         WHERE ${messageWhere.join(' AND ')}
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .bind(...messageBinds, messageLimit + 1)
      .all<Record<string, unknown>>();
    const rawMessages = messages.results;
    const hasMoreMessages = rawMessages.length > messageLimit;
    const pageMessages = rawMessages.slice(0, messageLimit).reverse();
    const oldestMessage = pageMessages[0];
    const internalMessages = await c.env.DB
      .prepare(
        `SELECT id, friend_id, line_account_id, parent_id, body, mentions, reactions, created_by, created_by_name, created_at
         FROM chat_internal_messages
         WHERE friend_id = ?
         ORDER BY created_at ASC, id ASC
         LIMIT 300`,
      )
      .bind(resolvedFriendId)
      .all<ChatInternalMessageRow>();
    const [internalMessageMentionIds, internalMessageEvents] = await Promise.all([
      mentionStaffIdsForMessages(
        c.env.DB,
        'chat',
        internalMessages.results.map((message) => message.id),
      ),
      latestInternalMessageEvents(
        c.env.DB,
        'chat',
        internalMessages.results.map((message) => message.id),
      ),
    ]);
    const activeSupportCase = await getActiveSupportCaseForFriend(
      c.env.DB,
      resolvedFriendId,
      currentStaff(c),
    );
    const staff = currentStaff(c);
    const now = jstNow();
    const typingParticipants = chatRow
      ? await getChatTypingParticipants(c.env.DB, chatRow.id, staff, now)
      : [];
    const scheduledMessages = chatRow
      ? await getActiveScheduledChatMessages(c.env.DB, chatRow.id)
      : [];
    const { getChatReplyRequirements } = await import('../services/unanswered-inbox.js');
    const replyRequirement = (await getChatReplyRequirements(
      c.env.DB,
      [resolvedFriendId],
      staff,
    )).get(resolvedFriendId);
    const [lastHumanReply, latestCustomerMessage, latestConfirmation] = await Promise.all([
      c.env.DB
        .prepare(
          `SELECT MAX(created_at) AS created_at
           FROM messages_log
           WHERE friend_id = ?
             AND direction = 'outgoing'
             AND source IN ('manual', 'scheduled_manual', 'line_official')
             AND (delivery_type IS NULL OR delivery_type != 'test')
             AND deleted_at IS NULL`,
        )
        .bind(resolvedFriendId)
        .first<{ created_at: string | null }>(),
      c.env.DB
        .prepare(
          `SELECT id, created_at
           FROM messages_log
           WHERE friend_id = ?
             AND direction = 'incoming'
             AND message_type != 'postback'
             AND (delivery_type IS NULL OR delivery_type != 'test')
             AND deleted_at IS NULL
           ORDER BY created_at DESC, id DESC
           LIMIT 1`,
        )
        .bind(resolvedFriendId)
        .first<{ id: string; created_at: string }>(),
      c.env.DB
        .prepare(
          `SELECT confirmed_message_id, confirmed_message_at
           FROM chat_confirmation_events
           WHERE friend_id = ? AND staff_id = ?
           ORDER BY confirmed_message_at DESC, confirmed_message_id DESC, created_at DESC
           LIMIT 1`,
        )
        .bind(resolvedFriendId, staff.id)
        .first<{ confirmed_message_id: string; confirmed_message_at: string }>(),
    ]);
    const latestMessage = pageMessages.at(-1);

    return c.json({
      success: true,
      data: {
        id: responseId,
        friendId: resolvedFriendId,
        friendName: friend?.display_name || '名前なし',
        friendPictureUrl: friend?.picture_url || null,
        operatorId,
        status,
        notes,
        lastMessageAt: latestMessage?.created_at ?? lastMessageAt,
        lastMessageContent: latestMessage?.content ?? null,
        lastMessageDirection: latestMessage?.direction ?? null,
        lastMessageType: latestMessage?.message_type ?? null,
        needsReply: replyRequirement?.needsReply ?? false,
        lastUnansweredAt: replyRequirement?.lastUnansweredIncomingAt ?? null,
        lastHumanReplyAt: lastHumanReply?.created_at ?? null,
        latestCustomerMessageId: latestCustomerMessage?.id ?? null,
        latestCustomerMessageAt: latestCustomerMessage?.created_at ?? null,
        isConfirmed: Boolean(
          latestCustomerMessage?.id
          && latestConfirmation?.confirmed_message_id === latestCustomerMessage.id
        ),
        confirmedMessageAt: latestConfirmation?.confirmed_message_at ?? null,
        createdAt,
        hasMoreMessages,
        nextMessagesBefore: hasMoreMessages && oldestMessage
          ? { createdAt: oldestMessage.created_at, id: oldestMessage.id }
          : null,
        internalMessages: internalMessages.results.map((message) => serializeChatInternalMessage(
          message,
          staff,
          internalMessageMentionIds.get(message.id) ?? [],
          internalMessageEvents.get(message.id),
        )),
        activeSupportCase: serializeActiveSupportCaseForChat(activeSupportCase),
        typingParticipants,
        scheduledMessages: scheduledMessages.map(serializeScheduledChatMessage),
        messages: pageMessages.map((m) => ({
          id: m.id,
          direction: m.direction,
          messageType: m.message_type,
          content: m.content,
          source: m.source,
          canQuote: m.direction === 'incoming' && typeof m.quote_token === 'string' && m.quote_token.trim() !== '' && !m.deleted_at,
          quotedMessageId: m.quoted_message_id,
          markedAsReadAt: m.marked_as_read_at,
          markedAsReadBy: m.marked_as_read_by,
          deletedAt: m.deleted_at,
          deletedReason: m.deleted_reason,
          sentByStaffId: m.sent_by_staff_id,
          sentByStaffName: m.sent_by_staff_name,
          createdAt: m.created_at,
        })),
      },
    });
  } catch (err) {
    console.error(`GET /api/chats/:id error: ${chatRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

chats.post('/api/chats/:id/confirm', async (c) => {
  try {
    const id = parseChatPathId(c.req.param('id'));
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const resolved = await resolveExistingChatOrFriend(c.env.DB, id.value);
    if (!resolved) return c.json({ success: false, error: 'Chat not found' }, 404);
    const denied = await ensureChatFriendAccess(c, resolved.friendId);
    if (denied) return denied;
    const latestCustomerMessage = await c.env.DB
      .prepare(
        `SELECT id, created_at
         FROM messages_log
         WHERE friend_id = ?
           AND direction = 'incoming'
           AND message_type != 'postback'
           AND (delivery_type IS NULL OR delivery_type != 'test')
           AND deleted_at IS NULL
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
      )
      .bind(resolved.friendId)
      .first<{ id: string; created_at: string }>();
    if (!latestCustomerMessage) {
      return c.json({ success: false, error: '確認対象の顧客メッセージがありません' }, 400);
    }
    const friend = await c.env.DB
      .prepare(`SELECT line_account_id FROM friends WHERE id = ?`)
      .bind(resolved.friendId)
      .first<{ line_account_id: string | null }>();
    const staff = currentStaff(c);
    const now = jstNow();
    await c.env.DB
      .prepare(
        `INSERT OR IGNORE INTO chat_confirmation_events (
          id, friend_id, line_account_id, staff_id, staff_name,
          confirmed_message_id, confirmed_message_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        resolved.friendId,
        friend?.line_account_id ?? null,
        staff.id,
        staff.name,
        latestCustomerMessage.id,
        latestCustomerMessage.created_at,
        now,
      )
      .run();
    return c.json({
      success: true,
      data: {
        isConfirmed: true,
        confirmedMessageId: latestCustomerMessage.id,
        confirmedMessageAt: latestCustomerMessage.created_at,
        confirmedAt: now,
      },
    });
  } catch (err) {
    console.error(`POST /api/chats/:id/confirm error: ${chatRouteErrorKind(err)}`);
    return c.json({ success: false, error: '確認状態の更新に失敗しました' }, 500);
  }
});

chats.post('/api/chats', async (c) => {
  try {
    const parsed = parseChatCreateBody(await readJsonBody(c));
    if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);
    const body = parsed.value;
    const denied = await ensureChatFriendAccess(c, body.friendId);
    if (denied) return denied;

    const item = await createChat(c.env.DB, body);
    // Save line_account_id if provided
    if (body.lineAccountId) {
      await c.env.DB.prepare(`UPDATE chats SET line_account_id = ? WHERE id = ?`)
        .bind(body.lineAccountId, item.id).run();
    }
    return c.json({ success: true, data: { id: item.id, friendId: item.friend_id, status: item.status } }, 201);
  } catch (err) {
    console.error(`POST /api/chats error: ${chatRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// チャットのアサイン/ステータス更新/ノート更新
chats.put('/api/chats/:id', async (c) => {
  try {
    const id = parseChatPathId(c.req.param('id'));
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const parsed = parseChatUpdateBody(await readJsonBody(c));
    if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);
    const resolved = await resolveOrCreateChat(c.env.DB, id.value);
    if (!resolved) return c.json({ success: false, error: 'Not found' }, 404);
    const denied = await ensureChatFriendAccess(c, resolved.friend_id);
    if (denied) return denied;

    const update = parsed.value.status === 'long_term'
      ? { ...parsed.value, status: 'in_progress', isLongTerm: true }
      : {
          ...parsed.value,
          ...(parsed.value.status ? { isLongTerm: false } : {}),
        };
    await updateChat(c.env.DB, resolved.id, update);
    const updated = await getChatById(c.env.DB, resolved.id);
    if (!updated) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({
      success: true,
      // 公開 ID は friend_id に統一
      data: {
        id: updated.friend_id,
        friendId: updated.friend_id,
        operatorId: updated.operator_id,
        status: publicChatStatus(updated.status, updated.is_long_term),
        notes: updated.notes,
      },
    });
  } catch (err) {
    console.error(`PUT /api/chats/:id error: ${chatRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

chats.post('/api/chats/:id/typing', async (c) => {
  try {
    const id = parseChatPathId(c.req.param('id'));
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const parsed = parseChatTypingStatusBody(await readJsonBody(c));
    if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);

    const chat = await resolveOrCreateChat(c.env.DB, id.value);
    if (!chat) return c.json({ success: false, error: 'Chat not found' }, 404);
    const denied = await ensureChatFriendAccess(c, chat.friend_id);
    if (denied) return denied;

    const friend = await getFriendById(c.env.DB, chat.friend_id) as { line_account_id?: string | null } | null;
    if (!friend) return c.json({ success: false, error: 'Friend not found' }, 404);

    const staff = currentStaff(c);
    const now = jstNow();
    await cleanupExpiredChatTyping(c.env.DB, now);

    // Typing is presence only. Workflow state changes require an explicit action.
    if (parsed.value.active) {
      const expiresAt = jstTimestampAfterMs(15_000);
      await c.env.DB
        .prepare(
          `INSERT INTO chat_typing_status (
             id, chat_id, friend_id, staff_id, staff_name, line_account_id, expires_at, updated_at
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(chat_id, staff_id) DO UPDATE SET
             staff_name = excluded.staff_name,
             line_account_id = excluded.line_account_id,
             expires_at = excluded.expires_at,
             updated_at = excluded.updated_at`,
        )
        .bind(
          crypto.randomUUID(),
          chat.id,
          chat.friend_id,
          staff.id,
          staff.name,
          friend.line_account_id ?? null,
          expiresAt,
          now,
        )
        .run();
    } else {
      await c.env.DB
        .prepare(`DELETE FROM chat_typing_status WHERE chat_id = ? AND staff_id = ?`)
        .bind(chat.id, staff.id)
        .run();
    }

    return c.json({
      success: true,
      data: {
        active: parsed.value.active,
        status: publicChatStatus(chat.status, chat.is_long_term),
        typingParticipants: await getChatTypingParticipants(c.env.DB, chat.id, staff, jstNow()),
      },
    });
  } catch (err) {
    console.error(`POST /api/chats/:id/typing error: ${chatRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

chats.post('/api/chats/:id/internal-messages', async (c) => {
  try {
    const id = parseChatPathId(c.req.param('id'));
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const parsed = parseChatInternalMessageBody(await readJsonBody(c));
    if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);

    const chat = await resolveOrCreateChat(c.env.DB, id.value);
    if (!chat) return c.json({ success: false, error: 'Chat not found' }, 404);
    const denied = await ensureChatFriendAccess(c, chat.friend_id);
    if (denied) return denied;

    const friend = await getFriendById(c.env.DB, chat.friend_id) as { line_account_id?: string | null } | null;
    if (!friend) return c.json({ success: false, error: 'Friend not found' }, 404);

    if (parsed.value.parentId) {
      const parent = await c.env.DB
        .prepare(
          `SELECT id
           FROM chat_internal_messages
           WHERE id = ? AND friend_id = ?
           LIMIT 1`,
        )
        .bind(parsed.value.parentId, chat.friend_id)
        .first<{ id: string }>();
      if (!parent) return c.json({ success: false, error: 'parent message not found' }, 404);
    }

    const messageId = crypto.randomUUID();
    const now = jstNow();
    const staff = currentStaff(c);
    const resolvedMentions = await resolveMentionStaffTargets(c.env.DB, parsed.value.mentionStaffIds);
    if (resolvedMentions.missingIds.length > 0) {
      return c.json({ success: false, error: 'mention target not found' }, 400);
    }
    if (!mentionTargetsMatchBody(parsed.value.body, resolvedMentions.targets)) {
      return c.json({ success: false, error: 'mention target must appear in body' }, 400);
    }
    const mentionNames = Array.from(new Set([
      ...parsed.value.mentions,
      ...resolvedMentions.targets.map((target) => target.name),
    ]));
    await c.env.DB
      .prepare(
        `INSERT INTO chat_internal_messages (
           id, friend_id, line_account_id, parent_id, body, mentions, created_by, created_by_name, created_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        messageId,
        chat.friend_id,
        friend.line_account_id ?? null,
        parsed.value.parentId ?? null,
        parsed.value.body,
        JSON.stringify(mentionNames),
        staff.id,
        staff.name,
        now,
      )
      .run();

    await recordInternalMessageMentions(
      c.env.DB,
      'chat',
      messageId,
      resolvedMentions.targets,
      now,
    );

    const row = await c.env.DB
      .prepare(
        `SELECT id, friend_id, line_account_id, parent_id, body, mentions, reactions, created_by, created_by_name, created_at
         FROM chat_internal_messages
         WHERE id = ?`,
      )
      .bind(messageId)
      .first<ChatInternalMessageRow>();

    kickWebPushNotifications(c);
    return c.json({
      success: true,
      data: row ? serializeChatInternalMessage(row, staff, parsed.value.mentionStaffIds) : null,
    }, 201);
  } catch (err) {
    console.error(`POST /api/chats/:id/internal-messages error: ${chatRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

chats.patch('/api/chats/:id/internal-messages/:messageId', async (c) => {
  try {
    const id = parseChatPathId(c.req.param('id'));
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const messageId = parseChatPathId(c.req.param('messageId'));
    if (!messageId.ok) return c.json({ success: false, error: messageId.error }, 400);
    const rawBody = await readJsonBody(c);
    if (!isRecord(rawBody)) return c.json({ success: false, error: 'Invalid payload' }, 400);
    const parsed = parseChatInternalMessageBody(rawBody);
    if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);
    const baseVersion = parseInternalMessageBaseVersion(rawBody.baseVersion);
    if (!baseVersion.ok) return c.json({ success: false, error: baseVersion.error }, 400);
    const chat = await resolveOrCreateChat(c.env.DB, id.value);
    if (!chat) return c.json({ success: false, error: 'Chat not found' }, 404);
    const denied = await ensureChatFriendAccess(c, chat.friend_id);
    if (denied) return denied;
    const message = await c.env.DB
      .prepare(
        `SELECT id, friend_id, line_account_id, parent_id, body, mentions, reactions, created_by, created_by_name, created_at
         FROM chat_internal_messages WHERE id = ? AND friend_id = ? LIMIT 1`,
      )
      .bind(messageId.value, chat.friend_id)
      .first<ChatInternalMessageRow>();
    if (!message) return c.json({ success: false, error: 'message not found' }, 404);
    const resolvedMentions = await resolveMentionStaffTargets(c.env.DB, parsed.value.mentionStaffIds);
    if (resolvedMentions.missingIds.length > 0) {
      return c.json({ success: false, error: 'mention target not found' }, 400);
    }
    if (!mentionTargetsMatchBody(parsed.value.body, resolvedMentions.targets)) {
      return c.json({ success: false, error: 'mention target must appear in body' }, 400);
    }
    const mentionNames = Array.from(new Set([
      ...parsed.value.mentions,
      ...resolvedMentions.targets.map((target) => target.name),
    ]));
    const staff = currentStaff(c);
    const result = await appendInternalMessageEvent({
      db: c.env.DB,
      source: 'chat',
      message,
      staff,
      baseVersion: baseVersion.value,
      action: 'edit',
      body: parsed.value.body,
      mentions: mentionNames,
      mentionTargets: resolvedMentions.targets,
      now: jstNow(),
    });
    if (!result.ok) {
      if (result.reason === 'conflict') return c.json({ success: false, error: '別の更新が反映されています。再読み込みしてください' }, 409);
      if (result.reason === 'deleted') return c.json({ success: false, error: '削除済みメッセージは編集できません' }, 400);
      return c.json({ success: false, error: '自分が投稿したメッセージだけ編集できます' }, 403);
    }
    kickWebPushNotifications(c);
    return c.json({
      success: true,
      data: serializeChatInternalMessage(message, staff, parsed.value.mentionStaffIds, result.event),
    });
  } catch (err) {
    console.error(`PATCH /api/chats/:id/internal-messages/:messageId error: ${chatRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'メッセージの編集に失敗しました' }, 500);
  }
});

chats.post('/api/chats/:id/internal-messages/:messageId/soft-delete', async (c) => {
  try {
    const id = parseChatPathId(c.req.param('id'));
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const messageId = parseChatPathId(c.req.param('messageId'));
    if (!messageId.ok) return c.json({ success: false, error: messageId.error }, 400);
    const rawBody = await readJsonBody(c);
    if (!isRecord(rawBody)) return c.json({ success: false, error: 'Invalid payload' }, 400);
    const baseVersion = parseInternalMessageBaseVersion(rawBody.baseVersion);
    if (!baseVersion.ok) return c.json({ success: false, error: baseVersion.error }, 400);
    const reason = parseOptionalSearchString(rawBody.reason, 'reason', 500);
    if (!reason.ok) return c.json({ success: false, error: reason.error }, 400);
    const chat = await resolveOrCreateChat(c.env.DB, id.value);
    if (!chat) return c.json({ success: false, error: 'Chat not found' }, 404);
    const denied = await ensureChatFriendAccess(c, chat.friend_id);
    if (denied) return denied;
    const message = await c.env.DB
      .prepare(
        `SELECT id, friend_id, line_account_id, parent_id, body, mentions, reactions, created_by, created_by_name, created_at
         FROM chat_internal_messages WHERE id = ? AND friend_id = ? LIMIT 1`,
      )
      .bind(messageId.value, chat.friend_id)
      .first<ChatInternalMessageRow>();
    if (!message) return c.json({ success: false, error: 'message not found' }, 404);
    const staff = currentStaff(c);
    if (message.created_by !== staff.id && !reason.value) {
      return c.json({ success: false, error: '他のスタッフの投稿を削除する場合は理由を入力してください' }, 400);
    }
    const result = await appendInternalMessageEvent({
      db: c.env.DB,
      source: 'chat',
      message,
      staff,
      baseVersion: baseVersion.value,
      action: 'delete',
      reason: reason.value,
      now: jstNow(),
    });
    if (!result.ok) {
      if (result.reason === 'conflict') return c.json({ success: false, error: '別の更新が反映されています。再読み込みしてください' }, 409);
      if (result.reason === 'deleted') return c.json({ success: false, error: 'すでに削除済みです' }, 400);
      return c.json({ success: false, error: 'このメッセージは削除できません' }, 403);
    }
    return c.json({ success: true, data: serializeChatInternalMessage(message, staff, [], result.event) });
  } catch (err) {
    console.error(`POST /api/chats/:id/internal-messages/:messageId/soft-delete error: ${chatRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'メッセージの削除に失敗しました' }, 500);
  }
});

chats.post('/api/chats/:id/internal-messages/:messageId/reactions', async (c) => {
  try {
    const id = parseChatPathId(c.req.param('id'));
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const messageId = parseChatPathId(c.req.param('messageId'));
    if (!messageId.ok) return c.json({ success: false, error: messageId.error }, 400);
    const rawBody = await readJsonBody(c);
    if (!isRecord(rawBody)) return c.json({ success: false, error: 'Invalid payload' }, 400);
    const emoji = normalizeInternalReactionEmoji(rawBody.emoji);
    if (!emoji.ok) return c.json({ success: false, error: emoji.error }, 400);

    const chat = await resolveOrCreateChat(c.env.DB, id.value);
    if (!chat) return c.json({ success: false, error: 'Chat not found' }, 404);
    const denied = await ensureChatFriendAccess(c, chat.friend_id);
    if (denied) return denied;

    const message = await c.env.DB
      .prepare(
        `SELECT id, friend_id, line_account_id, parent_id, body, mentions, reactions, created_by, created_by_name, created_at
         FROM chat_internal_messages
         WHERE id = ? AND friend_id = ?
         LIMIT 1`,
      )
      .bind(messageId.value, chat.friend_id)
      .first<ChatInternalMessageRow>();
    if (!message) return c.json({ success: false, error: 'message not found' }, 404);
    const messageEvent = (await latestInternalMessageEvents(c.env.DB, 'chat', [messageId.value])).get(messageId.value);
    if (messageEvent?.action === 'delete') {
      return c.json({ success: false, error: '削除済みメッセージにはリアクションできません' }, 400);
    }

    const staff = currentStaff(c);
    const { reactionsJson } = toggleInternalReaction(message.reactions, emoji.value, staff);
    await c.env.DB
      .prepare(`UPDATE chat_internal_messages SET reactions = ? WHERE id = ? AND friend_id = ?`)
      .bind(reactionsJson, messageId.value, chat.friend_id)
      .run();

    const updated = await c.env.DB
      .prepare(
        `SELECT id, friend_id, line_account_id, parent_id, body, mentions, reactions, created_by, created_by_name, created_at
         FROM chat_internal_messages
         WHERE id = ? AND friend_id = ?
         LIMIT 1`,
      )
      .bind(messageId.value, chat.friend_id)
      .first<ChatInternalMessageRow>();
    const mentionIds = await mentionStaffIdsForMessages(c.env.DB, 'chat', [messageId.value]);

    return c.json({
      success: true,
      data: updated
        ? serializeChatInternalMessage(updated, staff, mentionIds.get(messageId.value) ?? [], messageEvent)
        : null,
    });
  } catch (err) {
    console.error(`POST /api/chats/:id/internal-messages/:messageId/reactions error: ${chatRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

chats.post('/api/chats/:id/external-outgoing', async (c) => {
  try {
    const chatId = parseChatPathId(c.req.param('id'));
    if (!chatId.ok) return c.json({ success: false, error: chatId.error }, 400);
    const body = parseExternalOutgoingBody(await readJsonBody(c));
    if (!body.ok) return c.json({ success: false, error: body.error }, 400);

    const chat = await resolveOrCreateChat(c.env.DB, chatId.value);
    if (!chat) return c.json({ success: false, error: 'Chat not found' }, 404);
    const denied = await ensureChatFriendAccess(c, chat.friend_id);
    if (denied) return denied;

    const { friend } = await resolveFriendAndAccessToken(
      c.env.DB,
      chat.friend_id,
      c.env.LINE_CHANNEL_ACCESS_TOKEN,
    );
    if (!friend) return c.json({ success: false, error: 'Friend not found' }, 404);

    const messageId = crypto.randomUUID();
    const now = jstNow();
    await c.env.DB
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, source, line_account_id, created_at)
         VALUES (?, ?, 'outgoing', 'text', ?, 'line_official', ?, ?)`,
      )
      .bind(messageId, friend.id, body.value.content, friend.line_account_id ?? null, now)
      .run();
    await updateChat(c.env.DB, chat.id, { status: 'in_progress', isLongTerm: false, lastMessageAt: now });

    return c.json({
      success: true,
      data: {
        recorded: true,
        messageId,
        message: {
          id: messageId,
          direction: 'outgoing',
          messageType: 'text',
          content: body.value.content,
          source: 'line_official',
          createdAt: now,
        },
      },
    });
  } catch (err) {
    console.error(`POST /api/chats/:id/external-outgoing error: ${chatRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// オペレーター入力中のローディング表示を開始
chats.post('/api/chats/:id/loading', async (c) => {
  try {
    if (!canUseManualLineSend(c.env)) {
      return c.json({ success: false, error: 'Manual LINE sending is disabled' }, 403);
    }
    const chatId = parseChatPathId(c.req.param('id'));
    if (!chatId.ok) return c.json({ success: false, error: chatId.error }, 400);
    const chat = await resolveOrCreateChat(c.env.DB, chatId.value);
    if (!chat) return c.json({ success: false, error: 'Chat not found' }, 404);
    const denied = await ensureChatFriendAccess(c, chat.friend_id);
    if (denied) return denied;

    let loadingSecondsInput: number | undefined;
    try {
      const body = await c.req.json<{ loadingSeconds?: number }>();
      loadingSecondsInput = body.loadingSeconds;
    } catch {
      loadingSecondsInput = undefined;
    }
    const loadingSeconds = clampLoadingSeconds(loadingSecondsInput);

    const { friend, accessToken } = await resolveFriendAndAccessToken(
      c.env.DB,
      chat.friend_id,
      c.env.LINE_CHANNEL_ACCESS_TOKEN,
    );
    if (!friend) return c.json({ success: false, error: 'Friend not found' }, 404);
    const safetyBlock = await getLineSendSafetyBlock(c.env.DB, friend.line_account_id);
    if (safetyBlock) return lineSafetyBlockedResponse(c, safetyBlock);

    await startLoadingAnimation(
      accessToken,
      friend.line_user_id,
      loadingSeconds,
    );

    return c.json({ success: true, data: { started: true, loadingSeconds } });
  } catch (err) {
    console.error(`POST /api/chats/:id/loading error: ${chatRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// 送信前検証。LINE送信やDB更新は行わず、プリフライトやUI側の安全確認に使う。
chats.post('/api/chats/:id/send/validate', async (c) => {
  try {
    const chatId = parseChatPathId(c.req.param('id'));
    if (!chatId.ok) return c.json({ success: false, error: chatId.error }, 400);
    const body = parseChatSendBody(await readJsonBody(c));
    if (!body.ok) return c.json({ success: false, error: body.error }, 400);
    const normalized = normalizeChatSendPayload(body.value);
    if (!normalized.ok) return c.json({ success: false, error: normalized.error }, 400);

    const resolved = await resolveExistingChatOrFriend(c.env.DB, chatId.value);
    if (!resolved) return c.json({ success: false, error: 'Chat not found' }, 404);
    const denied = await ensureChatFriendAccess(c, resolved.friendId);
    if (denied) return denied;

    const { friend } = await resolveFriendAndAccessToken(
      c.env.DB,
      resolved.friendId,
      c.env.LINE_CHANNEL_ACCESS_TOKEN,
    );
    if (!friend) return c.json({ success: false, error: 'Friend not found' }, 404);

    const validation = await validateSupportCaseForSend(c, currentStaff(c), friend, body.value);
    if (!validation.ok) return validation.response;
    const safetyBlock = await getLineSendSafetyBlock(
      c.env.DB,
      friend.line_account_id ?? validation.supportLineAccountId,
    );
    if (safetyBlock) return lineSafetyBlockedResponse(c, safetyBlock);

    return c.json({
      success: true,
      data: {
        valid: true,
        messageType: normalized.payload.messageType,
        supportCaseId: validation.supportCase?.id ?? null,
        supportCaseStatus: validation.supportCase?.status ?? null,
      },
    });
  } catch (err) {
    console.error(`POST /api/chats/:id/send/validate error: ${chatRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// 顧客からの最新メッセージに、LINE公式側の既読だけを付ける。
// メッセージ送信やログ追加は行わない。
chats.post('/api/chats/:id/read', async (c) => {
  try {
    const chatId = parseChatPathId(c.req.param('id'));
    if (!chatId.ok) return c.json({ success: false, error: chatId.error }, 400);

    const resolved = await resolveExistingChatOrFriend(c.env.DB, chatId.value);
    if (!resolved) return c.json({ success: false, error: 'Chat not found' }, 404);
    const denied = await ensureChatFriendAccess(c, resolved.friendId);
    if (denied) return denied;

    const { friend, accessToken } = await resolveFriendAndAccessToken(
      c.env.DB,
      resolved.friendId,
      c.env.LINE_CHANNEL_ACCESS_TOKEN,
    );
    if (!friend) return c.json({ success: false, error: 'Friend not found' }, 404);

    const staff = currentStaff(c);
    const { LineClient } = await import('@line-crm/line-sdk');
    const lineClient = new LineClient(accessToken, {
      allowMutationsWhenDisabled: isLineCaptureOnly(c.env) && isLineManualSendEnabled(c.env),
    });
    const markAsRead = await markLatestIncomingAsRead(c.env.DB, lineClient, friend.id, true, staff.id);
    const nextStatus = markAsRead.marked ? 'in_progress' : resolved.chat?.status ?? null;

    if (markAsRead.marked && resolved.chat) {
      await updateChat(c.env.DB, resolved.chat.id, { status: 'in_progress', isLongTerm: false });
    }

    return c.json({
      success: true,
      data: {
        markAsRead,
        status: nextStatus,
        markedMessageId: markAsRead.messageId,
        markedAt: markAsRead.markedAt,
        updatedAt: jstNow(),
      } satisfies ChatMarkAsReadResponse,
    });
  } catch (err) {
    console.error(`POST /api/chats/:id/read error: ${chatRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// LINE公式側で送信取り消しした送信ログを、Harness側でも非表示にする。
// 公式側のオペレーター操作はWebhookで確実に届かないため、Harness上では明示操作で反映する。
chats.post('/api/chats/:id/messages/:messageId/deleted', async (c) => {
  try {
    const chatId = parseChatPathId(c.req.param('id'));
    if (!chatId.ok) return c.json({ success: false, error: chatId.error }, 400);
    const messageId = parseChatPathId(c.req.param('messageId'));
    if (!messageId.ok) return c.json({ success: false, error: messageId.error }, 400);

    const resolved = await resolveExistingChatOrFriend(c.env.DB, chatId.value);
    if (!resolved) return c.json({ success: false, error: 'Chat not found' }, 404);
    const denied = await ensureChatFriendAccess(c, resolved.friendId);
    if (denied) return denied;

    const message = await c.env.DB
      .prepare(
        `SELECT id, friend_id, direction, deleted_at
         FROM messages_log
         WHERE id = ?
           AND friend_id = ?
           AND (delivery_type IS NULL OR delivery_type != 'test')
         LIMIT 1`,
      )
      .bind(messageId.value, resolved.friendId)
      .first<{ id: string; friend_id: string; direction: string; deleted_at: string | null }>();

    if (!message) return c.json({ success: false, error: 'Message not found' }, 404);
    if (message.direction !== 'outgoing') {
      return c.json({ success: false, error: 'Only outgoing messages can be marked as deleted' }, 400);
    }

    const deletedAt = message.deleted_at ?? jstNow();
    if (!message.deleted_at) {
      await c.env.DB
        .prepare(
          `UPDATE messages_log
           SET deleted_at = ?,
               deleted_reason = 'manual_unsend_reflection'
           WHERE id = ?
             AND friend_id = ?
             AND deleted_at IS NULL`,
        )
        .bind(deletedAt, messageId.value, resolved.friendId)
        .run();
    }

    return c.json({
      success: true,
      data: {
        messageId: messageId.value,
        deletedAt,
      } satisfies ChatDeletedMessageResponse,
    });
  } catch (err) {
    console.error(`POST /api/chats/:id/messages/:messageId/deleted error: ${chatRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

chats.post('/api/chats/:id/scheduled-messages', async (c) => {
  try {
    if (!canUseManualLineSend(c.env)) {
      return c.json({ success: false, error: 'Manual LINE sending is disabled' }, 403);
    }
    const chatId = parseChatPathId(c.req.param('id'));
    if (!chatId.ok) return c.json({ success: false, error: chatId.error }, 400);
    const body = parseChatScheduleBody(await readJsonBody(c));
    if (!body.ok) return c.json({ success: false, error: body.error }, 400);

    const chat = await resolveOrCreateChat(c.env.DB, chatId.value);
    if (!chat) return c.json({ success: false, error: 'Chat not found' }, 404);
    const denied = await ensureChatFriendAccess(c, chat.friend_id);
    if (denied) return denied;

    const { friend } = await resolveFriendAndAccessToken(
      c.env.DB,
      chat.friend_id,
      c.env.LINE_CHANNEL_ACCESS_TOKEN,
    );
    if (!friend) return c.json({ success: false, error: 'Friend not found' }, 404);

    const staff = currentStaff(c);
    const validation = await validateSupportCaseForSend(c, staff, friend, body.value);
    if (!validation.ok) return validation.response;
    const lineAccountId = friend.line_account_id || validation.supportLineAccountId || null;
    const safetyBlock = await getLineSendSafetyBlock(c.env.DB, lineAccountId);
    if (safetyBlock) return lineSafetyBlockedResponse(c, safetyBlock);

    const id = crypto.randomUUID();
    const now = jstNow();
    await c.env.DB
      .prepare(
        `INSERT INTO scheduled_chat_messages
         (id, chat_id, friend_id, line_account_id, messages_json, support_case_id,
          scheduled_at, next_attempt_at, status, attempts, created_by, created_by_name,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        chat.id,
        friend.id,
        lineAccountId,
        JSON.stringify(body.value.messages),
        validation.supportCase?.id ?? null,
        body.value.scheduledAt,
        body.value.scheduledAt,
        staff.id,
        staff.name,
        now,
        now,
      )
      .run();
    await updateChat(c.env.DB, chat.id, { status: 'in_progress', isLongTerm: false });
    const created = await c.env.DB
      .prepare('SELECT * FROM scheduled_chat_messages WHERE id = ?')
      .bind(id)
      .first<ScheduledChatMessageRow>();
    if (!created) return c.json({ success: false, error: 'Scheduled message was not created' }, 500);
    return c.json({ success: true, data: serializeScheduledChatMessage(created) }, 201);
  } catch (err) {
    console.error(`POST /api/chats/:id/scheduled-messages error: ${chatRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

chats.delete('/api/chats/:id/scheduled-messages/:messageId', async (c) => {
  try {
    const chatId = parseChatPathId(c.req.param('id'));
    if (!chatId.ok) return c.json({ success: false, error: chatId.error }, 400);
    const messageId = parseChatPathId(c.req.param('messageId'));
    if (!messageId.ok) return c.json({ success: false, error: messageId.error }, 400);
    const chat = await resolveOrCreateChat(c.env.DB, chatId.value);
    if (!chat) return c.json({ success: false, error: 'Chat not found' }, 404);
    const denied = await ensureChatFriendAccess(c, chat.friend_id);
    if (denied) return denied;

    const now = jstNow();
    const result = await c.env.DB
      .prepare(
        `UPDATE scheduled_chat_messages
         SET status = 'cancelled', cancelled_at = ?, updated_at = ?
         WHERE id = ? AND chat_id = ? AND status IN ('pending', 'failed', 'failed_permanent')`,
      )
      .bind(now, now, messageId.value, chat.id)
      .run();
    if (Number(result.meta?.changes ?? 0) === 0) {
      return c.json({ success: false, error: '取消できる予約が見つかりません' }, 409);
    }
    return c.json({ success: true, data: { id: messageId.value, status: 'cancelled', cancelledAt: now } });
  } catch (err) {
    console.error(`DELETE /api/chats/:id/scheduled-messages/:messageId error: ${chatRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

chats.post('/api/chats/:id/scheduled-messages/:messageId/retry', async (c) => {
  try {
    if (!canUseManualLineSend(c.env)) {
      return c.json({ success: false, error: 'Manual LINE sending is disabled' }, 403);
    }
    const chatId = parseChatPathId(c.req.param('id'));
    if (!chatId.ok) return c.json({ success: false, error: chatId.error }, 400);
    const messageId = parseChatPathId(c.req.param('messageId'));
    if (!messageId.ok) return c.json({ success: false, error: messageId.error }, 400);
    const chat = await resolveOrCreateChat(c.env.DB, chatId.value);
    if (!chat) return c.json({ success: false, error: 'Chat not found' }, 404);
    const denied = await ensureChatFriendAccess(c, chat.friend_id);
    if (denied) return denied;

    const now = jstNow();
    const nextAttemptAt = new Date().toISOString();
    const result = await c.env.DB
      .prepare(
        `UPDATE scheduled_chat_messages
         SET status = 'pending', attempts = 0, next_attempt_at = ?, last_error = NULL, updated_at = ?
         WHERE id = ? AND chat_id = ? AND status IN ('failed', 'failed_permanent')`,
      )
      .bind(nextAttemptAt, now, messageId.value, chat.id)
      .run();
    if (Number(result.meta?.changes ?? 0) === 0) {
      return c.json({ success: false, error: '再試行できる予約が見つかりません' }, 409);
    }
    return c.json({ success: true, data: { id: messageId.value, status: 'pending', nextAttemptAt } });
  } catch (err) {
    console.error(`POST /api/chats/:id/scheduled-messages/:messageId/retry error: ${chatRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// オペレーターからメッセージ送信
chats.post('/api/chats/:id/send', async (c) => {
  try {
    if (!canUseManualLineSend(c.env)) {
      return c.json({ success: false, error: 'Manual LINE sending is disabled' }, 403);
    }
    const chatId = parseChatPathId(c.req.param('id'));
    if (!chatId.ok) return c.json({ success: false, error: chatId.error }, 400);
    const body = parseChatSendBody(await readJsonBody(c));
    if (!body.ok) return c.json({ success: false, error: body.error }, 400);
    const normalized = normalizeChatSendPayload(body.value);
    if (!normalized.ok) return c.json({ success: false, error: normalized.error }, 400);
    const idempotencyKey = parseChatIdempotencyKey(c.req.header('Idempotency-Key'));
    if (!idempotencyKey.ok) return c.json({ success: false, error: idempotencyKey.error }, 400);

    const chat = await resolveOrCreateChat(c.env.DB, chatId.value);
    if (!chat) return c.json({ success: false, error: 'Chat not found' }, 404);
    const denied = await ensureChatFriendAccess(c, chat.friend_id);
    if (denied) return denied;

    const { friend, accessToken } = await resolveFriendAndAccessToken(
      c.env.DB,
      chat.friend_id,
      c.env.LINE_CHANNEL_ACCESS_TOKEN,
    );
    if (!friend) return c.json({ success: false, error: 'Friend not found' }, 404);

    const staff = currentStaff(c);
    const validation = await validateSupportCaseForSend(c, staff, friend, body.value);
    if (!validation.ok) return validation.response;
    const { supportCase, supportLineAccountId } = validation;
    const safetyBlock = await getLineSendSafetyBlock(c.env.DB, friend.line_account_id ?? supportLineAccountId);
    if (safetyBlock) return lineSafetyBlockedResponse(c, safetyBlock);

    // LINE APIでメッセージ送信
    const { LineClient } = await import('@line-crm/line-sdk');
    const lineClient = new LineClient(accessToken, {
      allowMutationsWhenDisabled: isLineCaptureOnly(c.env) && isLineManualSendEnabled(c.env),
    });
    const { messageType, content } = normalized.payload;
    const quoteTarget = await resolveQuoteTargetForSend(
      c.env.DB,
      friend.id,
      body.value.quoteMessageId,
      messageType,
    );
    if (!quoteTarget.ok) return c.json({ success: false, error: quoteTarget.error }, 400);
    let lineSendResult: unknown = null;

    try {
      if (messageType === 'text') {
        if (idempotencyKey.value) {
          lineSendResult = await lineClient.pushTextMessage(
            friend.line_user_id,
            content,
            quoteTarget.value?.quoteToken,
            idempotencyKey.value,
          );
        } else {
          lineSendResult = quoteTarget.value
            ? await lineClient.pushTextMessage(friend.line_user_id, content, quoteTarget.value.quoteToken)
            : await lineClient.pushTextMessage(friend.line_user_id, content);
        }
      } else if (messageType === 'flex') {
        const contents = normalized.payload.flexContents;
        lineSendResult = idempotencyKey.value
          ? await lineClient.pushFlexMessage(friend.line_user_id, extractFlexAltText(contents), contents, idempotencyKey.value)
          : await lineClient.pushFlexMessage(friend.line_user_id, extractFlexAltText(contents), contents);
      } else if (messageType === 'image') {
        const parsed = normalized.payload.image;
        lineSendResult = idempotencyKey.value
          ? await lineClient.pushImageMessage(
              friend.line_user_id,
              parsed.originalContentUrl,
              parsed.previewImageUrl,
              idempotencyKey.value,
            )
          : await lineClient.pushImageMessage(
              friend.line_user_id,
              parsed.originalContentUrl,
              parsed.previewImageUrl,
            );
      }
    } catch (err) {
      if (idempotencyKey.value && lineApiErrorStatus(err) === 409) {
        lineSendResult = null;
      } else {
        console.error(`manual LINE send failed: ${chatRouteErrorKind(err)}`);
        return c.json({ success: false, error: manualLineSendFailureMessage(err) }, 502);
      }
    }

    const markAsRead = await markLatestIncomingAsRead(
      c.env.DB,
      lineClient,
      friend.id,
      body.value.markAsRead,
      staff.id,
    );

    // メッセージログに記録
    const logId = idempotencyKey.value ?? crypto.randomUUID();
    const now = jstNow();
    const lineMessageId = extractLineSentMessageId(lineSendResult);
    const lineQuoteToken = extractLineSentQuoteToken(lineSendResult);
    if (lineQuoteToken || quoteTarget.value) {
      await c.env.DB
        .prepare(
        `INSERT OR IGNORE INTO messages_log (id, friend_id, direction, message_type, content, source, line_account_id, line_message_id, quote_token, quoted_message_id, sent_by_staff_id, sent_by_staff_name, created_at)
           VALUES (?, ?, 'outgoing', ?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(logId, friend.id, messageType, content, friend.line_account_id ?? null, lineMessageId, lineQuoteToken, quoteTarget.value?.id ?? null, staff.id, staff.name, now)
        .run();
    } else {
      await c.env.DB
        .prepare(
          `INSERT OR IGNORE INTO messages_log (id, friend_id, direction, message_type, content, source, line_account_id, line_message_id, sent_by_staff_id, sent_by_staff_name, created_at)
           VALUES (?, ?, 'outgoing', ?, ?, 'manual', ?, ?, ?, ?, ?)`,
        )
        .bind(logId, friend.id, messageType, content, friend.line_account_id ?? null, lineMessageId, staff.id, staff.name, now)
        .run();
    }

    let supportCaseResult: {
      id: string;
      previousStatus: string;
      nextStatus: 'customer_reply' | null;
      statusUpdated: boolean;
    } | null = null;

    if (supportCase) {
      try {
        const statusUpdated = await markSupportCaseCustomerReply(c.env.DB, supportCase, staff, supportLineAccountId, now);
        await addSupportReplyEvent(c.env.DB, supportCase, staff, {
          chatId: chat.id,
          friendId: friend.id,
          lineAccountId: supportLineAccountId,
          messageId: logId,
          messageType,
          content,
          previousStatus: supportCase.status,
          nextStatus: statusUpdated ? 'customer_reply' : null,
          statusUpdateApplied: statusUpdated,
          createdAt: now,
        });
        supportCaseResult = {
          id: supportCase.id,
          previousStatus: supportCase.status,
          nextStatus: statusUpdated ? 'customer_reply' : null,
          statusUpdated,
        };
      } catch (err) {
        console.error(`support reply bookkeeping failed after LINE send: ${chatRouteErrorKind(err)}`);
        supportCaseResult = {
          id: supportCase.id,
          previousStatus: supportCase.status,
          nextStatus: null,
          statusUpdated: false,
        };
      }
    }

    // チャットの最終メッセージ日時を更新（chat.id を直接使う — friend_id で呼ばれても resolveOrCreateChat 済み）
    await updateChat(c.env.DB, chat.id, { status: 'in_progress', isLongTerm: false, lastMessageAt: now });

    return c.json({
      success: true,
      data: {
        sent: true,
        messageId: logId,
        sentByStaffId: staff.id,
        sentByStaffName: staff.name,
        quotedMessageId: quoteTarget.value?.id ?? null,
        supportCase: supportCaseResult,
        markAsRead,
      },
    });
  } catch (err) {
    console.error(`POST /api/chats/:id/send error: ${chatRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { chats };

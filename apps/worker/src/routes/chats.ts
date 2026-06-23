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
  canAccessSupportFriend,
  supportCaseVisibilitySql,
  supportFriendVisibilitySql,
  type SupportAccessStaff,
} from '../services/support-access.js';
import { requireRole } from '../middleware/role-guard.js';
import {
  canUseManualLineSend,
  isLineCaptureOnly,
  isLineManualSendEnabled,
} from '../services/line-capture-only.js';

const chats = new Hono<Env>();

const OPERATOR_ID_MAX_LENGTH = 128;
const OPERATOR_NAME_MAX_LENGTH = 120;
const OPERATOR_EMAIL_MAX_LENGTH = 254;
const OPERATOR_ROLE_MAX_LENGTH = 64;
const CHAT_ID_MAX_LENGTH = 128;
const CHAT_CURSOR_MAX_LENGTH = 64;
const CHAT_NOTES_MAX_LENGTH = 4096;
const VISIBLE_ASCII_PATTERN = /^[!-~]+$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CHAT_STATUSES = new Set(['unread', 'in_progress', 'resolved']);

function currentStaff(c: { get: (key: 'staff') => SupportAccessStaff | undefined }): SupportAccessStaff {
  return c.get('staff') ?? { id: 'system', name: 'system', role: 'staff' };
}

async function ensureChatFriendAccess(c: Context<Env>, friendId: string): Promise<Response | null> {
  if (await canAccessSupportFriend(c.env.DB, currentStaff(c), friendId)) return null;
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
  notes: string | null;
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
};

type SupportCaseForChat = {
  id: string;
  title: string;
  status: string;
};

type ChatSendBody = {
  messageType?: string;
  content: string;
  supportCaseId?: string;
  lineAccountId?: string | null;
  markAsRead?: boolean;
};
type ExternalOutgoingBody = {
  content: string;
};

type OperatorCreateBody = { name: string; email: string; role?: string };
type OperatorUpdateBody = Partial<{ name: string; email: string; role: string; isActive: boolean }>;
type ChatStatus = 'unread' | 'in_progress' | 'resolved';
type ChatListQuery = {
  status?: ChatStatus;
  operatorId?: string;
  lineAccountId?: string;
  unansweredOnly: boolean;
};
type ChatCreateInput = { friendId: string; operatorId?: string; lineAccountId?: string };
type ChatUpdateInput = Partial<{ operatorId: string | null; status: ChatStatus; notes: string | null }>;
type ChatDetailQuery = { messageLimit: number; beforeCreatedAt?: string; beforeId?: string };
type ValueResult<T> = { ok: true; value: T } | { ok: false; error: string };
type ChatRouteError = Error & { status?: number };

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

type MarkAsReadResult = {
  requested: boolean;
  marked: boolean;
  reason: 'not_requested' | 'no_token' | 'line_error' | null;
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
  return {
    ok: true,
    value: {
      status: status.value,
      operatorId: operatorId.value,
      lineAccountId: lineAccountId.value,
      unansweredOnly: unansweredOnly.value,
    },
  };
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
  return {
    ok: true,
    value: {
      messageType: raw.messageType,
      content: raw.content,
      supportCaseId: supportCaseId.value,
      lineAccountId: lineAccountId.value ?? undefined,
      markAsRead: raw.markAsRead === true,
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
      `INSERT INTO support_case_events
       (id, case_id, event_type, actor_id, actor_name, body, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
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
      `SELECT MAX(created_at) AS last FROM messages_log WHERE friend_id = ? AND (delivery_type IS NULL OR delivery_type != 'test')`,
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

async function getLatestMarkAsReadToken(
  db: D1Database,
  friendId: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT mark_as_read_token
       FROM messages_log
       WHERE friend_id = ?
         AND direction = 'incoming'
         AND mark_as_read_token IS NOT NULL
         AND mark_as_read_token != ''
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
    )
    .bind(friendId)
    .first<{ mark_as_read_token: string | null }>();
  return row?.mark_as_read_token ?? null;
}

async function markLatestIncomingAsRead(
  db: D1Database,
  lineClient: { markMessagesAsRead(markAsReadToken: string): Promise<unknown> },
  friendId: string,
  requested: boolean | undefined,
): Promise<MarkAsReadResult> {
  const result = initialMarkAsReadResult(requested === true);
  if (!result.requested) return result;

  const token = await getLatestMarkAsReadToken(db, friendId);
  if (!token) return result;

  try {
    await lineClient.markMessagesAsRead(token);
    return { requested: true, marked: true, reason: null };
  } catch (err) {
    console.error(`mark-as-read failed: ${chatRouteErrorKind(err)}`);
    return { requested: true, marked: false, reason: 'line_error' };
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

chats.get('/api/chats', async (c) => {
  try {
    const parsed = parseChatListQuery(new URL(c.req.url).searchParams);
    if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);
    const { status, operatorId, lineAccountId, unansweredOnly } = parsed.value;

    let unansweredIds: Set<string> | null = null;
    if (unansweredOnly) {
      const { getUnansweredFriendIds } = await import('../services/unanswered-inbox.js');
      unansweredIds = await getUnansweredFriendIds(c.env.DB, currentStaff(c));
      // 空 Set のとき = 未対応ゼロ。早期 return で空配列を返す。
      if (unansweredIds.size === 0) {
        return c.json({ success: true, data: [] });
      }
    }

    // List everyone who has any message history (incoming or outgoing — push/broadcast/scenario included)
    // PLUS any chats row that exists even before any messages_log entry is written.
    // Source = messages_log ∪ chats.friend_id; chats は status/operator/notes 用に LEFT JOIN で最新1件だけ採用。
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
          AND ${accountFilterSql}
        GROUP BY friend_id
        UNION ALL
        SELECT friend_id, last_message_at
        FROM chats
        WHERE ${accountFilterSql}
      ),
      deduped AS (
        SELECT friend_id, MAX(last_message_at) AS last_message_at
        FROM activity
        GROUP BY friend_id
      ),
      -- preview は **最新の incoming (ユーザー発)** を優先する。auto_reply / scenario 等の
      -- outbound が直後に書き込まれて preview を上書きすると「ユーザーが何と言ったか」が
      -- 一覧から見えなくなる (operator triage の主目的が損なわれる)。
      -- incoming が無い (broadcast push など outbound only) chat は最新 outbound にフォールバック。
      -- text 以外 (flex/image/sticker 等) は content を NULL にして payload size を抑える
      -- (フロントは type で 📋 Flex / 📷 画像 等のラベルを出すので content は不要)。
      -- preview は **常に最新メッセージ** を表示する。postback (rich menu tap) も含む。
      -- preview text と displayed time を揃えるための単純化 (deprioritize すると
      -- 「最新は postback だが preview は古い text」の time mismatch が起きるため)。
      -- 注: postback.data が opaque な JSON token だと一覧で人間には読めない値が出るが、
      -- それは admin が rich menu の postback.data を人間向け文言にすべき config 問題。
      -- (LINE 仕様: postback.displayText は admin が設定可能、それを data に揃えるのが推奨)
      ranked_in AS (
        SELECT friend_id,
          CASE WHEN message_type = 'text' THEN SUBSTR(content, 1, 200) ELSE NULL END AS content,
          direction, message_type, created_at,
          ROW_NUMBER() OVER (PARTITION BY friend_id ORDER BY created_at DESC) AS rn
        FROM messages_log
        WHERE direction = 'incoming'
          AND (delivery_type IS NULL OR delivery_type != 'test')
          AND ${accountFilterSql}
      ),
      ranked_any AS (
        SELECT friend_id,
          CASE WHEN message_type = 'text' THEN SUBSTR(content, 1, 200) ELSE NULL END AS content,
          direction, message_type, created_at,
          ROW_NUMBER() OVER (PARTITION BY friend_id ORDER BY created_at DESC) AS rn
        FROM messages_log
        WHERE (delivery_type IS NULL OR delivery_type != 'test')
          AND ${accountFilterSql}
      ),
      -- ra (any direction の最新) を master にして、ri (incoming の最新) を LEFT JOIN。
      -- COALESCE で ri 優先 → incoming があればそれ、無ければ outbound にフォールバック。
      -- created_at も preview の元メッセージに合わせて返す (一覧の時刻と preview text が
      -- 別メッセージを指して mismatch する事故を防ぐ)。
      recent_msg AS (
        SELECT
          ra.friend_id,
          COALESCE(ri.content, ra.content) AS content,
          COALESCE(ri.direction, ra.direction) AS direction,
          COALESCE(ri.message_type, ra.message_type) AS message_type,
          COALESCE(ri.created_at, ra.created_at) AS preview_at
        FROM (SELECT * FROM ranked_any WHERE rn = 1) ra
        LEFT JOIN (SELECT * FROM ranked_in WHERE rn = 1) ri ON ra.friend_id = ri.friend_id
      )
      SELECT
        f.id AS id,
        f.id AS friend_id,
        f.display_name,
        f.picture_url,
        f.line_user_id,
        f.line_account_id,
        c.operator_id,
        COALESCE(c.status, 'resolved') AS status,
        c.notes,
        -- last_message_at は preview メッセージの時刻に揃える (一覧 row の時刻表示と preview が
        -- 別メッセージを指す mismatch を防ぐ)。preview が無い (chats 行のみ存在) ケースは
        -- d.last_message_at にフォールバック。
        COALESCE(rm.preview_at, d.last_message_at) AS last_message_at,
        rm.content AS last_message_content,
        rm.direction AS last_message_direction,
        rm.message_type AS last_message_type,
        COALESCE(c.created_at, d.last_message_at) AS created_at,
        COALESCE(c.updated_at, d.last_message_at) AS updated_at
      FROM deduped d
      INNER JOIN friends f ON f.id = d.friend_id
      LEFT JOIN chats c ON c.id = (
        SELECT id FROM chats WHERE friend_id = f.id ORDER BY created_at DESC LIMIT 1
      )
      LEFT JOIN recent_msg rm ON rm.friend_id = f.id
    `;
    // accountFilterSql に '?' が複数 (4 箇所) あるので、bindings は事前に積んでおく。
    const ctePrebindings: unknown[] = lineAccountId
      ? [lineAccountId, lineAccountId, lineAccountId, lineAccountId]
      : [];
    const conditions: string[] = [];
    const bindings: unknown[] = [];

    if (status) {
      conditions.push(`COALESCE(c.status, 'resolved') = ?`);
      bindings.push(status);
    }
    if (operatorId) {
      conditions.push('c.operator_id = ?');
      bindings.push(operatorId);
    }
    if (lineAccountId) {
      conditions.push('f.line_account_id = ?');
      bindings.push(lineAccountId);
    }
    const visibility = supportFriendVisibilitySql(currentStaff(c), 'f.id');
    if (visibility.sql) {
      conditions.push(visibility.sql);
      bindings.push(...visibility.binds);
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY d.last_message_at DESC';

    // CTE 内 placeholder (4 個) → 外側 WHERE placeholder の順に bind する
    const allBindings = [...ctePrebindings, ...bindings];
    const stmt = allBindings.length > 0
      ? c.env.DB.prepare(sql).bind(...allBindings)
      : c.env.DB.prepare(sql);
    const result = await stmt.all();

    let data = result.results.map((ch: Record<string, unknown>) => ({
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
      createdAt: ch.created_at,
      updatedAt: ch.updated_at,
    }));

    if (unansweredIds) {
      data = data.filter((row) => unansweredIds!.has(row.id));
    }

    return c.json({ success: true, data });
  } catch (err) {
    console.error(`GET /api/chats error: ${chatRouteErrorKind(err)}`);
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
        .first<{ id: string; friend_id: string; operator_id: string | null; status: string; notes: string | null; last_message_at: string | null; created_at: string; updated_at: string }>();
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
    const status = chatRow?.status ?? 'resolved';
    const notes = chatRow?.notes ?? null;
    const lastMessageAt = chatRow?.last_message_at ?? null;
    const createdAt = chatRow?.created_at ?? null;

    const friend = await c.env.DB
      .prepare(`SELECT display_name, picture_url, line_user_id FROM friends WHERE id = ?`)
      .bind(resolvedFriendId)
      .first<{ display_name: string | null; picture_url: string | null; line_user_id: string }>();

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
        `SELECT id, friend_id, direction, message_type, content, source, created_at
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
        lastMessageAt,
        createdAt,
        hasMoreMessages,
        nextMessagesBefore: hasMoreMessages && oldestMessage
          ? { createdAt: oldestMessage.created_at, id: oldestMessage.id }
          : null,
        messages: pageMessages.map((m) => ({
          id: m.id,
          direction: m.direction,
          messageType: m.message_type,
          content: m.content,
          source: m.source,
          createdAt: m.created_at,
        })),
      },
    });
  } catch (err) {
    console.error(`GET /api/chats/:id error: ${chatRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
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

    await updateChat(c.env.DB, resolved.id, parsed.value);
    const updated = await getChatById(c.env.DB, resolved.id);
    if (!updated) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({
      success: true,
      // 公開 ID は friend_id に統一
      data: { id: updated.friend_id, friendId: updated.friend_id, operatorId: updated.operator_id, status: updated.status, notes: updated.notes },
    });
  } catch (err) {
    console.error(`PUT /api/chats/:id error: ${chatRouteErrorKind(err)}`);
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
    await updateChat(c.env.DB, chat.id, { status: 'in_progress', lastMessageAt: now });

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

    // LINE APIでメッセージ送信
    const { LineClient } = await import('@line-crm/line-sdk');
    const lineClient = new LineClient(accessToken, {
      allowMutationsWhenDisabled: isLineCaptureOnly(c.env) && isLineManualSendEnabled(c.env),
    });
    const { messageType, content } = normalized.payload;

    try {
      if (messageType === 'text') {
        await lineClient.pushTextMessage(friend.line_user_id, content);
      } else if (messageType === 'flex') {
        const contents = normalized.payload.flexContents;
        await lineClient.pushFlexMessage(friend.line_user_id, extractFlexAltText(contents), contents);
      } else if (messageType === 'image') {
        const parsed = normalized.payload.image;
        await lineClient.pushImageMessage(
          friend.line_user_id,
          parsed.originalContentUrl,
          parsed.previewImageUrl,
        );
      }
    } catch (err) {
      console.error(`manual LINE send failed: ${chatRouteErrorKind(err)}`);
      return c.json({ success: false, error: manualLineSendFailureMessage(err) }, 502);
    }

    const markAsRead = await markLatestIncomingAsRead(
      c.env.DB,
      lineClient,
      friend.id,
      body.value.markAsRead,
    );

    // メッセージログに記録
    const logId = crypto.randomUUID();
    const now = jstNow();
    await c.env.DB
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, source, line_account_id, created_at)
         VALUES (?, ?, 'outgoing', ?, ?, 'manual', ?, ?)`,
      )
      .bind(logId, friend.id, messageType, content, friend.line_account_id ?? null, now)
      .run();

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
    await updateChat(c.env.DB, chat.id, { status: 'in_progress', lastMessageAt: now });

    return c.json({
      success: true,
      data: {
        sent: true,
        messageId: logId,
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

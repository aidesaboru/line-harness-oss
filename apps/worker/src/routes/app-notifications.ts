import { Hono } from 'hono';
import { jstNow, toJstString } from '@line-crm/db';
import type { Env } from '../index.js';
import {
  supportCaseVisibilitySql,
  supportFriendVisibilitySql,
  supportStaffAssignmentName,
  type SupportAccessStaff,
} from '../services/support-access.js';
import {
  isWebPushConfigured,
  sendWebPush,
  type WebPushPayload,
  type WebPushSubscriptionRecord,
} from '../services/web-push.js';
import { summarizeInternalReactions } from '../services/internal-message-reactions.js';
import { mentionStaffIdsForMessages } from '../services/internal-message-mentions.js';

const appNotifications = new Hono<Env>();

const NOTIFICATION_LIMIT = 12;
const INTERNAL_CHAT_FEED_DEFAULT_LIMIT = 50;
const INTERNAL_CHAT_FEED_MAX_LIMIT = 100;
const CURSOR_MAX_LENGTH = 64;
const INTERNAL_CHAT_CURSOR_MAX_LENGTH = 512;
const INTERNAL_CHAT_SEARCH_MAX_LENGTH = 256;
const ACCOUNT_ID_MAX_LENGTH = 128;
const WEB_PUSH_ENDPOINT_MAX_LENGTH = 2048;
const WEB_PUSH_KEY_MAX_LENGTH = 256;
const WEB_PUSH_USER_AGENT_MAX_LENGTH = 512;
const WEB_PUSH_LOOKBACK_MINUTES = 60;
const VISIBLE_ASCII_PATTERN = /^[!-~]+$/;

type AppNotificationKind =
  | 'urgent_case'
  | 'secondary_assigned'
  | 'secondary_answered'
  | 'support_mention'
  | 'chat_mention';

type AppNotificationItem = {
  id: string;
  kind: AppNotificationKind;
  title: string;
  body: string;
  href: string;
  createdAt: string;
};

type AppNotificationInboxRow = {
  id: string;
  notification_key: string;
  kind: AppNotificationKind;
  title: string;
  body: string;
  href: string;
  source_created_at: string;
  read_at: string | null;
  snoozed_until: string | null;
};

type ValueResult<T> = { ok: true; value: T } | { ok: false; error: string };

type EscalationAssignedRow = {
  id: string;
  case_id: string;
  case_title: string | null;
  assignee: string;
  question: string;
  created_at: string;
};

type EscalationAnsweredRow = {
  id: string;
  case_id: string;
  case_title: string | null;
  assignee: string;
  answer: string;
  updated_at: string;
};

type SupportMentionRow = {
  id: string;
  case_id: string;
  case_title: string | null;
  body: string;
  created_by_name: string | null;
  created_at: string;
};

type ChatMentionRow = {
  id: string;
  friend_id: string;
  friend_name: string | null;
  body: string;
  created_by_name: string | null;
  created_at: string;
};

type SupportInternalChatFeedRow = {
  id: string;
  case_id: string;
  case_title: string | null;
  customer_name: string | null;
  parent_id: string | null;
  body: string;
  mentions: string;
  reactions?: string | null;
  created_by_name: string | null;
  created_by: string | null;
  created_at: string;
};

type ChatInternalChatFeedRow = {
  id: string;
  friend_id: string;
  friend_name: string | null;
  ticket_title: string | null;
  parent_id: string | null;
  body: string;
  mentions: string;
  reactions?: string | null;
  created_by_name: string | null;
  created_by: string | null;
  created_at: string;
};

type InternalConversationReadRow = {
  conversation_id: string;
  last_read_at: string;
};

type InternalChatCursor = {
  createdAt: string;
  id: string;
};

type UrgentCaseRow = {
  id: string;
  title: string;
  friend_name: string | null;
  updated_at: string;
};

type WebPushSubscriptionBody = {
  endpoint?: unknown;
  keys?: {
    p256dh?: unknown;
    auth?: unknown;
  };
  userAgent?: unknown;
};

type WebPushSettingsBody = {
  endpoint?: unknown;
  notifyUrgent?: unknown;
  notifySecondary?: unknown;
  notifyMentions?: unknown;
};

type WebPushSubscriptionRow = WebPushSubscriptionRecord & {
  staff_id: string;
  staff_name: string;
  staff_role: 'owner' | 'admin' | 'staff' | 'secondary';
  notify_urgent: number;
  notify_secondary: number;
  notify_mentions: number;
};

type WebPushProcessOptions = {
  now?: Date;
  lookbackMinutes?: number;
  lineAccountId?: string;
};

function routeErrorKind(err: unknown): string {
  if (err instanceof TypeError) return 'network_error';
  if (err instanceof Error) return err.name || 'error';
  return typeof err;
}

function currentStaff(c: { get: (key: 'staff') => SupportAccessStaff | undefined }): SupportAccessStaff {
  return c.get('staff') ?? { id: 'system', name: 'system', role: 'staff' };
}

function parseCursor(raw: unknown): ValueResult<string | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== 'string') return { ok: false, error: 'after must be a string' };
  const value = raw.trim();
  if (!value) return { ok: true, value: undefined };
  if (value.length > CURSOR_MAX_LENGTH || !value.includes('T')) return { ok: false, error: 'after is invalid' };
  return { ok: true, value };
}

function parseAccountId(raw: unknown): ValueResult<string | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== 'string') return { ok: false, error: 'lineAccountId must be a string' };
  const value = raw.trim();
  if (!value) return { ok: true, value: undefined };
  if (value.length > ACCOUNT_ID_MAX_LENGTH || !VISIBLE_ASCII_PATTERN.test(value)) {
    return { ok: false, error: 'lineAccountId is invalid' };
  }
  return { ok: true, value };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function mentionLikePattern(staff: SupportAccessStaff): string | null {
  const name = staff.name.trim();
  if (!name) return null;
  return `%"${escapeLike(name)}"%`;
}

function compact(text: string | null | undefined, fallback: string): string {
  const value = (text ?? '').replace(/\s+/g, ' ').trim();
  return value ? value.slice(0, 120) : fallback;
}

function notificationInboxId(staffId: string, notificationKey: string): string {
  return `${staffId}:${notificationKey}`;
}

async function persistNotificationInbox(
  db: D1Database,
  staff: SupportAccessStaff,
  lineAccountId: string | undefined,
  items: AppNotificationItem[],
): Promise<void> {
  if (items.length === 0) return;
  const now = jstNow();
  await db.batch(items.map((item) => (
    db.prepare(
      `INSERT INTO app_notification_inbox (
         id, notification_key, recipient_staff_id, line_account_id,
         kind, title, body, href, source_created_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(recipient_staff_id, notification_key) DO UPDATE SET
         line_account_id = COALESCE(excluded.line_account_id, app_notification_inbox.line_account_id),
         kind = excluded.kind,
         title = excluded.title,
         body = excluded.body,
         href = excluded.href,
         source_created_at = excluded.source_created_at,
         updated_at = excluded.updated_at`,
    ).bind(
      notificationInboxId(staff.id, item.id),
      item.id,
      staff.id,
      lineAccountId ?? null,
      item.kind,
      item.title,
      item.body,
      item.href,
      item.createdAt,
      now,
      now,
    )
  )));
}

function serializeNotificationInboxRow(row: AppNotificationInboxRow) {
  return {
    id: row.id,
    notificationKey: row.notification_key,
    kind: row.kind,
    title: row.title,
    body: row.body,
    href: row.href,
    createdAt: row.source_created_at,
    readAt: row.read_at,
    snoozedUntil: row.snoozed_until,
  };
}

function parseLimit(raw: unknown): ValueResult<number> {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, value: INTERNAL_CHAT_FEED_DEFAULT_LIMIT };
  }
  if (typeof raw !== 'string') return { ok: false, error: 'limit must be a string' };
  const value = Number(raw);
  if (!Number.isFinite(value)) return { ok: false, error: 'limit is invalid' };
  return {
    ok: true,
    value: Math.max(1, Math.min(INTERNAL_CHAT_FEED_MAX_LIMIT, Math.floor(value))),
  };
}

function parseInternalChatCursor(raw: unknown): ValueResult<InternalChatCursor | undefined> {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: undefined };
  if (typeof raw !== 'string') return { ok: false, error: 'before must be a string' };
  const value = raw.trim();
  const separator = value.lastIndexOf('|');
  if (
    !value
    || value.length > INTERNAL_CHAT_CURSOR_MAX_LENGTH
    || separator <= 0
    || separator === value.length - 1
  ) {
    return { ok: false, error: 'before is invalid' };
  }
  const createdAt = value.slice(0, separator);
  const id = value.slice(separator + 1);
  if (!createdAt.includes('T') || !id.includes(':')) {
    return { ok: false, error: 'before is invalid' };
  }
  return { ok: true, value: { createdAt, id } };
}

function parseInternalChatSearch(raw: unknown): ValueResult<string | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== 'string') return { ok: false, error: 'q must be a string' };
  const value = raw.trim();
  if (!value) return { ok: true, value: undefined };
  if (value.length > INTERNAL_CHAT_SEARCH_MAX_LENGTH) {
    return { ok: false, error: 'q is too long' };
  }
  return { ok: true, value };
}

function internalConversationId(source: 'support' | 'chat', sourceId: string): string {
  return `${source}:${sourceId}`;
}

function internalChatCursorValue(item: { createdAt: string; id: string }): string {
  return `${item.createdAt}|${item.id}`;
}

async function loadInternalConversationReads(
  db: D1Database,
  staffId: string,
  lineAccountId?: string,
): Promise<Map<string, string>> {
  const conditions = ['icr.staff_id = ?'];
  const binds: unknown[] = [staffId];
  if (lineAccountId) {
    conditions.push('ic.line_account_id = ?');
    binds.push(lineAccountId);
  }
  const rows = await db
    .prepare(
      `SELECT icr.conversation_id, icr.last_read_at
       FROM internal_conversation_reads icr
       INNER JOIN internal_conversations ic ON ic.id = icr.conversation_id
       WHERE ${conditions.join(' AND ')}`,
    )
    .bind(...binds)
    .all<InternalConversationReadRow>();
  return new Map(rows.results.map((row) => [row.conversation_id, row.last_read_at]));
}

function parseStoredMentions(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function fallbackContextTitle(prefix: string, id: string): string {
  const shortId = id.length > 8 ? id.slice(0, 8) : id;
  return `${prefix} ${shortId}`;
}

function webPushRouteErrorKind(err: unknown): string {
  if (err instanceof TypeError) return 'network_error';
  if (err instanceof Error) return err.name || err.message || 'error';
  return typeof err;
}

async function sha256Base64Url(value: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const bytes = new Uint8Array(hash);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function subscriptionId(endpoint: string): Promise<string> {
  return `wps_${await sha256Base64Url(endpoint)}`;
}

function parseVisibleText(raw: unknown, label: string, maxLength: number): ValueResult<string> {
  if (typeof raw !== 'string') return { ok: false, error: `${label} must be a string` };
  const value = raw.trim();
  if (!value) return { ok: false, error: `${label} is required` };
  if (value.length > maxLength) return { ok: false, error: `${label} is too long` };
  if (!VISIBLE_ASCII_PATTERN.test(value)) return { ok: false, error: `${label} is invalid` };
  return { ok: true, value };
}

function parseOptionalUserAgent(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value ? value.slice(0, WEB_PUSH_USER_AGENT_MAX_LENGTH) : null;
}

function parseOptionalBoolean(raw: unknown, label: string): ValueResult<boolean | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw === 'boolean') return { ok: true, value: raw };
  return { ok: false, error: `${label} must be a boolean` };
}

function publicWebPushSettings(row: Pick<WebPushSubscriptionRow, 'notify_urgent' | 'notify_secondary' | 'notify_mentions'>): {
  notifyUrgent: boolean;
  notifySecondary: boolean;
  notifyMentions: boolean;
} {
  return {
    notifyUrgent: row.notify_urgent === 1,
    notifySecondary: row.notify_secondary === 1,
    notifyMentions: row.notify_mentions === 1,
  };
}

function parseWebPushSubscription(raw: WebPushSubscriptionBody): ValueResult<{
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
}> {
  const endpoint = parseVisibleText(raw.endpoint, 'endpoint', WEB_PUSH_ENDPOINT_MAX_LENGTH);
  if (!endpoint.ok) return endpoint;
  try {
    const url = new URL(endpoint.value);
    if (url.protocol !== 'https:') return { ok: false, error: 'endpoint must be https' };
  } catch {
    return { ok: false, error: 'endpoint is invalid' };
  }
  const p256dh = parseVisibleText(raw.keys?.p256dh, 'p256dh', WEB_PUSH_KEY_MAX_LENGTH);
  if (!p256dh.ok) return p256dh;
  const auth = parseVisibleText(raw.keys?.auth, 'auth', WEB_PUSH_KEY_MAX_LENGTH);
  if (!auth.ok) return auth;
  return {
    ok: true,
    value: {
      endpoint: endpoint.value,
      p256dh: p256dh.value,
      auth: auth.value,
      userAgent: parseOptionalUserAgent(raw.userAgent),
    },
  };
}

function notificationMatchesSubscription(item: AppNotificationItem, subscription: WebPushSubscriptionRow): boolean {
  if (item.kind === 'urgent_case') return subscription.notify_urgent === 1;
  if (item.kind === 'secondary_assigned' || item.kind === 'secondary_answered') {
    return subscription.notify_secondary === 1;
  }
  return subscription.notify_mentions === 1;
}

function toPushPayload(item: AppNotificationItem): WebPushPayload {
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    body: item.body,
    href: item.href,
    createdAt: item.createdAt,
  };
}

async function fetchUrgentCases(
  db: D1Database,
  staff: SupportAccessStaff,
  after: string,
  lineAccountId?: string,
): Promise<AppNotificationItem[]> {
  const conditions = [
    'sc.updated_at > ?',
    'sc.priority = ?',
    'sc.status != ?',
  ];
  const binds: unknown[] = [after, 'urgent', 'resolved'];
  if (lineAccountId) {
    conditions.push('sc.line_account_id = ?');
    binds.push(lineAccountId);
  }
  const visibility = supportCaseVisibilitySql(staff, 'sc', 'urgent_case_scope');
  if (visibility.sql) {
    conditions.push(visibility.sql);
    binds.push(...visibility.binds);
  }

  const rows = await db
    .prepare(
      `SELECT
         sc.id,
         sc.title,
         COALESCE(NULLIF(f.display_name, ''), NULLIF(sc.contact_name, ''), NULLIF(sc.company_name, ''), NULLIF(sc.customer_number, '')) AS friend_name,
         sc.updated_at
       FROM support_cases sc
       LEFT JOIN friends f ON f.id = sc.friend_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY sc.updated_at DESC
       LIMIT ?`,
    )
    .bind(...binds, NOTIFICATION_LIMIT)
    .all<UrgentCaseRow>();

  return rows.results.map((row) => ({
    id: `urgent_case:${row.id}:${row.updated_at}`,
    kind: 'urgent_case',
    title: '大至急チケットがあります',
    body: `${row.title || 'チケット'}${row.friend_name ? ` / ${row.friend_name}` : ''}`,
    href: `/support?case=${encodeURIComponent(row.id)}`,
    createdAt: row.updated_at,
  }));
}

async function fetchSecondaryAssigned(
  db: D1Database,
  staff: SupportAccessStaff,
  after: string,
  lineAccountId?: string,
): Promise<AppNotificationItem[]> {
  const assignmentName = supportStaffAssignmentName(staff);
  if (!assignmentName) return [];
  const conditions = [
    'se.created_at > ?',
    'se.status != ?',
    `se.assignee = ?`,
  ];
  const binds: unknown[] = [after, 'closed', assignmentName];
  if (lineAccountId) {
    conditions.push('se.line_account_id = ?');
    binds.push(lineAccountId);
  }
  const visibility = supportCaseVisibilitySql(staff, 'sc', 'se_scope_assigned');
  if (visibility.sql) {
    conditions.push(visibility.sql);
    binds.push(...visibility.binds);
  }

  const rows = await db
    .prepare(
      `SELECT se.id, se.case_id, sc.title AS case_title, se.assignee, se.question, se.created_at
       FROM support_escalations se
       INNER JOIN support_cases sc ON sc.id = se.case_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY se.created_at DESC
       LIMIT ?`,
    )
    .bind(...binds, NOTIFICATION_LIMIT)
    .all<EscalationAssignedRow>();

  return rows.results.map((row) => ({
    id: `secondary_assigned:${row.id}:${row.created_at}`,
    kind: 'secondary_assigned',
    title: '二次対応が届きました',
    body: `${row.case_title || 'チケット'}: ${compact(row.question, '回答依頼があります')}`,
    href: `/support?case=${encodeURIComponent(row.case_id)}`,
    createdAt: row.created_at,
  }));
}

async function fetchSecondaryAnswered(
  db: D1Database,
  staff: SupportAccessStaff,
  after: string,
  lineAccountId?: string,
): Promise<AppNotificationItem[]> {
  const assignmentName = supportStaffAssignmentName(staff);
  if (!assignmentName) return [];
  const conditions = [
    'se.updated_at > ?',
    'se.status = ?',
    '(sc.primary_assignee = ? OR sc.created_by = ?)',
    '(se.updated_by IS NULL OR se.updated_by != ?)',
  ];
  const binds: unknown[] = [after, 'answered', assignmentName, staff.id, staff.id];
  if (lineAccountId) {
    conditions.push('se.line_account_id = ?');
    binds.push(lineAccountId);
  }
  const visibility = supportCaseVisibilitySql(staff, 'sc', 'se_scope_answered');
  if (visibility.sql) {
    conditions.push(visibility.sql);
    binds.push(...visibility.binds);
  }

  const rows = await db
    .prepare(
      `SELECT se.id, se.case_id, sc.title AS case_title, se.assignee, se.answer, se.updated_at
       FROM support_escalations se
       INNER JOIN support_cases sc ON sc.id = se.case_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY se.updated_at DESC
       LIMIT ?`,
    )
    .bind(...binds, NOTIFICATION_LIMIT)
    .all<EscalationAnsweredRow>();

  return rows.results.map((row) => ({
    id: `secondary_answered:${row.id}:${row.updated_at}`,
    kind: 'secondary_answered',
    title: '二次対応回答済みになりました',
    body: `${row.case_title || 'チケット'}: ${compact(row.answer, '回答を確認してください')}`,
    href: `/support?case=${encodeURIComponent(row.case_id)}`,
    createdAt: row.updated_at,
  }));
}

async function fetchSupportMentions(
  db: D1Database,
  staff: SupportAccessStaff,
  after: string,
  lineAccountId?: string,
): Promise<AppNotificationItem[]> {
  const mentionPattern = mentionLikePattern(staff);
  const conditions = [
    'sim.created_at > ?',
    '(sim.created_by IS NULL OR sim.created_by != ?)',
  ];
  const binds: unknown[] = [after, staff.id];
  if (mentionPattern) {
    conditions.push(
      `(EXISTS (
        SELECT 1
        FROM internal_message_mentions imm
        WHERE imm.source_type = 'support'
          AND imm.source_message_id = sim.id
          AND imm.staff_id = ?
      ) OR sim.mentions LIKE ? ESCAPE '\\')`,
    );
    binds.push(staff.id, mentionPattern);
  } else {
    conditions.push(
      `EXISTS (
        SELECT 1
        FROM internal_message_mentions imm
        WHERE imm.source_type = 'support'
          AND imm.source_message_id = sim.id
          AND imm.staff_id = ?
      )`,
    );
    binds.push(staff.id);
  }
  if (lineAccountId) {
    conditions.push('sim.line_account_id = ?');
    binds.push(lineAccountId);
  }
  const visibility = supportCaseVisibilitySql(staff, 'sc', 'se_scope_support_mention');
  if (visibility.sql) {
    conditions.push(visibility.sql);
    binds.push(...visibility.binds);
  }

  const rows = await db
    .prepare(
      `SELECT sim.id, sim.case_id, sc.title AS case_title, sim.body, sim.created_by_name, sim.created_at
       FROM support_internal_messages sim
       INNER JOIN support_cases sc ON sc.id = sim.case_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY sim.created_at DESC
       LIMIT ?`,
    )
    .bind(...binds, NOTIFICATION_LIMIT)
    .all<SupportMentionRow>();

  return rows.results.map((row) => ({
    id: `support_mention:${row.id}`,
    kind: 'support_mention',
    title: `${row.created_by_name || 'スタッフ'}さんからメンション`,
    body: `${row.case_title || 'チケット'}: ${compact(row.body, '社内チャットを確認してください')}`,
    href: `/support?case=${encodeURIComponent(row.case_id)}`,
    createdAt: row.created_at,
  }));
}

async function fetchChatMentions(
  db: D1Database,
  staff: SupportAccessStaff,
  after: string,
  lineAccountId?: string,
): Promise<AppNotificationItem[]> {
  const mentionPattern = mentionLikePattern(staff);
  const conditions = [
    'cim.created_at > ?',
    '(cim.created_by IS NULL OR cim.created_by != ?)',
  ];
  const binds: unknown[] = [after, staff.id];
  if (mentionPattern) {
    conditions.push(
      `(EXISTS (
        SELECT 1
        FROM internal_message_mentions imm
        WHERE imm.source_type = 'chat'
          AND imm.source_message_id = cim.id
          AND imm.staff_id = ?
      ) OR cim.mentions LIKE ? ESCAPE '\\')`,
    );
    binds.push(staff.id, mentionPattern);
  } else {
    conditions.push(
      `EXISTS (
        SELECT 1
        FROM internal_message_mentions imm
        WHERE imm.source_type = 'chat'
          AND imm.source_message_id = cim.id
          AND imm.staff_id = ?
      )`,
    );
    binds.push(staff.id);
  }
  if (lineAccountId) {
    conditions.push('COALESCE(cim.line_account_id, f.line_account_id) = ?');
    binds.push(lineAccountId);
  }
  const visibility = supportFriendVisibilitySql(staff, 'cim.friend_id');
  if (visibility.sql) {
    conditions.push(visibility.sql);
    binds.push(...visibility.binds);
  }

  const rows = await db
    .prepare(
      `SELECT cim.id, cim.friend_id, f.display_name AS friend_name, cim.body, cim.created_by_name, cim.created_at
       FROM chat_internal_messages cim
       LEFT JOIN friends f ON f.id = cim.friend_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY cim.created_at DESC
       LIMIT ?`,
    )
    .bind(...binds, NOTIFICATION_LIMIT)
    .all<ChatMentionRow>();

  return rows.results.map((row) => ({
    id: `chat_mention:${row.id}`,
    kind: 'chat_mention',
    title: `${row.created_by_name || 'スタッフ'}さんからメンション`,
    body: `${row.friend_name || '個別チャット'}: ${compact(row.body, '社内チャットを確認してください')}`,
    href: `/chats?friend=${encodeURIComponent(row.friend_id)}`,
    createdAt: row.created_at,
  }));
}

export async function collectAppNotifications(
  db: D1Database,
  staff: SupportAccessStaff,
  after: string,
  lineAccountId?: string,
): Promise<AppNotificationItem[]> {
  const batches = await Promise.all([
    fetchUrgentCases(db, staff, after, lineAccountId),
    fetchSecondaryAssigned(db, staff, after, lineAccountId),
    fetchSecondaryAnswered(db, staff, after, lineAccountId),
    fetchSupportMentions(db, staff, after, lineAccountId),
    fetchChatMentions(db, staff, after, lineAccountId),
  ]);
  const seen = new Set<string>();
  return batches
    .flat()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    })
    .slice(-NOTIFICATION_LIMIT);
}

appNotifications.get('/api/app-notifications/recent', async (c) => {
  try {
    const params = new URL(c.req.url).searchParams;
    const after = parseCursor(params.get('after'));
    if (!after.ok) return c.json({ success: false, error: after.error }, 400);
    const lineAccountId = parseAccountId(params.get('lineAccountId'));
    if (!lineAccountId.ok) return c.json({ success: false, error: lineAccountId.error }, 400);
    const cursor = jstNow();
    if (!after.value) {
      return c.json({ success: true, data: { cursor, items: [] } });
    }

    const staff = currentStaff(c);
    const items = await collectAppNotifications(c.env.DB, staff, after.value, lineAccountId.value);
    await persistNotificationInbox(c.env.DB, staff, lineAccountId.value, items);

    return c.json({ success: true, data: { cursor, items } });
  } catch (err) {
    console.error(`GET /api/app-notifications/recent error: ${routeErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

appNotifications.get('/api/app-notifications/inbox', async (c) => {
  try {
    const params = new URL(c.req.url).searchParams;
    const lineAccountId = parseAccountId(params.get('lineAccountId'));
    if (!lineAccountId.ok) return c.json({ success: false, error: lineAccountId.error }, 400);
    const limit = parseLimit(params.get('limit'));
    if (!limit.ok) return c.json({ success: false, error: limit.error }, 400);
    const staff = currentStaff(c);
    const backfillAfter = toJstString(new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000));
    const collected = await collectAppNotifications(
      c.env.DB,
      staff,
      backfillAfter,
      lineAccountId.value,
    );
    await persistNotificationInbox(c.env.DB, staff, lineAccountId.value, collected);

    const conditions = [
      'recipient_staff_id = ?',
      'dismissed_at IS NULL',
      '(snoozed_until IS NULL OR snoozed_until <= ?)',
    ];
    const now = jstNow();
    const binds: unknown[] = [staff.id, now];
    if (lineAccountId.value) {
      conditions.push('line_account_id = ?');
      binds.push(lineAccountId.value);
    }
    const where = conditions.join(' AND ');
    const [rows, unread] = await Promise.all([
      c.env.DB
        .prepare(
          `SELECT id, notification_key, kind, title, body, href,
                  source_created_at, read_at, snoozed_until
           FROM app_notification_inbox
           WHERE ${where}
           ORDER BY CASE WHEN read_at IS NULL THEN 0 ELSE 1 END,
                    source_created_at DESC
           LIMIT ?`,
        )
        .bind(...binds, limit.value)
        .all<AppNotificationInboxRow>(),
      c.env.DB
        .prepare(
          `SELECT COUNT(*) AS count
           FROM app_notification_inbox
           WHERE ${where} AND read_at IS NULL`,
        )
        .bind(...binds)
        .first<{ count: number }>(),
    ]);
    return c.json({
      success: true,
      data: {
        items: rows.results.map(serializeNotificationInboxRow),
        unreadCount: Number(unread?.count ?? 0),
      },
    });
  } catch (err) {
    console.error(`GET /api/app-notifications/inbox error: ${routeErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

appNotifications.post('/api/app-notifications/inbox/read', async (c) => {
  try {
    const body = await c.req.json<{
      lineAccountId?: unknown;
      id?: unknown;
      all?: unknown;
    }>().catch(() => null);
    if (!body) return c.json({ success: false, error: 'Invalid payload' }, 400);
    const lineAccountId = parseAccountId(body.lineAccountId);
    if (!lineAccountId.ok) return c.json({ success: false, error: lineAccountId.error }, 400);
    if (!lineAccountId.value) {
      return c.json({ success: false, error: 'lineAccountId is required' }, 400);
    }
    const markAll = body.all === true;
    const id = markAll ? { ok: true as const, value: undefined } : parseVisibleText(body.id, 'id', 512);
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const staff = currentStaff(c);
    const now = jstNow();
    if (markAll) {
      await c.env.DB
        .prepare(
          `UPDATE app_notification_inbox
           SET read_at = COALESCE(read_at, ?), updated_at = ?
           WHERE recipient_staff_id = ?
             AND line_account_id = ?
             AND dismissed_at IS NULL`,
        )
        .bind(now, now, staff.id, lineAccountId.value)
        .run();
    } else {
      await c.env.DB
        .prepare(
          `UPDATE app_notification_inbox
           SET read_at = COALESCE(read_at, ?), updated_at = ?
           WHERE id = ?
             AND recipient_staff_id = ?
             AND line_account_id = ?
             AND dismissed_at IS NULL`,
        )
        .bind(now, now, id.value, staff.id, lineAccountId.value)
        .run();
    }
    return c.json({ success: true, data: { readAt: now } });
  } catch (err) {
    console.error(`POST /api/app-notifications/inbox/read error: ${routeErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

appNotifications.get('/api/app-notifications/internal-chat-feed', async (c) => {
  try {
    const params = new URL(c.req.url).searchParams;
    const lineAccountId = parseAccountId(params.get('lineAccountId'));
    if (!lineAccountId.ok) return c.json({ success: false, error: lineAccountId.error }, 400);
    const limit = parseLimit(params.get('limit'));
    if (!limit.ok) return c.json({ success: false, error: limit.error }, 400);
    const before = parseInternalChatCursor(params.get('before'));
    if (!before.ok) return c.json({ success: false, error: before.error }, 400);
    const search = parseInternalChatSearch(params.get('q'));
    if (!search.ok) return c.json({ success: false, error: search.error }, 400);

    const staff = currentStaff(c);
    const supportConditions: string[] = [];
    const supportBinds: unknown[] = [];
    if (lineAccountId.value) {
      supportConditions.push('sim.line_account_id = ?');
      supportBinds.push(lineAccountId.value);
    }
    const supportVisibility = supportCaseVisibilitySql(staff, 'sc', 'internal_feed_support_scope');
    if (supportVisibility.sql) {
      supportConditions.push(supportVisibility.sql);
      supportBinds.push(...supportVisibility.binds);
    }
    if (before.value) {
      supportConditions.push(
        `(sim.created_at < ? OR (sim.created_at = ? AND ('support:' || sim.id) < ?))`,
      );
      supportBinds.push(before.value.createdAt, before.value.createdAt, before.value.id);
    }
    if (search.value) {
      const pattern = `%${escapeLike(search.value)}%`;
      supportConditions.push(
        `(sim.body LIKE ? ESCAPE '\\'
          OR sc.title LIKE ? ESCAPE '\\'
          OR f.display_name LIKE ? ESCAPE '\\')`,
      );
      supportBinds.push(pattern, pattern, pattern);
    }

    const chatConditions: string[] = [];
    const chatBinds: unknown[] = [];
    if (lineAccountId.value) {
      chatConditions.push('COALESCE(cim.line_account_id, f.line_account_id) = ?');
      chatBinds.push(lineAccountId.value);
    }
    const chatVisibility = supportFriendVisibilitySql(staff, 'cim.friend_id');
    if (chatVisibility.sql) {
      chatConditions.push(chatVisibility.sql);
      chatBinds.push(...chatVisibility.binds);
    }
    if (before.value) {
      chatConditions.push(
        `(cim.created_at < ? OR (cim.created_at = ? AND ('chat:' || cim.id) < ?))`,
      );
      chatBinds.push(before.value.createdAt, before.value.createdAt, before.value.id);
    }
    if (search.value) {
      const pattern = `%${escapeLike(search.value)}%`;
      chatConditions.push(
        `(cim.body LIKE ? ESCAPE '\\'
          OR f.display_name LIKE ? ESCAPE '\\'
          OR EXISTS (
            SELECT 1
            FROM support_cases sc_search
            WHERE sc_search.friend_id = cim.friend_id
              AND sc_search.title LIKE ? ESCAPE '\\'
          ))`,
      );
      chatBinds.push(pattern, pattern, pattern);
    }

    const queryLimit = limit.value + 1;

    const [supportRows, chatRows] = await Promise.all([
      c.env.DB
        .prepare(
          `SELECT
             sim.id,
             sim.case_id,
             sc.title AS case_title,
             f.display_name AS customer_name,
             sim.parent_id,
             sim.body,
             sim.mentions,
             sim.reactions,
             sim.created_by,
             sim.created_by_name,
             sim.created_at
           FROM support_internal_messages sim
           INNER JOIN support_cases sc ON sc.id = sim.case_id
           LEFT JOIN friends f ON f.id = sc.friend_id
           ${supportConditions.length > 0 ? `WHERE ${supportConditions.join(' AND ')}` : ''}
           ORDER BY sim.created_at DESC
           LIMIT ?`,
        )
        .bind(...supportBinds, queryLimit)
        .all<SupportInternalChatFeedRow>(),
      c.env.DB
        .prepare(
          `SELECT
             cim.id,
             cim.friend_id,
             f.display_name AS friend_name,
             (
               SELECT sc_chat.title
               FROM support_cases sc_chat
               WHERE sc_chat.friend_id = cim.friend_id
                 AND sc_chat.status != 'resolved'
               ORDER BY sc_chat.updated_at DESC, sc_chat.created_at DESC
               LIMIT 1
             ) AS ticket_title,
             cim.parent_id,
             cim.body,
             cim.mentions,
             cim.reactions,
             cim.created_by,
             cim.created_by_name,
             cim.created_at
           FROM chat_internal_messages cim
           LEFT JOIN friends f ON f.id = cim.friend_id
           ${chatConditions.length > 0 ? `WHERE ${chatConditions.join(' AND ')}` : ''}
           ORDER BY cim.created_at DESC
           LIMIT ?`,
        )
        .bind(...chatBinds, queryLimit)
        .all<ChatInternalChatFeedRow>(),
    ]);

    const [supportMentionIds, chatMentionIds, readCursors] = await Promise.all([
      mentionStaffIdsForMessages(c.env.DB, 'support', supportRows.results.map((row) => row.id)),
      mentionStaffIdsForMessages(c.env.DB, 'chat', chatRows.results.map((row) => row.id)),
      loadInternalConversationReads(c.env.DB, staff.id, lineAccountId.value),
    ]);

    const allItems = [
      ...supportRows.results.map((row) => ({
        id: `support:${row.id}`,
        source: 'support' as const,
        sourceId: row.case_id,
        sourceTitle: row.case_title?.trim() || fallbackContextTitle('チケットID', row.case_id),
        customerName: row.customer_name?.trim() || null,
        ticketTitle: row.case_title?.trim() || fallbackContextTitle('チケットID', row.case_id),
        parentId: row.parent_id,
        body: row.body,
        mentions: parseStoredMentions(row.mentions),
        mentionStaffIds: supportMentionIds.get(row.id) ?? [],
        reactions: summarizeInternalReactions(row.reactions, staff),
        createdByName: row.created_by_name,
        createdAt: row.created_at,
        href: `/support?case=${encodeURIComponent(row.case_id)}`,
        isUnread: row.created_by !== staff.id
          && row.created_at > (readCursors.get(internalConversationId('support', row.case_id)) ?? ''),
      })),
      ...chatRows.results.map((row) => ({
        id: `chat:${row.id}`,
        source: 'chat' as const,
        sourceId: row.friend_id,
        sourceTitle: row.friend_name?.trim() || fallbackContextTitle('顧客ID', row.friend_id),
        customerName: row.friend_name?.trim() || fallbackContextTitle('顧客ID', row.friend_id),
        ticketTitle: row.ticket_title?.trim() || null,
        parentId: row.parent_id,
        body: row.body,
        mentions: parseStoredMentions(row.mentions),
        mentionStaffIds: chatMentionIds.get(row.id) ?? [],
        reactions: summarizeInternalReactions(row.reactions, staff),
        createdByName: row.created_by_name,
        createdAt: row.created_at,
        href: `/chats?friend=${encodeURIComponent(row.friend_id)}`,
        isUnread: row.created_by !== staff.id
          && row.created_at > (readCursors.get(internalConversationId('chat', row.friend_id)) ?? ''),
      })),
    ]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    const hasMore = allItems.length > limit.value;
    const items = allItems.slice(0, limit.value);
    const lastItem = items.at(-1);

    return c.json({
      success: true,
      data: {
        items,
        hasMore,
        nextCursor: hasMore && lastItem ? internalChatCursorValue(lastItem) : null,
      },
    });
  } catch (err) {
    console.error(`GET /api/app-notifications/internal-chat-feed error: ${routeErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

appNotifications.post('/api/app-notifications/internal-chat-read', async (c) => {
  try {
    const body = await c.req.json<{
      lineAccountId?: unknown;
      source?: unknown;
      sourceId?: unknown;
    }>().catch(() => null);
    if (!body) return c.json({ success: false, error: 'Invalid payload' }, 400);
    const lineAccountId = parseAccountId(body.lineAccountId);
    if (!lineAccountId.ok) return c.json({ success: false, error: lineAccountId.error }, 400);
    if (!lineAccountId.value) {
      return c.json({ success: false, error: 'lineAccountId is required' }, 400);
    }
    const source = body.source === undefined ? 'all' : body.source;
    if (source !== 'all' && source !== 'support' && source !== 'chat') {
      return c.json({ success: false, error: 'source is invalid' }, 400);
    }

    const staff = currentStaff(c);
    const now = jstNow();
    if (source === 'all') {
      await c.env.DB
        .prepare(
          `INSERT INTO internal_conversation_reads (
             conversation_id, staff_id, last_read_at, updated_at
           )
           SELECT id, ?, ?, ?
           FROM internal_conversations
           WHERE line_account_id = ? AND archived_at IS NULL
           ON CONFLICT(conversation_id, staff_id) DO UPDATE SET
             last_read_at = excluded.last_read_at,
             updated_at = excluded.updated_at`,
        )
        .bind(staff.id, now, now, lineAccountId.value)
        .run();
      return c.json({ success: true, data: { readAt: now, conversationId: null } });
    }

    const sourceId = parseVisibleText(body.sourceId, 'sourceId', ACCOUNT_ID_MAX_LENGTH);
    if (!sourceId.ok) return c.json({ success: false, error: sourceId.error }, 400);
    const conversationId = internalConversationId(source, sourceId.value);
    const conversation = await c.env.DB
      .prepare(
        `SELECT id
         FROM internal_conversations
         WHERE id = ? AND line_account_id = ? AND archived_at IS NULL`,
      )
      .bind(conversationId, lineAccountId.value)
      .first<{ id: string }>();
    if (!conversation) return c.json({ success: false, error: 'conversation not found' }, 404);

    await c.env.DB
      .prepare(
        `INSERT INTO internal_conversation_reads (
           conversation_id, staff_id, last_read_at, updated_at
         ) VALUES (?, ?, ?, ?)
         ON CONFLICT(conversation_id, staff_id) DO UPDATE SET
           last_read_at = excluded.last_read_at,
           updated_at = excluded.updated_at`,
      )
      .bind(conversationId, staff.id, now, now)
      .run();
    return c.json({ success: true, data: { readAt: now, conversationId } });
  } catch (err) {
    console.error(`POST /api/app-notifications/internal-chat-read error: ${routeErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

appNotifications.get('/api/app-notifications/web-push/config', (c) => {
  const publicKey = (c.env.WEB_PUSH_VAPID_PUBLIC_KEY ?? '').trim();
  return c.json({
    success: true,
    data: {
      enabled: isWebPushConfigured(c.env),
      publicKey,
    },
  });
});

appNotifications.post('/api/app-notifications/web-push/subscribe', async (c) => {
  try {
    if (!isWebPushConfigured(c.env)) {
      return c.json({ success: false, error: 'Web push is not configured' }, 503);
    }
    const body = await c.req.json<WebPushSubscriptionBody>().catch(() => null);
    if (!body) return c.json({ success: false, error: 'Invalid JSON' }, 400);
    const parsed = parseWebPushSubscription(body);
    if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);
    const staff = currentStaff(c);
    const id = await subscriptionId(parsed.value.endpoint);
    const now = jstNow();
    await c.env.DB
      .prepare(
        `INSERT INTO web_push_subscriptions (
          id, staff_id, staff_name, staff_role, endpoint, p256dh, auth, user_agent,
          is_active, last_error, created_at, updated_at, last_seen_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, ?)
        ON CONFLICT(endpoint) DO UPDATE SET
          staff_id = excluded.staff_id,
          staff_name = excluded.staff_name,
          staff_role = excluded.staff_role,
          p256dh = excluded.p256dh,
          auth = excluded.auth,
          user_agent = excluded.user_agent,
          is_active = 1,
          last_error = NULL,
          updated_at = excluded.updated_at,
          last_seen_at = excluded.last_seen_at`,
      )
      .bind(
        id,
        staff.id,
        staff.name,
        staff.role,
        parsed.value.endpoint,
        parsed.value.p256dh,
        parsed.value.auth,
        parsed.value.userAgent,
        now,
        now,
        now,
      )
      .run();

    return c.json({ success: true, data: { id } });
  } catch (err) {
    console.error(`POST /api/app-notifications/web-push/subscribe error: ${webPushRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

appNotifications.delete('/api/app-notifications/web-push/subscribe', async (c) => {
  try {
    const body = await c.req.json<{ endpoint?: unknown }>().catch(() => null);
    const endpoint = parseVisibleText(body?.endpoint, 'endpoint', WEB_PUSH_ENDPOINT_MAX_LENGTH);
    if (!endpoint.ok) return c.json({ success: false, error: endpoint.error }, 400);
    const staff = currentStaff(c);
    await c.env.DB
      .prepare(
        `UPDATE web_push_subscriptions
         SET is_active = 0, updated_at = ?
         WHERE endpoint = ? AND staff_id = ?`,
      )
      .bind(jstNow(), endpoint.value, staff.id)
      .run();
    return c.json({ success: true, data: { unsubscribed: true } });
  } catch (err) {
    console.error(`DELETE /api/app-notifications/web-push/subscribe error: ${webPushRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

appNotifications.post('/api/app-notifications/web-push/status', async (c) => {
  try {
    const body = await c.req.json<WebPushSettingsBody>().catch(() => null);
    const endpoint = parseVisibleText(body?.endpoint, 'endpoint', WEB_PUSH_ENDPOINT_MAX_LENGTH);
    if (!endpoint.ok) return c.json({ success: false, error: endpoint.error }, 400);
    const staff = currentStaff(c);
    const row = await c.env.DB
      .prepare(
        `SELECT id, staff_id, staff_name, staff_role, endpoint, p256dh, auth,
                notify_urgent, notify_secondary, notify_mentions
         FROM web_push_subscriptions
         WHERE endpoint = ? AND staff_id = ? AND is_active = 1`,
      )
      .bind(endpoint.value, staff.id)
      .first<WebPushSubscriptionRow>();
    return c.json({
      success: true,
      data: {
        subscribed: Boolean(row),
        settings: row ? publicWebPushSettings(row) : null,
      },
    });
  } catch (err) {
    console.error(`POST /api/app-notifications/web-push/status error: ${webPushRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

appNotifications.patch('/api/app-notifications/web-push/settings', async (c) => {
  try {
    const body = await c.req.json<WebPushSettingsBody>().catch(() => null);
    if (!body) return c.json({ success: false, error: 'Invalid JSON' }, 400);
    const endpoint = parseVisibleText(body.endpoint, 'endpoint', WEB_PUSH_ENDPOINT_MAX_LENGTH);
    if (!endpoint.ok) return c.json({ success: false, error: endpoint.error }, 400);
    const notifyUrgent = parseOptionalBoolean(body.notifyUrgent, 'notifyUrgent');
    if (!notifyUrgent.ok) return c.json({ success: false, error: notifyUrgent.error }, 400);
    const notifySecondary = parseOptionalBoolean(body.notifySecondary, 'notifySecondary');
    if (!notifySecondary.ok) return c.json({ success: false, error: notifySecondary.error }, 400);
    const notifyMentions = parseOptionalBoolean(body.notifyMentions, 'notifyMentions');
    if (!notifyMentions.ok) return c.json({ success: false, error: notifyMentions.error }, 400);

    const fields: Array<[string, unknown]> = [];
    if (notifyUrgent.value !== undefined) fields.push(['notify_urgent', notifyUrgent.value ? 1 : 0]);
    if (notifySecondary.value !== undefined) fields.push(['notify_secondary', notifySecondary.value ? 1 : 0]);
    if (notifyMentions.value !== undefined) fields.push(['notify_mentions', notifyMentions.value ? 1 : 0]);
    if (fields.length === 0) return c.json({ success: false, error: 'No settings to update' }, 400);
    fields.push(['updated_at', jstNow()]);

    const staff = currentStaff(c);
    const setSql = fields.map(([column]) => `${column} = ?`).join(', ');
    const result = await c.env.DB
      .prepare(`UPDATE web_push_subscriptions SET ${setSql} WHERE endpoint = ? AND staff_id = ? AND is_active = 1`)
      .bind(...fields.map(([, value]) => value), endpoint.value, staff.id)
      .run();
    if (!result.meta.changes) {
      return c.json({ success: false, error: 'Subscription not found' }, 404);
    }

    const row = await c.env.DB
      .prepare(
        `SELECT id, staff_id, staff_name, staff_role, endpoint, p256dh, auth,
                notify_urgent, notify_secondary, notify_mentions
         FROM web_push_subscriptions
         WHERE endpoint = ? AND staff_id = ? AND is_active = 1`,
      )
      .bind(endpoint.value, staff.id)
      .first<WebPushSubscriptionRow>();
    return c.json({ success: true, data: { settings: row ? publicWebPushSettings(row) : null } });
  } catch (err) {
    console.error(`PATCH /api/app-notifications/web-push/settings error: ${webPushRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

async function activeWebPushSubscriptionsForStaff(
  db: D1Database,
  staff: SupportAccessStaff,
): Promise<WebPushSubscriptionRow[]> {
  const rows = await db
    .prepare(
      `SELECT id, staff_id, staff_name, staff_role, endpoint, p256dh, auth,
              notify_urgent, notify_secondary, notify_mentions
       FROM web_push_subscriptions
       WHERE staff_id = ? AND is_active = 1
       ORDER BY last_seen_at DESC
       LIMIT 10`,
    )
    .bind(staff.id)
    .all<WebPushSubscriptionRow>();
  return rows.results;
}

appNotifications.post('/api/app-notifications/web-push/test', async (c) => {
  try {
    if (!isWebPushConfigured(c.env)) {
      return c.json({ success: false, error: 'Web push is not configured' }, 503);
    }
    const staff = currentStaff(c);
    const subscriptions = await activeWebPushSubscriptionsForStaff(c.env.DB, staff);
    if (subscriptions.length === 0) {
      return c.json({ success: false, error: 'No active web push subscription' }, 404);
    }
    const payload: WebPushPayload = {
      id: `web_push_test:${crypto.randomUUID()}`,
      kind: 'support_mention',
      title: 'LINE Harness 通知テスト',
      body: 'PC通知のテストです。Chromeからこの通知が表示されています。',
      href: '/notification-settings',
      createdAt: jstNow(),
    };
    let sent = 0;
    let failed = 0;
    for (const subscription of subscriptions) {
      const result = await sendWebPush(c.env, subscription, payload);
      if (result.ok) {
        sent += 1;
        await c.env.DB
          .prepare(
            `UPDATE web_push_subscriptions
             SET last_error = NULL,
                 updated_at = ?,
                 last_seen_at = ?
             WHERE id = ?`,
          )
          .bind(jstNow(), jstNow(), subscription.id)
          .run();
      } else {
        failed += 1;
        await c.env.DB
          .prepare(
            `UPDATE web_push_subscriptions
             SET is_active = CASE WHEN ? THEN 0 ELSE is_active END,
                 last_error = ?,
                 updated_at = ?
             WHERE id = ?`,
          )
          .bind(result.expired ? 1 : 0, result.error ?? `status_${result.status}`, jstNow(), subscription.id)
          .run();
      }
    }
    return c.json({ success: true, data: { sent, failed } });
  } catch (err) {
    console.error(`POST /api/app-notifications/web-push/test error: ${webPushRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export async function processWebPushNotifications(
  db: D1Database,
  env: Env['Bindings'],
  options: WebPushProcessOptions = {},
): Promise<{ sent: number; skipped: number; failed: number; subscriptions: number }> {
  if (!isWebPushConfigured(env)) return { sent: 0, skipped: 0, failed: 0, subscriptions: 0 };
  const now = options.now ?? new Date();
  const lookbackMinutes = Math.max(5, Math.min(24 * 60, options.lookbackMinutes ?? WEB_PUSH_LOOKBACK_MINUTES));
  const after = toJstString(new Date(now.getTime() - lookbackMinutes * 60_000));
  const rows = await db
    .prepare(
      `SELECT id, staff_id, staff_name, staff_role, endpoint, p256dh, auth,
              notify_urgent, notify_secondary, notify_mentions
       FROM web_push_subscriptions
       WHERE is_active = 1
       ORDER BY last_seen_at DESC
       LIMIT 200`,
    )
    .all<WebPushSubscriptionRow>();

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  for (const subscription of rows.results) {
    const staff: SupportAccessStaff = {
      id: subscription.staff_id,
      name: subscription.staff_name,
      role: subscription.staff_role,
    };
    const collected = await collectAppNotifications(db, staff, after, options.lineAccountId);
    await persistNotificationInbox(db, staff, options.lineAccountId, collected);
    const items = collected.filter((item) => notificationMatchesSubscription(item, subscription));
    for (const item of items) {
      const existing = await db
        .prepare(
          `SELECT notification_id
           FROM web_push_deliveries
           WHERE subscription_id = ? AND notification_id = ?`,
        )
        .bind(subscription.id, item.id)
        .first<{ notification_id: string }>();
      if (existing) {
        skipped += 1;
        continue;
      }
      const deliveryId = crypto.randomUUID();
      await db
        .prepare(
          `INSERT INTO web_push_deliveries (
            id, subscription_id, notification_id, status, created_at, updated_at
          ) VALUES (?, ?, ?, 'pending', ?, ?)`,
        )
        .bind(deliveryId, subscription.id, item.id, jstNow(), jstNow())
        .run();

      const result = await sendWebPush(env, subscription, toPushPayload(item));
      if (result.ok) {
        sent += 1;
        await db
          .prepare(
            `UPDATE web_push_subscriptions
             SET last_error = NULL,
                 updated_at = ?,
                 last_seen_at = ?
             WHERE id = ?`,
          )
          .bind(jstNow(), jstNow(), subscription.id)
          .run();
        await db
          .prepare(
            `UPDATE web_push_deliveries
             SET status = 'sent', sent_at = ?, updated_at = ?
             WHERE id = ?`,
          )
          .bind(jstNow(), jstNow(), deliveryId)
          .run();
      } else {
        failed += 1;
        const error = result.error ?? `status_${result.status}`;
        await db.batch([
          db
            .prepare(
              `UPDATE web_push_deliveries
               SET status = 'failed', error = ?, updated_at = ?
               WHERE id = ?`,
            )
            .bind(error, jstNow(), deliveryId),
          db
            .prepare(
              `UPDATE web_push_subscriptions
               SET is_active = CASE WHEN ? THEN 0 ELSE is_active END,
                   last_error = ?,
                   updated_at = ?
               WHERE id = ?`,
            )
            .bind(result.expired ? 1 : 0, error, jstNow(), subscription.id),
        ]);
      }
    }
  }

  return { sent, skipped, failed, subscriptions: rows.results.length };
}

export function kickWebPushNotifications(c: { env: Env['Bindings']; executionCtx: ExecutionContext }): void {
  if (!isWebPushConfigured(c.env)) return;
  try {
    c.executionCtx.waitUntil(
      processWebPushNotifications(c.env.DB, c.env, { lookbackMinutes: WEB_PUSH_LOOKBACK_MINUTES })
        .catch((err) => {
          console.error(`web-push background error: ${webPushRouteErrorKind(err)}`);
        }),
    );
  } catch (err) {
    console.warn(`web-push waitUntil unavailable: ${webPushRouteErrorKind(err)}`);
  }
}

export { appNotifications };

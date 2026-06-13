import { Hono, type Context } from 'hono';
import {
  getBroadcasts,
  getBroadcastById,
  createBroadcast,
  updateBroadcast,
  deleteBroadcast,
} from '@line-crm/db';
import type { Broadcast as DbBroadcast, BroadcastMessageType, BroadcastTargetType } from '@line-crm/db';
import { LineClient } from '@line-crm/line-sdk';
import { processBroadcastSend, buildMessage, processQueuedBroadcasts } from '../services/broadcast.js';
import { computeDedupBroadcastPreview } from '../services/dedup-broadcast.js';
import { processSegmentSend } from '../services/segment-send.js';
import type { SegmentCondition } from '../services/segment-query.js';
import { getLineAccountById } from '@line-crm/db';
import type { Env } from '../index.js';
import { requireRole } from '../middleware/role-guard.js';
import { supportFriendVisibilitySql } from '../services/support-access.js';
import { currentSupportStaff } from './support-friend-access.js';

const broadcasts = new Hono<Env>();

const BROADCAST_ID_MAX_LENGTH = 128;
const BROADCAST_TITLE_MAX_LENGTH = 160;
const BROADCAST_MESSAGE_CONTENT_MAX_LENGTH = 50000;
const BROADCAST_ALT_TEXT_MAX_LENGTH = 400;
const BROADCAST_URL_MAX_LENGTH = 2048;
const BROADCAST_MAX_ACCOUNT_IDS = 100;
const BROADCAST_SEGMENT_MAX_BYTES = 20000;
const BROADCAST_SEGMENT_MAX_RULES = 50;
const BROADCAST_VISIBLE_ASCII_PATTERN = /^[!-~]+$/;
const BROADCAST_VISIBLE_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const BROADCAST_MESSAGE_TYPES = new Set<BroadcastMessageType>(['text', 'image', 'flex']);
const BROADCAST_TARGET_TYPES = new Set<BroadcastTargetType>(['all', 'tag', 'multi-account-dedup']);
const BROADCAST_SEGMENT_RULE_TYPES = new Set([
  'tag_exists',
  'tag_not_exists',
  'metadata_equals',
  'metadata_not_equals',
  'ref_code',
  'is_following',
]);

type ValueResult<T> = { ok: true; value: T } | { ok: false; error: string };
type BroadcastCreatePayload = {
  title: string;
  messageType: BroadcastMessageType;
  messageContent: string;
  targetType: BroadcastTargetType;
  targetTagId: string | null;
  scheduledAt?: string | null;
  lineAccountId?: string | null;
  altText?: string | null;
  accountIds?: string[];
  dedupPriority?: string[];
};
type BroadcastUpdatePayload = {
  title?: string;
  message_type?: BroadcastMessageType;
  message_content?: string;
  target_type?: BroadcastTargetType;
  target_tag_id?: string | null;
  scheduled_at?: string | null;
  status?: 'draft' | 'scheduled';
};

async function readJsonObject(c: Context<Env>): Promise<ValueResult<Record<string, unknown>>> {
  try {
    const body = await c.req.json<unknown>();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { ok: false, error: 'invalid_payload' };
    }
    return { ok: true, value: body as Record<string, unknown> };
  } catch {
    return { ok: false, error: 'invalid_json' };
  }
}

function parseVisibleId(raw: unknown, label: string, maxLength = BROADCAST_ID_MAX_LENGTH): ValueResult<string> {
  if (typeof raw !== 'string') return { ok: false, error: `invalid_${label}` };
  const value = raw.trim();
  if (!value || value.length > maxLength || !BROADCAST_VISIBLE_ASCII_PATTERN.test(value)) {
    return { ok: false, error: `invalid_${label}` };
  }
  return { ok: true, value };
}

function parseSafeSqlId(raw: unknown, label: string, maxLength = BROADCAST_ID_MAX_LENGTH): ValueResult<string> {
  const parsed = parseVisibleId(raw, label, maxLength);
  if (!parsed.ok) return parsed;
  if (!BROADCAST_VISIBLE_ID_PATTERN.test(parsed.value)) {
    return { ok: false, error: `invalid_${label}` };
  }
  return parsed;
}

function parseOptionalSafeSqlId(raw: unknown, label: string): ValueResult<string | undefined> {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: undefined };
  return parseSafeSqlId(raw, label);
}

function parseOptionalNullableSafeSqlId(raw: unknown, label: string): ValueResult<string | null | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null || raw === '') return { ok: true, value: null };
  return parseSafeSqlId(raw, label);
}

function parseRequiredString(raw: unknown, label: string, maxLength: number): ValueResult<string> {
  if (typeof raw !== 'string') return { ok: false, error: `invalid_${label}` };
  const value = raw.trim();
  if (!value || value.length > maxLength) return { ok: false, error: `invalid_${label}` };
  return { ok: true, value };
}

function parseOptionalNullableString(
  raw: unknown,
  label: string,
  maxLength: number,
): ValueResult<string | null | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null || raw === '') return { ok: true, value: null };
  return parseRequiredString(raw, label, maxLength);
}

function parseMessageType(raw: unknown, required: boolean): ValueResult<BroadcastMessageType | undefined> {
  if (raw === undefined) {
    return required ? { ok: false, error: 'invalid_message_type' } : { ok: true, value: undefined };
  }
  if (typeof raw !== 'string') return { ok: false, error: 'invalid_message_type' };
  const value = raw.trim() as BroadcastMessageType;
  if (!BROADCAST_MESSAGE_TYPES.has(value)) return { ok: false, error: 'invalid_message_type' };
  return { ok: true, value };
}

function parseTargetType(raw: unknown, required: boolean): ValueResult<BroadcastTargetType | undefined> {
  if (raw === undefined) {
    return required ? { ok: false, error: 'invalid_target_type' } : { ok: true, value: undefined };
  }
  if (typeof raw !== 'string') return { ok: false, error: 'invalid_target_type' };
  const value = raw.trim() as BroadcastTargetType;
  if (!BROADCAST_TARGET_TYPES.has(value)) return { ok: false, error: 'invalid_target_type' };
  return { ok: true, value };
}

function parseScheduledAt(raw: unknown): ValueResult<string | null | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null || raw === '') return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: 'invalid_scheduled_at' };
  const value = raw.trim();
  if (!value || value.length > 64 || Number.isNaN(Date.parse(value))) {
    return { ok: false, error: 'invalid_scheduled_at' };
  }
  return { ok: true, value };
}

function broadcastLineErrorStatus(err: unknown): number | null {
  if (!(err instanceof Error)) return null;
  const match = err.message.match(/^LINE API error:\s+(\d{3})\b/);
  return match ? Number(match[1]) : null;
}

function broadcastRouteErrorKind(err: unknown): string {
  const status = broadcastLineErrorStatus(err);
  if (status != null) return `line_http_status_${status}`;
  if (err instanceof TypeError) return 'network_error';
  if (err instanceof Error) return err.name || 'error';
  return typeof err;
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > BROADCAST_URL_MAX_LENGTH) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function parseJsonRecordString(value: string): ValueResult<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'invalid_message_content' };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, error: 'invalid_message_content' };
  }
}

function validateMessageContent(messageType: BroadcastMessageType, messageContent: string): ValueResult<string> {
  if (messageType === 'image') {
    const parsed = parseJsonRecordString(messageContent);
    if (!parsed.ok) return parsed;
    if (!isHttpsUrl(parsed.value.originalContentUrl) || !isHttpsUrl(parsed.value.previewImageUrl)) {
      return { ok: false, error: 'invalid_message_content' };
    }
  }
  if (messageType === 'flex') {
    const parsed = parseJsonRecordString(messageContent);
    if (!parsed.ok) return parsed;
    if (typeof parsed.value.type !== 'string') return { ok: false, error: 'invalid_message_content' };
  }
  return { ok: true, value: messageContent };
}

function parseMessageContent(
  raw: unknown,
  messageType: BroadcastMessageType,
  required: boolean,
): ValueResult<string | undefined> {
  if (raw === undefined) {
    return required ? { ok: false, error: 'invalid_message_content' } : { ok: true, value: undefined };
  }
  const parsed = parseRequiredString(raw, 'message_content', BROADCAST_MESSAGE_CONTENT_MAX_LENGTH);
  if (!parsed.ok) return parsed;
  const valid = validateMessageContent(messageType, parsed.value);
  if (!valid.ok) return valid;
  return { ok: true, value: valid.value };
}

function parseIdArray(raw: unknown, label: string, minLength: number): ValueResult<string[]> {
  if (!Array.isArray(raw) || raw.length < minLength || raw.length > BROADCAST_MAX_ACCOUNT_IDS) {
    return { ok: false, error: `invalid_${label}` };
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const parsed = parseSafeSqlId(item, `${label}_item`);
    if (!parsed.ok) return { ok: false, error: `invalid_${label}` };
    if (!seen.has(parsed.value)) {
      seen.add(parsed.value);
      ids.push(parsed.value);
    }
  }
  return { ok: true, value: ids };
}

function parseBroadcastCreate(body: Record<string, unknown>): ValueResult<BroadcastCreatePayload> {
  const title = parseRequiredString(body.title, 'title', BROADCAST_TITLE_MAX_LENGTH);
  if (!title.ok) return title;
  const messageType = parseMessageType(body.messageType, true);
  if (!messageType.ok || messageType.value === undefined) return { ok: false, error: 'invalid_message_type' };
  const messageContent = parseMessageContent(body.messageContent, messageType.value, true);
  if (!messageContent.ok || messageContent.value === undefined) return { ok: false, error: messageContent.ok ? 'invalid_message_content' : messageContent.error };
  const targetType = parseTargetType(body.targetType, true);
  if (!targetType.ok || targetType.value === undefined) return { ok: false, error: 'invalid_target_type' };
  const targetTagId = parseOptionalNullableSafeSqlId(body.targetTagId, 'target_tag_id');
  if (!targetTagId.ok) return targetTagId;
  const scheduledAt = parseScheduledAt(body.scheduledAt);
  if (!scheduledAt.ok) return scheduledAt;
  const lineAccountId = parseOptionalNullableSafeSqlId(body.lineAccountId, 'line_account_id');
  if (!lineAccountId.ok) return lineAccountId;
  const altText = parseOptionalNullableString(body.altText, 'alt_text', BROADCAST_ALT_TEXT_MAX_LENGTH);
  if (!altText.ok) return altText;

  if (targetType.value === 'tag' && !targetTagId.value) {
    return { ok: false, error: 'invalid_target_tag_id' };
  }

  const payload: BroadcastCreatePayload = {
    title: title.value,
    messageType: messageType.value,
    messageContent: messageContent.value,
    targetType: targetType.value,
    targetTagId: targetType.value === 'tag' || targetType.value === 'multi-account-dedup' ? (targetTagId.value ?? null) : null,
    ...(scheduledAt.value !== undefined ? { scheduledAt: scheduledAt.value } : {}),
    ...(lineAccountId.value !== undefined ? { lineAccountId: lineAccountId.value } : {}),
    ...(altText.value !== undefined ? { altText: altText.value } : {}),
  };

  if (targetType.value === 'multi-account-dedup') {
    const accountIds = parseIdArray(body.accountIds, 'account_ids', 1);
    if (!accountIds.ok) return accountIds;
    const dedupPriority = parseIdArray(body.dedupPriority, 'dedup_priority', 0);
    if (!dedupPriority.ok) return dedupPriority;
    const accountIdSet = new Set(accountIds.value);
    payload.accountIds = accountIds.value;
    payload.dedupPriority = dedupPriority.value.filter((id) => accountIdSet.has(id));
  }

  return { ok: true, value: payload };
}

function parseBroadcastUpdate(body: Record<string, unknown>, existing: DbBroadcast): ValueResult<BroadcastUpdatePayload> {
  const input: BroadcastUpdatePayload = {};
  const messageType = parseMessageType(body.messageType, false);
  if (!messageType.ok) return messageType;
  const effectiveMessageType = messageType.value ?? existing.message_type;
  if (messageType.value !== undefined) input.message_type = messageType.value;

  if ('title' in body) {
    const title = parseRequiredString(body.title, 'title', BROADCAST_TITLE_MAX_LENGTH);
    if (!title.ok) return title;
    input.title = title.value;
  }
  if ('messageContent' in body || messageType.value !== undefined) {
    const rawContent = 'messageContent' in body ? body.messageContent : existing.message_content;
    const content = parseMessageContent(rawContent, effectiveMessageType, true);
    if (!content.ok || content.value === undefined) return { ok: false, error: content.ok ? 'invalid_message_content' : content.error };
    if ('messageContent' in body) input.message_content = content.value;
  }

  const targetType = parseTargetType(body.targetType, false);
  if (!targetType.ok) return targetType;
  const effectiveTargetType = targetType.value ?? existing.target_type;
  if (targetType.value !== undefined) input.target_type = targetType.value;

  if ('targetTagId' in body) {
    const targetTagId = parseOptionalNullableSafeSqlId(body.targetTagId, 'target_tag_id');
    if (!targetTagId.ok) return targetTagId;
    input.target_tag_id = targetTagId.value ?? null;
  }
  const effectiveTargetTagId = 'target_tag_id' in input ? input.target_tag_id : existing.target_tag_id;
  if (effectiveTargetType === 'tag' && !effectiveTargetTagId) {
    return { ok: false, error: 'invalid_target_tag_id' };
  }
  if (targetType.value !== undefined && targetType.value !== 'tag' && !('targetTagId' in body)) {
    input.target_tag_id = null;
  }

  if ('scheduledAt' in body) {
    const scheduledAt = parseScheduledAt(body.scheduledAt);
    if (!scheduledAt.ok) return scheduledAt;
    input.scheduled_at = scheduledAt.value ?? null;
    input.status = scheduledAt.value ? 'scheduled' : 'draft';
  }

  if (Object.keys(input).length === 0) return { ok: false, error: 'empty_update' };
  return { ok: true, value: input };
}

function parseSegmentCondition(raw: unknown): ValueResult<SegmentCondition> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'invalid_conditions' };
  if (JSON.stringify(raw).length > BROADCAST_SEGMENT_MAX_BYTES) return { ok: false, error: 'invalid_conditions' };
  const condition = raw as Record<string, unknown>;
  if (condition.operator !== 'AND' && condition.operator !== 'OR') return { ok: false, error: 'invalid_conditions' };
  if (!Array.isArray(condition.rules) || condition.rules.length > BROADCAST_SEGMENT_MAX_RULES) {
    return { ok: false, error: 'invalid_conditions' };
  }
  const rules: SegmentCondition['rules'] = [];
  for (const item of condition.rules) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { ok: false, error: 'invalid_conditions' };
    const rule = item as Record<string, unknown>;
    if (typeof rule.type !== 'string' || !BROADCAST_SEGMENT_RULE_TYPES.has(rule.type)) {
      return { ok: false, error: 'invalid_conditions' };
    }
    if (rule.type === 'is_following') {
      if (typeof rule.value !== 'boolean') return { ok: false, error: 'invalid_conditions' };
      rules.push({ type: rule.type, value: rule.value });
      continue;
    }
    if (rule.type === 'metadata_equals' || rule.type === 'metadata_not_equals') {
      if (!rule.value || typeof rule.value !== 'object' || Array.isArray(rule.value)) {
        return { ok: false, error: 'invalid_conditions' };
      }
      const value = rule.value as Record<string, unknown>;
      const key = parseSafeSqlId(value.key, 'metadata_key');
      if (!key.ok) return { ok: false, error: 'invalid_conditions' };
      const stringValue = parseRequiredString(value.value, 'metadata_value', BROADCAST_ID_MAX_LENGTH);
      if (!stringValue.ok) return { ok: false, error: 'invalid_conditions' };
      rules.push({ type: rule.type, value: { key: key.value, value: stringValue.value } });
      continue;
    }
    const value = parseSafeSqlId(rule.value, 'segment_rule_value');
    if (!value.ok) return { ok: false, error: 'invalid_conditions' };
    rules.push({ type: rule.type as 'tag_exists' | 'tag_not_exists' | 'ref_code', value: value.value });
  }
  return { ok: true, value: { operator: condition.operator, rules } };
}

/**
 * Parse a D1 JSON-array column. Returns:
 *   - null if the column is null/undefined/empty string or parse fails
 *   - the value as-is if already an array (some D1 drivers auto-parse JSON columns)
 *   - the parsed array if the JSON is a valid string-array
 *   - null if parsed JSON is not an array (e.g., object, scalar)
 */
function parseJsonArray(s: unknown): string[] | null {
  if (!s) return null;
  if (Array.isArray(s)) return s as string[];
  if (typeof s !== 'string') return null;
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? (parsed as string[]) : null;
  } catch {
    return null;
  }
}

function serializeBroadcast(row: DbBroadcast) {
  const r = row as unknown as Record<string, unknown>;
  return {
    id: row.id,
    title: row.title,
    messageType: row.message_type,
    messageContent: row.message_content,
    targetType: row.target_type,
    targetTagId: row.target_tag_id,
    status: row.status,
    scheduledAt: row.scheduled_at,
    sentAt: row.sent_at,
    totalCount: row.total_count,
    successCount: row.success_count,
    lineRequestId: r.line_request_id || null,
    aggregationUnit: r.aggregation_unit || null,
    lineAccountId: r.line_account_id || null,
    accountIds: parseJsonArray(r.account_ids),
    dedupPriority: parseJsonArray(r.dedup_priority),
    failedAccountIds: parseJsonArray(r.failed_account_ids),
    createdAt: row.created_at,
  };
}

// GET /api/broadcasts - list all
broadcasts.get('/api/broadcasts', requireRole('owner', 'admin'), async (c) => {
  try {
    const lineAccountId = parseOptionalSafeSqlId(c.req.query('lineAccountId'), 'line_account_id');
    if (!lineAccountId.ok) return c.json({ success: false, error: lineAccountId.error }, 400);
    const items = await getBroadcasts(c.env.DB, lineAccountId.value);
    return c.json({ success: true, data: items.map(serializeBroadcast) });
  } catch (err) {
    console.error(`GET /api/broadcasts error: ${broadcastRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/broadcasts/:id - get single
broadcasts.get('/api/broadcasts/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = parseSafeSqlId(c.req.param('id'), 'broadcast_id');
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const broadcast = await getBroadcastById(c.env.DB, id.value);

    if (!broadcast) {
      return c.json({ success: false, error: 'Broadcast not found' }, 404);
    }

    return c.json({ success: true, data: serializeBroadcast(broadcast) });
  } catch (err) {
    console.error(`GET /api/broadcasts/:id error: ${broadcastRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/broadcasts/:id/preview-count — 送信前の対象人数を計算する。
// draft 状態の broadcast に対し、send 確認モーダルで「対象 X人」を表示するために使う。
// target_type ごとに使う SQL を切り替える。total_count は send 後にしか入らないので、
// このエンドポイントが「送ったらこの人数」を返す唯一の手段。
broadcasts.get('/api/broadcasts/:id/preview-count', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = parseSafeSqlId(c.req.param('id'), 'broadcast_id');
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const broadcast = await getBroadcastById(c.env.DB, id.value);
    if (!broadcast) {
      return c.json({ success: false, error: 'Broadcast not found' }, 404);
    }

    const raw = broadcast as unknown as Record<string, unknown>;
    let count = 0;
    let perAccount: Array<{ accountId: string; sendCount: number }> | undefined;

    if (broadcast.target_type === 'multi-account-dedup') {
      const accountIds = parseJsonArray(raw.account_ids) ?? [];
      const dedupPriority = parseJsonArray(raw.dedup_priority) ?? [];
      const preview = await computeDedupBroadcastPreview(
        c.env.DB,
        accountIds,
        dedupPriority,
        broadcast.target_tag_id ?? null,
      );
      // /send パスと同じく inactive/missing アカウントを除外して、実送信数の見積りを返す。
      // 同時に per-account breakdown も返して confirm modal に表示できるようにする。
      const { getLineAccountById } = await import('@line-crm/db');
      let active = 0;
      const breakdown: Array<{ accountId: string; sendCount: number }> = [];
      for (const a of preview.perAccount) {
        const account = await getLineAccountById(c.env.DB, a.accountId);
        if (account && account.is_active) {
          active += a.recipients.length;
          breakdown.push({ accountId: a.accountId, sendCount: a.recipients.length });
        }
      }
      count = active;
      perAccount = breakdown;
    } else if (broadcast.target_type === 'tag' && broadcast.target_tag_id) {
      // 注: ここは inline send パス (broadcast.ts:61 getFriendsByTag) が
      // line_account_id でフィルタしないので、preview もアカウント横断で数える。
      // 実際の送信先と modal 表示を一致させるための整合性。
      const row = await c.env.DB.prepare(
        `SELECT COUNT(*) AS cnt FROM friends f
           INNER JOIN friend_tags ft ON ft.friend_id = f.id
           WHERE ft.tag_id = ? AND f.is_following = 1`,
      ).bind(broadcast.target_tag_id).first<{ cnt: number }>();
      count = row?.cnt ?? 0;
    } else if (broadcast.target_type === 'all') {
      const accountId = (raw.line_account_id as string | null) || null;
      const sql = accountId
        ? `SELECT COUNT(*) AS cnt FROM friends WHERE is_following = 1 AND line_account_id = ?`
        : `SELECT COUNT(*) AS cnt FROM friends WHERE is_following = 1`;
      const binds: unknown[] = accountId ? [accountId] : [];
      const row = await c.env.DB.prepare(sql).bind(...binds).first<{ cnt: number }>();
      count = row?.cnt ?? 0;
    }

    return c.json({ success: true, data: { count, perAccount } });
  } catch (err) {
    console.error(`GET /api/broadcasts/:id/preview-count error: ${broadcastRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/broadcasts/:id/per-account-stats — multi-account-dedup などで
// アカウント別の配信数 + insight 内訳を返す。
//
// 返り値:
//   data: [{
//     accountId, accountName,
//     sent: number,                    // messages_log での実送信数
//     uniqueImpression: number | null, // LINE Insight (アカ token で個別 fetch)
//     uniqueClick: number | null,
//   }]
//
// insight は live で各アカウントの token を使って LINE API を叩く (sent and aggregation_unit 必須)。
// キャッシュしない (broadcast_insights は集計値しか持たない設計のため)。
broadcasts.get('/api/broadcasts/:id/per-account-stats', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = parseSafeSqlId(c.req.param('id'), 'broadcast_id');
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const broadcast = await getBroadcastById(c.env.DB, id.value);
    if (!broadcast) {
      return c.json({ success: false, error: 'Broadcast not found' }, 404);
    }

    const raw = broadcast as unknown as Record<string, unknown>;
    const aggregationUnit = (raw.aggregation_unit as string | null) || null;

    // 対象アカウントリスト: dedup なら account_ids JSON、それ以外なら line_account_id 単独
    let accountIds: string[];
    if (broadcast.target_type === 'multi-account-dedup') {
      accountIds = parseJsonArray(raw.account_ids) ?? [];
    } else {
      const single = (raw.line_account_id as string | null) || null;
      accountIds = single ? [single] : [];
    }

    if (accountIds.length === 0) {
      return c.json({ success: true, data: [] });
    }

    // sent 数: messages_log の line_account_id (送信時固定) で GROUP BY する。
    // 旧データ (032 migration 前) は ml.line_account_id=NULL なので、その場合だけ
    // friends.line_account_id にフォールバックする (best-effort、現在のアカウント帰属で集計)。
    const placeholders = accountIds.map(() => '?').join(',');
    const sentRes = await c.env.DB.prepare(
      `SELECT COALESCE(ml.line_account_id, f.line_account_id) AS account_id, COUNT(*) AS sent
       FROM messages_log ml
       INNER JOIN friends f ON f.id = ml.friend_id
       WHERE ml.broadcast_id = ? AND ml.direction = 'outgoing'
         AND COALESCE(ml.line_account_id, f.line_account_id) IN (${placeholders})
       GROUP BY COALESCE(ml.line_account_id, f.line_account_id)`,
    ).bind(id.value, ...accountIds).all<{ account_id: string; sent: number }>();
    const sentMap = new Map<string, number>();
    for (const r of sentRes.results ?? []) sentMap.set(r.account_id, r.sent);

    // アカウント名
    const metaRes = await c.env.DB.prepare(
      `SELECT id, name FROM line_accounts WHERE id IN (${placeholders})`,
    ).bind(...accountIds).all<{ id: string; name: string }>();
    const nameMap = new Map<string, string>();
    for (const r of metaRes.results ?? []) nameMap.set(r.id, r.name);

    // insight: status='sent' かつ aggregation_unit がある場合だけ live fetch する。
    // 各アカウントの LINE API call は 3-5 秒かかるので、Promise.all で並列化して
    // 4 アカ夢中なら ~5 秒、シリアルだと ~20 秒の差。Worker / browser timeout 回避用。
    const insightMap = new Map<string, { uniqueImpression: number | null; uniqueClick: number | null }>();
    if (broadcast.status === 'sent' && aggregationUnit && broadcast.sent_at) {
      const sentDate = broadcast.sent_at.slice(0, 10).replace(/-/g, '');
      const { getLineAccountById } = await import('@line-crm/db');
      await Promise.all(
        accountIds.map(async (aid) => {
          const account = await getLineAccountById(c.env.DB, aid);
          if (!account) return;
          try {
            const client = new LineClient(account.channel_access_token);
            const response = await client.getUnitInsight(aggregationUnit, sentDate, sentDate) as Record<string, unknown>;
            const messages = response.messages as Array<Record<string, unknown>> | undefined;
            const overview = messages?.[0] || {};
            insightMap.set(aid, {
              uniqueImpression: (overview.uniqueImpression as number) ?? null,
              uniqueClick: (overview.uniqueClick as number) ?? null,
            });
          } catch (err) {
            console.error(`[per-account-stats] insight failed: ${broadcastRouteErrorKind(err)}`);
          }
        }),
      );
    }

    const result = accountIds.map((aid) => ({
      accountId: aid,
      accountName: nameMap.get(aid) ?? aid,
      sent: sentMap.get(aid) ?? 0,
      uniqueImpression: insightMap.get(aid)?.uniqueImpression ?? null,
      uniqueClick: insightMap.get(aid)?.uniqueClick ?? null,
    }));

    return c.json({ success: true, data: result });
  } catch (err) {
    console.error(`GET /api/broadcasts/:id/per-account-stats error: ${broadcastRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/broadcasts - create
broadcasts.post('/api/broadcasts', requireRole('owner', 'admin'), async (c) => {
  try {
    const rawBody = await readJsonObject(c);
    if (!rawBody.ok) return c.json({ success: false, error: rawBody.error }, 400);
    const body = parseBroadcastCreate(rawBody.value);
    if (!body.ok) return c.json({ success: false, error: body.error }, 400);

    const broadcast = await createBroadcast(c.env.DB, {
      title: body.value.title,
      messageType: body.value.messageType,
      messageContent: body.value.messageContent,
      targetType: body.value.targetType,
      targetTagId: body.value.targetTagId,
      scheduledAt: body.value.scheduledAt ?? null,
      accountIds: body.value.accountIds,
      dedupPriority: body.value.dedupPriority,
    });

    // Save line_account_id and alt_text if provided
    const updates: string[] = [];
    const binds: unknown[] = [];
    if (body.value.lineAccountId) { updates.push('line_account_id = ?'); binds.push(body.value.lineAccountId); }
    if (body.value.altText) { updates.push('alt_text = ?'); binds.push(body.value.altText); }
    if (updates.length > 0) {
      binds.push(broadcast.id);
      await c.env.DB.prepare(`UPDATE broadcasts SET ${updates.join(', ')} WHERE id = ?`)
        .bind(...binds).run();
    }

    return c.json({ success: true, data: serializeBroadcast(broadcast) }, 201);
  } catch (err) {
    console.error(`POST /api/broadcasts error: ${broadcastRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PUT /api/broadcasts/:id - update draft
broadcasts.put('/api/broadcasts/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = parseSafeSqlId(c.req.param('id'), 'broadcast_id');
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const rawBody = await readJsonObject(c);
    if (!rawBody.ok) return c.json({ success: false, error: rawBody.error }, 400);
    const existing = await getBroadcastById(c.env.DB, id.value);

    if (!existing) {
      return c.json({ success: false, error: 'Broadcast not found' }, 404);
    }

    if (existing.status !== 'draft' && existing.status !== 'scheduled') {
      return c.json({ success: false, error: 'Only draft or scheduled broadcasts can be updated' }, 400);
    }

    const body = parseBroadcastUpdate(rawBody.value, existing);
    if (!body.ok) return c.json({ success: false, error: body.error }, 400);

    const updated = await updateBroadcast(c.env.DB, id.value, body.value);

    // 失敗 partial dedup broadcast を draft に戻して編集 → 再送するケースで、
    // 残っていた resume 用 state を全部クリアして fresh campaign として送り直せる
    // ようにする。
    // - dedup_progress: 残すと過去 partial を skip して mixed delivery 事故
    // - success_count: 残すと recover 経路の `success_count > 0 + dedup_progress=NULL`
    //   排除条件にひっかかって永久に stuck になる (再 lock 後 crash で復旧不可)
    // - failed_account_ids: 過去 attempt の失敗 mark を継承するのは misleading
    // - batch_lock_at: stale lock 跡を残さない
    // - sent_at: 念のため NULL に戻す。getQueuedBroadcasts / recoverStalledBroadcasts は
    //   `sent_at IS NULL` を要求するので、過去 sent 値が残ると永久 stuck の元
    // - aggregation_unit / line_request_id: 過去送信の insight 集計参照を残さない
    await c.env.DB.prepare(
      `UPDATE broadcasts SET
         dedup_progress = NULL,
         batch_lock_at = NULL,
         success_count = 0,
         failed_account_ids = NULL,
         sent_at = NULL,
         aggregation_unit = NULL,
         line_request_id = NULL
       WHERE id = ?`,
    ).bind(id.value).run();

    // 過去 send の insight 行を削除する。createBroadcastInsight は idempotent で
    // 既存行があれば skip する設計のため、削除しないと再送時に新しい pending
    // insight が作られず getPendingInsights / GET /insight が古い metrics を返し続ける。
    await c.env.DB.prepare(
      `DELETE FROM broadcast_insights WHERE broadcast_id = ?`,
    ).bind(id.value).run();

    return c.json({ success: true, data: updated ? serializeBroadcast(updated) : null });
  } catch (err) {
    console.error(`PUT /api/broadcasts/:id error: ${broadcastRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/broadcasts/:id - delete
broadcasts.delete('/api/broadcasts/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = parseSafeSqlId(c.req.param('id'), 'broadcast_id');
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    await deleteBroadcast(c.env.DB, id.value);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error(`DELETE /api/broadcasts/:id error: ${broadcastRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/broadcasts/:id/send - send now (tag配信で500人超はキュー方式)
//
// Atomic UPDATE-WHERE で多重起動を防ぐ。check-then-act の TOCTOU race だと、
// 並列リクエストが同時に status='draft' を読んで両方が processBroadcastSend に
// 進入しうる (2026-04-10 19:50 の重複配信事故 broadcast 0069eb9f / 57c9667d)。
// 既存の lock 修正 (a27ad9f / bffcdf8 / 3ac2fec) は cron / scheduled 経路を
// 守ったが、API direct 経路は未対応のままだった。
broadcasts.post('/api/broadcasts/:id/send', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = parseSafeSqlId(c.req.param('id'), 'broadcast_id');
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const existing = await getBroadcastById(c.env.DB, id.value);

    if (!existing) {
      return c.json({ success: false, error: 'Broadcast not found' }, 404);
    }

    // multi-account-dedup は常にキュー方式 — Worker の30秒制限を超えるため
    if (existing.target_type === 'multi-account-dedup') {
      // Always queue — never run inline. The executor walks per-account multicast
      // loops which can exceed the Worker's 30 s wall-clock if invoked synchronously.
      // Use status='sending' + batch_offset=0 to signal queued; processed by cron
      // via processQueuedBroadcasts (schema CHECK allows only draft/scheduled/sending/sent).
      //
      // total_count を同期計算して書く: progress polling が 0/0 のまま固まらないように。
      // computeDedupBroadcastPreview は単一SQL (ROW_NUMBER OVER) なので軽量。
      const rawExisting = existing as unknown as Record<string, unknown>;
      const accountIds = parseJsonArray(rawExisting.account_ids) ?? [];
      const dedupPriority = parseJsonArray(rawExisting.dedup_priority) ?? [];
      const preview = await computeDedupBroadcastPreview(
        c.env.DB,
        accountIds,
        dedupPriority,
        existing.target_tag_id ?? null,
      );

      // executor (processMultiAccountDedupBroadcast) は inactive/missing
      // アカウントを skip するので、total_count もそれに揃える。preview は
      // inactive 分も含めた全件を返すため、ここでアカウント状態を引き直して
      // active 分だけ集計する。これで confirm/progress UI と実送信数が一致する。
      let projectedTotal = 0;
      const { getLineAccountById } = await import('@line-crm/db');
      for (const a of preview.perAccount) {
        const account = await getLineAccountById(c.env.DB, a.accountId);
        if (account && account.is_active) projectedTotal += a.recipients.length;
      }

      const lockResult = await c.env.DB.prepare(
        `UPDATE broadcasts SET status = 'sending', batch_offset = 0, total_count = ? WHERE id = ? AND status IN ('draft','scheduled')`
      ).bind(projectedTotal, id.value).run();
      if (!lockResult.meta.changes) {
        return c.json({ success: false, error: 'Broadcast is already sent or sending' }, 409);
      }

      // cron (5min) を待たず即時にバックグラウンド処理を起動する。waitUntil なら
      // レスポンス返却後も Worker が処理を続行できる。失敗しても cron が拾うので
      // 二重で安全。processQueuedBroadcasts 内の楽観ロック (batch_offset=-1) が
      // 並走を防ぐ。
      try {
        const ctx = c.executionCtx as ExecutionContext;
        const defaultClient = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);
        ctx.waitUntil(
          processQueuedBroadcasts(c.env.DB, defaultClient, c.env.WORKER_URL).catch((err) => {
            console.error(`[multi-account-dedup] background queue processing failed: ${broadcastRouteErrorKind(err)}`);
          }),
        );
      } catch (kickErr) {
        // ExecutionContext 未利用環境 (test 等) — cron 経由にフォールバック
        console.warn(`[multi-account-dedup] waitUntil unavailable, falling back to cron: ${broadcastRouteErrorKind(kickErr)}`);
      }

      return c.json({
        success: true,
        data: { id: id.value, status: 'sending', totalCount: projectedTotal },
        queued: true,
        message: 'Broadcast queued for immediate background processing',
      }, 202);
    }

    // target_type='tag' で対象が多い場合はキュー方式
    if (existing.target_type === 'tag' && existing.target_tag_id) {
      const { getFriendsByTag } = await import('@line-crm/db');
      const friends = await getFriendsByTag(c.env.DB, existing.target_tag_id);
      const followingCount = friends.filter(f => f.is_following).length;

      if (followingCount > 500) {
        // Atomic lock: status='draft'|'scheduled' のときだけ status='sending' に遷移
        const tagMarker = JSON.stringify({ operator: 'AND', rules: [{ type: 'tag_exists', value: existing.target_tag_id }] });
        const lockResult = await c.env.DB.prepare(
          `UPDATE broadcasts SET status = 'sending', batch_offset = 0, segment_conditions = ? WHERE id = ? AND status IN ('draft','scheduled')`
        ).bind(tagMarker, id.value).run();
        if (!lockResult.meta.changes) {
          return c.json({ success: false, error: 'Broadcast is already sent or sending' }, 409);
        }
        const result = await getBroadcastById(c.env.DB, id.value);
        return c.json({ success: true, data: result ? serializeBroadcast(result) : null, queued: true, message: 'Broadcast queued for batch processing by Cron' }, 202);
      }
    }

    // 500人以下またはtarget_type='all'は即時送信
    // accessToken 解決は lock 前に行う (setup 失敗時に status='sending' で stuck しないため、
    // 即時送信パスには recoverStalledBroadcasts がない)
    let accessToken = c.env.LINE_CHANNEL_ACCESS_TOKEN;
    const broadcastAccountId = (existing as unknown as Record<string, unknown>).line_account_id;
    if (broadcastAccountId) {
      const { getLineAccountById } = await import('@line-crm/db');
      const account = await getLineAccountById(c.env.DB, broadcastAccountId as string);
      if (account) accessToken = account.channel_access_token;
    }
    const lineClient = new LineClient(accessToken);

    // atomic lock — 'draft' と 'scheduled' を分けて単一 UPDATE で claim する。
    // 各 UPDATE は単一 write statement なので read-then-write transaction の
    // SQLITE_BUSY_SNAPSHOT を引き起こさず、claim 成功時の status も WHERE 句から
    // 一意に確定する (rollback 時の status 復元に使用)。
    let claimedStatus: 'draft' | 'scheduled' | null = null;
    const draftClaim = await c.env.DB.prepare(
      `UPDATE broadcasts SET status = 'sending' WHERE id = ? AND status = 'draft'`
    ).bind(id.value).run();
    if (draftClaim.meta.changes) {
      claimedStatus = 'draft';
    } else {
      const schedClaim = await c.env.DB.prepare(
        `UPDATE broadcasts SET status = 'sending' WHERE id = ? AND status = 'scheduled'`
      ).bind(id.value).run();
      if (schedClaim.meta.changes) {
        claimedStatus = 'scheduled';
      }
    }
    if (!claimedStatus) {
      return c.json({ success: false, error: 'Broadcast is already sent or sending' }, 409);
    }

    // processBroadcastSend は内部の try/catch で multicast 失敗を 'draft' に戻すが、
    // 冒頭 (updateBroadcastStatus / getBroadcastById / autoTrackContent / buildMessage) で
    // 失敗した場合は内部 catch の対象外。lock を外側で必ず rollback する。
    try {
      await processBroadcastSend(c.env.DB, lineClient, id.value, c.env.WORKER_URL);
    } catch (err) {
      await c.env.DB.prepare(
        `UPDATE broadcasts SET status = ? WHERE id = ? AND status = 'sending'`
      ).bind(claimedStatus, id.value).run();
      throw err;
    }

    const result = await getBroadcastById(c.env.DB, id.value);
    return c.json({ success: true, data: result ? serializeBroadcast(result) : null });
  } catch (err) {
    console.error(`POST /api/broadcasts/:id/send error: ${broadcastRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/broadcasts/:id/send-segment - send to a filtered segment (常にキュー方式)
broadcasts.post('/api/broadcasts/:id/send-segment', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = parseSafeSqlId(c.req.param('id'), 'broadcast_id');
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const rawBody = await readJsonObject(c);
    if (!rawBody.ok) return c.json({ success: false, error: rawBody.error }, 400);
    const conditions = parseSegmentCondition(rawBody.value.conditions);
    if (!conditions.ok) return c.json({ success: false, error: conditions.error }, 400);
    const existing = await getBroadcastById(c.env.DB, id.value);

    if (!existing) {
      return c.json({ success: false, error: 'Broadcast not found' }, 404);
    }

    // Atomic lock: status='draft'|'scheduled' のときだけ status='sending' に遷移
    const lockResult = await c.env.DB.prepare(
      `UPDATE broadcasts SET status = 'sending', batch_offset = 0, segment_conditions = ? WHERE id = ? AND status IN ('draft','scheduled')`
    ).bind(JSON.stringify(conditions.value), id.value).run();
    if (!lockResult.meta.changes) {
      return c.json({ success: false, error: 'Broadcast is already sent or sending' }, 409);
    }

    const result = await getBroadcastById(c.env.DB, id.value);
    return c.json({ success: true, data: result ? serializeBroadcast(result) : null, queued: true, message: 'Broadcast queued for batch processing by Cron' }, 202);
  } catch (err) {
    console.error(`POST /api/broadcasts/:id/send-segment error: ${broadcastRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/broadcasts/:id/insight — インサイト（開封率・クリック率）取得
broadcasts.get('/api/broadcasts/:id/insight', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = parseSafeSqlId(c.req.param('id'), 'broadcast_id');
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const insight = await c.env.DB.prepare(
      'SELECT * FROM broadcast_insights WHERE broadcast_id = ? ORDER BY created_at DESC LIMIT 1'
    ).bind(id.value).first<Record<string, unknown>>();

    if (!insight) {
      return c.json({ success: true, data: null, message: 'Insight not yet available' });
    }

    return c.json({
      success: true,
      data: {
        broadcastId: insight.broadcast_id,
        delivered: insight.delivered,
        uniqueImpression: insight.unique_impression,
        uniqueClick: insight.unique_click,
        uniqueMediaPlayed: insight.unique_media_played,
        openRate: insight.open_rate,
        clickRate: insight.click_rate,
        status: insight.status,
        fetchedAt: insight.fetched_at,
      },
    });
  } catch (err) {
    console.error(`GET /api/broadcasts/:id/insight error: ${broadcastRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/broadcasts/:id/fetch-insight — LINE APIからインサイトを即時取得
broadcasts.post('/api/broadcasts/:id/fetch-insight', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = parseSafeSqlId(c.req.param('id'), 'broadcast_id');
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const broadcast = await getBroadcastById(c.env.DB, id.value);
    if (!broadcast) {
      return c.json({ success: false, error: 'Broadcast not found' }, 404);
    }
    if (broadcast.status !== 'sent') {
      return c.json({ success: false, error: 'Broadcast has not been sent yet' }, 400);
    }

    // DBから直接取得してline_request_id/aggregation_unit/account_ids/failed_account_idsを確実に読む
    const rawBroadcast = await c.env.DB.prepare(
      'SELECT line_request_id, aggregation_unit, line_account_id, target_type, account_ids, failed_account_ids FROM broadcasts WHERE id = ?',
    ).bind(id.value).first<Record<string, string | null>>();
    const lineRequestId = rawBroadcast?.line_request_id || null;
    const aggregationUnit = rawBroadcast?.aggregation_unit || null;
    const targetType = rawBroadcast?.target_type || null;

    if (!lineRequestId && !aggregationUnit) {
      return c.json({ success: false, error: 'No line_request_id or aggregation_unit available for this broadcast' }, 400);
    }

    let delivered: number | null = null;
    let uniqueImpression: number | null = null;
    let uniqueClick: number | null = null;
    let uniqueMediaPlayed: number | null = null;
    let rawResponse: string = '{}';

    const sentDate = broadcast.sent_at!.slice(0, 10).replace(/-/g, '');

    if (lineRequestId) {
      // broadcast API ('all') 経由の insight: 単一 lineRequestId で取れる
      const accountId = rawBroadcast?.line_account_id || null;
      let accessToken = c.env.LINE_CHANNEL_ACCESS_TOKEN;
      if (accountId) {
        const { getLineAccountById } = await import('@line-crm/db');
        const account = await getLineAccountById(c.env.DB, accountId);
        if (account) accessToken = account.channel_access_token;
      }
      const lineClient = new LineClient(accessToken);
      const response = await lineClient.getMessageEventInsight(lineRequestId) as Record<string, unknown>;
      const overview = response.overview as Record<string, unknown> | undefined;
      delivered = (overview?.delivered as number) ?? null;
      uniqueImpression = (overview?.uniqueImpression as number) ?? null;
      uniqueClick = (overview?.uniqueClick as number) ?? null;
      uniqueMediaPlayed = (overview?.uniqueMediaPlayed as number) ?? null;
      rawResponse = JSON.stringify(response);
    } else if (aggregationUnit && targetType === 'multi-account-dedup') {
      // 多アカ dedup: 同じ unit 名を全アカウントの multicast で共有しているが、
      // LINE 側のカウントはチャネルごとに独立しているため、各アカウントの
      // channel_access_token で getUnitInsight を呼んで合算する。
      // failed_account_ids は除外しない: アカウントは途中バッチで例外を出しても
      // それ以前のバッチは送信成功している可能性があるため、部分配信の insight も
      // 拾うべき。
      const accountIds = parseJsonArray(rawBroadcast?.account_ids) ?? [];

      const { getLineAccountById } = await import('@line-crm/db');
      const responses: Array<{ accountId: string; data: Record<string, unknown> }> = [];

      let aggImpression = 0;
      let aggClick = 0;
      let aggMedia = 0;
      let hasAnyData = false;
      let allCallsFailed = true;

      for (const aid of accountIds) {
        // is_active は意図的にチェックしない: 送信時にアクティブだったアカウントが
        // insight 取得時に deactivate されてる可能性がある。token があれば LINE
        // API は叩けるので、過去配信の集計を欠損させない。
        const account = await getLineAccountById(c.env.DB, aid);
        if (!account) continue;
        const client = new LineClient(account.channel_access_token);
        try {
          const response = await client.getUnitInsight(aggregationUnit, sentDate, sentDate) as Record<string, unknown>;
          responses.push({ accountId: aid, data: response });
          allCallsFailed = false;
          const messages = response.messages as Array<Record<string, unknown>> | undefined;
          const overview = messages?.[0] || {};
          aggImpression += (overview.uniqueImpression as number) ?? 0;
          aggClick += (overview.uniqueClick as number) ?? 0;
          aggMedia += (overview.uniqueMediaPlayed as number) ?? 0;
          if (messages && messages.length > 0) hasAnyData = true;
        } catch (err) {
          const errorKind = broadcastRouteErrorKind(err);
          console.error(`[fetch-insight] dedup account insight failed: ${errorKind}`);
          responses.push({ accountId: aid, data: { error: errorKind } });
        }
      }

      if (allCallsFailed && accountIds.length > 0) {
        // 全アカウントの API 呼び出しが失敗した場合、blank insight を保存して
        // retry ボタンを潰さないように 502 を返す (ユーザーが再試行できる状態)。
        return c.json({
          success: false,
          error: 'All account insight fetches failed; please retry later',
        }, 502);
      }

      if (hasAnyData) {
        uniqueImpression = aggImpression;
        uniqueClick = aggClick;
        uniqueMediaPlayed = aggMedia;
      }
      // delivered は unit insight には含まれない (LINE 仕様)。dedup の場合は
      // broadcasts.success_count を delivered として採用する (送達数の近似値)。
      delivered = (broadcast as unknown as Record<string, number | null>).success_count ?? null;
      rawResponse = JSON.stringify({ perAccount: responses });
    } else if (aggregationUnit) {
      // tag broadcast (単一アカ): 既存パス
      const accountId = rawBroadcast?.line_account_id || null;
      let accessToken = c.env.LINE_CHANNEL_ACCESS_TOKEN;
      if (accountId) {
        const { getLineAccountById } = await import('@line-crm/db');
        const account = await getLineAccountById(c.env.DB, accountId);
        if (account) accessToken = account.channel_access_token;
      }
      const lineClient = new LineClient(accessToken);
      const response = await lineClient.getUnitInsight(aggregationUnit, sentDate, sentDate) as Record<string, unknown>;
      const messages = response.messages as Array<Record<string, unknown>> | undefined;
      const overview = messages?.[0] || {};
      uniqueImpression = (overview.uniqueImpression as number) ?? null;
      uniqueClick = (overview.uniqueClick as number) ?? null;
      uniqueMediaPlayed = (overview.uniqueMediaPlayed as number) ?? null;
      rawResponse = JSON.stringify(response);
    }

    const openRate = (delivered && uniqueImpression) ? uniqueImpression / delivered : null;
    const clickRate = (delivered && uniqueClick) ? uniqueClick / delivered : null;

    // 旧コードの `ON CONFLICT(broadcast_id)` は broadcast_insights.broadcast_id に
    // UNIQUE 制約がないため D1 が `SQLITE_ERROR: ON CONFLICT clause does not match
    // any PRIMARY KEY or UNIQUE constraint` を返して 500 化していた。
    // SELECT で既存の pending 行を探して UPDATE、なければ INSERT する明示的 upsert に置き換え。
    const { jstNow } = await import('@line-crm/db');
    const now = jstNow();
    const existing = await c.env.DB.prepare(
      'SELECT id FROM broadcast_insights WHERE broadcast_id = ? ORDER BY created_at DESC LIMIT 1',
    ).bind(id.value).first<{ id: string }>();

    if (existing) {
      await c.env.DB.prepare(
        `UPDATE broadcast_insights SET
           delivered = ?, unique_impression = ?, unique_click = ?, unique_media_played = ?,
           open_rate = ?, click_rate = ?, raw_response = ?, status = 'ready', fetched_at = ?
         WHERE id = ?`,
      ).bind(delivered, uniqueImpression, uniqueClick, uniqueMediaPlayed, openRate, clickRate, rawResponse, now, existing.id).run();
    } else {
      const insightId = crypto.randomUUID();
      await c.env.DB.prepare(
        `INSERT INTO broadcast_insights (id, broadcast_id, delivered, unique_impression, unique_click, unique_media_played, open_rate, click_rate, raw_response, status, fetched_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)`,
      ).bind(insightId, id.value, delivered, uniqueImpression, uniqueClick, uniqueMediaPlayed, openRate, clickRate, rawResponse, now, now).run();
    }

    return c.json({
      success: true,
      data: { delivered, uniqueImpression, uniqueClick, uniqueMediaPlayed, openRate, clickRate },
    });
  } catch (err) {
    console.error(`POST /api/broadcasts/:id/fetch-insight error: ${broadcastRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/broadcasts/:id/test-send — send to test recipients with 【テスト配信】 label
broadcasts.post('/api/broadcasts/:id/test-send', requireRole('owner', 'admin'), async (c) => {
  const id = parseSafeSqlId(c.req.param('id'), 'broadcast_id');
  if (!id.ok) return c.json({ success: false, error: id.error }, 400);
  try {
    const broadcast = await getBroadcastById(c.env.DB, id.value);
    if (!broadcast) return c.json({ success: false, error: 'Broadcast not found' }, 404);
    if (broadcast.status !== 'draft') {
      return c.json({ success: false, error: 'Only draft broadcasts can be test-sent' }, 400);
    }

    const raw = broadcast as unknown as Record<string, unknown>;
    const accountId = raw.line_account_id as string | null;
    if (!accountId) return c.json({ success: false, error: 'Broadcast has no line_account_id' }, 400);

    // Get test recipients
    const setting = await c.env.DB.prepare(
      `SELECT value FROM account_settings WHERE line_account_id = ? AND key = 'test_recipients'`
    ).bind(accountId).first<{ value: string }>();
    if (!setting) return c.json({ success: false, error: 'No test recipients configured' }, 400);

    const friendIds: string[] = JSON.parse(setting.value);
    if (friendIds.length === 0) return c.json({ success: false, error: 'No test recipients configured' }, 400);

    const placeholders = friendIds.map(() => '?').join(',');
    const visibility = supportFriendVisibilitySql(currentSupportStaff(c), 'f.id');
    const friends = await c.env.DB.prepare(
      `SELECT f.id, f.line_user_id
       FROM friends f
       WHERE f.id IN (${placeholders})${visibility.sql ? ` AND ${visibility.sql}` : ''}`
    ).bind(...friendIds, ...visibility.binds).all<{ id: string; line_user_id: string }>();
    if (friends.results.length === 0) {
      return c.json({ success: false, error: 'No accessible test recipients configured' }, 400);
    }

    const account = await getLineAccountById(c.env.DB, accountId);
    if (!account) return c.json({ success: false, error: 'LINE account not found' }, 400);
    const lineClient = new LineClient(account.channel_access_token);

    // Build message with test label
    let messageContent = broadcast.message_content;
    if (broadcast.message_type === 'text') {
      messageContent = `【テスト配信】\n${messageContent}`;
    }

    // Auto-track URLs
    const { autoTrackContent } = await import('../services/auto-track.js');
    const tracked = await autoTrackContent(c.env.DB, broadcast.message_type, messageContent, c.env.WORKER_URL);

    const { extractFlexAltText } = await import('../utils/flex-alt-text.js');
    const altText = raw.alt_text as string || (tracked.messageType === 'flex' ? extractFlexAltText(tracked.content) : undefined);
    const message = buildMessage(tracked.messageType, tracked.content, altText);

    let sent = 0;
    let failed = 0;
    const now = new Date(Date.now() + 9 * 60 * 60_000).toISOString().replace('Z', '+09:00');

    for (const friend of friends.results) {
      try {
        await lineClient.pushMessage(friend.line_user_id, [message]);
        sent++;
        await c.env.DB.prepare(
          `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, delivery_type, source, created_at)
           VALUES (?, ?, 'outgoing', ?, ?, NULL, 'test', 'broadcast', ?)`
        ).bind(crypto.randomUUID(), friend.id, broadcast.message_type, messageContent, now).run();
      } catch (err) {
        console.error(`Broadcast test send failed: ${broadcastRouteErrorKind(err)}`);
        failed++;
      }
    }

    return c.json({ success: true, sent, failed });
  } catch (err) {
    console.error(`POST /api/broadcasts/:id/test-send error: ${broadcastRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/broadcasts/:id/progress — batch send progress
broadcasts.get('/api/broadcasts/:id/progress', requireRole('owner', 'admin'), async (c) => {
  const id = parseSafeSqlId(c.req.param('id'), 'broadcast_id');
  if (!id.ok) return c.json({ success: false, error: id.error }, 400);
  const broadcast = await getBroadcastById(c.env.DB, id.value);
  if (!broadcast) return c.json({ success: false, error: 'Not found' }, 404);

  const raw = broadcast as unknown as Record<string, unknown>;
  return c.json({
    success: true,
    data: {
      status: broadcast.status,
      totalCount: broadcast.total_count,
      successCount: broadcast.success_count,
      batchOffset: raw.batch_offset as number,
    },
  });
});

// POST /api/segments/count — count friends matching segment conditions
broadcasts.post('/api/segments/count', requireRole('owner', 'admin'), async (c) => {
  const rawBody = await readJsonObject(c);
  if (!rawBody.ok) return c.json({ success: false, error: rawBody.error }, 400);
  const conditions = parseSegmentCondition(rawBody.value.conditions);
  if (!conditions.ok) return c.json({ success: false, error: conditions.error }, 400);
  const accountId = parseOptionalSafeSqlId(rawBody.value.accountId, 'account_id');
  if (!accountId.ok) return c.json({ success: false, error: accountId.error }, 400);
  try {
    const { buildSegmentQuery } = await import('../services/segment-query.js');
    const { sql, bindings } = buildSegmentQuery(conditions.value);

    let accountSql = sql;
    const accountBindings = [...bindings];
    if (accountId.value) {
      accountSql = sql.replace('WHERE', 'WHERE f.line_account_id = ? AND');
      accountBindings.unshift(accountId.value);
    }

    const countSql = accountSql.replace(/^SELECT .+ FROM/, 'SELECT COUNT(*) as count FROM');
    const result = await c.env.DB.prepare(countSql).bind(...accountBindings).first<{ count: number }>();

    return c.json({ success: true, count: result?.count ?? 0 });
  } catch (err) {
    console.error(`POST /api/segments/count error: ${broadcastRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Invalid segment conditions' }, 400);
  }
});

export { broadcasts };

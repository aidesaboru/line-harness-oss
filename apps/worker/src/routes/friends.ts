import { Hono, type Context } from 'hono';
import {
  getFriends,
  getFriendById,
  getFriendCount,
  addTagToFriend,
  removeTagFromFriend,
  getFriendTags,
  getScenarios,
  enrollFriendInScenario,
  jstNow,
} from '@line-crm/db';
import type { Friend as DbFriend, Tag as DbTag } from '@line-crm/db';
import { fireEvent } from '../services/event-bus.js';
import { buildMessage } from '../services/step-delivery.js';
import type { Env } from '../index.js';
import {
  canAccessSupportFriend,
  supportFriendVisibilitySql,
  type SupportAccessStaff,
} from '../services/support-access.js';
import { requireRole } from '../middleware/role-guard.js';
import {
  canUseManualLineSend,
  isLineCaptureOnly,
  isLineManualSendEnabled,
} from '../services/line-capture-only.js';

const friends = new Hono<Env>();

const FRIEND_ID_MAX_LENGTH = 128;
const FRIEND_SEARCH_MAX_LENGTH = 120;
const FRIEND_METADATA_KEY_MAX_LENGTH = 80;
const FRIEND_METADATA_VALUE_MAX_LENGTH = 2000;
const FRIEND_METADATA_MAX_KEYS = 50;
const FRIEND_METADATA_MAX_BYTES = 16000;
const FRIEND_MESSAGE_CONTENT_MAX_LENGTH = 50000;
const FRIEND_ALT_TEXT_MAX_LENGTH = 400;
const FRIEND_URL_MAX_LENGTH = 2048;
const FRIEND_VISIBLE_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const FRIEND_MESSAGE_TYPES = new Set(['text', 'image', 'flex']);

type ValueResult<T> = { ok: true; value: T } | { ok: false; error: string };

function lineApiErrorStatus(err: unknown): number | null {
  if (!(err instanceof Error)) return null;
  const match = err.message.match(/^LINE API error:\s+(\d{3})\b/);
  return match ? Number(match[1]) : null;
}

function friendsRouteErrorKind(err: unknown): string {
  const lineStatus = lineApiErrorStatus(err);
  if (lineStatus != null) return `line_http_status_${lineStatus}`;
  if (err instanceof TypeError) return 'network_error';
  if (err instanceof Error) return err.name || 'error';
  return typeof err;
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

function clampLimit(raw: string | undefined, fallback = 50): number {
  const n = Number(raw ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(100, Math.floor(n)));
}

function clampOffset(raw: string | undefined): number {
  const n = Number(raw ?? 0);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}

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

function parseSafeId(raw: unknown, label: string): ValueResult<string> {
  if (typeof raw !== 'string') return { ok: false, error: `invalid_${label}` };
  const value = raw.trim();
  if (!value || value.length > FRIEND_ID_MAX_LENGTH || !FRIEND_VISIBLE_ID_PATTERN.test(value)) {
    return { ok: false, error: `invalid_${label}` };
  }
  return { ok: true, value };
}

function parseOptionalSafeId(raw: unknown, label: string): ValueResult<string | undefined> {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: undefined };
  return parseSafeId(raw, label);
}

function parseOptionalSearch(raw: unknown): ValueResult<string | undefined> {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: undefined };
  if (typeof raw !== 'string') return { ok: false, error: 'invalid_search' };
  const value = raw.trim();
  if (!value) return { ok: true, value: undefined };
  if (value.length > FRIEND_SEARCH_MAX_LENGTH) return { ok: false, error: 'invalid_search' };
  return { ok: true, value };
}

function parseMetadataKey(raw: unknown): ValueResult<string> {
  if (typeof raw !== 'string') return { ok: false, error: 'invalid_metadata_key' };
  const value = raw.trim();
  if (!value || value.length > FRIEND_METADATA_KEY_MAX_LENGTH || !FRIEND_VISIBLE_ID_PATTERN.test(value)) {
    return { ok: false, error: 'invalid_metadata_key' };
  }
  return { ok: true, value };
}

function parseMetadataQueryValue(raw: unknown): ValueResult<string> {
  if (typeof raw !== 'string') return { ok: false, error: 'invalid_metadata_value' };
  const value = raw.trim();
  if (value.length > FRIEND_METADATA_VALUE_MAX_LENGTH) return { ok: false, error: 'invalid_metadata_value' };
  return { ok: true, value };
}

function parseMetadataPatch(raw: Record<string, unknown>): ValueResult<Record<string, unknown>> {
  const entries = Object.entries(raw);
  if (entries.length === 0 || entries.length > FRIEND_METADATA_MAX_KEYS) {
    return { ok: false, error: 'invalid_metadata' };
  }
  if (JSON.stringify(raw).length > FRIEND_METADATA_MAX_BYTES) {
    return { ok: false, error: 'invalid_metadata' };
  }
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    const parsedKey = parseMetadataKey(key);
    if (!parsedKey.ok) return { ok: false, error: 'invalid_metadata' };
    if (value !== null && typeof value === 'object') {
      return { ok: false, error: 'invalid_metadata' };
    }
    if (typeof value === 'string' && value.length > FRIEND_METADATA_VALUE_MAX_LENGTH) {
      return { ok: false, error: 'invalid_metadata' };
    }
    normalized[parsedKey.value] = typeof value === 'string' ? value.trim() : value;
  }
  return { ok: true, value: normalized };
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > FRIEND_URL_MAX_LENGTH) return false;
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
      return { ok: false, error: 'invalid_content' };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, error: 'invalid_content' };
  }
}

function validateMessageContent(messageType: string, content: string): ValueResult<string> {
  if (messageType === 'image') {
    const parsed = parseJsonRecordString(content);
    if (!parsed.ok) return parsed;
    if (!isHttpsUrl(parsed.value.originalContentUrl) || !isHttpsUrl(parsed.value.previewImageUrl)) {
      return { ok: false, error: 'invalid_content' };
    }
  }
  if (messageType === 'flex') {
    const parsed = parseJsonRecordString(content);
    if (!parsed.ok) return parsed;
    if (typeof parsed.value.type !== 'string') return { ok: false, error: 'invalid_content' };
  }
  return { ok: true, value: content };
}

function parseDirectMessageBody(raw: Record<string, unknown>): ValueResult<{ messageType: string; content: string; altText?: string }> {
  const messageTypeRaw = raw.messageType ?? 'text';
  if (typeof messageTypeRaw !== 'string') return { ok: false, error: 'invalid_message_type' };
  const messageType = messageTypeRaw.trim();
  if (!FRIEND_MESSAGE_TYPES.has(messageType)) return { ok: false, error: 'invalid_message_type' };
  if (typeof raw.content !== 'string') return { ok: false, error: 'invalid_content' };
  const content = raw.content.trim();
  if (!content || content.length > FRIEND_MESSAGE_CONTENT_MAX_LENGTH) return { ok: false, error: 'invalid_content' };
  const validContent = validateMessageContent(messageType, content);
  if (!validContent.ok) return validContent;
  const altText = raw.altText;
  if (altText !== undefined && altText !== null && altText !== '') {
    if (typeof altText !== 'string') return { ok: false, error: 'invalid_alt_text' };
    const trimmed = altText.trim();
    if (!trimmed || trimmed.length > FRIEND_ALT_TEXT_MAX_LENGTH) return { ok: false, error: 'invalid_alt_text' };
    return { ok: true, value: { messageType, content: validContent.value, altText: trimmed } };
  }
  return { ok: true, value: { messageType, content: validContent.value } };
}

function currentStaff(c: { get: (key: 'staff') => SupportAccessStaff | undefined }): SupportAccessStaff {
  return c.get('staff') ?? { id: 'system', name: 'system', role: 'staff' };
}

function appendStaffFriendScope(
  c: { get: (key: 'staff') => SupportAccessStaff | undefined },
  conditions: string[],
  binds: unknown[],
  friendIdExpression = 'f.id',
): void {
  const visibility = supportFriendVisibilitySql(currentStaff(c), friendIdExpression);
  if (!visibility.sql) return;
  conditions.push(visibility.sql);
  binds.push(...visibility.binds);
}

async function ensureFriendAccess(c: Context<Env>, friendId: string): Promise<Response | null> {
  if (await canAccessSupportFriend(c.env.DB, currentStaff(c), friendId)) return null;
  return c.json({ success: false, error: 'Friend not found' }, 404);
}

/**
 * Convert a D1 snake_case Friend row to the shared camelCase shape.
 *
 * Bare-row variant — emits ONLY columns that exist on the friends table.
 * Used by GET /api/friends/:id and metadata-update responses where we read
 * via plain `getFriendById()` and have no JOINed columns. The list endpoint
 * uses `serializeFriendListRow` instead, which adds firstTrackedLinkName +
 * chatStatus from the JOINed query.
 */
function serializeFriend(row: DbFriend) {
  return {
    id: row.id,
    lineUserId: row.line_user_id,
    displayName: row.display_name,
    pictureUrl: row.picture_url,
    statusMessage: row.status_message,
    isFollowing: Boolean(row.is_following),
    metadata: JSON.parse(row.metadata || '{}'),
    refCode: (row as unknown as Record<string, unknown>).ref_code as string | null,
    userId: row.user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Friend serializer for the list endpoint. Adds firstTrackedLinkName +
 * chatStatus from the JOINed query, present only when the caller opted into
 * the chat-status path (?includeChatStatus=true). When absent, the fields
 * default to nullish so the response shape stays consistent for clients that
 * don't request them.
 */
function serializeFriendListRow(
  row: DbFriend & { first_tracked_link_name?: string | null; chat_status?: string | null },
  includeChatStatus: boolean,
) {
  const base = serializeFriend(row);
  if (!includeChatStatus) return base;
  return {
    ...base,
    // L-step style "ASP_LP名" — the campaign/landing-page name the friend
    // entered through, attributed once at friend-add time and never
    // overwritten (see migration 022). LEFT JOINed in the list query.
    firstTrackedLinkName: row.first_tracked_link_name ?? null,
    // chats.status defaulted to 'resolved' for friends without a chats row
    // (matches /api/chats listing). Friend-list and chats-list now agree on
    // 未対応/対応中/対応済み state.
    chatStatus: (row.chat_status ?? 'resolved') as 'unread' | 'in_progress' | 'resolved',
  };
}

/** Convert a D1 snake_case Tag row to the shared camelCase shape */
function serializeTag(row: DbTag) {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    createdAt: row.created_at,
  };
}

// GET /api/friends - list with pagination
friends.get('/api/friends', async (c) => {
  try {
    const limit = clampLimit(c.req.query('limit'), 50);
    const offset = clampOffset(c.req.query('offset'));
    const tagId = parseOptionalSafeId(c.req.query('tagId'), 'tag_id');
    if (!tagId.ok) return c.json({ success: false, error: tagId.error }, 400);
    const lineAccountId = parseOptionalSafeId(c.req.query('lineAccountId'), 'line_account_id');
    if (!lineAccountId.ok) return c.json({ success: false, error: lineAccountId.error }, 400);
    const search = parseOptionalSearch(c.req.query('search'));
    if (!search.ok) return c.json({ success: false, error: search.error }, 400);
    // ?includeTags=false skips per-row tag enrichment (N+1 of getFriendTags
    // → ~50 extra D1 reads on a wide list query). The list view needs tags
    // for filter chips, but autocomplete-style consumers (test-recipient
    // picker, broadcast recipient picker) only render id/displayName/picture
    // and pay the cost for nothing. Default true to keep the historical
    // behavior for existing callers.
    const includeTags = c.req.query('includeTags') !== 'false';
    // ?includeChatStatus=true — populate latestIncomingMessage,
    // latestOutgoingAt, activeScenario, and a derived `handled` flag for
    // each friend. Used by the L-step-style /friends listing; off by
    // default to keep the simple list / autocomplete paths cheap.
    const includeChatStatus = c.req.query('includeChatStatus') === 'true';
    // ?sort=oldest reverses default created_at DESC. Default = recent-first.
    // Search mode (when `search` is set) overrides both — we keep the
    // match-quality ranking and only flip the secondary `created_at` tier.
    const sort: 'recent' | 'oldest' = c.req.query('sort') === 'oldest' ? 'oldest' : 'recent';
    // ?handled=unhandled filters to friends whose latest activity is an
    // incoming message (mirroring the L-step "未対応" tab). Done in SQL so
    // pagination + total counts are correct; client-side filter would only
    // hide rows on the current page and leave `total` misleading.
    const handledFilter: 'unhandled' | null =
      c.req.query('handled') === 'unhandled' ? 'unhandled' : null;

    const db = c.env.DB;

    // Build WHERE conditions
    const conditions: string[] = [];
    const binds: unknown[] = [];
    if (tagId.value) {
      conditions.push('EXISTS (SELECT 1 FROM friend_tags ft WHERE ft.friend_id = f.id AND ft.tag_id = ?)');
      binds.push(tagId.value);
    }
    if (lineAccountId.value) {
      conditions.push('f.line_account_id = ?');
      binds.push(lineAccountId.value);
    }
    appendStaffFriendScope(c, conditions, binds, 'f.id');
    if (search.value) {
      conditions.push('f.display_name LIKE ?');
      binds.push(`%${search.value}%`);
    }
    // Unhandled filter: chats.status === 'unread'.
    //
    // We derive 対応マーク from chats.status — the same model the /chats UI
    // uses — instead of inferring from messages_log timestamps. Reasons:
    //   - silent auto-replies / postbacks intentionally do NOT flip the
    //     chat to unread (see webhook.ts), so a timestamp-based heuristic
    //     would mark them as 未対応 against the operator's intent
    //   - operators explicitly mark 対応済み (resolved) / 対応中 (in_progress)
    //     via the chats UI, and that state must be honored here
    //   - friends without any chat row default to 'resolved' (lazy-create
    //     in chats.ts:88 also seeds with 'resolved'), matching the chats
    //     listing's COALESCE(c.status, 'resolved') convention
    if (handledFilter === 'unhandled') {
      // DESC mirrors the /api/chats listing — newest chat row wins so a
      // resolved-then-reopened conversation correctly resurfaces as 未対応.
      conditions.push(
        `COALESCE(
           (SELECT status FROM chats c
            WHERE c.friend_id = f.id
            ORDER BY c.created_at DESC LIMIT 1),
           'resolved'
         ) = 'unread'`,
      );
    }
    // Metadata filters: ?metadata.key=value (e.g. ?metadata.monthly_cost=〜100万円)
    const url = new URL(c.req.url);
    for (const [key, value] of url.searchParams.entries()) {
      if (key.startsWith('metadata.')) {
        const metaKey = parseMetadataKey(key.slice('metadata.'.length));
        if (!metaKey.ok) return c.json({ success: false, error: metaKey.error }, 400);
        const metaValue = parseMetadataQueryValue(value);
        if (!metaValue.ok) return c.json({ success: false, error: metaValue.error }, 400);
        conditions.push(`json_extract(f.metadata, '$.' || ?) = ?`);
        binds.push(metaKey.value, metaValue.value);
      }
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countStmt = db.prepare(`SELECT COUNT(*) as count FROM friends f ${where}`);
    const totalRow = await (binds.length > 0 ? countStmt.bind(...binds) : countStmt).first<{ count: number }>();
    const total = totalRow?.count ?? 0;

    // When `search` is present we want exact / prefix matches to surface
    // first regardless of friend age. Plain `ORDER BY created_at DESC`
    // pushes the most-likely candidate (e.g. the operator themselves,
    // friended on day-one of the account) below recently-added friends
    // whose displayName happens to contain the same substring. The
    // CASE expression below ranks: exact (0) → prefix (1) → word-start (2)
    // → generic substring (3), then created_at DESC inside each tier.
    //
    // - The exact tier uses `LIKE ?` (no wildcards) instead of `= ?` so
    //   SQLite's ASCII case-insensitive `LIKE` lets `shu` match `Shu`.
    //   Plain `=` is byte-exact and would relegate that row to tier 1
    //   alongside `Shun` / `shuji`, defeating the rerank.
    // - Word-start patterns include both ASCII space and full-width
    //   so Japanese names like `山田　太郎` match on the second name part.
    // The tracked_links JOIN + chats.status subselect are only needed when the
    // caller requested chat status. Skipping them on autocomplete-style calls
    // (?includeChatStatus omitted, includeTags=false) keeps a single keystroke
    // cheap. List view enables it.
    //
    // chat_status subselect: the existing /api/chats listing pulls the
    // **newest** chat row per friend (chats.ts:288 — `ORDER BY created_at DESC`).
    // Operators can re-open a resolved chat, which inserts a new row; reading
    // the oldest row would show stale 対応済み in those cases. We mirror the
    // chats list's DESC convention here so the badge agrees with /chats.
    const baseSelect = includeChatStatus
      ? `f.*, tl.name AS first_tracked_link_name,
         COALESCE(
           (SELECT status FROM chats c
            WHERE c.friend_id = f.id
            ORDER BY c.created_at DESC LIMIT 1),
           'resolved'
         ) AS chat_status`
      : `f.*`;
    const baseFrom = includeChatStatus
      ? `FROM friends f LEFT JOIN tracked_links tl ON tl.id = f.first_tracked_link_id`
      : `FROM friends f`;
    // Secondary tier of the search-mode ORDER BY (after match_score) and the
    // primary tier in non-search mode. Switched by ?sort=oldest|recent.
    const createdOrder = sort === 'oldest' ? 'ASC' : 'DESC';
    let listStmt;
    let listBinds: unknown[];
    if (search.value) {
      const exactPattern = search.value;
      const prefixPattern = `${search.value}%`;
      const wordStartAscii = `% ${search.value}%`;
      const wordStartFullWidth = `%　${search.value}%`;
      listStmt = db.prepare(
        `SELECT ${baseSelect},
                CASE
                  WHEN f.display_name LIKE ? THEN 0
                  WHEN f.display_name LIKE ? THEN 1
                  WHEN f.display_name LIKE ? OR f.display_name LIKE ? THEN 2
                  ELSE 3
                END AS match_score
         ${baseFrom} ${where}
         ORDER BY match_score ASC, f.created_at ${createdOrder}
         LIMIT ? OFFSET ?`,
      );
      listBinds = [exactPattern, prefixPattern, wordStartAscii, wordStartFullWidth, ...binds, limit, offset];
    } else {
      listStmt = db.prepare(
        `SELECT ${baseSelect} ${baseFrom} ${where} ORDER BY f.created_at ${createdOrder} LIMIT ? OFFSET ?`,
      );
      listBinds = [...binds, limit, offset];
    }
    const listResult = await listStmt.bind(...listBinds).all<DbFriend>();
    const items = listResult.results;

    // Fetch tags for each friend in parallel so the list response includes tags.
    // Skipped when ?includeTags=false (autocomplete consumers don't render
    // tags and would otherwise pay N D1 reads per keystroke).
    let itemsWithTags = includeTags
      ? await Promise.all(
          items.map(async (friend) => {
            const tags = await getFriendTags(db, friend.id);
            return { ...serializeFriendListRow(friend, includeChatStatus), tags: tags.map(serializeTag) };
          }),
        )
      : items.map((friend) => ({ ...serializeFriendListRow(friend, includeChatStatus), tags: [] }));

    // Optional: hydrate chat status (latest in/out message, active scenario,
    // derived "handled" flag). Three batched queries instead of N×3 to keep
    // the request cheap even at limit=50. ROW_NUMBER() picks the freshest
    // row per friend; SQLite supports window functions on D1.
    if (includeChatStatus && items.length > 0) {
      const ids = items.map((f) => f.id);
      const placeholders = ids.map(() => '?').join(',');

      type IncomingRow = { friend_id: string; content: string; message_type: string; created_at: string };
      type OutgoingRow = { friend_id: string; max_at: string };
      type ScenarioRow = { friend_id: string; scenario_name: string; status: string };

      const [incomingRes, outgoingRes, scenarioRes] = await Promise.all([
        db
          .prepare(
            `SELECT friend_id, content, message_type, created_at FROM (
               SELECT friend_id, content, message_type, created_at,
                      ROW_NUMBER() OVER (PARTITION BY friend_id ORDER BY created_at DESC) AS rn
               FROM messages_log
               WHERE direction = 'incoming' AND friend_id IN (${placeholders})
             ) WHERE rn = 1`,
          )
          .bind(...ids)
          .all<IncomingRow>(),
        db
          .prepare(
            // delivery_type='test' は実顧客への配信ではない (テスト送信先への
            // ブロードキャスト)。/api/chats など他のチャット系ビューも同じく
            // test 配信を除外して "活動" を判定するので、そちらと整合させる。
            // 含めると、テスト送信先に登録されたまま実 incoming を放置している
            // 友だちの handled が誤って true に flip する事故が起きる。
            `SELECT friend_id, MAX(created_at) AS max_at FROM messages_log
             WHERE direction = 'outgoing'
               AND (delivery_type IS NULL OR delivery_type != 'test')
               AND friend_id IN (${placeholders})
             GROUP BY friend_id`,
          )
          .bind(...ids)
          .all<OutgoingRow>(),
        db
          .prepare(
            `SELECT fs.friend_id, s.name AS scenario_name, fs.status FROM (
               SELECT friend_id, scenario_id, status,
                      ROW_NUMBER() OVER (PARTITION BY friend_id ORDER BY started_at DESC) AS rn
               FROM friend_scenarios
               WHERE status IN ('active', 'delivering') AND friend_id IN (${placeholders})
             ) fs
             JOIN scenarios s ON s.id = fs.scenario_id
             WHERE fs.rn = 1`,
          )
          .bind(...ids)
          .all<ScenarioRow>(),
      ]);

      const incomingByFriend = new Map(incomingRes.results.map((r) => [r.friend_id, r]));
      const outgoingByFriend = new Map(outgoingRes.results.map((r) => [r.friend_id, r.max_at]));
      const scenarioByFriend = new Map(scenarioRes.results.map((r) => [r.friend_id, r]));

      // We're inside `if (includeChatStatus)` so every row was emitted by
      // serializeFriendListRow with chatStatus populated. TS can't narrow
      // through the union, so assert the populated shape locally.
      type WithChatStatus = (typeof itemsWithTags)[number] & { chatStatus: 'unread' | 'in_progress' | 'resolved' };
      itemsWithTags = (itemsWithTags as WithChatStatus[]).map((f) => {
        const inc = incomingByFriend.get(f.id);
        const outAt = outgoingByFriend.get(f.id);
        const sc = scenarioByFriend.get(f.id);
        // 対応済み判定は chats.status 一本。messages_log の出入り時刻ではなく、
        // /chats 画面が見ている persisted state を使う。silent auto-reply や
        // postback のように "incoming だが unread にしない" イベントもあるので、
        // タイムスタンプベースで推測すると /chats と乖離する。
        const handled = f.chatStatus !== 'unread';
        return {
          ...f,
          latestIncomingMessage: inc
            ? { content: inc.content, messageType: inc.message_type, createdAt: inc.created_at }
            : null,
          latestOutgoingAt: outAt ?? null,
          activeScenario: sc ? { name: sc.scenario_name, status: sc.status } : null,
          handled,
        };
      });
    }

    return c.json({
      success: true,
      data: {
        items: itemsWithTags,
        total,
        page: Math.floor(offset / limit) + 1,
        limit,
        hasNextPage: offset + limit < total,
      },
    });
  } catch (err) {
    console.error(`GET /api/friends error: ${friendsRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/friends/count - friend count (must be before /:id)
friends.get('/api/friends/count', async (c) => {
  try {
    const lineAccountId = parseOptionalSafeId(c.req.query('lineAccountId'), 'line_account_id');
    if (!lineAccountId.ok) return c.json({ success: false, error: lineAccountId.error }, 400);
    const conditions = ['f.is_following = 1'];
    const binds: unknown[] = [];
    if (lineAccountId.value) {
      conditions.push('f.line_account_id = ?');
      binds.push(lineAccountId.value);
    }
    appendStaffFriendScope(c, conditions, binds, 'f.id');
    const visibilityApplied = conditions.length > (lineAccountId.value ? 2 : 1);
    let count: number;
    if (!lineAccountId.value && !visibilityApplied) {
      count = await getFriendCount(c.env.DB);
    } else {
      const row = await c.env.DB.prepare(`SELECT COUNT(*) as count FROM friends f WHERE ${conditions.join(' AND ')}`)
        .bind(...binds).first<{ count: number }>();
      count = row?.count ?? 0;
    }
    return c.json({ success: true, data: { count } });
  } catch (err) {
    console.error(`GET /api/friends/count error: ${friendsRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/friends/ref-stats - ref code attribution stats
friends.get('/api/friends/ref-stats', requireRole('owner', 'admin'), async (c) => {
  try {
    const lineAccountId = parseOptionalSafeId(c.req.query('lineAccountId'), 'line_account_id');
    if (!lineAccountId.ok) return c.json({ success: false, error: lineAccountId.error }, 400);
    const where = lineAccountId.value ? 'WHERE line_account_id = ?' : 'WHERE ref_code IS NOT NULL';
    const binds = lineAccountId.value ? [lineAccountId.value] : [];
    const stmt = c.env.DB.prepare(
      `SELECT ref_code, COUNT(*) as count FROM friends ${where} AND ref_code IS NOT NULL GROUP BY ref_code ORDER BY count DESC`,
    );
    const result = await (binds.length > 0 ? stmt.bind(...binds) : stmt).all<{ ref_code: string; count: number }>();
    const total = await c.env.DB.prepare(
      `SELECT COUNT(*) as count FROM friends ${lineAccountId.value ? 'WHERE line_account_id = ?' : ''} ${lineAccountId.value ? 'AND' : 'WHERE'} ref_code IS NOT NULL`,
    ).bind(...(lineAccountId.value ? [lineAccountId.value] : [])).first<{ count: number }>();
    return c.json({
      success: true,
      data: {
        routes: result.results.map((r) => ({ refCode: r.ref_code, friendCount: r.count })),
        totalWithRef: total?.count ?? 0,
      },
    });
  } catch (err) {
    console.error(`GET /api/friends/ref-stats error: ${friendsRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/friends/:id - get single friend with tags
friends.get('/api/friends/:id', async (c) => {
  try {
    const id = parseSafeId(c.req.param('id'), 'friend_id');
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const db = c.env.DB;
    const denied = await ensureFriendAccess(c, id.value);
    if (denied) return denied;

    const [friend, tags] = await Promise.all([
      getFriendById(db, id.value),
      getFriendTags(db, id.value),
    ]);

    if (!friend) {
      return c.json({ success: false, error: 'Friend not found' }, 404);
    }

    return c.json({
      success: true,
      data: {
        ...serializeFriend(friend),
        tags: tags.map(serializeTag),
      },
    });
  } catch (err) {
    console.error(`GET /api/friends/:id error: ${friendsRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/friends/:id/tags - add tag
friends.post('/api/friends/:id/tags', async (c) => {
  try {
    const friendId = parseSafeId(c.req.param('id'), 'friend_id');
    if (!friendId.ok) return c.json({ success: false, error: friendId.error }, 400);
    const body = await readJsonObject(c);
    if (!body.ok) return c.json({ success: false, error: body.error }, 400);
    const tagId = parseSafeId(body.value.tagId, 'tag_id');
    if (!tagId.ok) return c.json({ success: false, error: tagId.error }, 400);
    const denied = await ensureFriendAccess(c, friendId.value);
    if (denied) return denied;

    const db = c.env.DB;
    await addTagToFriend(db, friendId.value, tagId.value);

    // Enroll in tag_added scenarios that match this tag
    const allScenarios = await getScenarios(db);
    for (const scenario of allScenarios) {
      if (scenario.trigger_type === 'tag_added' && scenario.is_active && scenario.trigger_tag_id === tagId.value) {
        const existing = await db
          .prepare(`SELECT id FROM friend_scenarios WHERE friend_id = ? AND scenario_id = ?`)
          .bind(friendId.value, scenario.id)
          .first();
        if (!existing) {
          await enrollFriendInScenario(db, friendId.value, scenario.id);
        }
      }
    }

    // イベントバス発火: tag_change
    await fireEvent(db, 'tag_change', { friendId: friendId.value, eventData: { tagId: tagId.value, action: 'add' } });

    return c.json({ success: true, data: null }, 201);
  } catch (err) {
    console.error(`POST /api/friends/:id/tags error: ${friendsRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/friends/:id/tags/:tagId - remove tag
friends.delete('/api/friends/:id/tags/:tagId', async (c) => {
  try {
    const friendId = parseSafeId(c.req.param('id'), 'friend_id');
    if (!friendId.ok) return c.json({ success: false, error: friendId.error }, 400);
    const tagId = parseSafeId(c.req.param('tagId'), 'tag_id');
    if (!tagId.ok) return c.json({ success: false, error: tagId.error }, 400);
    const denied = await ensureFriendAccess(c, friendId.value);
    if (denied) return denied;

    await removeTagFromFriend(c.env.DB, friendId.value, tagId.value);

    // イベントバス発火: tag_change
    await fireEvent(c.env.DB, 'tag_change', { friendId: friendId.value, eventData: { tagId: tagId.value, action: 'remove' } });

    return c.json({ success: true, data: null });
  } catch (err) {
    console.error(`DELETE /api/friends/:id/tags/:tagId error: ${friendsRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PUT /api/friends/:id/metadata - merge metadata fields
friends.put('/api/friends/:id/metadata', async (c) => {
  try {
    const friendId = parseSafeId(c.req.param('id'), 'friend_id');
    if (!friendId.ok) return c.json({ success: false, error: friendId.error }, 400);
    const body = await readJsonObject(c);
    if (!body.ok) return c.json({ success: false, error: body.error }, 400);
    const metadataPatch = parseMetadataPatch(body.value);
    if (!metadataPatch.ok) return c.json({ success: false, error: metadataPatch.error }, 400);
    const db = c.env.DB;
    const denied = await ensureFriendAccess(c, friendId.value);
    if (denied) return denied;

    const friend = await getFriendById(db, friendId.value);
    if (!friend) {
      return c.json({ success: false, error: 'Friend not found' }, 404);
    }

    const existing = JSON.parse(friend.metadata || '{}');
    const merged = { ...existing, ...metadataPatch.value };
    const now = jstNow();

    await db
      .prepare('UPDATE friends SET metadata = ?, updated_at = ? WHERE id = ?')
      .bind(JSON.stringify(merged), now, friendId.value)
      .run();

    const updated = await getFriendById(db, friendId.value);
    const tags = await getFriendTags(db, friendId.value);

    return c.json({
      success: true,
      data: {
        ...serializeFriend(updated!),
        tags: tags.map(serializeTag),
      },
    });
  } catch (err) {
    console.error(`PUT /api/friends/:id/metadata error: ${friendsRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/friends/:id/messages - get message history
friends.get('/api/friends/:id/messages', async (c) => {
  try {
    const friendId = parseSafeId(c.req.param('id'), 'friend_id');
    if (!friendId.ok) return c.json({ success: false, error: friendId.error }, 400);
    const denied = await ensureFriendAccess(c, friendId.value);
    if (denied) return denied;
    // Fetch the latest 200 messages (DESC) then reverse to ASC for display.
    // Using ORDER BY ASC LIMIT 200 returns the OLDEST 200 rows, which silently
    // hides recent activity for chatty friends. Exclude delivery_type='test'
    // to stay consistent with /api/chats/:id, so the same friend shows the
    // same history across DirectMessagePanel and the chat panel.
    const result = await c.env.DB
      .prepare(
        `SELECT id, direction, message_type as messageType, content, created_at as createdAt
         FROM messages_log WHERE friend_id = ?
           AND (delivery_type IS NULL OR delivery_type != 'test')
         ORDER BY created_at DESC LIMIT 200`,
      )
      .bind(friendId.value)
      .all<{ id: string; direction: string; messageType: string; content: string; createdAt: string }>();
    return c.json({ success: true, data: result.results.reverse() });
  } catch (err) {
    console.error(`GET /api/friends/:id/messages error: ${friendsRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/friends/:id/messages - send message to friend
friends.post('/api/friends/:id/messages', async (c) => {
  try {
    if (!canUseManualLineSend(c.env)) {
      return c.json({ success: false, error: 'Manual LINE sending is disabled' }, 403);
    }
    const friendId = parseSafeId(c.req.param('id'), 'friend_id');
    if (!friendId.ok) return c.json({ success: false, error: friendId.error }, 400);
    const body = await readJsonObject(c);
    if (!body.ok) return c.json({ success: false, error: body.error }, 400);
    const messageBody = parseDirectMessageBody(body.value);
    if (!messageBody.ok) return c.json({ success: false, error: messageBody.error }, 400);
    const denied = await ensureFriendAccess(c, friendId.value);
    if (denied) return denied;

    const db = c.env.DB;
    const friend = await getFriendById(db, friendId.value);
    if (!friend) {
      return c.json({ success: false, error: 'Friend not found' }, 404);
    }

    const { LineClient } = await import('@line-crm/line-sdk');
    // Resolve access token from friend's account (multi-account support)
    let accessToken = c.env.LINE_CHANNEL_ACCESS_TOKEN;
    if ((friend as unknown as Record<string, unknown>).line_account_id) {
      const { getLineAccountById } = await import('@line-crm/db');
      const account = await getLineAccountById(db, (friend as unknown as Record<string, unknown>).line_account_id as string);
      if (account) accessToken = account.channel_access_token;
    }
    const lineClient = new LineClient(accessToken, {
      allowMutationsWhenDisabled: isLineCaptureOnly(c.env) && isLineManualSendEnabled(c.env),
    });
    const messageType = messageBody.value.messageType;

    // Auto-wrap URLs with tracking links (text with URLs → Flex with button)
    const { autoTrackContent } = await import('../services/auto-track.js');
    const tracked = await autoTrackContent(
      db, messageType, messageBody.value.content,
      c.env.WORKER_URL || new URL(c.req.url).origin,
    );

    const message = buildMessage(tracked.messageType, tracked.content, messageBody.value.altText);
    try {
      await lineClient.pushMessage(friend.line_user_id, [message]);
    } catch (err) {
      console.error(`manual friend LINE send failed: ${friendsRouteErrorKind(err)}`);
      return c.json({ success: false, error: manualLineSendFailureMessage(err) }, 502);
    }

    // Log outgoing message
    const logId = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, source, line_account_id, created_at)
         VALUES (?, ?, 'outgoing', ?, ?, NULL, NULL, 'manual', ?, ?)`,
      )
      .bind(logId, friend.id, messageType, messageBody.value.content, friend.line_account_id ?? null, jstNow())
      .run();

    return c.json({ success: true, data: { messageId: logId } });
  } catch (err) {
    console.error(`POST /api/friends/:id/messages error: ${friendsRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { friends };

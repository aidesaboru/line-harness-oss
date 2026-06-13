import { Hono } from 'hono';
import type { Context } from 'hono';
import { jstNow } from '@line-crm/db';
import type { Env } from '../index.js';
import { requireRole } from '../middleware/role-guard.js';
import {
  canAccessSupportFriend,
  isRestrictedSupportStaff,
  supportCaseVisibilitySql,
  supportEscalationVisibilitySql,
  supportStaffLikePattern,
  type SupportAccessStaff,
} from '../services/support-access.js';

const support = new Hono<Env>();

const CASE_STATUSES = new Set([
  'open',
  'in_progress',
  'waiting_primary',
  'escalated',
  'waiting_secondary',
  'customer_reply',
  'on_hold',
  'resolved',
  'reopened',
]);

const PRIORITIES = new Set(['low', 'medium', 'high', 'urgent']);
const ESCALATION_STATUSES = new Set(['pending', 'answered', 'needs_info', 'transferred', 'expert_check', 'closed']);
const ESCALATION_LEVELS = new Set(['L2', 'L3']);
const STAFF_ALLOWED_CASE_UPDATE_KEYS = new Set([
  'lineAccountId',
  'status',
  'nextCheckAt',
  'customerSummary',
  'internalNote',
  'customerReplyDraft',
  'resolutionNote',
  'manualIds',
  'eventBody',
]);
const STAFF_ALLOWED_ESCALATION_UPDATE_KEYS = new Set([
  'lineAccountId',
  'status',
  'answer',
  'eventBody',
]);
const STAFF_ALLOWED_ESCALATION_CREATE_KEYS = new Set([
  'lineAccountId',
  'question',
  'eventBody',
]);
const STAFF_ALLOWED_ESCALATION_STATUSES = new Set(['answered', 'needs_info']);
const SUPPORT_ID_MAX_LENGTH = 128;
const SUPPORT_QUERY_TEXT_MAX_LENGTH = 256;
const SUPPORT_SHORT_TEXT_MAX_LENGTH = 256;
const SUPPORT_URL_MAX_LENGTH = 2048;
const SUPPORT_LONG_TEXT_MAX_LENGTH = 64 * 1024;
const SUPPORT_EVENT_METADATA_MAX_LENGTH = 16 * 1024;
const SUPPORT_VISIBLE_ASCII_PATTERN = /^[!-~]+$/;

type ValueResult<T> = { ok: true; value: T } | { ok: false; error: string };

type SupportCaseRow = {
  id: string;
  line_account_id: string | null;
  friend_id: string | null;
  friend_name?: string | null;
  friend_picture_url?: string | null;
  line_user_id?: string | null;
  title: string;
  category: string;
  priority: string;
  status: string;
  primary_assignee: string | null;
  escalation_assignee: string | null;
  escalation_level: string;
  due_at: string | null;
  next_check_at: string | null;
  customer_number: string | null;
  company_name: string | null;
  contact_name: string | null;
  store_name: string | null;
  contract_type: string | null;
  customer_summary: string;
  internal_note: string;
  customer_reply_draft: string;
  resolution_note: string;
  manual_ids: string;
  created_by: string | null;
  updated_by: string | null;
  closed_at: string | null;
  reopened_at: string | null;
  created_at: string;
  updated_at: string;
};

type SupportEscalationRow = {
  id: string;
  case_id: string;
  case_title?: string | null;
  friend_name?: string | null;
  line_account_id: string | null;
  assignee: string;
  level: string;
  status: string;
  question: string;
  answer: string;
  due_at: string | null;
  answered_at: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

type SupportManualRow = {
  id: string;
  line_account_id: string | null;
  title: string;
  category: string;
  body: string;
  url: string | null;
  keywords: string;
  owner: string | null;
  approved_by: string | null;
  revised_at: string | null;
  is_active: number;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

type SupportEventRow = {
  id: string;
  case_id: string;
  event_type: string;
  actor_id: string | null;
  actor_name: string | null;
  body: string;
  metadata: string;
  created_at: string;
};

function supportRouteErrorKind(err: unknown): string {
  if (err instanceof TypeError) return 'network_error';
  if (err instanceof Error) return err.name || 'error';
  return typeof err;
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function parseOptionalTextField(raw: unknown, label: string, maxLength = SUPPORT_SHORT_TEXT_MAX_LENGTH): ValueResult<string | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: `${label} must be a string` };
  const value = raw.trim();
  if (!value) return { ok: true, value: null };
  if (value.length > maxLength) return { ok: false, error: `${label} is too long` };
  return { ok: true, value };
}

function parseRequiredTextField(raw: unknown, label: string, maxLength = SUPPORT_SHORT_TEXT_MAX_LENGTH): ValueResult<string> {
  const parsed = parseOptionalTextField(raw, label, maxLength);
  if (!parsed.ok) return parsed;
  if (!parsed.value) return { ok: false, error: `${label} is required` };
  return { ok: true, value: parsed.value };
}

function parseOptionalEventMetadata(raw: unknown): ValueResult<Record<string, unknown>> {
  if (raw === undefined || raw === null) return { ok: true, value: {} };
  if (!isRecord(raw)) return { ok: false, error: 'metadata must be an object' };
  if (JSON.stringify(raw).length > SUPPORT_EVENT_METADATA_MAX_LENGTH) {
    return { ok: false, error: 'metadata is too long' };
  }
  return { ok: true, value: raw };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJsonRecord(c: { req: { json(): Promise<unknown> } }): Promise<ValueResult<Record<string, unknown>>> {
  const raw = await c.req.json().catch(() => null);
  if (!isRecord(raw)) return { ok: false, error: 'Invalid payload' };
  return { ok: true, value: raw };
}

function parseRequiredVisibleId(raw: unknown, label: string): ValueResult<string> {
  if (typeof raw !== 'string') return { ok: false, error: `${label} must be a string` };
  const value = raw.trim();
  if (!value) return { ok: false, error: `${label} is required` };
  if (value.length > SUPPORT_ID_MAX_LENGTH) return { ok: false, error: `${label} is too long` };
  if (!SUPPORT_VISIBLE_ASCII_PATTERN.test(value)) return { ok: false, error: `${label} is invalid` };
  return { ok: true, value };
}

function parseOptionalVisibleId(raw: unknown, label: string): ValueResult<string | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== 'string') return { ok: false, error: `${label} must be a string` };
  const value = raw.trim();
  if (!value) return { ok: true, value: undefined };
  if (value.length > SUPPORT_ID_MAX_LENGTH) return { ok: false, error: `${label} is too long` };
  if (!SUPPORT_VISIBLE_ASCII_PATTERN.test(value)) return { ok: false, error: `${label} is invalid` };
  return { ok: true, value };
}

function parseOptionalQueryText(raw: unknown, label: string): ValueResult<string | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== 'string') return { ok: false, error: `${label} must be a string` };
  const value = raw.trim();
  if (!value) return { ok: true, value: undefined };
  if (value.length > SUPPORT_QUERY_TEXT_MAX_LENGTH) return { ok: false, error: `${label} is too long` };
  return { ok: true, value };
}

function parseManualIdsInput(raw: unknown): ValueResult<string[]> {
  if (raw === undefined) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, error: 'manualIds must be an array' };
  const ids: string[] = [];
  for (const item of raw) {
    const id = parseRequiredVisibleId(item, 'manualId');
    if (!id.ok) return id;
    ids.push(id.value);
  }
  return { ok: true, value: ids };
}

function parseActiveFilter(raw: unknown): ValueResult<'0' | '1' | 'all'> {
  if (raw === undefined || raw === null) return { ok: true, value: '1' };
  if (typeof raw !== 'string') return { ok: false, error: 'active must be a string' };
  const value = raw.trim();
  if (value === '0' || value === '1' || value === 'all') return { ok: true, value };
  return { ok: false, error: 'active is invalid' };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function nullableText(value: unknown): string | null {
  if (value === null) return null;
  if (value === undefined) return undefined as unknown as null;
  return text(value);
}

function parseManualIds(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
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

function currentStaff(c: Context<Env>) {
  const staff = c.get('staff');
  return staff ?? { id: 'system', name: 'system', role: 'staff' as const };
}

function canManageSupportCaseRouting(staff: SupportAccessStaff): boolean {
  return staff.role === 'owner' || staff.role === 'admin';
}

function lineAccountIdFrom(c: Context<Env>, body?: Record<string, unknown>): ValueResult<string> {
  const raw = body && Object.prototype.hasOwnProperty.call(body, 'lineAccountId')
    ? body.lineAccountId
    : c.req.query('lineAccountId');
  return parseRequiredVisibleId(raw, 'lineAccountId');
}

function serializeCase(row: SupportCaseRow) {
  return {
    id: row.id,
    lineAccountId: row.line_account_id,
    friendId: row.friend_id,
    friendName: row.friend_name ?? null,
    friendPictureUrl: row.friend_picture_url ?? null,
    lineUserId: row.line_user_id ?? null,
    title: row.title,
    category: row.category,
    priority: row.priority,
    status: row.status,
    primaryAssignee: row.primary_assignee,
    escalationAssignee: row.escalation_assignee,
    escalationLevel: row.escalation_level,
    dueAt: row.due_at,
    nextCheckAt: row.next_check_at,
    customerNumber: row.customer_number,
    companyName: row.company_name,
    contactName: row.contact_name,
    storeName: row.store_name,
    contractType: row.contract_type,
    customerSummary: row.customer_summary,
    internalNote: row.internal_note,
    customerReplyDraft: row.customer_reply_draft,
    resolutionNote: row.resolution_note,
    manualIds: parseManualIds(row.manual_ids),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    closedAt: row.closed_at,
    reopenedAt: row.reopened_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeEscalation(row: SupportEscalationRow) {
  return {
    id: row.id,
    caseId: row.case_id,
    caseTitle: row.case_title ?? null,
    friendName: row.friend_name ?? null,
    lineAccountId: row.line_account_id,
    assignee: row.assignee,
    level: row.level,
    status: row.status,
    question: row.question,
    answer: row.answer,
    dueAt: row.due_at,
    answeredAt: row.answered_at,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeManual(row: SupportManualRow) {
  return {
    id: row.id,
    lineAccountId: row.line_account_id,
    title: row.title,
    category: row.category,
    body: row.body,
    url: row.url,
    keywords: row.keywords,
    owner: row.owner,
    approvedBy: row.approved_by,
    revisedAt: row.revised_at,
    isActive: Boolean(row.is_active),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeEvent(row: SupportEventRow) {
  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(row.metadata || '{}');
  } catch {
    metadata = {};
  }
  return {
    id: row.id,
    caseId: row.case_id,
    eventType: row.event_type,
    actorId: row.actor_id,
    actorName: row.actor_name,
    body: row.body,
    metadata,
    createdAt: row.created_at,
  };
}

async function getCaseRow(
  db: D1Database,
  id: string,
  lineAccountId: string,
  staff?: SupportAccessStaff,
) {
  const conditions = ['sc.id = ?', 'sc.line_account_id = ?'];
  const binds: unknown[] = [id, lineAccountId];
  if (staff) {
    const visibility = supportCaseVisibilitySql(staff, 'sc', 'se_case_row_scope');
    if (visibility.sql) {
      conditions.push(visibility.sql);
      binds.push(...visibility.binds);
    }
  }

  return db
    .prepare(
      `SELECT sc.*,
              f.display_name AS friend_name,
              f.picture_url AS friend_picture_url,
              f.line_user_id
       FROM support_cases sc
       LEFT JOIN friends f ON f.id = sc.friend_id
       WHERE ${conditions.join(' AND ')}`,
    )
    .bind(...binds)
    .first<SupportCaseRow>();
}

async function validateManualIds(
  db: D1Database,
  lineAccountId: string,
  manualIds: string[],
): Promise<{ ok: true; ids: string[] } | { ok: false; error: string }> {
  const ids = Array.from(new Set(manualIds.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim())));
  if (ids.length === 0) return { ok: true, ids: [] };
  const placeholders = ids.map(() => '?').join(',');
  const result = await db
    .prepare(
      `SELECT id
       FROM support_manuals
       WHERE id IN (${placeholders})
         AND is_active = 1
         AND (line_account_id = ? OR line_account_id IS NULL)`,
    )
    .bind(...ids, lineAccountId)
    .all<{ id: string }>();
  const allowed = new Set(result.results.map((row) => row.id));
  const rejected = ids.filter((id) => !allowed.has(id));
  if (rejected.length > 0) {
    return { ok: false, error: 'manualIds contains manuals outside this LINE account' };
  }
  return { ok: true, ids };
}

async function addCaseEvent(
  db: D1Database,
  caseId: string,
  eventType: string,
  actorId: string | null,
  actorName: string | null,
  body = '',
  metadata: Record<string, unknown> = {},
) {
  await db
    .prepare(
      `INSERT INTO support_case_events
       (id, case_id, event_type, actor_id, actor_name, body, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      caseId,
      eventType,
      actorId,
      actorName,
      body,
      JSON.stringify(metadata),
      jstNow(),
    )
    .run();
}

function validateCaseState(payload: {
  status: string;
  next_check_at: string | null;
  internal_note: string;
  resolution_note: string;
}) {
  if (payload.status === 'on_hold' && (!payload.next_check_at || !payload.internal_note.trim())) {
    return '保留にする場合は、保留理由の内部メモと次回確認日が必要です';
  }
  if (payload.status === 'resolved' && !payload.resolution_note.trim()) {
    return '完了にする場合は、対応結果メモが必要です';
  }
  return null;
}

support.get('/api/support/summary', async (c) => {
  try {
    const lineAccountId = parseRequiredVisibleId(c.req.query('lineAccountId'), 'lineAccountId');
    if (!lineAccountId.ok) return c.json({ success: false, error: lineAccountId.error }, 400);

    const now = jstNow();
    const staff = currentStaff(c);
    const myEscalationPattern = supportStaffLikePattern(staff);
    const visibility = supportCaseVisibilitySql(staff, 'sc', 'se_summary_scope');
    const caseWhere = ['sc.line_account_id = ?'];
    const caseBinds: unknown[] = [lineAccountId.value];
    if (visibility.sql) {
      caseWhere.push(visibility.sql);
      caseBinds.push(...visibility.binds);
    }
    const totals = await c.env.DB
      .prepare(
        `SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN sc.status != 'resolved' THEN 1 ELSE 0 END) AS open,
          SUM(CASE WHEN sc.status IN ('escalated', 'waiting_secondary') THEN 1 ELSE 0 END) AS escalated,
          SUM(CASE WHEN sc.status != 'resolved'
            AND (
              sc.escalation_assignee LIKE ? ESCAPE '\\'
              OR EXISTS (
                SELECT 1
                FROM support_escalations se
                WHERE se.case_id = sc.id
                  AND se.status != 'closed'
                  AND se.assignee LIKE ? ESCAPE '\\'
              )
            )
            THEN 1 ELSE 0 END) AS my_escalations,
          SUM(CASE WHEN sc.due_at IS NOT NULL AND sc.due_at < ? AND sc.status != 'resolved' THEN 1 ELSE 0 END) AS overdue,
          SUM(CASE WHEN (sc.primary_assignee IS NULL OR sc.primary_assignee = '') AND sc.status != 'resolved' THEN 1 ELSE 0 END) AS unassigned,
          SUM(CASE WHEN sc.status = 'customer_reply' THEN 1 ELSE 0 END) AS waiting_customer,
          SUM(CASE WHEN sc.status = 'resolved' THEN 1 ELSE 0 END) AS resolved
         FROM support_cases sc
         WHERE ${caseWhere.join(' AND ')}`,
      )
      .bind(myEscalationPattern, myEscalationPattern, now, ...caseBinds)
      .first<Record<string, number | null>>();

    const [byStatus, byCategory, byAssignee] = await Promise.all([
      c.env.DB.prepare(
        `SELECT status, COUNT(*) AS count
         FROM support_cases sc
         WHERE ${caseWhere.join(' AND ')}
         GROUP BY status`,
      ).bind(...caseBinds).all<{ status: string; count: number }>(),
      c.env.DB.prepare(
        `SELECT category, COUNT(*) AS count
         FROM support_cases sc
         WHERE ${caseWhere.join(' AND ')}
         GROUP BY category`,
      ).bind(...caseBinds).all<{ category: string; count: number }>(),
      c.env.DB.prepare(
        `SELECT COALESCE(NULLIF(primary_assignee, ''), '担当者なし') AS assignee, COUNT(*) AS count
         FROM support_cases sc
         WHERE ${caseWhere.join(' AND ')} AND status != 'resolved'
         GROUP BY COALESCE(NULLIF(primary_assignee, ''), '担当者なし')`,
      ).bind(...caseBinds).all<{ assignee: string; count: number }>(),
    ]);

    return c.json({
      success: true,
      data: {
        totals: {
          total: totals?.total ?? 0,
          open: totals?.open ?? 0,
          escalated: totals?.escalated ?? 0,
          myEscalations: totals?.my_escalations ?? 0,
          overdue: totals?.overdue ?? 0,
          unassigned: totals?.unassigned ?? 0,
          waitingCustomer: totals?.waiting_customer ?? 0,
          resolved: totals?.resolved ?? 0,
        },
        byStatus: byStatus.results,
        byCategory: byCategory.results,
        byAssignee: byAssignee.results,
      },
    });
  } catch (err) {
    console.error(`GET /api/support/summary error: ${supportRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

support.get('/api/support/cases', async (c) => {
  try {
    const lineAccountId = parseRequiredVisibleId(c.req.query('lineAccountId'), 'lineAccountId');
    if (!lineAccountId.ok) return c.json({ success: false, error: lineAccountId.error }, 400);
    const status = parseOptionalQueryText(c.req.query('status'), 'status');
    if (!status.ok) return c.json({ success: false, error: status.error }, 400);
    const queue = parseOptionalQueryText(c.req.query('queue'), 'queue');
    if (!queue.ok) return c.json({ success: false, error: queue.error }, 400);
    const scope = parseOptionalQueryText(c.req.query('scope'), 'scope');
    if (!scope.ok) return c.json({ success: false, error: scope.error }, 400);
    const assignee = parseOptionalQueryText(c.req.query('assignee'), 'assignee');
    if (!assignee.ok) return c.json({ success: false, error: assignee.error }, 400);
    const escalationAssignee = parseOptionalQueryText(c.req.query('escalationAssignee'), 'escalationAssignee');
    if (!escalationAssignee.ok) return c.json({ success: false, error: escalationAssignee.error }, 400);
    const q = parseOptionalQueryText(c.req.query('q'), 'q');
    if (!q.ok) return c.json({ success: false, error: q.error }, 400);
    const limit = clampLimit(c.req.query('limit'), 50);
    const offset = clampOffset(c.req.query('offset'));
    const conditions = ['sc.line_account_id = ?'];
    const binds: unknown[] = [lineAccountId.value];
    const staff = currentStaff(c);
    const visibility = supportCaseVisibilitySql(staff, 'sc', 'se_case_list_scope');
    if (visibility.sql) {
      conditions.push(visibility.sql);
      binds.push(...visibility.binds);
    }

    if (status.value && status.value !== 'all') {
      if (!CASE_STATUSES.has(status.value)) return c.json({ success: false, error: 'invalid status' }, 400);
      conditions.push('sc.status = ?');
      binds.push(status.value);
    }

    const isMyEscalationScope = queue.value === 'my_escalations' || scope.value === 'my_escalations';

    if (queue.value === 'escalated') {
      conditions.push(`sc.status IN ('escalated', 'waiting_secondary')`);
    } else if (queue.value === 'overdue') {
      conditions.push(`sc.due_at IS NOT NULL AND sc.due_at < ? AND sc.status != 'resolved'`);
      binds.push(jstNow());
    } else if (queue.value === 'unassigned') {
      conditions.push(`(sc.primary_assignee IS NULL OR sc.primary_assignee = '') AND sc.status != 'resolved'`);
    } else if (queue.value === 'waiting_customer') {
      conditions.push(`sc.status = 'customer_reply'`);
    } else if (queue.value === 'unresolved') {
      conditions.push(`sc.status != 'resolved'`);
    }

    if (isMyEscalationScope) {
      const pattern = supportStaffLikePattern(staff);
      conditions.push(`sc.status != 'resolved' AND (
        sc.escalation_assignee LIKE ? ESCAPE '\\'
        OR EXISTS (
          SELECT 1
          FROM support_escalations se
          WHERE se.case_id = sc.id
            AND se.status != 'closed'
            AND se.assignee LIKE ? ESCAPE '\\'
        )
      )`);
      binds.push(pattern, pattern);
    }

    if (assignee.value) {
      conditions.push(`(sc.primary_assignee LIKE ? OR sc.escalation_assignee LIKE ?)`);
      binds.push(`%${assignee.value}%`, `%${assignee.value}%`);
    }
    if (escalationAssignee.value) {
      conditions.push(`sc.escalation_assignee LIKE ?`);
      binds.push(`%${escalationAssignee.value}%`);
    }

    if (q.value) {
      const pattern = `%${q.value}%`;
      conditions.push(
        `(sc.title LIKE ? OR sc.customer_summary LIKE ? OR sc.internal_note LIKE ? OR
          sc.customer_number LIKE ? OR sc.company_name LIKE ? OR sc.store_name LIKE ? OR
          f.display_name LIKE ?)`,
      );
      binds.push(pattern, pattern, pattern, pattern, pattern, pattern, pattern);
    }

    const sql = `
      SELECT sc.*,
             f.display_name AS friend_name,
             f.picture_url AS friend_picture_url,
             f.line_user_id
      FROM support_cases sc
      LEFT JOIN friends f ON f.id = sc.friend_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY
        CASE sc.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
        CASE WHEN sc.due_at IS NULL THEN 1 ELSE 0 END,
        sc.due_at ASC,
        sc.updated_at DESC
      LIMIT ? OFFSET ?`;
    const result = await c.env.DB.prepare(sql).bind(...binds, limit, offset).all<SupportCaseRow>();
    return c.json({ success: true, data: result.results.map(serializeCase) });
  } catch (err) {
    console.error(`GET /api/support/cases error: ${supportRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

support.post('/api/support/cases', requireRole('owner', 'admin'), async (c) => {
  try {
    const parsedBody = await readJsonRecord(c);
    if (!parsedBody.ok) return c.json({ success: false, error: parsedBody.error }, 400);
    const body = parsedBody.value;
    const parsedFriendId = parseOptionalVisibleId(body.friendId, 'friendId');
    if (!parsedFriendId.ok) return c.json({ success: false, error: parsedFriendId.error }, 400);
    const friendId = parsedFriendId.value;
    const parsedLineAccountId = parseOptionalVisibleId(body.lineAccountId, 'lineAccountId');
    if (!parsedLineAccountId.ok) return c.json({ success: false, error: parsedLineAccountId.error }, 400);
    let lineAccountId: string | undefined | null = parsedLineAccountId.value;

    if (friendId) {
      const friend = await c.env.DB
        .prepare(`SELECT id, line_account_id, display_name FROM friends WHERE id = ?`)
        .bind(friendId)
        .first<{ id: string; line_account_id: string | null; display_name: string | null }>();
      if (!friend) return c.json({ success: false, error: 'friend not found' }, 404);
      if (lineAccountId && friend.line_account_id && lineAccountId !== friend.line_account_id) {
        return c.json({ success: false, error: 'friend does not belong to lineAccountId' }, 400);
      }
      lineAccountId = lineAccountId ?? friend.line_account_id;
    }

    if (!lineAccountId) return c.json({ success: false, error: 'lineAccountId is required' }, 400);
    const staff = currentStaff(c);
    if (friendId && isRestrictedSupportStaff(staff) && !(await canAccessSupportFriend(c.env.DB, staff, friendId))) {
      return c.json({ success: false, error: 'friend not found' }, 404);
    }

    const parsedCategory = parseOptionalTextField(body.category, 'category');
    if (!parsedCategory.ok) return c.json({ success: false, error: parsedCategory.error }, 400);
    const parsedPriority = parseOptionalTextField(body.priority, 'priority');
    if (!parsedPriority.ok) return c.json({ success: false, error: parsedPriority.error }, 400);
    const parsedStatus = parseOptionalTextField(body.status, 'status');
    if (!parsedStatus.ok) return c.json({ success: false, error: parsedStatus.error }, 400);
    const category = parsedCategory.value ?? 'other';
    const priority = parsedPriority.value ?? 'medium';
    const status = parsedStatus.value ?? 'open';
    if (!PRIORITIES.has(priority)) return c.json({ success: false, error: 'invalid priority' }, 400);
    if (!CASE_STATUSES.has(status)) return c.json({ success: false, error: 'invalid status' }, 400);

    const parsedCustomerSummary = parseOptionalTextField(body.customerSummary, 'customerSummary', SUPPORT_LONG_TEXT_MAX_LENGTH);
    if (!parsedCustomerSummary.ok) return c.json({ success: false, error: parsedCustomerSummary.error }, 400);
    const customerSummary = parsedCustomerSummary.value ?? '';
    if (!friendId && !customerSummary.trim()) {
      return c.json({ success: false, error: 'LINE会話を選ぶか、問い合わせ要約を入力してください。' }, 400);
    }
    const parsedInternalNote = parseOptionalTextField(body.internalNote, 'internalNote', SUPPORT_LONG_TEXT_MAX_LENGTH);
    if (!parsedInternalNote.ok) return c.json({ success: false, error: parsedInternalNote.error }, 400);
    const parsedResolutionNote = parseOptionalTextField(body.resolutionNote, 'resolutionNote', SUPPORT_LONG_TEXT_MAX_LENGTH);
    if (!parsedResolutionNote.ok) return c.json({ success: false, error: parsedResolutionNote.error }, 400);
    const parsedNextCheckAt = parseOptionalTextField(body.nextCheckAt, 'nextCheckAt');
    if (!parsedNextCheckAt.ok) return c.json({ success: false, error: parsedNextCheckAt.error }, 400);
    const internalNote = parsedInternalNote.value ?? '';
    const resolutionNote = parsedResolutionNote.value ?? '';
    const nextCheckAt = parsedNextCheckAt.value;
    const validationError = validateCaseState({
      status,
      next_check_at: nextCheckAt,
      internal_note: internalNote,
      resolution_note: resolutionNote,
    });
    if (validationError) return c.json({ success: false, error: validationError }, 400);

    const now = jstNow();
    const id = crypto.randomUUID();
    const manualIdsInput = parseManualIdsInput(body.manualIds);
    if (!manualIdsInput.ok) return c.json({ success: false, error: manualIdsInput.error }, 400);
    const manualValidation = await validateManualIds(c.env.DB, lineAccountId, manualIdsInput.value);
    if (!manualValidation.ok) return c.json({ success: false, error: manualValidation.error }, 400);
    const manualIds = JSON.stringify(manualValidation.ids);
    const parsedTitle = parseOptionalTextField(body.title, 'title');
    if (!parsedTitle.ok) return c.json({ success: false, error: parsedTitle.error }, 400);
    const parsedPrimaryAssignee = parseOptionalTextField(body.primaryAssignee, 'primaryAssignee');
    if (!parsedPrimaryAssignee.ok) return c.json({ success: false, error: parsedPrimaryAssignee.error }, 400);
    const parsedEscalationAssignee = parseOptionalTextField(body.escalationAssignee, 'escalationAssignee');
    if (!parsedEscalationAssignee.ok) return c.json({ success: false, error: parsedEscalationAssignee.error }, 400);
    const parsedEscalationLevel = parseOptionalTextField(body.escalationLevel, 'escalationLevel');
    if (!parsedEscalationLevel.ok) return c.json({ success: false, error: parsedEscalationLevel.error }, 400);
    const parsedDueAt = parseOptionalTextField(body.dueAt, 'dueAt');
    if (!parsedDueAt.ok) return c.json({ success: false, error: parsedDueAt.error }, 400);
    const parsedCustomerNumber = parseOptionalTextField(body.customerNumber, 'customerNumber');
    if (!parsedCustomerNumber.ok) return c.json({ success: false, error: parsedCustomerNumber.error }, 400);
    const parsedCompanyName = parseOptionalTextField(body.companyName, 'companyName');
    if (!parsedCompanyName.ok) return c.json({ success: false, error: parsedCompanyName.error }, 400);
    const parsedContactName = parseOptionalTextField(body.contactName, 'contactName');
    if (!parsedContactName.ok) return c.json({ success: false, error: parsedContactName.error }, 400);
    const parsedStoreName = parseOptionalTextField(body.storeName, 'storeName');
    if (!parsedStoreName.ok) return c.json({ success: false, error: parsedStoreName.error }, 400);
    const parsedContractType = parseOptionalTextField(body.contractType, 'contractType');
    if (!parsedContractType.ok) return c.json({ success: false, error: parsedContractType.error }, 400);
    const parsedCustomerReplyDraft = parseOptionalTextField(body.customerReplyDraft, 'customerReplyDraft', SUPPORT_LONG_TEXT_MAX_LENGTH);
    if (!parsedCustomerReplyDraft.ok) return c.json({ success: false, error: parsedCustomerReplyDraft.error }, 400);
    const title =
      parsedTitle.value ??
      (customerSummary ? customerSummary.slice(0, 42) : null) ??
      '新規問い合わせ';

    await c.env.DB
      .prepare(
        `INSERT INTO support_cases (
          id, line_account_id, friend_id, title, category, priority, status,
          primary_assignee, escalation_assignee, escalation_level, due_at, next_check_at,
          customer_number, company_name, contact_name, store_name, contract_type,
          customer_summary, internal_note, customer_reply_draft, resolution_note, manual_ids,
          created_by, updated_by, closed_at, reopened_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        lineAccountId,
        friendId,
        title,
        category,
        priority,
        status,
        parsedPrimaryAssignee.value,
        parsedEscalationAssignee.value,
        parsedEscalationLevel.value ?? 'L1',
        parsedDueAt.value,
        nextCheckAt,
        parsedCustomerNumber.value,
        parsedCompanyName.value,
        parsedContactName.value,
        parsedStoreName.value,
        parsedContractType.value,
        customerSummary,
        internalNote,
        parsedCustomerReplyDraft.value ?? '',
        resolutionNote,
        manualIds,
        staff.id,
        staff.id,
        status === 'resolved' ? now : null,
        status === 'reopened' ? now : null,
        now,
        now,
      )
      .run();

    await addCaseEvent(c.env.DB, id, 'created', staff.id, staff.name, '案件を作成しました', {
      status,
      priority,
      category,
      friendId,
    });

    const created = await getCaseRow(c.env.DB, id, lineAccountId, staff);
    return c.json({ success: true, data: serializeCase(created!) }, 201);
  } catch (err) {
    console.error(`POST /api/support/cases error: ${supportRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

support.get('/api/support/cases/:id', async (c) => {
  try {
    const id = parseRequiredVisibleId(c.req.param('id'), 'caseId');
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const lineAccountId = lineAccountIdFrom(c);
    if (!lineAccountId.ok) return c.json({ success: false, error: lineAccountId.error }, 400);
    const row = await getCaseRow(c.env.DB, id.value, lineAccountId.value, currentStaff(c));
    if (!row) return c.json({ success: false, error: 'case not found' }, 404);

    const [events, escalations] = await Promise.all([
      c.env.DB.prepare(
        `SELECT * FROM support_case_events WHERE case_id = ? ORDER BY created_at ASC`,
      ).bind(row.id).all<SupportEventRow>(),
      c.env.DB.prepare(
        `SELECT se.*, sc.title AS case_title, f.display_name AS friend_name
         FROM support_escalations se
         LEFT JOIN support_cases sc ON sc.id = se.case_id
         LEFT JOIN friends f ON f.id = sc.friend_id
         WHERE se.case_id = ?
         ORDER BY se.created_at DESC`,
      ).bind(row.id).all<SupportEscalationRow>(),
    ]);

    const messages = row.friend_id
      ? await c.env.DB.prepare(
        `SELECT id, direction, message_type, content, created_at
         FROM messages_log
         WHERE friend_id = ? AND (delivery_type IS NULL OR delivery_type != 'test')
         ORDER BY created_at DESC LIMIT 50`,
      ).bind(row.friend_id).all<{ id: string; direction: string; message_type: string; content: string; created_at: string }>()
      : { results: [] as Array<{ id: string; direction: string; message_type: string; content: string; created_at: string }> };

    const manualIds = parseManualIds(row.manual_ids);
    let manuals: SupportManualRow[] = [];
    if (manualIds.length > 0) {
      const placeholders = manualIds.map(() => '?').join(',');
      const res = await c.env.DB
        .prepare(
          `SELECT * FROM support_manuals
           WHERE id IN (${placeholders})
             AND (line_account_id = ? OR line_account_id IS NULL)
           ORDER BY revised_at DESC, title ASC`,
        )
        .bind(...manualIds, lineAccountId.value)
        .all<SupportManualRow>();
      manuals = res.results;
    }

    return c.json({
      success: true,
      data: {
        ...serializeCase(row),
        events: events.results.map(serializeEvent),
        escalations: escalations.results.map(serializeEscalation),
        manuals: manuals.map(serializeManual),
        recentMessages: [...messages.results].reverse().map((m) => ({
          id: m.id,
          direction: m.direction,
          messageType: m.message_type,
          content: m.content,
          createdAt: m.created_at,
        })),
      },
    });
  } catch (err) {
    console.error(`GET /api/support/cases/:id error: ${supportRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

support.patch('/api/support/cases/:id', async (c) => {
  try {
    const id = parseRequiredVisibleId(c.req.param('id'), 'caseId');
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const parsedBody = await readJsonRecord(c);
    if (!parsedBody.ok) return c.json({ success: false, error: parsedBody.error }, 400);
    const body = parsedBody.value;
    const lineAccountId = lineAccountIdFrom(c, body);
    if (!lineAccountId.ok) return c.json({ success: false, error: lineAccountId.error }, 400);
    const staff = currentStaff(c);
    const existing = await getCaseRow(c.env.DB, id.value, lineAccountId.value, staff);
    if (!existing) return c.json({ success: false, error: 'case not found' }, 404);

    if (!canManageSupportCaseRouting(staff)) {
      const forbiddenKeys = Object.keys(body).filter((key) => !STAFF_ALLOWED_CASE_UPDATE_KEYS.has(key));
      if (forbiddenKeys.length > 0) {
        return c.json({
          success: false,
          error: `staff権限では変更できない項目です: ${forbiddenKeys.join(', ')}`,
        }, 403);
      }
    }

    const fields: Array<[string, unknown]> = [];
    const next = { ...existing };

    const stringFields: Array<[keyof SupportCaseRow, string, number]> = [
      ['title', 'title', SUPPORT_SHORT_TEXT_MAX_LENGTH],
      ['category', 'category', SUPPORT_SHORT_TEXT_MAX_LENGTH],
      ['priority', 'priority', SUPPORT_SHORT_TEXT_MAX_LENGTH],
      ['status', 'status', SUPPORT_SHORT_TEXT_MAX_LENGTH],
      ['primary_assignee', 'primaryAssignee', SUPPORT_SHORT_TEXT_MAX_LENGTH],
      ['escalation_assignee', 'escalationAssignee', SUPPORT_SHORT_TEXT_MAX_LENGTH],
      ['escalation_level', 'escalationLevel', SUPPORT_SHORT_TEXT_MAX_LENGTH],
      ['due_at', 'dueAt', SUPPORT_SHORT_TEXT_MAX_LENGTH],
      ['next_check_at', 'nextCheckAt', SUPPORT_SHORT_TEXT_MAX_LENGTH],
      ['customer_number', 'customerNumber', SUPPORT_SHORT_TEXT_MAX_LENGTH],
      ['company_name', 'companyName', SUPPORT_SHORT_TEXT_MAX_LENGTH],
      ['contact_name', 'contactName', SUPPORT_SHORT_TEXT_MAX_LENGTH],
      ['store_name', 'storeName', SUPPORT_SHORT_TEXT_MAX_LENGTH],
      ['contract_type', 'contractType', SUPPORT_SHORT_TEXT_MAX_LENGTH],
      ['customer_summary', 'customerSummary', SUPPORT_LONG_TEXT_MAX_LENGTH],
      ['internal_note', 'internalNote', SUPPORT_LONG_TEXT_MAX_LENGTH],
      ['customer_reply_draft', 'customerReplyDraft', SUPPORT_LONG_TEXT_MAX_LENGTH],
      ['resolution_note', 'resolutionNote', SUPPORT_LONG_TEXT_MAX_LENGTH],
    ];

    for (const [column, key, maxLength] of stringFields) {
      if (!(key in body)) continue;
      const parsed = parseOptionalTextField(body[key], key, maxLength);
      if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);
      const value = parsed.value;
      next[column] = (value ?? '') as never;
      if (['due_at', 'next_check_at', 'primary_assignee', 'escalation_assignee', 'customer_number', 'company_name', 'contact_name', 'store_name', 'contract_type'].includes(column)) {
        fields.push([column, value ?? null]);
      } else {
        fields.push([column, value ?? '']);
      }
    }

    if ('manualIds' in body) {
      const manualIdsInput = parseManualIdsInput(body.manualIds);
      if (!manualIdsInput.ok) return c.json({ success: false, error: manualIdsInput.error }, 400);
      const manualValidation = await validateManualIds(
        c.env.DB,
        lineAccountId.value,
        manualIdsInput.value,
      );
      if (!manualValidation.ok) return c.json({ success: false, error: manualValidation.error }, 400);
      next.manual_ids = JSON.stringify(manualValidation.ids);
      fields.push(['manual_ids', next.manual_ids]);
    }

    const statusRequested = 'status' in body;

    if (!CASE_STATUSES.has(next.status)) return c.json({ success: false, error: 'invalid status' }, 400);
    if (!PRIORITIES.has(next.priority)) return c.json({ success: false, error: 'invalid priority' }, 400);

    const validationError = validateCaseState({
      status: next.status,
      next_check_at: next.next_check_at,
      internal_note: next.internal_note,
      resolution_note: next.resolution_note,
    });
    if (validationError) return c.json({ success: false, error: validationError }, 400);

    if (existing.status === 'resolved' && next.status !== 'resolved' && next.status !== 'reopened') {
      return c.json({ success: false, error: '完了済み案件を戻す場合は再オープンを選択してください' }, 400);
    }
    if (statusRequested && next.status === 'reopened' && existing.status !== 'resolved' && existing.status !== 'reopened') {
      return c.json({ success: false, error: '再オープンは完了済み案件だけで選択できます' }, 400);
    }

    if (fields.length === 0) {
      return c.json({ success: true, data: serializeCase(existing) });
    }

    const now = jstNow();
    if (next.status === 'resolved' && !existing.closed_at) {
      fields.push(['closed_at', now]);
    }
    if (statusRequested && next.status === 'reopened' && existing.status !== 'reopened') {
      fields.push(['reopened_at', now], ['closed_at', null]);
    }
    fields.push(['updated_by', staff.id], ['updated_at', now]);

    const setSql = fields.map(([column]) => `${column} = ?`).join(', ');
    await c.env.DB
      .prepare(`UPDATE support_cases SET ${setSql} WHERE id = ? AND line_account_id = ?`)
      .bind(...fields.map(([, value]) => value), id.value, lineAccountId.value)
      .run();

    await addCaseEvent(c.env.DB, id.value, 'updated', staff.id, staff.name, text(body.eventBody) ?? '案件を更新しました', {
      changed: fields.map(([column]) => column),
      fromStatus: existing.status,
      toStatus: next.status,
    });

    const updated = await getCaseRow(c.env.DB, id.value, lineAccountId.value, staff);
    return c.json({ success: true, data: serializeCase(updated!) });
  } catch (err) {
    console.error(`PATCH /api/support/cases/:id error: ${supportRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

support.post('/api/support/cases/:id/events', async (c) => {
  try {
    const id = parseRequiredVisibleId(c.req.param('id'), 'caseId');
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const parsedBody = await readJsonRecord(c);
    if (!parsedBody.ok) return c.json({ success: false, error: parsedBody.error }, 400);
    const body = parsedBody.value;
    const lineAccountId = lineAccountIdFrom(c, body);
    if (!lineAccountId.ok) return c.json({ success: false, error: lineAccountId.error }, 400);
    const eventType = parseOptionalTextField(body.eventType, 'eventType');
    if (!eventType.ok) return c.json({ success: false, error: eventType.error }, 400);
    const eventBody = parseOptionalTextField(body.body, 'body', SUPPORT_LONG_TEXT_MAX_LENGTH);
    if (!eventBody.ok) return c.json({ success: false, error: eventBody.error }, 400);
    const metadata = parseOptionalEventMetadata(body.metadata);
    if (!metadata.ok) return c.json({ success: false, error: metadata.error }, 400);
    const row = await getCaseRow(c.env.DB, id.value, lineAccountId.value, currentStaff(c));
    if (!row) return c.json({ success: false, error: 'case not found' }, 404);
    const staff = currentStaff(c);
    await addCaseEvent(
      c.env.DB,
      row.id,
      eventType.value ?? 'note',
      staff.id,
      staff.name,
      eventBody.value ?? '',
      metadata.value,
    );
    return c.json({ success: true, data: null }, 201);
  } catch (err) {
    console.error(`POST /api/support/cases/:id/events error: ${supportRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

support.post('/api/support/cases/:id/escalations', async (c) => {
  try {
    const caseId = parseRequiredVisibleId(c.req.param('id'), 'caseId');
    if (!caseId.ok) return c.json({ success: false, error: caseId.error }, 400);
    const parsedBody = await readJsonRecord(c);
    if (!parsedBody.ok) return c.json({ success: false, error: parsedBody.error }, 400);
    const body = parsedBody.value;
    const lineAccountId = lineAccountIdFrom(c, body);
    if (!lineAccountId.ok) return c.json({ success: false, error: lineAccountId.error }, 400);
    const staff = currentStaff(c);
    const row = await getCaseRow(c.env.DB, caseId.value, lineAccountId.value, staff);
    if (!row) return c.json({ success: false, error: 'case not found' }, 404);
    if (row.status === 'resolved') {
      return c.json({ success: false, error: '完了済み案件は再オープンしてからエスカレーションしてください' }, 400);
    }
    const canRouteEscalation = canManageSupportCaseRouting(staff);
    if (!canRouteEscalation) {
      const forbiddenKeys = Object.keys(body).filter((key) => !STAFF_ALLOWED_ESCALATION_CREATE_KEYS.has(key));
      if (forbiddenKeys.length > 0) {
        return c.json({
          success: false,
          error: `staff権限では指定できないエスカレーション項目です: ${forbiddenKeys.join(', ')}`,
        }, 403);
      }
    }

    const parsedAssignee = canRouteEscalation
      ? parseOptionalTextField(body.assignee, 'assignee')
      : parseOptionalTextField(row.escalation_assignee, 'assignee');
    if (!parsedAssignee.ok) return c.json({ success: false, error: parsedAssignee.error }, 400);
    const parsedQuestion = parseOptionalTextField(body.question, 'question', SUPPORT_LONG_TEXT_MAX_LENGTH);
    if (!parsedQuestion.ok) return c.json({ success: false, error: parsedQuestion.error }, 400);
    const assignee = parsedAssignee.value;
    const question = parsedQuestion.value;
    const levelFromCase = ESCALATION_LEVELS.has(row.escalation_level) ? row.escalation_level : 'L2';
    const parsedLevel = canRouteEscalation ? parseOptionalTextField(body.level, 'level') : { ok: true as const, value: levelFromCase };
    if (!parsedLevel.ok) return c.json({ success: false, error: parsedLevel.error }, 400);
    const level = parsedLevel.value ?? 'L2';
    if (!assignee) {
      return c.json({
        success: false,
        error: canRouteEscalation ? 'assignee is required' : 'staff権限では二次対応先が設定済みの案件だけエスカレーションできます',
      }, 400);
    }
    if (!question) return c.json({ success: false, error: 'question is required' }, 400);
    if (!ESCALATION_LEVELS.has(level)) return c.json({ success: false, error: 'invalid level' }, 400);

    const now = jstNow();
    const id = crypto.randomUUID();
    const parsedDueAt = canRouteEscalation ? parseOptionalTextField(body.dueAt, 'dueAt') : { ok: true as const, value: null };
    if (!parsedDueAt.ok) return c.json({ success: false, error: parsedDueAt.error }, 400);
    const dueAt = parsedDueAt.value;
    await c.env.DB
      .prepare(
        `INSERT INTO support_escalations (
          id, case_id, line_account_id, assignee, level, status, question, answer,
          due_at, answered_at, created_by, updated_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?, '', ?, NULL, ?, ?, ?, ?)`,
      )
      .bind(id, caseId.value, row.line_account_id, assignee, level, question, dueAt, staff.id, staff.id, now, now)
      .run();

    if (canRouteEscalation) {
      await c.env.DB
        .prepare(
          `UPDATE support_cases
           SET status = 'waiting_secondary',
               escalation_assignee = ?,
               escalation_level = ?,
               due_at = COALESCE(?, due_at),
               updated_by = ?,
               updated_at = ?
           WHERE id = ? AND line_account_id = ?`,
        )
        .bind(assignee, level, dueAt, staff.id, now, caseId.value, lineAccountId.value)
        .run();
    } else {
      await c.env.DB
        .prepare(
          `UPDATE support_cases
           SET status = 'waiting_secondary',
               updated_by = ?,
               updated_at = ?
           WHERE id = ? AND line_account_id = ?`,
        )
        .bind(staff.id, now, caseId.value, lineAccountId.value)
        .run();
    }

    await addCaseEvent(c.env.DB, caseId.value, 'escalated', staff.id, staff.name, question, {
      escalationId: id,
      assignee,
      level,
      dueAt,
    });

    const escalation = await c.env.DB
      .prepare(`SELECT * FROM support_escalations WHERE id = ? AND line_account_id = ?`)
      .bind(id, lineAccountId.value)
      .first<SupportEscalationRow>();
    return c.json({ success: true, data: serializeEscalation(escalation!) }, 201);
  } catch (err) {
    console.error(`POST /api/support/cases/:id/escalations error: ${supportRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

support.get('/api/support/escalations', async (c) => {
  try {
    const lineAccountId = parseRequiredVisibleId(c.req.query('lineAccountId'), 'lineAccountId');
    if (!lineAccountId.ok) return c.json({ success: false, error: lineAccountId.error }, 400);
    const status = parseOptionalQueryText(c.req.query('status'), 'status');
    if (!status.ok) return c.json({ success: false, error: status.error }, 400);
    const assignee = parseOptionalQueryText(c.req.query('assignee'), 'assignee');
    if (!assignee.ok) return c.json({ success: false, error: assignee.error }, 400);
    const queue = parseOptionalQueryText(c.req.query('queue'), 'queue');
    if (!queue.ok) return c.json({ success: false, error: queue.error }, 400);
    const scope = parseOptionalQueryText(c.req.query('scope'), 'scope');
    if (!scope.ok) return c.json({ success: false, error: scope.error }, 400);
    const conditions = ['se.line_account_id = ?'];
    const binds: unknown[] = [lineAccountId.value];
    const staff = currentStaff(c);
    const visibility = supportEscalationVisibilitySql(staff, 'se', 'sc_escalation_list_scope');
    if (visibility.sql) {
      conditions.push(visibility.sql);
      binds.push(...visibility.binds);
    }

    if (status.value && status.value !== 'all') {
      if (!ESCALATION_STATUSES.has(status.value)) return c.json({ success: false, error: 'invalid status' }, 400);
      conditions.push('se.status = ?');
      binds.push(status.value);
    }
    if (assignee.value) {
      conditions.push('se.assignee LIKE ?');
      binds.push(`%${assignee.value}%`);
    }
    if (scope.value === 'my_escalations' || queue.value === 'my_escalations') {
      conditions.push(`se.assignee LIKE ? ESCAPE '\\'`);
      binds.push(supportStaffLikePattern(staff));
    }
    if (queue.value === 'due') {
      conditions.push(`se.status = 'pending' AND se.due_at IS NOT NULL AND se.due_at <= ?`);
      binds.push(jstNow());
    }

    const result = await c.env.DB
      .prepare(
        `SELECT se.*, sc.title AS case_title, f.display_name AS friend_name
         FROM support_escalations se
         LEFT JOIN support_cases sc ON sc.id = se.case_id
         LEFT JOIN friends f ON f.id = sc.friend_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY
           CASE WHEN se.due_at IS NULL THEN 1 ELSE 0 END,
           se.due_at ASC,
           se.updated_at DESC
         LIMIT 100`,
      )
      .bind(...binds)
      .all<SupportEscalationRow>();
    return c.json({ success: true, data: result.results.map(serializeEscalation) });
  } catch (err) {
    console.error(`GET /api/support/escalations error: ${supportRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

support.patch('/api/support/escalations/:id', async (c) => {
  try {
    const id = parseRequiredVisibleId(c.req.param('id'), 'escalationId');
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const parsedBody = await readJsonRecord(c);
    if (!parsedBody.ok) return c.json({ success: false, error: parsedBody.error }, 400);
    const body = parsedBody.value;
    const lineAccountId = lineAccountIdFrom(c, body);
    if (!lineAccountId.ok) return c.json({ success: false, error: lineAccountId.error }, 400);
    const staffForScope = currentStaff(c);
    const visibility = supportEscalationVisibilitySql(staffForScope, 'se', 'sc_escalation_update_scope');
    const conditions = ['se.id = ?', 'se.line_account_id = ?'];
    const binds: unknown[] = [id.value, lineAccountId.value];
    if (visibility.sql) {
      conditions.push(visibility.sql);
      binds.push(...visibility.binds);
    }
    const existing = await c.env.DB
      .prepare(`SELECT se.* FROM support_escalations se WHERE ${conditions.join(' AND ')}`)
      .bind(...binds)
      .first<SupportEscalationRow>();
    if (!existing) return c.json({ success: false, error: 'escalation not found' }, 404);

    const fields: Array<[string, unknown]> = [];
    const statusRequested = 'status' in body;
    const parsedStatus = parseOptionalTextField(body.status, 'status');
    if (!parsedStatus.ok) return c.json({ success: false, error: parsedStatus.error }, 400);
    const parsedLevel = parseOptionalTextField(body.level, 'level');
    if (!parsedLevel.ok) return c.json({ success: false, error: parsedLevel.error }, 400);
    const parsedAnswer = parseOptionalTextField(body.answer, 'answer', SUPPORT_LONG_TEXT_MAX_LENGTH);
    if (!parsedAnswer.ok) return c.json({ success: false, error: parsedAnswer.error }, 400);
    const parsedAssignee = parseOptionalTextField(body.assignee, 'assignee');
    if (!parsedAssignee.ok) return c.json({ success: false, error: parsedAssignee.error }, 400);
    const parsedQuestion = parseOptionalTextField(body.question, 'question', SUPPORT_LONG_TEXT_MAX_LENGTH);
    if (!parsedQuestion.ok) return c.json({ success: false, error: parsedQuestion.error }, 400);
    const parsedDueAt = parseOptionalTextField(body.dueAt, 'dueAt');
    if (!parsedDueAt.ok) return c.json({ success: false, error: parsedDueAt.error }, 400);
    const parsedEventBody = parseOptionalTextField(body.eventBody, 'eventBody', SUPPORT_LONG_TEXT_MAX_LENGTH);
    if (!parsedEventBody.ok) return c.json({ success: false, error: parsedEventBody.error }, 400);
    const status = parsedStatus.value ?? existing.status;
    const level = parsedLevel.value ?? existing.level;
    if (!ESCALATION_STATUSES.has(status)) return c.json({ success: false, error: 'invalid status' }, 400);
    if (!ESCALATION_LEVELS.has(level)) return c.json({ success: false, error: 'invalid level' }, 400);
    const nextAnswer = 'answer' in body ? (parsedAnswer.value ?? '') : existing.answer;
    if (status === 'answered' && !nextAnswer.trim()) {
      return c.json({ success: false, error: '回答済みにする場合は回答要点が必要です' }, 400);
    }
    if (!canManageSupportCaseRouting(staffForScope)) {
      const forbiddenKeys = Object.keys(body).filter((key) => !STAFF_ALLOWED_ESCALATION_UPDATE_KEYS.has(key));
      if (forbiddenKeys.length > 0) {
        return c.json({
          success: false,
          error: `staff権限では変更できないエスカレーション項目です: ${forbiddenKeys.join(', ')}`,
        }, 403);
      }
      if ('status' in body && !STAFF_ALLOWED_ESCALATION_STATUSES.has(status)) {
        return c.json({
          success: false,
          error: 'staff権限ではエスカレーションを回答済み、または差し戻しにのみ変更できます',
        }, 403);
      }
    }

    if ('status' in body) fields.push(['status', status]);
    if ('level' in body) fields.push(['level', level]);
    if ('assignee' in body) fields.push(['assignee', parsedAssignee.value ?? existing.assignee]);
    if ('question' in body) fields.push(['question', parsedQuestion.value ?? existing.question]);
    if ('answer' in body) fields.push(['answer', nextAnswer]);
    if ('dueAt' in body) fields.push(['due_at', parsedDueAt.value]);

    let nextCaseStatus: string | null = null;
    if (statusRequested) {
      if (status === 'answered') nextCaseStatus = 'customer_reply';
      if (status === 'needs_info') nextCaseStatus = 'waiting_primary';
      if (status === 'transferred' || status === 'expert_check') nextCaseStatus = 'waiting_secondary';
    }
    if (nextCaseStatus) {
      const linkedCase = await c.env.DB
        .prepare(`SELECT status FROM support_cases WHERE id = ? AND line_account_id = ?`)
        .bind(existing.case_id, lineAccountId.value)
        .first<{ status: string }>();
      if (!linkedCase) return c.json({ success: false, error: 'case not found' }, 404);
      if (linkedCase.status === 'resolved') {
        return c.json({ success: false, error: '完了済み案件は再オープンしてからエスカレーションを更新してください' }, 400);
      }
    }

    const staff = staffForScope;
    const now = jstNow();
    if ((status === 'answered' || status === 'closed') && !existing.answered_at) {
      fields.push(['answered_at', now]);
    }
    fields.push(['updated_by', staff.id], ['updated_at', now]);

    if (fields.length > 0) {
      const setSql = fields.map(([column]) => `${column} = ?`).join(', ');
      await c.env.DB.prepare(`UPDATE support_escalations SET ${setSql} WHERE id = ? AND line_account_id = ?`)
        .bind(...fields.map(([, value]) => value), id.value, lineAccountId.value)
        .run();
    }

    if (nextCaseStatus) {
      await c.env.DB.prepare(`UPDATE support_cases SET status = ?, updated_by = ?, updated_at = ? WHERE id = ? AND line_account_id = ?`)
        .bind(nextCaseStatus, staff.id, now, existing.case_id, lineAccountId.value)
        .run();
    }

    await addCaseEvent(
      c.env.DB,
      existing.case_id,
      'escalation_updated',
      staff.id,
      staff.name,
      parsedEventBody.value ?? parsedAnswer.value ?? 'エスカレーションを更新しました',
      { escalationId: id.value, status, nextCaseStatus },
    );

    const updated = await c.env.DB
      .prepare(
        `SELECT se.*, sc.title AS case_title, f.display_name AS friend_name
         FROM support_escalations se
         LEFT JOIN support_cases sc ON sc.id = se.case_id
         LEFT JOIN friends f ON f.id = sc.friend_id
         WHERE se.id = ? AND se.line_account_id = ?`,
      )
      .bind(id.value, lineAccountId.value)
      .first<SupportEscalationRow>();
    return c.json({ success: true, data: serializeEscalation(updated!) });
  } catch (err) {
    console.error(`PATCH /api/support/escalations/:id error: ${supportRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

support.get('/api/support/manuals', async (c) => {
  try {
    const lineAccountId = parseOptionalVisibleId(c.req.query('lineAccountId'), 'lineAccountId');
    if (!lineAccountId.ok) return c.json({ success: false, error: lineAccountId.error }, 400);
    const category = parseOptionalQueryText(c.req.query('category'), 'category');
    if (!category.ok) return c.json({ success: false, error: category.error }, 400);
    const q = parseOptionalQueryText(c.req.query('q'), 'q');
    if (!q.ok) return c.json({ success: false, error: q.error }, 400);
    const active = parseActiveFilter(c.req.query('active'));
    if (!active.ok) return c.json({ success: false, error: active.error }, 400);
    const conditions: string[] = [];
    const binds: unknown[] = [];

    if (lineAccountId.value) {
      conditions.push('(line_account_id = ? OR line_account_id IS NULL)');
      binds.push(lineAccountId.value);
    }
    if (category.value && category.value !== 'all') {
      conditions.push('category = ?');
      binds.push(category.value);
    }
    if (active.value !== 'all') {
      conditions.push('is_active = ?');
      binds.push(active.value === '0' ? 0 : 1);
    }
    if (q.value) {
      const pattern = `%${q.value}%`;
      conditions.push('(title LIKE ? OR body LIKE ? OR keywords LIKE ?)');
      binds.push(pattern, pattern, pattern);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await c.env.DB
      .prepare(
        `SELECT * FROM support_manuals
         ${where}
         ORDER BY is_active DESC, revised_at DESC, title ASC
         LIMIT 100`,
      )
      .bind(...binds)
      .all<SupportManualRow>();
    return c.json({ success: true, data: result.results.map(serializeManual) });
  } catch (err) {
    console.error(`GET /api/support/manuals error: ${supportRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

support.post('/api/support/manuals', requireRole('owner', 'admin'), async (c) => {
  try {
    const parsedBody = await readJsonRecord(c);
    if (!parsedBody.ok) return c.json({ success: false, error: parsedBody.error }, 400);
    const body = parsedBody.value;
    const titleInput = parseRequiredTextField(body.title, 'title');
    if (!titleInput.ok) return c.json({ success: false, error: titleInput.error }, 400);
    const manualBodyInput = parseRequiredTextField(body.body, 'body', SUPPORT_LONG_TEXT_MAX_LENGTH);
    if (!manualBodyInput.ok) return c.json({ success: false, error: manualBodyInput.error }, 400);
    const manualUrlInput = parseOptionalTextField(body.url, 'url', SUPPORT_URL_MAX_LENGTH);
    if (!manualUrlInput.ok) return c.json({ success: false, error: manualUrlInput.error }, 400);
    const category = parseOptionalTextField(body.category, 'category');
    if (!category.ok) return c.json({ success: false, error: category.error }, 400);
    const keywords = parseOptionalTextField(body.keywords, 'keywords', SUPPORT_LONG_TEXT_MAX_LENGTH);
    if (!keywords.ok) return c.json({ success: false, error: keywords.error }, 400);
    const owner = parseOptionalTextField(body.owner, 'owner');
    if (!owner.ok) return c.json({ success: false, error: owner.error }, 400);
    const approvedBy = parseOptionalTextField(body.approvedBy, 'approvedBy');
    if (!approvedBy.ok) return c.json({ success: false, error: approvedBy.error }, 400);
    const revisedAt = parseOptionalTextField(body.revisedAt, 'revisedAt');
    if (!revisedAt.ok) return c.json({ success: false, error: revisedAt.error }, 400);
    const title = titleInput.value;
    const manualBody = manualBodyInput.value;
    const manualUrl = manualUrlInput.value;
    if (manualUrl && !isHttpUrl(manualUrl)) {
      return c.json({ success: false, error: 'url must start with http:// or https://' }, 400);
    }
    const lineAccountId = parseRequiredVisibleId(body.lineAccountId, 'lineAccountId');
    if (!lineAccountId.ok) return c.json({ success: false, error: lineAccountId.error }, 400);

    const staff = currentStaff(c);
    const now = jstNow();
    const id = crypto.randomUUID();
    await c.env.DB.prepare(
      `INSERT INTO support_manuals (
        id, line_account_id, title, category, body, url, keywords, owner, approved_by,
        revised_at, is_active, created_by, updated_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      lineAccountId.value,
      title,
      category.value ?? 'basic',
      manualBody,
      manualUrl,
      keywords.value ?? '',
      owner.value,
      approvedBy.value,
      revisedAt.value ?? now.slice(0, 10),
      body.isActive === false ? 0 : 1,
      staff.id,
      staff.id,
      now,
      now,
    ).run();

    const created = await c.env.DB.prepare(`SELECT * FROM support_manuals WHERE id = ?`).bind(id).first<SupportManualRow>();
    return c.json({ success: true, data: serializeManual(created!) }, 201);
  } catch (err) {
    console.error(`POST /api/support/manuals error: ${supportRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

support.patch('/api/support/manuals/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = parseRequiredVisibleId(c.req.param('id'), 'manualId');
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const parsedBody = await readJsonRecord(c);
    if (!parsedBody.ok) return c.json({ success: false, error: parsedBody.error }, 400);
    const body = parsedBody.value;
    const lineAccountId = lineAccountIdFrom(c, body);
    if (!lineAccountId.ok) return c.json({ success: false, error: lineAccountId.error }, 400);

    const existing = await c.env.DB
      .prepare(`SELECT * FROM support_manuals WHERE id = ? AND line_account_id = ?`)
      .bind(id.value, lineAccountId.value)
      .first<SupportManualRow>();
    if (!existing) return c.json({ success: false, error: 'manual not found' }, 404);
    const manualInputs: Record<string, string | null> = {};
    const manualFieldLimits: Record<string, number> = {
      title: SUPPORT_SHORT_TEXT_MAX_LENGTH,
      category: SUPPORT_SHORT_TEXT_MAX_LENGTH,
      body: SUPPORT_LONG_TEXT_MAX_LENGTH,
      url: SUPPORT_URL_MAX_LENGTH,
      keywords: SUPPORT_LONG_TEXT_MAX_LENGTH,
      owner: SUPPORT_SHORT_TEXT_MAX_LENGTH,
      approvedBy: SUPPORT_SHORT_TEXT_MAX_LENGTH,
      revisedAt: SUPPORT_SHORT_TEXT_MAX_LENGTH,
    };
    for (const [key, maxLength] of Object.entries(manualFieldLimits)) {
      if (!(key in body)) continue;
      const parsed = parseOptionalTextField(body[key], key, maxLength);
      if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);
      manualInputs[key] = parsed.value;
    }
    if ('title' in body && !manualInputs.title) return c.json({ success: false, error: 'title is required' }, 400);
    if ('body' in body && !manualInputs.body) return c.json({ success: false, error: 'body is required' }, 400);
    const manualUrl = 'url' in body ? manualInputs.url : null;
    if (manualUrl && !isHttpUrl(manualUrl)) {
      return c.json({ success: false, error: 'url must start with http:// or https://' }, 400);
    }

    const fields: Array<[string, unknown]> = [];
    const mapping: Array<[string, string]> = [
      ['title', 'title'],
      ['category', 'category'],
      ['body', 'body'],
      ['url', 'url'],
      ['keywords', 'keywords'],
      ['owner', 'owner'],
      ['approved_by', 'approvedBy'],
      ['revised_at', 'revisedAt'],
    ];
    for (const [column, key] of mapping) {
      if (key in body) fields.push([column, manualInputs[key] ?? null]);
    }
    if ('isActive' in body) fields.push(['is_active', body.isActive === false ? 0 : 1]);
    const staff = currentStaff(c);
    fields.push(['updated_by', staff.id], ['updated_at', jstNow()]);

    await c.env.DB.prepare(`UPDATE support_manuals SET ${fields.map(([column]) => `${column} = ?`).join(', ')} WHERE id = ? AND line_account_id = ?`)
      .bind(...fields.map(([, value]) => value), id.value, lineAccountId.value)
      .run();

    const updated = await c.env.DB
      .prepare(`SELECT * FROM support_manuals WHERE id = ? AND line_account_id = ?`)
      .bind(id.value, lineAccountId.value)
      .first<SupportManualRow>();
    return c.json({ success: true, data: serializeManual(updated!) });
  } catch (err) {
    console.error(`PATCH /api/support/manuals/:id error: ${supportRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

support.delete('/api/support/manuals/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    const staff = currentStaff(c);
    const id = parseRequiredVisibleId(c.req.param('id'), 'manualId');
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const lineAccountId = parseRequiredVisibleId(c.req.query('lineAccountId'), 'lineAccountId');
    if (!lineAccountId.ok) return c.json({ success: false, error: lineAccountId.error }, 400);

    const existing = await c.env.DB
      .prepare(`SELECT * FROM support_manuals WHERE id = ? AND line_account_id = ?`)
      .bind(id.value, lineAccountId.value)
      .first<SupportManualRow>();
    if (!existing) return c.json({ success: false, error: 'manual not found' }, 404);

    await c.env.DB
      .prepare(`UPDATE support_manuals SET is_active = 0, updated_by = ?, updated_at = ? WHERE id = ? AND line_account_id = ?`)
      .bind(staff.id, jstNow(), id.value, lineAccountId.value)
      .run();
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error(`DELETE /api/support/manuals/:id error: ${supportRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { support };

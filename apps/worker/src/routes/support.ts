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

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
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

function currentStaff(c: Context<Env>) {
  const staff = c.get('staff');
  return staff ?? { id: 'system', name: 'system', role: 'staff' as const };
}

function canManageSupportCaseRouting(staff: SupportAccessStaff): boolean {
  return staff.role === 'owner' || staff.role === 'admin';
}

function lineAccountIdFrom(c: Context<Env>, body?: Record<string, unknown>): string | null {
  return text(body?.lineAccountId) ?? text(c.req.query('lineAccountId'));
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
    const lineAccountId = c.req.query('lineAccountId');
    if (!lineAccountId) return c.json({ success: false, error: 'lineAccountId is required' }, 400);

    const now = jstNow();
    const staff = currentStaff(c);
    const myEscalationPattern = supportStaffLikePattern(staff);
    const visibility = supportCaseVisibilitySql(staff, 'sc', 'se_summary_scope');
    const caseWhere = ['sc.line_account_id = ?'];
    const caseBinds: unknown[] = [lineAccountId];
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
    console.error('GET /api/support/summary error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

support.get('/api/support/cases', async (c) => {
  try {
    const lineAccountId = c.req.query('lineAccountId');
    if (!lineAccountId) return c.json({ success: false, error: 'lineAccountId is required' }, 400);

    const status = c.req.query('status');
    const queue = c.req.query('queue');
    const scope = c.req.query('scope');
    const assignee = c.req.query('assignee');
    const escalationAssignee = c.req.query('escalationAssignee');
    const q = c.req.query('q');
    const limit = clampLimit(c.req.query('limit'), 50);
    const offset = Math.max(0, Number(c.req.query('offset') ?? '0') || 0);
    const conditions = ['sc.line_account_id = ?'];
    const binds: unknown[] = [lineAccountId];
    const staff = currentStaff(c);
    const visibility = supportCaseVisibilitySql(staff, 'sc', 'se_case_list_scope');
    if (visibility.sql) {
      conditions.push(visibility.sql);
      binds.push(...visibility.binds);
    }

    if (status && status !== 'all') {
      if (!CASE_STATUSES.has(status)) return c.json({ success: false, error: 'invalid status' }, 400);
      conditions.push('sc.status = ?');
      binds.push(status);
    }

    const isMyEscalationScope = queue === 'my_escalations' || scope === 'my_escalations';

    if (queue === 'escalated') {
      conditions.push(`sc.status IN ('escalated', 'waiting_secondary')`);
    } else if (queue === 'overdue') {
      conditions.push(`sc.due_at IS NOT NULL AND sc.due_at < ? AND sc.status != 'resolved'`);
      binds.push(jstNow());
    } else if (queue === 'unassigned') {
      conditions.push(`(sc.primary_assignee IS NULL OR sc.primary_assignee = '') AND sc.status != 'resolved'`);
    } else if (queue === 'waiting_customer') {
      conditions.push(`sc.status = 'customer_reply'`);
    } else if (queue === 'unresolved') {
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

    if (assignee) {
      conditions.push(`(sc.primary_assignee LIKE ? OR sc.escalation_assignee LIKE ?)`);
      binds.push(`%${assignee}%`, `%${assignee}%`);
    }
    if (escalationAssignee) {
      conditions.push(`sc.escalation_assignee LIKE ?`);
      binds.push(`%${escalationAssignee}%`);
    }

    if (q) {
      const pattern = `%${q}%`;
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
    console.error('GET /api/support/cases error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

support.post('/api/support/cases', requireRole('owner', 'admin'), async (c) => {
  try {
    const body = await c.req.json<Record<string, unknown>>();
    const friendId = text(body.friendId);
    let lineAccountId = text(body.lineAccountId);

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

    const category = text(body.category) ?? 'other';
    const priority = text(body.priority) ?? 'medium';
    const status = text(body.status) ?? 'open';
    if (!PRIORITIES.has(priority)) return c.json({ success: false, error: 'invalid priority' }, 400);
    if (!CASE_STATUSES.has(status)) return c.json({ success: false, error: 'invalid status' }, 400);

    const customerSummary = text(body.customerSummary) ?? '';
    if (!friendId && !customerSummary.trim()) {
      return c.json({ success: false, error: 'LINE会話を選ぶか、問い合わせ要約を入力してください。' }, 400);
    }
    const internalNote = text(body.internalNote) ?? '';
    const resolutionNote = text(body.resolutionNote) ?? '';
    const nextCheckAt = text(body.nextCheckAt);
    const validationError = validateCaseState({
      status,
      next_check_at: nextCheckAt,
      internal_note: internalNote,
      resolution_note: resolutionNote,
    });
    if (validationError) return c.json({ success: false, error: validationError }, 400);

    const now = jstNow();
    const id = crypto.randomUUID();
    const manualIdsInput = Array.isArray(body.manualIds)
      ? body.manualIds.filter((item): item is string => typeof item === 'string')
      : [];
    const manualValidation = await validateManualIds(c.env.DB, lineAccountId, manualIdsInput);
    if (!manualValidation.ok) return c.json({ success: false, error: manualValidation.error }, 400);
    const manualIds = JSON.stringify(manualValidation.ids);
    const title =
      text(body.title) ??
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
        text(body.primaryAssignee),
        text(body.escalationAssignee),
        text(body.escalationLevel) ?? 'L1',
        text(body.dueAt),
        nextCheckAt,
        text(body.customerNumber),
        text(body.companyName),
        text(body.contactName),
        text(body.storeName),
        text(body.contractType),
        customerSummary,
        internalNote,
        text(body.customerReplyDraft) ?? '',
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
    console.error('POST /api/support/cases error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

support.get('/api/support/cases/:id', async (c) => {
  try {
    const lineAccountId = lineAccountIdFrom(c);
    if (!lineAccountId) return c.json({ success: false, error: 'lineAccountId is required' }, 400);
    const row = await getCaseRow(c.env.DB, c.req.param('id'), lineAccountId, currentStaff(c));
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
        .bind(...manualIds, lineAccountId)
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
    console.error('GET /api/support/cases/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

support.patch('/api/support/cases/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json<Record<string, unknown>>();
    const lineAccountId = lineAccountIdFrom(c, body);
    if (!lineAccountId) return c.json({ success: false, error: 'lineAccountId is required' }, 400);
    const staff = currentStaff(c);
    const existing = await getCaseRow(c.env.DB, id, lineAccountId, staff);
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

    const stringFields: Array<[keyof SupportCaseRow, string]> = [
      ['title', 'title'],
      ['category', 'category'],
      ['priority', 'priority'],
      ['status', 'status'],
      ['primary_assignee', 'primaryAssignee'],
      ['escalation_assignee', 'escalationAssignee'],
      ['escalation_level', 'escalationLevel'],
      ['due_at', 'dueAt'],
      ['next_check_at', 'nextCheckAt'],
      ['customer_number', 'customerNumber'],
      ['company_name', 'companyName'],
      ['contact_name', 'contactName'],
      ['store_name', 'storeName'],
      ['contract_type', 'contractType'],
      ['customer_summary', 'customerSummary'],
      ['internal_note', 'internalNote'],
      ['customer_reply_draft', 'customerReplyDraft'],
      ['resolution_note', 'resolutionNote'],
    ];

    for (const [column, key] of stringFields) {
      if (!(key in body)) continue;
      const value = nullableText(body[key]);
      next[column] = (value ?? '') as never;
      if (['due_at', 'next_check_at', 'primary_assignee', 'escalation_assignee', 'customer_number', 'company_name', 'contact_name', 'store_name', 'contract_type'].includes(column)) {
        fields.push([column, value ?? null]);
      } else {
        fields.push([column, value ?? '']);
      }
    }

    if ('manualIds' in body) {
      if (!Array.isArray(body.manualIds)) return c.json({ success: false, error: 'manualIds must be an array' }, 400);
      const manualValidation = await validateManualIds(
        c.env.DB,
        lineAccountId,
        body.manualIds.filter((item): item is string => typeof item === 'string'),
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
      .bind(...fields.map(([, value]) => value), id, lineAccountId)
      .run();

    await addCaseEvent(c.env.DB, id, 'updated', staff.id, staff.name, text(body.eventBody) ?? '案件を更新しました', {
      changed: fields.map(([column]) => column),
      fromStatus: existing.status,
      toStatus: next.status,
    });

    const updated = await getCaseRow(c.env.DB, id, lineAccountId, staff);
    return c.json({ success: true, data: serializeCase(updated!) });
  } catch (err) {
    console.error('PATCH /api/support/cases/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

support.post('/api/support/cases/:id/events', async (c) => {
  try {
    const body = await c.req.json<Record<string, unknown>>();
    const lineAccountId = lineAccountIdFrom(c, body);
    if (!lineAccountId) return c.json({ success: false, error: 'lineAccountId is required' }, 400);
    const row = await getCaseRow(c.env.DB, c.req.param('id'), lineAccountId, currentStaff(c));
    if (!row) return c.json({ success: false, error: 'case not found' }, 404);
    const staff = currentStaff(c);
    await addCaseEvent(
      c.env.DB,
      row.id,
      text(body.eventType) ?? 'note',
      staff.id,
      staff.name,
      text(body.body) ?? '',
      typeof body.metadata === 'object' && body.metadata !== null ? body.metadata as Record<string, unknown> : {},
    );
    return c.json({ success: true, data: null }, 201);
  } catch (err) {
    console.error('POST /api/support/cases/:id/events error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

support.post('/api/support/cases/:id/escalations', async (c) => {
  try {
    const caseId = c.req.param('id');
    const body = await c.req.json<Record<string, unknown>>();
    const lineAccountId = lineAccountIdFrom(c, body);
    if (!lineAccountId) return c.json({ success: false, error: 'lineAccountId is required' }, 400);
    const staff = currentStaff(c);
    const row = await getCaseRow(c.env.DB, caseId, lineAccountId, staff);
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

    const assignee = canRouteEscalation ? text(body.assignee) : text(row.escalation_assignee);
    const question = text(body.question);
    const levelFromCase = ESCALATION_LEVELS.has(row.escalation_level) ? row.escalation_level : 'L2';
    const level = canRouteEscalation ? (text(body.level) ?? 'L2') : levelFromCase;
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
    const dueAt = canRouteEscalation ? text(body.dueAt) : null;
    await c.env.DB
      .prepare(
        `INSERT INTO support_escalations (
          id, case_id, line_account_id, assignee, level, status, question, answer,
          due_at, answered_at, created_by, updated_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?, '', ?, NULL, ?, ?, ?, ?)`,
      )
      .bind(id, caseId, row.line_account_id, assignee, level, question, dueAt, staff.id, staff.id, now, now)
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
        .bind(assignee, level, dueAt, staff.id, now, caseId, lineAccountId)
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
        .bind(staff.id, now, caseId, lineAccountId)
        .run();
    }

    await addCaseEvent(c.env.DB, caseId, 'escalated', staff.id, staff.name, question, {
      escalationId: id,
      assignee,
      level,
      dueAt,
    });

    const escalation = await c.env.DB
      .prepare(`SELECT * FROM support_escalations WHERE id = ? AND line_account_id = ?`)
      .bind(id, lineAccountId)
      .first<SupportEscalationRow>();
    return c.json({ success: true, data: serializeEscalation(escalation!) }, 201);
  } catch (err) {
    console.error('POST /api/support/cases/:id/escalations error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

support.get('/api/support/escalations', async (c) => {
  try {
    const lineAccountId = c.req.query('lineAccountId');
    if (!lineAccountId) return c.json({ success: false, error: 'lineAccountId is required' }, 400);
    const status = c.req.query('status');
    const assignee = c.req.query('assignee');
    const queue = c.req.query('queue');
    const scope = c.req.query('scope');
    const conditions = ['se.line_account_id = ?'];
    const binds: unknown[] = [lineAccountId];
    const staff = currentStaff(c);
    const visibility = supportEscalationVisibilitySql(staff, 'se', 'sc_escalation_list_scope');
    if (visibility.sql) {
      conditions.push(visibility.sql);
      binds.push(...visibility.binds);
    }

    if (status && status !== 'all') {
      if (!ESCALATION_STATUSES.has(status)) return c.json({ success: false, error: 'invalid status' }, 400);
      conditions.push('se.status = ?');
      binds.push(status);
    }
    if (assignee) {
      conditions.push('se.assignee LIKE ?');
      binds.push(`%${assignee}%`);
    }
    if (scope === 'my_escalations' || queue === 'my_escalations') {
      conditions.push(`se.assignee LIKE ? ESCAPE '\\'`);
      binds.push(supportStaffLikePattern(staff));
    }
    if (queue === 'due') {
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
    console.error('GET /api/support/escalations error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

support.patch('/api/support/escalations/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json<Record<string, unknown>>();
    const lineAccountId = lineAccountIdFrom(c, body);
    if (!lineAccountId) return c.json({ success: false, error: 'lineAccountId is required' }, 400);
    const staffForScope = currentStaff(c);
    const visibility = supportEscalationVisibilitySql(staffForScope, 'se', 'sc_escalation_update_scope');
    const conditions = ['se.id = ?', 'se.line_account_id = ?'];
    const binds: unknown[] = [id, lineAccountId];
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
    const status = text(body.status) ?? existing.status;
    const level = text(body.level) ?? existing.level;
    if (!ESCALATION_STATUSES.has(status)) return c.json({ success: false, error: 'invalid status' }, 400);
    if (!ESCALATION_LEVELS.has(level)) return c.json({ success: false, error: 'invalid level' }, 400);
    const nextAnswer = 'answer' in body ? (text(body.answer) ?? '') : existing.answer;
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
    if ('assignee' in body) fields.push(['assignee', text(body.assignee) ?? existing.assignee]);
    if ('question' in body) fields.push(['question', text(body.question) ?? existing.question]);
    if ('answer' in body) fields.push(['answer', nextAnswer]);
    if ('dueAt' in body) fields.push(['due_at', text(body.dueAt)]);

    let nextCaseStatus: string | null = null;
    if (statusRequested) {
      if (status === 'answered') nextCaseStatus = 'customer_reply';
      if (status === 'needs_info') nextCaseStatus = 'waiting_primary';
      if (status === 'transferred' || status === 'expert_check') nextCaseStatus = 'waiting_secondary';
    }
    if (nextCaseStatus) {
      const linkedCase = await c.env.DB
        .prepare(`SELECT status FROM support_cases WHERE id = ? AND line_account_id = ?`)
        .bind(existing.case_id, lineAccountId)
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
        .bind(...fields.map(([, value]) => value), id, lineAccountId)
        .run();
    }

    if (nextCaseStatus) {
      await c.env.DB.prepare(`UPDATE support_cases SET status = ?, updated_by = ?, updated_at = ? WHERE id = ? AND line_account_id = ?`)
        .bind(nextCaseStatus, staff.id, now, existing.case_id, lineAccountId)
        .run();
    }

    await addCaseEvent(
      c.env.DB,
      existing.case_id,
      'escalation_updated',
      staff.id,
      staff.name,
      text(body.eventBody) ?? text(body.answer) ?? 'エスカレーションを更新しました',
      { escalationId: id, status, nextCaseStatus },
    );

    const updated = await c.env.DB
      .prepare(
        `SELECT se.*, sc.title AS case_title, f.display_name AS friend_name
         FROM support_escalations se
         LEFT JOIN support_cases sc ON sc.id = se.case_id
         LEFT JOIN friends f ON f.id = sc.friend_id
         WHERE se.id = ? AND se.line_account_id = ?`,
      )
      .bind(id, lineAccountId)
      .first<SupportEscalationRow>();
    return c.json({ success: true, data: serializeEscalation(updated!) });
  } catch (err) {
    console.error('PATCH /api/support/escalations/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

support.get('/api/support/manuals', async (c) => {
  try {
    const lineAccountId = c.req.query('lineAccountId');
    const category = c.req.query('category');
    const q = c.req.query('q');
    const active = c.req.query('active') ?? '1';
    const conditions: string[] = [];
    const binds: unknown[] = [];

    if (lineAccountId) {
      conditions.push('(line_account_id = ? OR line_account_id IS NULL)');
      binds.push(lineAccountId);
    }
    if (category && category !== 'all') {
      conditions.push('category = ?');
      binds.push(category);
    }
    if (active !== 'all') {
      conditions.push('is_active = ?');
      binds.push(active === '0' ? 0 : 1);
    }
    if (q) {
      const pattern = `%${q}%`;
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
    console.error('GET /api/support/manuals error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

support.post('/api/support/manuals', requireRole('owner', 'admin'), async (c) => {
  try {
    const body = await c.req.json<Record<string, unknown>>();
    const title = text(body.title);
    if (!title) return c.json({ success: false, error: 'title is required' }, 400);
    const manualBody = text(body.body);
    if (!manualBody) return c.json({ success: false, error: 'body is required' }, 400);
    const manualUrl = text(body.url);
    if (manualUrl && !isHttpUrl(manualUrl)) {
      return c.json({ success: false, error: 'url must start with http:// or https://' }, 400);
    }
    const lineAccountId = text(body.lineAccountId);
    if (!lineAccountId) return c.json({ success: false, error: 'lineAccountId is required' }, 400);

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
      lineAccountId,
      title,
      text(body.category) ?? 'basic',
      manualBody,
      manualUrl,
      text(body.keywords) ?? '',
      text(body.owner),
      text(body.approvedBy),
      text(body.revisedAt) ?? now.slice(0, 10),
      body.isActive === false ? 0 : 1,
      staff.id,
      staff.id,
      now,
      now,
    ).run();

    const created = await c.env.DB.prepare(`SELECT * FROM support_manuals WHERE id = ?`).bind(id).first<SupportManualRow>();
    return c.json({ success: true, data: serializeManual(created!) }, 201);
  } catch (err) {
    console.error('POST /api/support/manuals error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

support.patch('/api/support/manuals/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json<Record<string, unknown>>();
    const lineAccountId = text(c.req.query('lineAccountId')) ?? text(body.lineAccountId);
    if (!lineAccountId) return c.json({ success: false, error: 'lineAccountId is required' }, 400);

    const existing = await c.env.DB
      .prepare(`SELECT * FROM support_manuals WHERE id = ? AND line_account_id = ?`)
      .bind(id, lineAccountId)
      .first<SupportManualRow>();
    if (!existing) return c.json({ success: false, error: 'manual not found' }, 404);
    if ('title' in body && !text(body.title)) return c.json({ success: false, error: 'title is required' }, 400);
    if ('body' in body && !text(body.body)) return c.json({ success: false, error: 'body is required' }, 400);
    const manualUrl = 'url' in body ? text(body.url) : null;
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
      if (key in body) fields.push([column, text(body[key])]);
    }
    if ('isActive' in body) fields.push(['is_active', body.isActive === false ? 0 : 1]);
    const staff = currentStaff(c);
    fields.push(['updated_by', staff.id], ['updated_at', jstNow()]);

    await c.env.DB.prepare(`UPDATE support_manuals SET ${fields.map(([column]) => `${column} = ?`).join(', ')} WHERE id = ? AND line_account_id = ?`)
      .bind(...fields.map(([, value]) => value), id, lineAccountId)
      .run();

    const updated = await c.env.DB
      .prepare(`SELECT * FROM support_manuals WHERE id = ? AND line_account_id = ?`)
      .bind(id, lineAccountId)
      .first<SupportManualRow>();
    return c.json({ success: true, data: serializeManual(updated!) });
  } catch (err) {
    console.error('PATCH /api/support/manuals/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

support.delete('/api/support/manuals/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    const staff = currentStaff(c);
    const lineAccountId = text(c.req.query('lineAccountId'));
    if (!lineAccountId) return c.json({ success: false, error: 'lineAccountId is required' }, 400);

    const existing = await c.env.DB
      .prepare(`SELECT * FROM support_manuals WHERE id = ? AND line_account_id = ?`)
      .bind(c.req.param('id'), lineAccountId)
      .first<SupportManualRow>();
    if (!existing) return c.json({ success: false, error: 'manual not found' }, 404);

    await c.env.DB
      .prepare(`UPDATE support_manuals SET is_active = 0, updated_by = ?, updated_at = ? WHERE id = ? AND line_account_id = ?`)
      .bind(staff.id, jstNow(), c.req.param('id'), lineAccountId)
      .run();
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/support/manuals/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { support };

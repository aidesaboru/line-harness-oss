import { Hono, type Context } from 'hono';
import { jstNow } from '@line-crm/db';
import type { Env } from '../index.js';

const salesCustomers = new Hono<Env>();

const SALES_CUSTOMER_ID_MAX_LENGTH = 128;
const SALES_CUSTOMER_SEARCH_MAX_LENGTH = 120;
const SALES_CUSTOMER_SUMMARY_MAX_LENGTH = 1000;
const SALES_CUSTOMER_LIST_MAX_LIMIT = 100;
const SALES_CUSTOMER_DEFAULT_LIMIT = 50;
const SALES_CUSTOMER_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

const STORED_STATUSES = [
  'normal',
  'attention',
  'complaint',
  'exit_pending',
  'exited',
] as const;

type StoredSalesCustomerStatus = (typeof STORED_STATUSES)[number];
type SalesCustomerStatus = 'unreviewed' | StoredSalesCustomerStatus;
type SalesCustomerSubjectKind = 'friend' | 'conversation';
type ValueResult<T> = { ok: true; value: T } | { ok: false; error: string };

type SalesCustomerRow = {
  subject_kind: SalesCustomerSubjectKind;
  subject_id: string;
  source_kind: 'user' | 'group' | 'room';
  line_account_id: string | null;
  line_account_name: string | null;
  display_name: string | null;
  customer_metadata: string | null;
  subject_created_at: string;
  status_id: string | null;
  sales_status: SalesCustomerStatus;
  status_summary: string | null;
  status_version: number | null;
  status_updated_by_name: string | null;
  status_updated_at: string | null;
};

type SalesCustomerStatusEventRow = {
  id: string;
  from_status: SalesCustomerStatus;
  to_status: StoredSalesCustomerStatus;
  summary: string;
  actor_name: string | null;
  created_at: string;
};

const CUSTOMER_SUBJECTS_SQL = `
  WITH customer_subjects AS (
    SELECT
      'friend' AS subject_kind,
      f.id AS subject_id,
      'user' AS source_kind,
      f.line_account_id,
      la.name AS line_account_name,
      f.display_name,
      f.metadata AS customer_metadata,
      f.created_at AS subject_created_at,
      scs.id AS status_id,
      COALESCE(scs.status, 'unreviewed') AS sales_status,
      scs.summary AS status_summary,
      scs.version AS status_version,
      scs.updated_by_name AS status_updated_by_name,
      scs.updated_at AS status_updated_at
    FROM friends f
    INNER JOIN line_accounts la ON la.id = f.line_account_id AND la.is_active = 1
    LEFT JOIN sales_customer_statuses scs ON scs.friend_id = f.id

    UNION ALL

    SELECT
      'conversation' AS subject_kind,
      lc.id AS subject_id,
      lc.source_type AS source_kind,
      lc.line_account_id,
      la.name AS line_account_name,
      lc.display_name,
      lc.customer_metadata,
      lc.created_at AS subject_created_at,
      scs.id AS status_id,
      COALESCE(scs.status, 'unreviewed') AS sales_status,
      scs.summary AS status_summary,
      scs.version AS status_version,
      scs.updated_by_name AS status_updated_by_name,
      scs.updated_at AS status_updated_at
    FROM line_conversations lc
    INNER JOIN line_accounts la ON la.id = lc.line_account_id AND la.is_active = 1
    LEFT JOIN sales_customer_statuses scs ON scs.conversation_id = lc.id
    WHERE lc.source_type IN ('group', 'room')
  )
`;

// Search only the identity fields intentionally exposed to sales. Searching the
// raw metadata JSON would let a caller infer hidden operational notes from a
// match/no-match response even though those notes are not serialized.
const SALES_CUSTOMER_SEARCH_HAYSTACK_SQL = `lower(
  COALESCE(display_name, '') || ' ' ||
  CASE WHEN json_valid(COALESCE(customer_metadata, '')) THEN
    COALESCE(CAST(json_extract(customer_metadata, '$.customerNumber') AS TEXT), '') || ' ' ||
    COALESCE(CAST(json_extract(customer_metadata, '$.customer_number') AS TEXT), '') || ' ' ||
    COALESCE(CAST(json_extract(customer_metadata, '$.customerNo') AS TEXT), '') || ' ' ||
    COALESCE(CAST(json_extract(customer_metadata, '$.customer_no') AS TEXT), '') || ' ' ||
    COALESCE(CAST(json_extract(customer_metadata, '$.clientNumber') AS TEXT), '') || ' ' ||
    COALESCE(CAST(json_extract(customer_metadata, '$.client_number') AS TEXT), '') || ' ' ||
    COALESCE(CAST(json_extract(customer_metadata, '$.companyName') AS TEXT), '') || ' ' ||
    COALESCE(CAST(json_extract(customer_metadata, '$.company_name') AS TEXT), '') || ' ' ||
    COALESCE(CAST(json_extract(customer_metadata, '$.company') AS TEXT), '') || ' ' ||
    COALESCE(CAST(json_extract(customer_metadata, '$.corporationName') AS TEXT), '') || ' ' ||
    COALESCE(CAST(json_extract(customer_metadata, '$.corporation_name') AS TEXT), '') || ' ' ||
    COALESCE(CAST(json_extract(customer_metadata, '$.customerName') AS TEXT), '') || ' ' ||
    COALESCE(CAST(json_extract(customer_metadata, '$.customer_name') AS TEXT), '') || ' ' ||
    COALESCE(CAST(json_extract(customer_metadata, '$.contactName') AS TEXT), '') || ' ' ||
    COALESCE(CAST(json_extract(customer_metadata, '$.contact_name') AS TEXT), '') || ' ' ||
    COALESCE(CAST(json_extract(customer_metadata, '$.personInCharge') AS TEXT), '') || ' ' ||
    COALESCE(CAST(json_extract(customer_metadata, '$.person_in_charge') AS TEXT), '') || ' ' ||
    COALESCE(CAST(json_extract(customer_metadata, '$.representativeName') AS TEXT), '') || ' ' ||
    COALESCE(CAST(json_extract(customer_metadata, '$.representative_name') AS TEXT), '')
  ELSE '' END
)`;

function routeErrorKind(err: unknown): string {
  if (err instanceof TypeError) return 'network_error';
  if (err instanceof Error) return err.name || 'error';
  return typeof err;
}

function parseSubjectKind(raw: unknown): ValueResult<SalesCustomerSubjectKind> {
  if (raw === 'friend' || raw === 'conversation') return { ok: true, value: raw };
  return { ok: false, error: 'invalid_subject_kind' };
}

function parseId(raw: unknown, label: string): ValueResult<string> {
  if (typeof raw !== 'string') return { ok: false, error: `invalid_${label}` };
  const value = raw.trim();
  if (!value || value.length > SALES_CUSTOMER_ID_MAX_LENGTH || !SALES_CUSTOMER_ID_PATTERN.test(value)) {
    return { ok: false, error: `invalid_${label}` };
  }
  return { ok: true, value };
}

function parseSearch(raw: unknown): ValueResult<string | null> {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: 'invalid_search' };
  const value = raw.trim();
  if (value.length > SALES_CUSTOMER_SEARCH_MAX_LENGTH) return { ok: false, error: 'invalid_search' };
  return { ok: true, value: value || null };
}

function parseStatusFilter(raw: unknown): ValueResult<SalesCustomerStatus | 'action_required' | null> {
  if (raw === undefined || raw === null || raw === '' || raw === 'all') return { ok: true, value: null };
  if (raw === 'action_required' || raw === 'unreviewed' || STORED_STATUSES.includes(raw as StoredSalesCustomerStatus)) {
    return { ok: true, value: raw as SalesCustomerStatus | 'action_required' };
  }
  return { ok: false, error: 'invalid_status' };
}

function parseLimit(raw: unknown): ValueResult<number> {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, value: SALES_CUSTOMER_DEFAULT_LIMIT };
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > SALES_CUSTOMER_LIST_MAX_LIMIT) {
    return { ok: false, error: 'invalid_limit' };
  }
  return { ok: true, value };
}

function parseOffset(raw: unknown): ValueResult<number> {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: 0 };
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) return { ok: false, error: 'invalid_offset' };
  return { ok: true, value };
}

function parseStoredStatus(raw: unknown): ValueResult<StoredSalesCustomerStatus> {
  if (typeof raw !== 'string' || !STORED_STATUSES.includes(raw as StoredSalesCustomerStatus)) {
    return { ok: false, error: 'invalid_status' };
  }
  return { ok: true, value: raw as StoredSalesCustomerStatus };
}

function parseSummary(raw: unknown): ValueResult<string> {
  if (typeof raw !== 'string') return { ok: false, error: 'summary is required' };
  const value = raw.trim();
  if (!value) return { ok: false, error: 'summary is required' };
  if (value.length > SALES_CUSTOMER_SUMMARY_MAX_LENGTH) return { ok: false, error: 'summary is too long' };
  return { ok: true, value };
}

function parseExpectedVersion(raw: unknown): ValueResult<number> {
  if (!Number.isSafeInteger(raw) || (raw as number) < 0) {
    return { ok: false, error: 'invalid_expected_version' };
  }
  return { ok: true, value: raw as number };
}

async function readJsonObject(c: Context<Env>): Promise<ValueResult<Record<string, unknown>>> {
  try {
    const raw = await c.req.json<unknown>();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: 'invalid_payload' };
    }
    return { ok: true, value: raw as Record<string, unknown> };
  } catch {
    return { ok: false, error: 'invalid_json' };
  }
}

function canEditSalesCustomerStatus(c: Context<Env>): boolean {
  const staff = c.get('staff');
  return staff.salesOnly !== true && (
    staff.role === 'owner' || staff.role === 'admin' || staff.role === 'staff'
  );
}

function parseMetadata(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function metadataText(metadata: Record<string, unknown>, aliases: readonly string[]): string | null {
  for (const key of aliases) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function operationStoreNames(metadata: Record<string, unknown>): string[] {
  const raw = metadata.operationContracts ?? metadata.operation_contracts ?? metadata.contractStores ?? metadata.contract_stores;
  let items: unknown = raw;
  if (typeof raw === 'string') {
    try {
      items = JSON.parse(raw) as unknown;
    } catch {
      items = [];
    }
  }
  const entries = Array.isArray(items) ? items : [];
  const names = entries.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const name = metadataText(record, ['shopName', 'shop_name', 'storeName', 'store_name']);
    return name ? [name] : [];
  });
  const legacyName = metadataText(metadata, ['shopName', 'shop_name', 'storeName', 'store_name']);
  return Array.from(new Set([...(legacyName ? [legacyName] : []), ...names]));
}

function serializeCustomer(row: SalesCustomerRow) {
  const metadata = parseMetadata(row.customer_metadata);
  return {
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    sourceKind: row.source_kind,
    lineAccountId: row.line_account_id,
    lineAccountName: row.line_account_name,
    lineDisplayName: row.display_name,
    customerNumber: metadataText(metadata, [
      'customerNumber', 'customer_number', 'customerNo', 'customer_no', 'clientNumber', 'client_number',
    ]),
    companyName: metadataText(metadata, [
      'companyName', 'company_name', 'company', 'corporationName', 'corporation_name', 'customerName', 'customer_name',
    ]),
    contactName: metadataText(metadata, [
      'contactName', 'contact_name', 'personInCharge', 'person_in_charge', 'representativeName', 'representative_name',
    ]),
    storeNames: operationStoreNames(metadata),
    status: row.sales_status,
    summary: row.status_summary ?? '',
    version: row.status_version ?? 0,
    updatedByName: row.status_updated_by_name,
    updatedAt: row.status_updated_at,
    createdAt: row.subject_created_at,
  };
}

function serializeEvent(row: SalesCustomerStatusEventRow) {
  return {
    id: row.id,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    summary: row.summary,
    actorName: row.actor_name,
    createdAt: row.created_at,
  };
}

function customerFilterSql(input: {
  lineAccountId: string;
  search: string | null;
  status: SalesCustomerStatus | 'action_required' | null;
}) {
  const conditions = ['line_account_id = ?'];
  const binds: unknown[] = [input.lineAccountId];
  if (input.search) {
    conditions.push(`instr(${SALES_CUSTOMER_SEARCH_HAYSTACK_SQL}, lower(?)) > 0`);
    binds.push(input.search);
  }
  if (input.status === 'action_required') {
    conditions.push("sales_status IN ('unreviewed', 'attention', 'complaint', 'exit_pending')");
  } else if (input.status) {
    conditions.push('sales_status = ?');
    binds.push(input.status);
  }
  return { sql: conditions.join(' AND '), binds };
}

function salesStatusConflict(err: unknown): boolean {
  return err instanceof Error && (
    /sales_customer_status_events\.status_id/i.test(err.message)
    || /UNIQUE constraint failed: sales_customer_statuses/i.test(err.message)
    || /UNIQUE constraint failed: idx_sales_customer_status/i.test(err.message)
  );
}

salesCustomers.get('/api/sales-customers/accounts', async (c) => {
  try {
    const result = await c.env.DB.prepare(
      `SELECT id, name, is_active, country, role, display_order
       FROM line_accounts
       WHERE is_active = 1
       ORDER BY display_order ASC, created_at ASC`,
    ).all<{
      id: string;
      name: string;
      is_active: number;
      country: string | null;
      role: string | null;
      display_order: number;
    }>();
    return c.json({
      success: true,
      data: result.results.map((row) => ({
        id: row.id,
        name: row.name,
        displayName: row.name,
        isActive: Boolean(row.is_active),
        country: row.country,
        role: row.role,
        displayOrder: row.display_order,
      })),
    });
  } catch (err) {
    console.error(`GET /api/sales-customers/accounts error: ${routeErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

salesCustomers.get('/api/sales-customers', async (c) => {
  try {
    const lineAccountId = parseId(c.req.query('lineAccountId'), 'line_account_id');
    if (!lineAccountId.ok) return c.json({ success: false, error: lineAccountId.error }, 400);
    const search = parseSearch(c.req.query('q'));
    if (!search.ok) return c.json({ success: false, error: search.error }, 400);
    const status = parseStatusFilter(c.req.query('status'));
    if (!status.ok) return c.json({ success: false, error: status.error }, 400);
    const limit = parseLimit(c.req.query('limit'));
    if (!limit.ok) return c.json({ success: false, error: limit.error }, 400);
    const offset = parseOffset(c.req.query('offset'));
    if (!offset.ok) return c.json({ success: false, error: offset.error }, 400);

    const listFilter = customerFilterSql({
      lineAccountId: lineAccountId.value,
      search: search.value,
      status: status.value,
    });
    const summaryFilter = customerFilterSql({
      lineAccountId: lineAccountId.value,
      search: search.value,
      status: null,
    });
    const orderSql = `CASE sales_status
      WHEN 'complaint' THEN 0
      WHEN 'exit_pending' THEN 1
      WHEN 'attention' THEN 2
      WHEN 'unreviewed' THEN 3
      WHEN 'exited' THEN 4
      ELSE 5
    END ASC,
    COALESCE(status_updated_at, subject_created_at) DESC,
    subject_id ASC`;

    const [listResult, totalRow, summaryResult] = await Promise.all([
      c.env.DB.prepare(
        `${CUSTOMER_SUBJECTS_SQL}
         SELECT * FROM customer_subjects
         WHERE ${listFilter.sql}
         ORDER BY ${orderSql}
         LIMIT ? OFFSET ?`,
      ).bind(...listFilter.binds, limit.value, offset.value).all<SalesCustomerRow>(),
      c.env.DB.prepare(
        `${CUSTOMER_SUBJECTS_SQL}
         SELECT COUNT(*) AS count FROM customer_subjects
         WHERE ${listFilter.sql}`,
      ).bind(...listFilter.binds).first<{ count: number }>(),
      c.env.DB.prepare(
        `${CUSTOMER_SUBJECTS_SQL}
         SELECT sales_status AS status, COUNT(*) AS count
         FROM customer_subjects
         WHERE ${summaryFilter.sql}
         GROUP BY sales_status`,
      ).bind(...summaryFilter.binds).all<{ status: SalesCustomerStatus; count: number }>(),
    ]);

    const counts: Record<SalesCustomerStatus, number> = {
      unreviewed: 0,
      normal: 0,
      attention: 0,
      complaint: 0,
      exit_pending: 0,
      exited: 0,
    };
    for (const row of summaryResult.results) counts[row.status] = row.count;
    const total = totalRow?.count ?? 0;
    return c.json({
      success: true,
      data: {
        items: listResult.results.map(serializeCustomer),
        total,
        limit: limit.value,
        offset: offset.value,
        hasNextPage: offset.value + limit.value < total,
        counts,
        canEditStatus: canEditSalesCustomerStatus(c),
      },
    });
  } catch (err) {
    console.error(`GET /api/sales-customers error: ${routeErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

salesCustomers.get('/api/sales-customers/:subjectKind/:subjectId', async (c) => {
  try {
    const subjectKind = parseSubjectKind(c.req.param('subjectKind'));
    if (!subjectKind.ok) return c.json({ success: false, error: subjectKind.error }, 400);
    const subjectId = parseId(c.req.param('subjectId'), 'subject_id');
    if (!subjectId.ok) return c.json({ success: false, error: subjectId.error }, 400);
    const subjectColumn = subjectKind.value === 'friend' ? 'friend_id' : 'conversation_id';
    const row = await c.env.DB.prepare(
      `${CUSTOMER_SUBJECTS_SQL}
       SELECT * FROM customer_subjects
       WHERE subject_kind = ? AND subject_id = ?
       LIMIT 1`,
    ).bind(subjectKind.value, subjectId.value).first<SalesCustomerRow>();
    if (!row) return c.json({ success: false, error: 'Customer not found' }, 404);

    const history = row.status_id
      ? await c.env.DB.prepare(
          `SELECT e.id, e.from_status, e.to_status, e.summary, e.actor_name, e.created_at
           FROM sales_customer_status_events e
           INNER JOIN sales_customer_statuses s ON s.id = e.status_id
           WHERE s.${subjectColumn} = ?
           ORDER BY e.created_at DESC, e.id DESC
           LIMIT 50`,
        ).bind(subjectId.value).all<SalesCustomerStatusEventRow>()
      : { results: [] as SalesCustomerStatusEventRow[] };

    return c.json({
      success: true,
      data: {
        ...serializeCustomer(row),
        history: history.results.map(serializeEvent),
        canEditStatus: canEditSalesCustomerStatus(c),
      },
    });
  } catch (err) {
    console.error(`GET /api/sales-customers/:subjectKind/:subjectId error: ${routeErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

salesCustomers.patch('/api/sales-customers/:subjectKind/:subjectId/status', async (c) => {
  if (!canEditSalesCustomerStatus(c)) {
    return c.json({ success: false, error: 'この操作には運営スタッフ権限が必要です' }, 403);
  }
  try {
    const subjectKind = parseSubjectKind(c.req.param('subjectKind'));
    if (!subjectKind.ok) return c.json({ success: false, error: subjectKind.error }, 400);
    const subjectId = parseId(c.req.param('subjectId'), 'subject_id');
    if (!subjectId.ok) return c.json({ success: false, error: subjectId.error }, 400);
    const rawBody = await readJsonObject(c);
    if (!rawBody.ok) return c.json({ success: false, error: rawBody.error }, 400);
    const status = parseStoredStatus(rawBody.value.status);
    if (!status.ok) return c.json({ success: false, error: status.error }, 400);
    const summary = parseSummary(rawBody.value.summary);
    if (!summary.ok) return c.json({ success: false, error: summary.error }, 400);
    const expectedVersion = parseExpectedVersion(rawBody.value.expectedVersion);
    if (!expectedVersion.ok) return c.json({ success: false, error: expectedVersion.error }, 400);

    const subject = await c.env.DB.prepare(
      `${CUSTOMER_SUBJECTS_SQL}
       SELECT subject_id FROM customer_subjects
       WHERE subject_kind = ? AND subject_id = ?
       LIMIT 1`,
    ).bind(subjectKind.value, subjectId.value).first<{ subject_id: string }>();
    if (!subject) return c.json({ success: false, error: 'Customer not found' }, 404);

    const subjectColumn = subjectKind.value === 'friend' ? 'friend_id' : 'conversation_id';
    const current = await c.env.DB.prepare(
      `SELECT id, status, summary, version
       FROM sales_customer_statuses
       WHERE ${subjectColumn} = ?
       LIMIT 1`,
    ).bind(subjectId.value).first<{
      id: string;
      status: StoredSalesCustomerStatus;
      summary: string;
      version: number;
    }>();
    const currentVersion = current?.version ?? 0;
    if (currentVersion !== expectedVersion.value) {
      return c.json({ success: false, error: 'status_conflict' }, 409);
    }
    if (current?.status === status.value && current.summary === summary.value) {
      return c.json({ success: false, error: 'no_changes' }, 400);
    }

    const actor = c.get('staff');
    const now = jstNow();
    const mutationId = crypto.randomUUID();
    const statusId = current?.id ?? crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const friendId = subjectKind.value === 'friend' ? subjectId.value : null;
    const conversationId = subjectKind.value === 'conversation' ? subjectId.value : null;
    const actorId = actor.id === 'env-owner' ? null : actor.id;

    const statusMutation = current
      ? c.env.DB.prepare(
          `UPDATE sales_customer_statuses
           SET status = ?, summary = ?, version = version + 1, mutation_id = ?,
               updated_by = ?, updated_by_name = ?, updated_at = ?
           WHERE id = ? AND version = ?`,
        ).bind(
          status.value,
          summary.value,
          mutationId,
          actorId,
          actor.name,
          now,
          statusId,
          expectedVersion.value,
        )
      : c.env.DB.prepare(
          `INSERT INTO sales_customer_statuses (
             id, friend_id, conversation_id, status, summary, version, mutation_id,
             updated_by, updated_by_name, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
        ).bind(
          statusId,
          friendId,
          conversationId,
          status.value,
          summary.value,
          mutationId,
          actorId,
          actor.name,
          now,
          now,
        );

    try {
      await c.env.DB.batch([
        statusMutation,
        c.env.DB.prepare(
          `INSERT INTO sales_customer_status_events (
             id, status_id, from_status, to_status, summary, actor_id, actor_name, created_at
           ) VALUES (
             ?,
             (SELECT id FROM sales_customer_statuses WHERE mutation_id = ?),
             ?, ?, ?, ?, ?, ?
           )`,
        ).bind(
          eventId,
          mutationId,
          current?.status ?? 'unreviewed',
          status.value,
          summary.value,
          actorId,
          actor.name,
          now,
        ),
      ]);
    } catch (err) {
      if (salesStatusConflict(err)) {
        return c.json({ success: false, error: 'status_conflict' }, 409);
      }
      throw err;
    }

    const updated = await c.env.DB.prepare(
      `${CUSTOMER_SUBJECTS_SQL}
       SELECT * FROM customer_subjects
       WHERE subject_kind = ? AND subject_id = ?
       LIMIT 1`,
    ).bind(subjectKind.value, subjectId.value).first<SalesCustomerRow>();
    if (!updated) return c.json({ success: false, error: 'Customer not found' }, 404);
    return c.json({ success: true, data: serializeCustomer(updated) });
  } catch (err) {
    console.error(`PATCH /api/sales-customers/:subjectKind/:subjectId/status error: ${routeErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { salesCustomers };

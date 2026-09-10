import { Hono, type Context } from 'hono';
import { jstNow } from '@line-crm/db';
import type { Env } from '../index.js';
import {
  buildNoEligibleTextSummary,
  generateSalesCustomerSemanticSummary,
  prepareSalesCustomerSemanticSource,
  SALES_CUSTOMER_SEMANTIC_SUMMARY_MAX_MESSAGES,
  SALES_CUSTOMER_SEMANTIC_SUMMARY_METHOD,
  SALES_CUSTOMER_SEMANTIC_SUMMARY_MODEL,
  SALES_CUSTOMER_SEMANTIC_SUMMARY_PROMPT_VERSION,
  SalesCustomerSemanticSummaryError,
  type PreparedSalesCustomerSemanticSource,
  type SalesCustomerSemanticMessage,
  type SalesCustomerSemanticSummaryUsage,
} from '../services/sales-customer-semantic-summary.js';

const salesCustomers = new Hono<Env>();

const SALES_CUSTOMER_ID_MAX_LENGTH = 128;
const SALES_CUSTOMER_SEARCH_MAX_LENGTH = 120;
const SALES_CUSTOMER_SUMMARY_MAX_LENGTH = 1000;
const SALES_CUSTOMER_LIST_MAX_LIMIT = 100;
const SALES_CUSTOMER_DEFAULT_LIMIT = 50;
const SALES_CUSTOMER_OVERVIEW_BATCH_MAX_LIMIT = 5;
const SALES_CUSTOMER_OVERVIEW_BATCH_DEFAULT_LIMIT = 5;
const SALES_CUSTOMER_OVERVIEW_CONFIRMATION = 'generate_sales_customer_overviews';
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
  overview_id: string | null;
  overview_text: string | null;
  overview_generation_method: string | null;
  overview_ai_generated: number | null;
  overview_model: string | null;
  overview_prompt_version: string | null;
  overview_source_fingerprint: string | null;
  overview_source_message_count: number | null;
  overview_source_from_at: string | null;
  overview_source_to_at: string | null;
  overview_input_char_count: number | null;
  overview_version: number | null;
  overview_updated_by_name: string | null;
  overview_updated_at: string | null;
  is_following: number | null;
  chat_status: 'unread' | 'in_progress' | 'resolved' | 'long_term' | null;
  activity_last_at?: string | null;
  activity_last_incoming_at?: string | null;
  activity_last_human_outgoing_at?: string | null;
  activity_needs_human_reply?: number | null;
  activity_30_total?: number | null;
  activity_30_incoming?: number | null;
  activity_30_human_outgoing?: number | null;
  activity_30_automated_outgoing?: number | null;
  activity_30_active_days?: number | null;
  activity_30_media?: number | null;
  activity_60_total?: number | null;
  activity_60_incoming?: number | null;
  activity_60_human_outgoing?: number | null;
  activity_60_automated_outgoing?: number | null;
  activity_60_active_days?: number | null;
  activity_60_media?: number | null;
  activity_90_total?: number | null;
  activity_90_incoming?: number | null;
  activity_90_human_outgoing?: number | null;
  activity_90_automated_outgoing?: number | null;
  activity_90_active_days?: number | null;
  activity_90_media?: number | null;
  active_support_cases?: number | null;
  support_cases_90?: number | null;
  last_support_updated_at?: string | null;
};

type SalesCustomerStatusEventRow = {
  id: string;
  from_status: SalesCustomerStatus;
  to_status: StoredSalesCustomerStatus;
  summary: string;
  actor_name: string | null;
  created_at: string;
};

type SalesCustomerOverviewEventRow = {
  id: string;
  summary: string;
  ai_generated: number;
  model: string | null;
  source_message_count: number;
  source_from_at: string | null;
  source_to_at: string | null;
  actor_name: string | null;
  created_at: string;
};

type SalesCustomerSemanticMessageRow = {
  subject_id: string;
  direction: 'incoming' | 'outgoing';
  content: string;
  created_at: string;
  sender_name: string | null;
  sent_by_staff_name: string | null;
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
      scs.updated_at AS status_updated_at,
      scss.id AS overview_id,
      scss.summary AS overview_text,
      scss.generation_method AS overview_generation_method,
      scss.ai_generated AS overview_ai_generated,
      scss.model AS overview_model,
      scss.prompt_version AS overview_prompt_version,
      scss.source_fingerprint AS overview_source_fingerprint,
      scss.source_message_count AS overview_source_message_count,
      scss.source_from_at AS overview_source_from_at,
      scss.source_to_at AS overview_source_to_at,
      scss.input_char_count AS overview_input_char_count,
      scss.version AS overview_version,
      scss.updated_by_name AS overview_updated_by_name,
      scss.updated_at AS overview_updated_at,
      f.is_following,
      (
        SELECT CASE WHEN c.is_long_term = 1 THEN 'long_term' ELSE c.status END
        FROM chats c
        WHERE c.friend_id = f.id
        ORDER BY c.updated_at DESC, c.id DESC
        LIMIT 1
      ) AS chat_status
    FROM friends f
    INNER JOIN line_accounts la ON la.id = f.line_account_id AND la.is_active = 1
    LEFT JOIN sales_customer_statuses scs ON scs.friend_id = f.id
    LEFT JOIN sales_customer_semantic_summaries scss ON scss.friend_id = f.id

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
      scs.updated_at AS status_updated_at,
      scss.id AS overview_id,
      scss.summary AS overview_text,
      scss.generation_method AS overview_generation_method,
      scss.ai_generated AS overview_ai_generated,
      scss.model AS overview_model,
      scss.prompt_version AS overview_prompt_version,
      scss.source_fingerprint AS overview_source_fingerprint,
      scss.source_message_count AS overview_source_message_count,
      scss.source_from_at AS overview_source_from_at,
      scss.source_to_at AS overview_source_to_at,
      scss.input_char_count AS overview_input_char_count,
      scss.version AS overview_version,
      scss.updated_by_name AS overview_updated_by_name,
      scss.updated_at AS overview_updated_at,
      NULL AS is_following,
      COALESCE(lc.workflow_status, lc.status) AS chat_status
    FROM line_conversations lc
    INNER JOIN line_accounts la ON la.id = lc.line_account_id AND la.is_active = 1
    LEFT JOIN sales_customer_statuses scs ON scs.conversation_id = lc.id
    LEFT JOIN sales_customer_semantic_summaries scss ON scss.conversation_id = lc.id
    WHERE lc.source_type IN ('group', 'room')
  )
`;

// Sales receives aggregate activity only. Message content, sender identity,
// internal notes, and message IDs never enter this CTE or the response.
function customerActivityCtesSql(scope: 'account' | 'subject'): string {
  const friendFilter = scope === 'account' ? 'af.line_account_id = ?' : 'ml.friend_id = ?';
  const conversationFilter = scope === 'account' ? 'alc.line_account_id = ?' : 'lcm.conversation_id = ?';
  const supportFilter = scope === 'account' ? 'sf.line_account_id = ?' : 'sc.friend_id = ?';
  return `,
  customer_message_activity AS (
    SELECT
      'friend' AS activity_kind,
      ml.friend_id AS activity_id,
      ml.direction,
      ml.message_type,
      ml.created_at,
      CASE
        WHEN ml.direction = 'outgoing'
          AND ml.source IN ('manual', 'scheduled_manual', 'line_official')
        THEN 1 ELSE 0
      END AS human_outgoing
    FROM messages_log ml
    INNER JOIN friends af ON af.id = ml.friend_id
    WHERE (ml.delivery_type IS NULL OR ml.delivery_type != 'test')
      AND ml.deleted_at IS NULL
      AND ${friendFilter}

    UNION ALL

    SELECT
      'conversation' AS activity_kind,
      lcm.conversation_id AS activity_id,
      lcm.direction,
      lcm.message_type,
      lcm.created_at,
      CASE WHEN lcm.direction = 'outgoing' THEN 1 ELSE 0 END AS human_outgoing
    FROM line_conversation_messages lcm
    INNER JOIN line_conversations alc ON alc.id = lcm.conversation_id
    WHERE lcm.deleted_at IS NULL
      AND ${conversationFilter}
  ),
  customer_activity AS (
    SELECT
      activity_kind,
      activity_id,
      MAX(created_at) AS activity_last_at,
      MAX(CASE WHEN direction = 'incoming' THEN created_at END) AS activity_last_incoming_at,
      MAX(CASE WHEN human_outgoing = 1 THEN created_at END) AS activity_last_human_outgoing_at,
      CASE
        WHEN MAX(CASE WHEN direction = 'incoming' THEN julianday(created_at) END) IS NOT NULL
          AND (
            MAX(CASE WHEN human_outgoing = 1 THEN julianday(created_at) END) IS NULL
            OR MAX(CASE WHEN direction = 'incoming' THEN julianday(created_at) END)
              > MAX(CASE WHEN human_outgoing = 1 THEN julianday(created_at) END)
          )
        THEN 1 ELSE 0
      END AS activity_needs_human_reply,
      SUM(CASE WHEN datetime(created_at) >= datetime('now', '-30 days') THEN 1 ELSE 0 END) AS activity_30_total,
      SUM(CASE WHEN datetime(created_at) >= datetime('now', '-30 days') AND direction = 'incoming' THEN 1 ELSE 0 END) AS activity_30_incoming,
      SUM(CASE WHEN datetime(created_at) >= datetime('now', '-30 days') AND human_outgoing = 1 THEN 1 ELSE 0 END) AS activity_30_human_outgoing,
      SUM(CASE WHEN datetime(created_at) >= datetime('now', '-30 days') AND direction = 'outgoing' AND human_outgoing = 0 THEN 1 ELSE 0 END) AS activity_30_automated_outgoing,
      COUNT(DISTINCT CASE WHEN datetime(created_at) >= datetime('now', '-30 days') THEN date(created_at) END) AS activity_30_active_days,
      SUM(CASE WHEN datetime(created_at) >= datetime('now', '-30 days') AND message_type NOT IN ('text', 'postback') THEN 1 ELSE 0 END) AS activity_30_media,
      SUM(CASE WHEN datetime(created_at) >= datetime('now', '-60 days') THEN 1 ELSE 0 END) AS activity_60_total,
      SUM(CASE WHEN datetime(created_at) >= datetime('now', '-60 days') AND direction = 'incoming' THEN 1 ELSE 0 END) AS activity_60_incoming,
      SUM(CASE WHEN datetime(created_at) >= datetime('now', '-60 days') AND human_outgoing = 1 THEN 1 ELSE 0 END) AS activity_60_human_outgoing,
      SUM(CASE WHEN datetime(created_at) >= datetime('now', '-60 days') AND direction = 'outgoing' AND human_outgoing = 0 THEN 1 ELSE 0 END) AS activity_60_automated_outgoing,
      COUNT(DISTINCT CASE WHEN datetime(created_at) >= datetime('now', '-60 days') THEN date(created_at) END) AS activity_60_active_days,
      SUM(CASE WHEN datetime(created_at) >= datetime('now', '-60 days') AND message_type NOT IN ('text', 'postback') THEN 1 ELSE 0 END) AS activity_60_media,
      SUM(CASE WHEN datetime(created_at) >= datetime('now', '-90 days') THEN 1 ELSE 0 END) AS activity_90_total,
      SUM(CASE WHEN datetime(created_at) >= datetime('now', '-90 days') AND direction = 'incoming' THEN 1 ELSE 0 END) AS activity_90_incoming,
      SUM(CASE WHEN datetime(created_at) >= datetime('now', '-90 days') AND human_outgoing = 1 THEN 1 ELSE 0 END) AS activity_90_human_outgoing,
      SUM(CASE WHEN datetime(created_at) >= datetime('now', '-90 days') AND direction = 'outgoing' AND human_outgoing = 0 THEN 1 ELSE 0 END) AS activity_90_automated_outgoing,
      COUNT(DISTINCT CASE WHEN datetime(created_at) >= datetime('now', '-90 days') THEN date(created_at) END) AS activity_90_active_days,
      SUM(CASE WHEN datetime(created_at) >= datetime('now', '-90 days') AND message_type NOT IN ('text', 'postback') THEN 1 ELSE 0 END) AS activity_90_media
    FROM customer_message_activity
    GROUP BY activity_kind, activity_id
  ),
  customer_support_activity AS (
    SELECT
      sc.friend_id AS support_friend_id,
      SUM(CASE WHEN sc.status NOT IN ('resolved') THEN 1 ELSE 0 END) AS active_support_cases,
      SUM(CASE WHEN datetime(sc.updated_at) >= datetime('now', '-90 days') THEN 1 ELSE 0 END) AS support_cases_90,
      MAX(sc.updated_at) AS last_support_updated_at
    FROM support_cases sc
    INNER JOIN friends sf ON sf.id = sc.friend_id
    WHERE sc.friend_id IS NOT NULL
      AND ${supportFilter}
    GROUP BY sc.friend_id
  )
`;
}

const CUSTOMER_ACTIVITY_SELECT_SQL = `
  cs.*,
  ca.activity_last_at,
  ca.activity_last_incoming_at,
  ca.activity_last_human_outgoing_at,
  ca.activity_needs_human_reply,
  ca.activity_30_total,
  ca.activity_30_incoming,
  ca.activity_30_human_outgoing,
  ca.activity_30_automated_outgoing,
  ca.activity_30_active_days,
  ca.activity_30_media,
  ca.activity_60_total,
  ca.activity_60_incoming,
  ca.activity_60_human_outgoing,
  ca.activity_60_automated_outgoing,
  ca.activity_60_active_days,
  ca.activity_60_media,
  ca.activity_90_total,
  ca.activity_90_incoming,
  ca.activity_90_human_outgoing,
  ca.activity_90_automated_outgoing,
  ca.activity_90_active_days,
  ca.activity_90_media,
  CASE WHEN cs.subject_kind = 'friend' THEN COALESCE(csa.active_support_cases, 0) ELSE 0 END AS active_support_cases,
  CASE WHEN cs.subject_kind = 'friend' THEN COALESCE(csa.support_cases_90, 0) ELSE 0 END AS support_cases_90,
  CASE WHEN cs.subject_kind = 'friend' THEN csa.last_support_updated_at ELSE NULL END AS last_support_updated_at
`;

const CUSTOMER_ACTIVITY_JOINS_SQL = `
  LEFT JOIN customer_activity ca
    ON ca.activity_kind = cs.subject_kind AND ca.activity_id = cs.subject_id
  LEFT JOIN customer_support_activity csa
    ON cs.subject_kind = 'friend' AND csa.support_friend_id = cs.subject_id
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

function parseOverviewBatchLimit(raw: unknown): ValueResult<number> {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, value: SALES_CUSTOMER_OVERVIEW_BATCH_DEFAULT_LIMIT };
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > SALES_CUSTOMER_OVERVIEW_BATCH_MAX_LIMIT) {
    return { ok: false, error: 'invalid_limit' };
  }
  return { ok: true, value };
}

function parseDryRun(raw: unknown): ValueResult<boolean> {
  if (typeof raw !== 'boolean') return { ok: false, error: 'dryRun is required' };
  return { ok: true, value: raw };
}

function parseStoredStatus(raw: unknown): ValueResult<StoredSalesCustomerStatus> {
  if (typeof raw !== 'string' || !STORED_STATUSES.includes(raw as StoredSalesCustomerStatus)) {
    return { ok: false, error: 'invalid_status' };
  }
  return { ok: true, value: raw as StoredSalesCustomerStatus };
}

function parseSummary(raw: unknown): ValueResult<string> {
  if (typeof raw !== 'string') return { ok: false, error: 'summary is required' };
  const input = raw.trim();
  if (!input) return { ok: false, error: 'summary is required' };
  if (input.length > SALES_CUSTOMER_SUMMARY_MAX_LENGTH) return { ok: false, error: 'summary is too long' };
  const value = redactSalesSummary(input);
  if (value.length > SALES_CUSTOMER_SUMMARY_MAX_LENGTH) return { ok: false, error: 'summary is too long' };
  return { ok: true, value };
}

function redactSalesSummary(value: string): string {
  return value
    .replace(/https?:\/\/[^\s<>()]+/gi, '[URL非表示]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[メール非表示]')
    .replace(
      /(^|[^\d])((?:0(?:[\s()\-ー－]?\d){9,10}|\+81(?:[\s()\-ー－]?\d){9,10}))(?!\d)/g,
      '$1[電話番号非表示]',
    );
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

function serializeRecentOverview(row: SalesCustomerRow) {
  const stored = Boolean(row.overview_id && row.overview_text);
  return {
    text: stored
      ? row.overview_text
      : '会話内容の要約はまだ作成されていません。運営担当者が生成すると表示されます。',
    method: stored ? row.overview_generation_method : SALES_CUSTOMER_SEMANTIC_SUMMARY_METHOD,
    aiGenerated: stored ? Boolean(row.overview_ai_generated) : false,
    model: stored ? row.overview_model : null,
    promptVersion: stored ? row.overview_prompt_version : SALES_CUSTOMER_SEMANTIC_SUMMARY_PROMPT_VERSION,
    sourceMessageCount: stored ? Number(row.overview_source_message_count ?? 0) : 0,
    sourceFromAt: stored ? row.overview_source_from_at : null,
    sourceToAt: stored ? row.overview_source_to_at : null,
    inputCharCount: stored ? Number(row.overview_input_char_count ?? 0) : 0,
    stored,
    version: row.overview_version ?? 0,
    updatedByName: row.overview_updated_by_name ?? null,
    updatedAt: row.overview_updated_at ?? null,
  };
}

function serializeCustomer(row: SalesCustomerRow) {
  const metadata = parseMetadata(row.customer_metadata);
  const activityWindow = (days: 30 | 60 | 90) => {
    const values = days === 30
      ? {
          total: row.activity_30_total,
          incoming: row.activity_30_incoming,
          humanOutgoing: row.activity_30_human_outgoing,
          automatedOutgoing: row.activity_30_automated_outgoing,
          activeDays: row.activity_30_active_days,
          media: row.activity_30_media,
        }
      : days === 60
        ? {
            total: row.activity_60_total,
            incoming: row.activity_60_incoming,
            humanOutgoing: row.activity_60_human_outgoing,
            automatedOutgoing: row.activity_60_automated_outgoing,
            activeDays: row.activity_60_active_days,
            media: row.activity_60_media,
          }
        : {
            total: row.activity_90_total,
            incoming: row.activity_90_incoming,
            humanOutgoing: row.activity_90_human_outgoing,
            automatedOutgoing: row.activity_90_automated_outgoing,
            activeDays: row.activity_90_active_days,
            media: row.activity_90_media,
          };
    return {
      months: days / 30,
      totalMessages: Number(values.total ?? 0),
      customerMessages: Number(values.incoming ?? 0),
      staffReplies: Number(values.humanOutgoing ?? 0),
      automatedMessages: Number(values.automatedOutgoing ?? 0),
      activeDays: Number(values.activeDays ?? 0),
      mediaMessages: Number(values.media ?? 0),
    };
  };
  const lastIncomingAt = row.activity_last_incoming_at ?? null;
  const lastHumanOutgoingAt = row.activity_last_human_outgoing_at ?? null;
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
    isFollowing: row.is_following == null ? null : Boolean(row.is_following),
    chatStatus: row.chat_status ?? null,
    recentOverview: serializeRecentOverview(row),
    activity: {
      lastContactAt: row.activity_last_at ?? null,
      lastCustomerMessageAt: lastIncomingAt,
      lastStaffReplyAt: lastHumanOutgoingAt,
      needsHumanReply: Boolean(row.activity_needs_human_reply),
      windows: {
        oneMonth: activityWindow(30),
        twoMonths: activityWindow(60),
        threeMonths: activityWindow(90),
      },
      support: {
        activeCases: Number(row.active_support_cases ?? 0),
        casesInThreeMonths: Number(row.support_cases_90 ?? 0),
        lastUpdatedAt: row.last_support_updated_at ?? null,
      },
    },
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

function serializeOverviewEvent(row: SalesCustomerOverviewEventRow) {
  return {
    id: row.id,
    text: row.summary,
    aiGenerated: Boolean(row.ai_generated),
    model: row.model,
    sourceMessageCount: Number(row.source_message_count),
    sourceFromAt: row.source_from_at,
    sourceToAt: row.source_to_at,
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

function subjectMapKey(kind: SalesCustomerSubjectKind, id: string): string {
  return `${kind}:${id}`;
}

async function loadSemanticMessages(
  db: D1Database,
  rows: SalesCustomerRow[],
): Promise<Map<string, SalesCustomerSemanticMessageRow[]>> {
  const bySubject = new Map<string, SalesCustomerSemanticMessageRow[]>();
  const friendIds = rows.filter((row) => row.subject_kind === 'friend').map((row) => row.subject_id);
  const conversationIds = rows.filter((row) => row.subject_kind === 'conversation').map((row) => row.subject_id);

  const load = async (
    kind: SalesCustomerSubjectKind,
    table: 'messages_log' | 'line_conversation_messages',
    idColumn: 'friend_id' | 'conversation_id',
    ids: string[],
  ) => {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(', ');
    const deliveryFilter = table === 'messages_log'
      ? "AND (delivery_type IS NULL OR delivery_type != 'test')"
      : '';
    const senderName = table === 'messages_log' ? 'NULL' : 'sender_name';
    const result = await db.prepare(
      `WITH ranked_messages AS (
         SELECT
           ${idColumn} AS subject_id,
           direction,
           content,
           created_at,
           ${senderName} AS sender_name,
           sent_by_staff_name,
           id AS message_id,
           ROW_NUMBER() OVER (
             PARTITION BY ${idColumn}
             ORDER BY created_at DESC, id DESC
           ) AS message_rank
         FROM ${table}
         WHERE ${idColumn} IN (${placeholders})
           AND message_type = 'text'
           AND length(trim(content)) > 0
           AND deleted_at IS NULL
           ${deliveryFilter}
           AND (
             direction = 'incoming'
             OR (direction = 'outgoing' AND source IN ('manual', 'scheduled_manual', 'line_official'))
           )
       )
       SELECT subject_id, direction, content, created_at, sender_name, sent_by_staff_name
       FROM ranked_messages
       WHERE message_rank <= ?
       ORDER BY subject_id ASC, created_at ASC, message_id ASC`,
    ).bind(...ids, SALES_CUSTOMER_SEMANTIC_SUMMARY_MAX_MESSAGES).all<SalesCustomerSemanticMessageRow>();
    for (const row of result.results) {
      const key = subjectMapKey(kind, row.subject_id);
      const values = bySubject.get(key) ?? [];
      values.push(row);
      bySubject.set(key, values);
    }
  };

  await Promise.all([
    load('friend', 'messages_log', 'friend_id', friendIds),
    load('conversation', 'line_conversation_messages', 'conversation_id', conversationIds),
  ]);
  return bySubject;
}

function semanticSensitiveTerms(row: SalesCustomerRow, messages: SalesCustomerSemanticMessageRow[]): string[] {
  const metadata = parseMetadata(row.customer_metadata);
  return [
    row.display_name,
    row.line_account_name,
    metadataText(metadata, ['companyName', 'company_name', 'company', 'corporationName', 'corporation_name']),
    metadataText(metadata, ['customerName', 'customer_name', 'contactName', 'contact_name']),
    metadataText(metadata, ['personInCharge', 'person_in_charge', 'representativeName', 'representative_name']),
    ...operationStoreNames(metadata),
    ...messages.flatMap((message) => [message.sender_name, message.sent_by_staff_name]),
  ].filter((value): value is string => typeof value === 'string' && value.trim().length >= 2);
}

function prepareSemanticSource(
  row: SalesCustomerRow,
  messages: SalesCustomerSemanticMessageRow[],
): PreparedSalesCustomerSemanticSource {
  const sourceMessages: SalesCustomerSemanticMessage[] = messages.map((message) => ({
    direction: message.direction,
    content: message.content,
    createdAt: message.created_at,
  }));
  return prepareSalesCustomerSemanticSource(sourceMessages, semanticSensitiveTerms(row, messages));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function salesStatusConflict(err: unknown): boolean {
  return err instanceof Error && (
    /sales_customer_status_events\.status_id/i.test(err.message)
    || /UNIQUE constraint failed: sales_customer_statuses/i.test(err.message)
    || /UNIQUE constraint failed: idx_sales_customer_status/i.test(err.message)
  );
}

function salesOverviewConflict(err: unknown): boolean {
  return err instanceof Error && (
    /sales_customer_semantic_summary_events\.summary_id/i.test(err.message)
    || /UNIQUE constraint failed: sales_customer_semantic_summaries/i.test(err.message)
    || /UNIQUE constraint failed: idx_sales_customer_semantic_summary/i.test(err.message)
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
        `${CUSTOMER_SUBJECTS_SQL}${customerActivityCtesSql('account')}
         SELECT ${CUSTOMER_ACTIVITY_SELECT_SQL}
         FROM customer_subjects cs
         ${CUSTOMER_ACTIVITY_JOINS_SQL}
         WHERE ${listFilter.sql}
         ORDER BY ${orderSql}
         LIMIT ? OFFSET ?`,
      ).bind(
        lineAccountId.value,
        lineAccountId.value,
        lineAccountId.value,
        ...listFilter.binds,
        limit.value,
        offset.value,
      ).all<SalesCustomerRow>(),
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

salesCustomers.post('/api/sales-customers/overviews/generate', async (c) => {
  if (!canEditSalesCustomerStatus(c)) {
    return c.json({ success: false, error: 'この操作には運営スタッフ権限が必要です' }, 403);
  }
  try {
    const rawBody = await readJsonObject(c);
    if (!rawBody.ok) return c.json({ success: false, error: rawBody.error }, 400);
    const lineAccountId = parseId(rawBody.value.lineAccountId, 'line_account_id');
    if (!lineAccountId.ok) return c.json({ success: false, error: lineAccountId.error }, 400);
    const limit = parseOverviewBatchLimit(rawBody.value.limit);
    if (!limit.ok) return c.json({ success: false, error: limit.error }, 400);
    const offset = parseOffset(rawBody.value.offset);
    if (!offset.ok) return c.json({ success: false, error: offset.error }, 400);
    const dryRun = parseDryRun(rawBody.value.dryRun);
    if (!dryRun.ok) return c.json({ success: false, error: dryRun.error }, 400);
    if (!dryRun.value && rawBody.value.confirm !== SALES_CUSTOMER_OVERVIEW_CONFIRMATION) {
      return c.json({ success: false, error: 'confirmation_required' }, 400);
    }

    const [pageResult, totalRow] = await Promise.all([
      c.env.DB.prepare(
        `${CUSTOMER_SUBJECTS_SQL}${customerActivityCtesSql('account')}
         SELECT ${CUSTOMER_ACTIVITY_SELECT_SQL}
         FROM customer_subjects cs
         ${CUSTOMER_ACTIVITY_JOINS_SQL}
         WHERE cs.line_account_id = ?
         ORDER BY cs.subject_kind ASC, cs.subject_id ASC
         LIMIT ? OFFSET ?`,
      ).bind(
        lineAccountId.value,
        lineAccountId.value,
        lineAccountId.value,
        lineAccountId.value,
        limit.value,
        offset.value,
      ).all<SalesCustomerRow>(),
      c.env.DB.prepare(
        `${CUSTOMER_SUBJECTS_SQL}
         SELECT COUNT(*) AS count
         FROM customer_subjects
         WHERE line_account_id = ?`,
      ).bind(lineAccountId.value).first<{ count: number }>(),
    ]);

    const messagesBySubject = await loadSemanticMessages(c.env.DB, pageResult.results);
    const prepared = await Promise.all(pageResult.results.map(async (row) => {
      const messages = messagesBySubject.get(subjectMapKey(row.subject_kind, row.subject_id)) ?? [];
      const source = prepareSemanticSource(row, messages);
      const sourceFingerprint = await sha256Hex(source.fingerprintInput);
      return { row, source, sourceFingerprint };
    }));

    const changes = { create: 0, update: 0, unchanged: 0 };
    for (const item of prepared) {
      if (!item.row.overview_id) changes.create += 1;
      else if (item.row.overview_source_fingerprint === item.sourceFingerprint) changes.unchanged += 1;
      else changes.update += 1;
    }

    const changedItems = prepared.filter((item) => (
      item.row.overview_source_fingerprint !== item.sourceFingerprint
    ));
    const estimate = changedItems.reduce((result, item) => ({
      aiRequests: result.aiRequests + (item.source.messageCount > 0 ? 1 : 0),
      noText: result.noText + (item.source.messageCount === 0 ? 1 : 0),
      inputChars: result.inputChars + item.source.inputCharCount,
      inputTokens: result.inputTokens + item.source.estimatedInputTokens,
    }), { aiRequests: 0, noText: 0, inputChars: 0, inputTokens: 0 });

    let written = 0;
    let historyEventsWritten = 0;
    let aiGenerated = 0;
    let noTextWritten = 0;
    let aiAttempts = 0;
    let usage: SalesCustomerSemanticSummaryUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    const failures = { aiUnavailable: 0, invalidAiResponse: 0 };
    if (!dryRun.value && changedItems.length > 0) {
      type GeneratedItem = (typeof changedItems)[number] & {
        summary: string;
        aiGenerated: boolean;
        attempts: number;
        usage: SalesCustomerSemanticSummaryUsage;
      };
      const generated: GeneratedItem[] = [];
      const generatedAt = jstNow();
      let nextIndex = 0;
      const workers = Array.from(
        { length: Math.min(2, changedItems.length) },
        async () => {
          for (;;) {
            const itemIndex = nextIndex;
            nextIndex += 1;
            const item = changedItems[itemIndex];
            if (!item) break;
            if (item.source.messageCount === 0) {
              generated.push({
                ...item,
                summary: buildNoEligibleTextSummary(),
                aiGenerated: false,
                attempts: 0,
                usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
              });
              continue;
            }
            try {
              const result = await generateSalesCustomerSemanticSummary(c.env.AI, item.source, generatedAt);
              generated.push({
                ...item,
                summary: result.text,
                aiGenerated: true,
                attempts: result.attempts,
                usage: result.usage,
              });
            } catch (err) {
              const kind = err instanceof SalesCustomerSemanticSummaryError
                ? err.kind
                : 'ai_unavailable';
              if (kind === 'invalid_ai_response') failures.invalidAiResponse += 1;
              else failures.aiUnavailable += 1;
            }
          }
        },
      );
      await Promise.all(workers);

      const actor = c.get('staff');
      const actorId = actor.id === 'env-owner' ? null : actor.id;
      const now = generatedAt;
      const statements: D1PreparedStatement[] = [];

      for (const item of generated) {
        const overviewId = item.row.overview_id ?? crypto.randomUUID();
        const mutationId = crypto.randomUUID();
        const eventId = crypto.randomUUID();
        const friendId = item.row.subject_kind === 'friend' ? item.row.subject_id : null;
        const conversationId = item.row.subject_kind === 'conversation' ? item.row.subject_id : null;
        const model = item.aiGenerated ? SALES_CUSTOMER_SEMANTIC_SUMMARY_MODEL : null;

        if (item.row.overview_id) {
          statements.push(c.env.DB.prepare(
            `UPDATE sales_customer_semantic_summaries
             SET summary = ?, generation_method = ?, ai_generated = ?, model = ?,
                 prompt_version = ?, source_fingerprint = ?, source_message_count = ?,
                 source_from_at = ?, source_to_at = ?, input_char_count = ?,
                 prompt_tokens = ?, completion_tokens = ?, total_tokens = ?, attempt_count = ?,
                 version = version + 1, mutation_id = ?,
                 updated_by = ?, updated_by_name = ?, updated_at = ?
             WHERE id = ? AND version = ?`,
          ).bind(
            item.summary,
            SALES_CUSTOMER_SEMANTIC_SUMMARY_METHOD,
            item.aiGenerated ? 1 : 0,
            model,
            SALES_CUSTOMER_SEMANTIC_SUMMARY_PROMPT_VERSION,
            item.sourceFingerprint,
            item.source.messageCount,
            item.source.sourceFromAt,
            item.source.sourceToAt,
            item.source.inputCharCount,
            item.usage.promptTokens,
            item.usage.completionTokens,
            item.usage.totalTokens,
            item.attempts,
            mutationId,
            actorId,
            actor.name,
            now,
            overviewId,
            item.row.overview_version ?? 0,
          ));
        } else {
          statements.push(c.env.DB.prepare(
            `INSERT INTO sales_customer_semantic_summaries (
               id, friend_id, conversation_id, summary, generation_method,
               ai_generated, model, prompt_version, source_fingerprint,
               source_message_count, source_from_at, source_to_at, input_char_count,
               prompt_tokens, completion_tokens, total_tokens, attempt_count,
               version, mutation_id, updated_by, updated_by_name, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
          ).bind(
            overviewId,
            friendId,
            conversationId,
            item.summary,
            SALES_CUSTOMER_SEMANTIC_SUMMARY_METHOD,
            item.aiGenerated ? 1 : 0,
            model,
            SALES_CUSTOMER_SEMANTIC_SUMMARY_PROMPT_VERSION,
            item.sourceFingerprint,
            item.source.messageCount,
            item.source.sourceFromAt,
            item.source.sourceToAt,
            item.source.inputCharCount,
            item.usage.promptTokens,
            item.usage.completionTokens,
            item.usage.totalTokens,
            item.attempts,
            mutationId,
            actorId,
            actor.name,
            now,
            now,
          ));
        }

        statements.push(c.env.DB.prepare(
          `INSERT INTO sales_customer_semantic_summary_events (
             id, summary_id, summary, generation_method, ai_generated, model,
             prompt_version, source_fingerprint, source_message_count,
             source_from_at, source_to_at, input_char_count,
             prompt_tokens, completion_tokens, total_tokens, attempt_count,
             actor_id, actor_name, created_at
           ) VALUES (
             ?,
             (SELECT id FROM sales_customer_semantic_summaries WHERE mutation_id = ?),
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           )`,
        ).bind(
          eventId,
          mutationId,
          item.summary,
          SALES_CUSTOMER_SEMANTIC_SUMMARY_METHOD,
          item.aiGenerated ? 1 : 0,
          model,
          SALES_CUSTOMER_SEMANTIC_SUMMARY_PROMPT_VERSION,
          item.sourceFingerprint,
          item.source.messageCount,
          item.source.sourceFromAt,
          item.source.sourceToAt,
          item.source.inputCharCount,
          item.usage.promptTokens,
          item.usage.completionTokens,
          item.usage.totalTokens,
          item.attempts,
          actorId,
          actor.name,
          now,
        ));
        usage = {
          promptTokens: usage.promptTokens + item.usage.promptTokens,
          completionTokens: usage.completionTokens + item.usage.completionTokens,
          totalTokens: usage.totalTokens + item.usage.totalTokens,
        };
        aiAttempts += item.attempts;
        if (item.aiGenerated) aiGenerated += 1;
        else noTextWritten += 1;
      }

      if (statements.length > 0) {
        try {
          await c.env.DB.batch(statements);
        } catch (err) {
          if (salesOverviewConflict(err)) {
            return c.json({ success: false, error: 'overview_conflict' }, 409);
          }
          throw err;
        }
      }
      written = generated.length;
      historyEventsWritten = written;
    }

    const total = totalRow?.count ?? 0;
    const processed = pageResult.results.length;
    const nextOffset = offset.value + processed;
    return c.json({
      success: true,
      data: {
        dryRun: dryRun.value,
        lineAccountId: lineAccountId.value,
        total,
        offset: offset.value,
        limit: limit.value,
        processed,
        hasNextPage: nextOffset < total,
        nextOffset: nextOffset < total ? nextOffset : null,
        changes,
        estimate: {
          aiRequests: estimate.aiRequests,
          noText: estimate.noText,
          inputChars: estimate.inputChars,
          inputTokens: estimate.inputTokens,
        },
        written,
        historyEventsWritten,
        aiGenerated,
        noTextWritten,
        aiAttempts,
        usage,
        failed: failures.aiUnavailable + failures.invalidAiResponse,
        failures,
        statusRowsTouched: 0,
      },
    });
  } catch (err) {
    console.error(`POST /api/sales-customers/overviews/generate error: ${routeErrorKind(err)}`);
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
      `${CUSTOMER_SUBJECTS_SQL}${customerActivityCtesSql('subject')}
       SELECT ${CUSTOMER_ACTIVITY_SELECT_SQL}
       FROM customer_subjects cs
       ${CUSTOMER_ACTIVITY_JOINS_SQL}
       WHERE cs.subject_kind = ? AND cs.subject_id = ?
       LIMIT 1`,
    ).bind(
      subjectId.value,
      subjectId.value,
      subjectId.value,
      subjectKind.value,
      subjectId.value,
    ).first<SalesCustomerRow>();
    if (!row) return c.json({ success: false, error: 'Customer not found' }, 404);

    const [history, overviewHistory] = await Promise.all([
      row.status_id
        ? c.env.DB.prepare(
            `SELECT e.id, e.from_status, e.to_status, e.summary, e.actor_name, e.created_at
             FROM sales_customer_status_events e
             INNER JOIN sales_customer_statuses s ON s.id = e.status_id
             WHERE s.${subjectColumn} = ?
             ORDER BY e.created_at DESC, e.id DESC
             LIMIT 50`,
          ).bind(subjectId.value).all<SalesCustomerStatusEventRow>()
        : Promise.resolve({ results: [] as SalesCustomerStatusEventRow[] }),
      row.overview_id
        ? c.env.DB.prepare(
            `SELECT e.id, e.summary, e.ai_generated, e.model,
                    e.source_message_count, e.source_from_at, e.source_to_at,
                    e.actor_name, e.created_at
             FROM sales_customer_semantic_summary_events e
             INNER JOIN sales_customer_semantic_summaries s ON s.id = e.summary_id
             WHERE s.${subjectColumn} = ?
             ORDER BY e.created_at DESC, e.id DESC
             LIMIT 20`,
          ).bind(subjectId.value).all<SalesCustomerOverviewEventRow>()
        : Promise.resolve({ results: [] as SalesCustomerOverviewEventRow[] }),
    ]);

    return c.json({
      success: true,
      data: {
        ...serializeCustomer(row),
        history: history.results.map(serializeEvent),
        overviewHistory: overviewHistory.results.map(serializeOverviewEvent),
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
      `${CUSTOMER_SUBJECTS_SQL}${customerActivityCtesSql('subject')}
       SELECT ${CUSTOMER_ACTIVITY_SELECT_SQL}
       FROM customer_subjects cs
       ${CUSTOMER_ACTIVITY_JOINS_SQL}
       WHERE cs.subject_kind = ? AND cs.subject_id = ?
       LIMIT 1`,
    ).bind(
      subjectId.value,
      subjectId.value,
      subjectId.value,
      subjectKind.value,
      subjectId.value,
    ).first<SalesCustomerRow>();
    if (!updated) return c.json({ success: false, error: 'Customer not found' }, 404);
    return c.json({ success: true, data: serializeCustomer(updated) });
  } catch (err) {
    console.error(`PATCH /api/sales-customers/:subjectKind/:subjectId/status error: ${routeErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { salesCustomers };

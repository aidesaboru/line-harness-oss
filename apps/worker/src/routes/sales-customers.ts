import { Hono, type Context } from 'hono';
import { jstNow } from '@line-crm/db';
import type { Env } from '../index.js';
import {
  buildNoEligibleTextSituation,
  generateSalesCustomerSituation,
  prepareSalesCustomerSemanticSource,
  resolveAutomatedSalesStatus,
  SALES_CUSTOMER_SITUATION_MAX_MESSAGES,
  SALES_CUSTOMER_SITUATION_METHOD,
  SALES_CUSTOMER_SITUATION_MODEL,
  SALES_CUSTOMER_SITUATION_PROMPT_VERSION,
  SalesCustomerSemanticSummaryError,
  type GeneratedSalesCustomerSituation,
  type PreparedSalesCustomerSemanticSource,
  type SalesCustomerSemanticMessage,
  type SalesCustomerSemanticSummaryUsage,
  type SalesCustomerSituationEvent,
} from '../services/sales-customer-semantic-summary.js';

const salesCustomers = new Hono<Env>();

const SALES_CUSTOMER_ID_MAX_LENGTH = 128;
const SALES_CUSTOMER_SEARCH_MAX_LENGTH = 120;
const SALES_CUSTOMER_LIST_MAX_LIMIT = 100;
const SALES_CUSTOMER_DEFAULT_LIMIT = 50;
const SALES_CUSTOMER_OVERVIEW_BATCH_MAX_LIMIT = 5;
const SALES_CUSTOMER_OVERVIEW_BATCH_DEFAULT_LIMIT = 5;
const SALES_CUSTOMER_SITUATION_CONFIRMATION = 'generate_sales_customer_situations';
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
  status_source: 'manual' | 'ai' | null;
  status_source_fingerprint: string | null;
  status_version: number | null;
  status_updated_by_name: string | null;
  status_updated_at: string | null;
  timeline_id: string | null;
  timeline_current_state: string | null;
  timeline_recognized_status: SalesCustomerStatus | null;
  timeline_resolution_confirmed: number | null;
  timeline_json: string | null;
  timeline_generation_method: string | null;
  timeline_ai_generated: number | null;
  timeline_model: string | null;
  timeline_prompt_version: string | null;
  timeline_source_fingerprint: string | null;
  timeline_source_message_count: number | null;
  timeline_source_from_at: string | null;
  timeline_source_to_at: string | null;
  timeline_input_char_count: number | null;
  timeline_version: number | null;
  timeline_updated_by_name: string | null;
  timeline_updated_at: string | null;
};

type SalesCustomerStatusEventRow = {
  id: string;
  from_status: SalesCustomerStatus;
  to_status: StoredSalesCustomerStatus;
  summary: string;
  source: 'manual' | 'ai';
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
      scs.source AS status_source,
      scs.source_fingerprint AS status_source_fingerprint,
      scs.version AS status_version,
      scs.updated_by_name AS status_updated_by_name,
      scs.updated_at AS status_updated_at,
      scst.id AS timeline_id,
      scst.current_state AS timeline_current_state,
      scst.recognized_status AS timeline_recognized_status,
      scst.resolution_confirmed AS timeline_resolution_confirmed,
      scst.timeline_json,
      scst.generation_method AS timeline_generation_method,
      scst.ai_generated AS timeline_ai_generated,
      scst.model AS timeline_model,
      scst.prompt_version AS timeline_prompt_version,
      scst.source_fingerprint AS timeline_source_fingerprint,
      scst.source_message_count AS timeline_source_message_count,
      scst.source_from_at AS timeline_source_from_at,
      scst.source_to_at AS timeline_source_to_at,
      scst.input_char_count AS timeline_input_char_count,
      scst.version AS timeline_version,
      scst.updated_by_name AS timeline_updated_by_name,
      scst.updated_at AS timeline_updated_at
    FROM friends f
    INNER JOIN line_accounts la ON la.id = f.line_account_id AND la.is_active = 1
    LEFT JOIN sales_customer_statuses scs ON scs.friend_id = f.id
    LEFT JOIN sales_customer_situation_timelines scst ON scst.friend_id = f.id

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
      scs.source AS status_source,
      scs.source_fingerprint AS status_source_fingerprint,
      scs.version AS status_version,
      scs.updated_by_name AS status_updated_by_name,
      scs.updated_at AS status_updated_at,
      scst.id AS timeline_id,
      scst.current_state AS timeline_current_state,
      scst.recognized_status AS timeline_recognized_status,
      scst.resolution_confirmed AS timeline_resolution_confirmed,
      scst.timeline_json,
      scst.generation_method AS timeline_generation_method,
      scst.ai_generated AS timeline_ai_generated,
      scst.model AS timeline_model,
      scst.prompt_version AS timeline_prompt_version,
      scst.source_fingerprint AS timeline_source_fingerprint,
      scst.source_message_count AS timeline_source_message_count,
      scst.source_from_at AS timeline_source_from_at,
      scst.source_to_at AS timeline_source_to_at,
      scst.input_char_count AS timeline_input_char_count,
      scst.version AS timeline_version,
      scst.updated_by_name AS timeline_updated_by_name,
      scst.updated_at AS timeline_updated_at
    FROM line_conversations lc
    INNER JOIN line_accounts la ON la.id = lc.line_account_id AND la.is_active = 1
    LEFT JOIN sales_customer_statuses scs ON scs.conversation_id = lc.id
    LEFT JOIN sales_customer_situation_timelines scst ON scst.conversation_id = lc.id
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

function parseTimelineJson(raw: string | null): SalesCustomerSituationEvent[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is SalesCustomerSituationEvent => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
      const event = item as Record<string, unknown>;
      return typeof event.occurredAt === 'string'
        && (event.kind === 'customer_contact' || event.kind === 'staff_action' || event.kind === 'state_change')
        && typeof event.title === 'string'
        && typeof event.detail === 'string'
        && (event.state === 'open' || event.state === 'in_progress' || event.state === 'resolved' || event.state === 'information');
    });
  } catch {
    return [];
  }
}

function serializeSituation(row: SalesCustomerRow) {
  const stored = Boolean(row.timeline_id && row.timeline_current_state);
  return {
    currentState: stored
      ? row.timeline_current_state
      : '状況タイムラインはまだ生成されていません。',
    recognizedStatus: stored ? row.timeline_recognized_status : 'unreviewed',
    resolutionConfirmed: stored ? Boolean(row.timeline_resolution_confirmed) : false,
    events: stored ? parseTimelineJson(row.timeline_json) : [],
    method: stored ? row.timeline_generation_method : SALES_CUSTOMER_SITUATION_METHOD,
    aiGenerated: stored ? Boolean(row.timeline_ai_generated) : false,
    model: stored ? row.timeline_model : null,
    promptVersion: stored ? row.timeline_prompt_version : SALES_CUSTOMER_SITUATION_PROMPT_VERSION,
    sourceMessageCount: stored ? Number(row.timeline_source_message_count ?? 0) : 0,
    sourceFromAt: stored ? row.timeline_source_from_at : null,
    sourceToAt: stored ? row.timeline_source_to_at : null,
    inputCharCount: stored ? Number(row.timeline_input_char_count ?? 0) : 0,
    stored,
    version: row.timeline_version ?? 0,
    updatedByName: row.timeline_updated_by_name ?? null,
    updatedAt: row.timeline_updated_at ?? null,
  };
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
    statusSource: row.status_source,
    version: row.status_version ?? 0,
    updatedByName: row.status_updated_by_name,
    updatedAt: row.status_updated_at,
    createdAt: row.subject_created_at,
    situation: serializeSituation(row),
  };
}

function serializeEvent(row: SalesCustomerStatusEventRow) {
  return {
    id: row.id,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    source: row.source,
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
          OR content LIKE '%退会%'
          OR content LIKE '%解約%'
          OR content LIKE '%契約終了%'
          OR content LIKE '%利用停止%'
          OR content LIKE '%閉店%'
          OR content LIKE '%廃業%'
          OR content LIKE '%クレーム%'
          OR content LIKE '%苦情%'
          OR content LIKE '%不満%'
          OR content LIKE '%返金%'
          OR content LIKE '%誤請求%'
          OR content LIKE '%トラブル%'
          OR content LIKE '%解決%'
          OR content LIKE '%収束%'
          OR content LIKE '%撤回%'
          OR content LIKE '%取消%'
          OR content LIKE '%キャンセル%'
          OR content LIKE '%再開%'
          OR content LIKE '%復帰%'
          OR content LIKE '%再契約%'
       ORDER BY subject_id ASC, created_at ASC, message_id ASC`,
    ).bind(...ids, 120).all<SalesCustomerSemanticMessageRow>();
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

function normalizeSensitiveTerm(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.normalize('NFKC').replace(/[\t\f\v ]+/gu, ' ').trim();
  return normalized.length >= 2 && normalized.length <= 80 ? normalized : null;
}

function literalSensitiveTerms(value: string | null): string[] {
  const normalized = normalizeSensitiveTerm(value);
  return normalized ? [normalized] : [];
}

function organizationSensitiveTerms(value: string | null): string[] {
  const normalized = normalizeSensitiveTerm(value);
  if (!normalized) return [];
  const withoutLegalName = normalized
    .replace(/^(?:株式会社|有限会社|合同会社|一般社団法人|一般財団法人|医療法人|社会福祉法人)[\s　]*/u, '')
    .replace(/[\s　]*(?:株式会社|有限会社|合同会社)$/u, '')
    .trim();
  const compact = withoutLegalName.replace(/[\s　]+/gu, '');
  return Array.from(new Set([
    normalized,
    ...(withoutLegalName.length >= 2 ? [withoutLegalName] : []),
    ...(compact.length >= 3 && compact !== withoutLegalName ? [compact] : []),
  ]));
}

function personSensitiveTerms(value: string | null): string[] {
  const normalized = normalizeSensitiveTerm(value);
  if (!normalized) return [];
  if (/(?:株式会社|有限会社|合同会社|一般社団法人|一般財団法人|医療法人|社会福祉法人)/u.test(normalized)) {
    return organizationSensitiveTerms(normalized);
  }
  const withoutHonorific = normalized.replace(/(?:様|さん|氏)$/u, '').trim();
  const candidates = new Set<string>([normalized, withoutHonorific]);
  for (const match of withoutHonorific.matchAll(/[ぁ-んァ-ヶー一-龯々]{2,10}/gu)) {
    const name = match[0];
    if (/^(?:株式会社|有限会社|合同会社|一般社団法人|一般財団法人|医療法人|社会福祉法人|会社|お客様|顧客|担当者?|未設定)$/u.test(name)) continue;
    candidates.add(name);
    if (name.length >= 4) {
      candidates.add(name.slice(0, 2));
      candidates.add(name.slice(0, 3));
      candidates.add(name.slice(-2));
    }
  }
  return Array.from(candidates).filter((term) => term.length >= 2 && term.length <= 80);
}

function semanticSensitiveTerms(row: SalesCustomerRow, messages: SalesCustomerSemanticMessageRow[]): string[] {
  const metadata = parseMetadata(row.customer_metadata);
  const companyName = metadataText(metadata, [
    'companyName', 'company_name', 'company', 'corporationName', 'corporation_name',
  ]);
  const customerName = metadataText(metadata, [
    'customerName', 'customer_name', 'contactName', 'contact_name',
  ]);
  const representativeName = metadataText(metadata, [
    'personInCharge', 'person_in_charge', 'representativeName', 'representative_name',
  ]);
  const customerNumber = metadataText(metadata, [
    'customerNumber', 'customer_number', 'memberNumber', 'member_number',
  ]);
  return Array.from(new Set([
    ...personSensitiveTerms(row.display_name),
    ...literalSensitiveTerms(row.line_account_name),
    ...organizationSensitiveTerms(companyName),
    ...personSensitiveTerms(customerName),
    ...personSensitiveTerms(representativeName),
    ...literalSensitiveTerms(customerNumber),
    ...operationStoreNames(metadata).flatMap(organizationSensitiveTerms),
    ...messages.flatMap((message) => [
      ...personSensitiveTerms(message.sender_name),
      ...personSensitiveTerms(message.sent_by_staff_name),
    ]),
  ]));
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

function salesSituationConflict(err: unknown): boolean {
  return err instanceof Error && (
    /sales_customer_situation_timeline_events\.timeline_id/i.test(err.message)
    || /UNIQUE constraint failed: sales_customer_situation_timelines/i.test(err.message)
    || /UNIQUE constraint failed: idx_sales_customer_situation_timeline/i.test(err.message)
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
         SELECT cs.*
         FROM customer_subjects cs
         WHERE ${listFilter.sql}
         ORDER BY ${orderSql}
         LIMIT ? OFFSET ?`,
      ).bind(
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
        canRunBatch: canEditSalesCustomerStatus(c),
      },
    });
  } catch (err) {
    console.error(`GET /api/sales-customers error: ${routeErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

salesCustomers.post('/api/sales-customers/situations/generate', async (c) => {
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
    const hasSubjectKind = rawBody.value.subjectKind !== undefined;
    const hasSubjectId = rawBody.value.subjectId !== undefined;
    if (hasSubjectKind !== hasSubjectId) {
      return c.json({ success: false, error: 'exact_subject_requires_kind_and_id' }, 400);
    }
    let exactSubject: { kind: SalesCustomerSubjectKind; id: string } | null = null;
    if (hasSubjectKind && hasSubjectId) {
      const subjectKind = parseSubjectKind(rawBody.value.subjectKind);
      if (!subjectKind.ok) return c.json({ success: false, error: subjectKind.error }, 400);
      const subjectId = parseId(rawBody.value.subjectId, 'subject_id');
      if (!subjectId.ok) return c.json({ success: false, error: subjectId.error }, 400);
      exactSubject = { kind: subjectKind.value, id: subjectId.value };
    }
    if (!dryRun.value && rawBody.value.confirm !== SALES_CUSTOMER_SITUATION_CONFIRMATION) {
      return c.json({ success: false, error: 'confirmation_required' }, 400);
    }

    const effectiveLimit = exactSubject ? 1 : limit.value;
    const effectiveOffset = exactSubject ? 0 : offset.value;
    const pageStatement = exactSubject
      ? c.env.DB.prepare(
          `${CUSTOMER_SUBJECTS_SQL}
           SELECT cs.*
           FROM customer_subjects cs
           WHERE cs.line_account_id = ?
             AND cs.subject_kind = ?
             AND cs.subject_id = ?
           LIMIT 1`,
        ).bind(
          lineAccountId.value,
          exactSubject.kind,
          exactSubject.id,
        )
      : c.env.DB.prepare(
          `${CUSTOMER_SUBJECTS_SQL}
           SELECT cs.*
           FROM customer_subjects cs
           WHERE cs.line_account_id = ?
           ORDER BY cs.subject_kind ASC, cs.subject_id ASC
           LIMIT ? OFFSET ?`,
        ).bind(
          lineAccountId.value,
          limit.value,
          offset.value,
        );
    const totalStatement = exactSubject
      ? c.env.DB.prepare(
          `${CUSTOMER_SUBJECTS_SQL}
           SELECT COUNT(*) AS count
           FROM customer_subjects
           WHERE line_account_id = ? AND subject_kind = ? AND subject_id = ?`,
        ).bind(lineAccountId.value, exactSubject.kind, exactSubject.id)
      : c.env.DB.prepare(
          `${CUSTOMER_SUBJECTS_SQL}
           SELECT COUNT(*) AS count
           FROM customer_subjects
           WHERE line_account_id = ?`,
        ).bind(lineAccountId.value);
    const [pageResult, totalRow] = await Promise.all([
      pageStatement.all<SalesCustomerRow>(),
      totalStatement.first<{ count: number }>(),
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
      if (!item.row.timeline_id) changes.create += 1;
      else if (item.row.timeline_source_fingerprint === item.sourceFingerprint) changes.unchanged += 1;
      else changes.update += 1;
    }

    const changedItems = prepared.filter((item) => (
      item.row.timeline_source_fingerprint !== item.sourceFingerprint
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
    const statusChanges = { created: 0, updated: 0, unchanged: 0, protected: 0, unreviewed: 0 };
    let statusRowsTouched = 0;
    if (!dryRun.value && changedItems.length > 0) {
      type GeneratedItem = (typeof changedItems)[number] & {
        situation: Omit<GeneratedSalesCustomerSituation, 'usage' | 'attempts'>;
        aiGenerated: boolean;
        attempts: number;
        usage: SalesCustomerSemanticSummaryUsage;
      };
      const generated: GeneratedItem[] = [];
      const generatedAt = jstNow();
      let nextIndex = 0;
      const workers = Array.from(
        { length: Math.min(3, changedItems.length) },
        async () => {
          for (;;) {
            const itemIndex = nextIndex;
            nextIndex += 1;
            const item = changedItems[itemIndex];
            if (!item) break;
            if (item.source.messageCount === 0) {
              generated.push({
                ...item,
                situation: buildNoEligibleTextSituation(),
                aiGenerated: false,
                attempts: 0,
                usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
              });
              continue;
            }
            try {
              const result = await generateSalesCustomerSituation(c.env.AI, item.source, generatedAt);
              generated.push({
                ...item,
                situation: {
                  currentState: result.currentState,
                  recognizedStatus: result.recognizedStatus,
                  resolutionConfirmed: result.resolutionConfirmed,
                  events: result.events,
                },
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
        const timelineId = item.row.timeline_id ?? crypto.randomUUID();
        const mutationId = crypto.randomUUID();
        const eventId = crypto.randomUUID();
        const friendId = item.row.subject_kind === 'friend' ? item.row.subject_id : null;
        const conversationId = item.row.subject_kind === 'conversation' ? item.row.subject_id : null;
        const model = item.aiGenerated ? SALES_CUSTOMER_SITUATION_MODEL : null;
        const timelineJson = JSON.stringify(item.situation.events);

        if (item.row.timeline_id) {
          statements.push(c.env.DB.prepare(
            `UPDATE sales_customer_situation_timelines
             SET current_state = ?, recognized_status = ?, resolution_confirmed = ?, timeline_json = ?,
                 generation_method = ?, ai_generated = ?, model = ?,
                 prompt_version = ?, source_fingerprint = ?, source_message_count = ?,
                 source_from_at = ?, source_to_at = ?, input_char_count = ?,
                 prompt_tokens = ?, completion_tokens = ?, total_tokens = ?, attempt_count = ?,
                 version = version + 1, mutation_id = ?,
                 updated_by = ?, updated_by_name = ?, updated_at = ?
             WHERE id = ? AND version = ?`,
          ).bind(
            item.situation.currentState,
            item.situation.recognizedStatus,
            item.situation.resolutionConfirmed ? 1 : 0,
            timelineJson,
            SALES_CUSTOMER_SITUATION_METHOD,
            item.aiGenerated ? 1 : 0,
            model,
            SALES_CUSTOMER_SITUATION_PROMPT_VERSION,
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
            timelineId,
            item.row.timeline_version ?? 0,
          ));
        } else {
          statements.push(c.env.DB.prepare(
            `INSERT INTO sales_customer_situation_timelines (
               id, friend_id, conversation_id, current_state, recognized_status,
               resolution_confirmed, timeline_json, generation_method,
               ai_generated, model, prompt_version, source_fingerprint,
               source_message_count, source_from_at, source_to_at, input_char_count,
               prompt_tokens, completion_tokens, total_tokens, attempt_count,
               version, mutation_id, updated_by, updated_by_name, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
          ).bind(
            timelineId,
            friendId,
            conversationId,
            item.situation.currentState,
            item.situation.recognizedStatus,
            item.situation.resolutionConfirmed ? 1 : 0,
            timelineJson,
            SALES_CUSTOMER_SITUATION_METHOD,
            item.aiGenerated ? 1 : 0,
            model,
            SALES_CUSTOMER_SITUATION_PROMPT_VERSION,
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
          `INSERT INTO sales_customer_situation_timeline_events (
             id, timeline_id, current_state, recognized_status,
             resolution_confirmed, timeline_json, generation_method, ai_generated, model,
             prompt_version, source_fingerprint, source_message_count,
             source_from_at, source_to_at, input_char_count,
             prompt_tokens, completion_tokens, total_tokens, attempt_count,
             actor_id, actor_name, created_at
           ) VALUES (
             ?,
             (SELECT id FROM sales_customer_situation_timelines WHERE mutation_id = ?),
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           )`,
        ).bind(
          eventId,
          mutationId,
          item.situation.currentState,
          item.situation.recognizedStatus,
          item.situation.resolutionConfirmed ? 1 : 0,
          timelineJson,
          SALES_CUSTOMER_SITUATION_METHOD,
          item.aiGenerated ? 1 : 0,
          model,
          SALES_CUSTOMER_SITUATION_PROMPT_VERSION,
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

        const currentStatus = item.row.sales_status === 'unreviewed' ? null : item.row.sales_status;
        const nextStatus = resolveAutomatedSalesStatus(
          currentStatus,
          item.situation.recognizedStatus,
          item.situation.resolutionConfirmed,
        );
        if (item.situation.recognizedStatus === 'unreviewed' || nextStatus === null) {
          statusChanges.unreviewed += 1;
        } else if (nextStatus === currentStatus) {
          if (nextStatus !== item.situation.recognizedStatus) statusChanges.protected += 1;
          else statusChanges.unchanged += 1;
        } else {
          const statusMutationId = crypto.randomUUID();
          const statusId = item.row.status_id ?? crypto.randomUUID();
          const statusEventId = crypto.randomUUID();
          const auditSummary = '会話タイムラインの自動判定';
          if (item.row.status_id) {
            statements.push(c.env.DB.prepare(
              `UPDATE sales_customer_statuses
               SET status = ?, summary = ?, source = 'ai', source_fingerprint = ?,
                   version = version + 1, mutation_id = ?, updated_by = ?,
                   updated_by_name = ?, updated_at = ?
               WHERE id = ? AND version = ?`,
            ).bind(
              nextStatus,
              auditSummary,
              item.sourceFingerprint,
              statusMutationId,
              actorId,
              actor.name,
              now,
              statusId,
              item.row.status_version ?? 0,
            ));
            statusChanges.updated += 1;
          } else {
            statements.push(c.env.DB.prepare(
              `INSERT INTO sales_customer_statuses (
                 id, friend_id, conversation_id, status, summary, source,
                 source_fingerprint, version, mutation_id, updated_by,
                 updated_by_name, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, 'ai', ?, 1, ?, ?, ?, ?, ?)`,
            ).bind(
              statusId,
              friendId,
              conversationId,
              nextStatus,
              auditSummary,
              item.sourceFingerprint,
              statusMutationId,
              actorId,
              actor.name,
              now,
              now,
            ));
            statusChanges.created += 1;
          }
          statements.push(c.env.DB.prepare(
            `INSERT INTO sales_customer_status_events (
               id, status_id, from_status, to_status, summary, source,
               actor_id, actor_name, created_at
             ) VALUES (
               ?, (SELECT id FROM sales_customer_statuses WHERE mutation_id = ?),
               ?, ?, ?, 'ai', ?, ?, ?
             )`,
          ).bind(
            statusEventId,
            statusMutationId,
            currentStatus ?? 'unreviewed',
            nextStatus,
            auditSummary,
            actorId,
            actor.name,
            now,
          ));
          statusRowsTouched += 1;
        }
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
          if (salesSituationConflict(err) || salesStatusConflict(err)) {
            return c.json({ success: false, error: 'situation_conflict' }, 409);
          }
          throw err;
        }
      }
      written = generated.length;
      historyEventsWritten = written;
    }

    const total = totalRow?.count ?? 0;
    const processed = pageResult.results.length;
    const nextOffset = effectiveOffset + processed;
    return c.json({
      success: true,
      data: {
        dryRun: dryRun.value,
        lineAccountId: lineAccountId.value,
        total,
        offset: effectiveOffset,
        limit: effectiveLimit,
        processed,
        hasNextPage: exactSubject ? false : nextOffset < total,
        nextOffset: !exactSubject && nextOffset < total ? nextOffset : null,
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
        statusChanges,
        statusRowsTouched,
      },
    });
  } catch (err) {
    console.error(`POST /api/sales-customers/situations/generate error: ${routeErrorKind(err)}`);
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
       SELECT cs.*
       FROM customer_subjects cs
       WHERE cs.subject_kind = ? AND cs.subject_id = ?
       LIMIT 1`,
    ).bind(
      subjectKind.value,
      subjectId.value,
    ).first<SalesCustomerRow>();
    if (!row) return c.json({ success: false, error: 'Customer not found' }, 404);

    const history = await (
      row.status_id
        ? c.env.DB.prepare(
            `SELECT e.id, e.from_status, e.to_status, e.summary, e.source,
                    e.actor_name, e.created_at
             FROM sales_customer_status_events e
             INNER JOIN sales_customer_statuses s ON s.id = e.status_id
             WHERE s.${subjectColumn} = ?
             ORDER BY e.created_at DESC, e.id DESC
             LIMIT 50`,
          ).bind(subjectId.value).all<SalesCustomerStatusEventRow>()
        : Promise.resolve({ results: [] as SalesCustomerStatusEventRow[] })
    );

    return c.json({
      success: true,
      data: {
        ...serializeCustomer(row),
        history: history.results.map(serializeEvent),
      },
    });
  } catch (err) {
    console.error(`GET /api/sales-customers/:subjectKind/:subjectId error: ${routeErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { salesCustomers };

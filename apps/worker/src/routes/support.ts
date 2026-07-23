import { Hono } from 'hono';
import type { Context } from 'hono';
import { jstNow, toJstString } from '@line-crm/db';
import type { Env } from '../index.js';
import { requireRole } from '../middleware/role-guard.js';
import {
  isSecondaryOnlySupportStaff,
  supportCaseVisibilitySql,
  supportStaffAssignmentName,
  type SupportAccessStaff,
} from '../services/support-access.js';
import {
  deliverSupportTicketSlackNotification,
  getSupportTicketSlackNotificationHealth,
  notifyUrgentSupportCase,
  sendSupportTicketSlackTestNotification,
} from '../services/support-notifications.js';
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
import {
  isFollowUpReminderDue,
  nextFollowUpDueAt,
  serializeSupportCaseFollowUpReminder,
  type SupportCaseFollowUpReminderRow,
} from '../services/support-case-reminders.js';
import {
  deriveOperationalKnowledge,
  type KnowledgeStatus,
} from '../services/support-knowledge.js';
import { kickWebPushNotifications } from './app-notifications.js';

const support = new Hono<Env>();

const CASE_STATUSES = new Set([
  'open',
  'in_progress',
  'waiting_primary',
  'escalated',
  'waiting_secondary',
  'secondary_answered',
  'customer_reply',
  'on_hold',
  'resolved',
  'reopened',
]);

const PRIORITIES = new Set(['low', 'medium', 'high', 'urgent']);
const ESCALATION_STATUSES = new Set(['pending', 'answered', 'needs_info', 'transferred', 'expert_check', 'closed']);
const TERMINAL_ESCALATION_STATUSES = new Set(['answered', 'closed']);
const ESCALATION_LEVELS = new Set(['L2', 'L3']);
const SUPPORT_KNOWLEDGE_IMPORT_STATUSES = new Set(['draft', 'published', 'dismissed']);
const SUPPORT_MANUAL_KNOWLEDGE_STATUSES = new Set<KnowledgeStatus>(['verified', 'ready', 'needs_review', 'unresolved']);
const SUPPORT_MANUAL_USAGE_ACTIONS = new Set(['copied', 'helpful', 'needs_improvement']);
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
const SUPPORT_INTERNAL_MENTION_MAX = 20;
const SUPPORT_INTERNAL_MENTION_MAX_LENGTH = 80;
const SUPPORT_SECONDARY_ASSIGNEE_MAX = 10;
const SUPPORT_ATTACHMENT_MAX_COUNT = 5;
const SUPPORT_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
const SUPPORT_ATTACHMENT_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const SUPPORT_VISIBLE_ASCII_PATTERN = /^[!-~]+$/;
const SUPPORT_SLACK_IMPORT_DEFAULT_LIMIT = 20;
const SUPPORT_SLACK_IMPORT_MAX_LIMIT = 50;
const SUPPORT_CASE_CREATE_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000] as const;
const SUPPORT_CASE_CREATE_RETRYABLE_CODES = new Set([
  'database_busy',
  'database_error',
  'network_error',
  'unknown',
]);
const SUPPORT_CASE_DIAGNOSTIC_TTL_SECONDS = 7 * 24 * 60 * 60;
const SLACK_API_BASE = 'https://slack.com/api/';

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
  escalation_assignees?: string | null;
  last_human_reply_at?: string | null;
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
  followup_reminder_id?: string | null;
  followup_owner_staff_id?: string | null;
  followup_owner_name?: string | null;
  followup_interval_days?: number | null;
  followup_next_due_at?: string | null;
  followup_status?: 'active' | 'completed' | 'disabled' | null;
  followup_version?: number | null;
  followup_last_confirmed_at?: string | null;
  followup_last_confirmed_by?: string | null;
  followup_last_confirmed_name?: string | null;
  followup_created_by?: string | null;
  followup_created_by_name?: string | null;
  followup_created_at?: string | null;
  followup_updated_at?: string | null;
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
  reopened_from_id?: string | null;
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
  knowledge_question?: string | null;
  knowledge_resolution?: string | null;
  knowledge_procedure?: string | null;
  knowledge_applicability?: string | null;
  knowledge_cautions?: string | null;
  knowledge_source_body?: string | null;
  knowledge_status?: string | null;
  knowledge_quality_score?: number | null;
  knowledge_review_note?: string | null;
  knowledge_use_count?: number | null;
  knowledge_last_used_at?: string | null;
  knowledge_helpful_count?: number | null;
  knowledge_needs_improvement_count?: number | null;
};

type SupportKnowledgeImportRow = {
  id: string;
  line_account_id: string;
  source: string;
  source_channel_id: string;
  source_channel_name: string | null;
  source_message_ts: string;
  source_thread_ts: string;
  source_permalink: string | null;
  source_author: string | null;
  source_posted_at: string | null;
  title: string;
  category: string;
  question: string;
  answer: string;
  body: string;
  keywords: string;
  status: string;
  manual_id: string | null;
  imported_by: string | null;
  reviewed_by: string | null;
  imported_at: string;
  reviewed_at: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
};

type SlackMessage = {
  type?: string;
  subtype?: string;
  text?: string;
  user?: string;
  username?: string;
  bot_id?: string;
  ts?: string;
  thread_ts?: string;
  reply_count?: number;
};

type SlackApiResponse<T> = T & {
  ok?: boolean;
  error?: string;
  response_metadata?: {
    next_cursor?: string;
  };
};

type SlackHistoryResponse = SlackApiResponse<{
  messages?: SlackMessage[];
  has_more?: boolean;
}>;

type SlackRepliesResponse = SlackApiResponse<{
  messages?: SlackMessage[];
}>;

type SlackUserInfoResponse = SlackApiResponse<{
  user?: {
    id?: string;
    name?: string;
    real_name?: string;
    profile?: {
      display_name?: string;
      real_name?: string;
    };
  };
}>;

type KnowledgeCandidate = {
  sourceChannelId: string;
  sourceChannelName: string | null;
  sourceMessageTs: string;
  sourceThreadTs: string;
  sourceAuthor: string | null;
  sourcePostedAt: string | null;
  title: string;
  category: string;
  question: string;
  answer: string;
  body: string;
  keywords: string;
  sourceSnapshot: string;
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

type SupportInternalMessageRow = {
  id: string;
  case_id: string;
  line_account_id: string;
  parent_id: string | null;
  body: string;
  mentions: string;
  reactions?: string | null;
  created_by: string | null;
  created_by_name: string | null;
  edited_at?: string | null;
  edited_by?: string | null;
  deleted_at?: string | null;
  deleted_by?: string | null;
  deleted_by_name?: string | null;
  created_at: string;
};

type SupportCaseAttachmentRow = {
  id: string;
  case_id: string;
  line_account_id: string;
  r2_key: string;
  file_name: string;
  content_type: string;
  size_bytes: number;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
};

class SupportCaseCreateError extends Error {
  constructor(
    readonly originalError: unknown,
    readonly attempts: number,
  ) {
    super('Support case creation failed');
    this.name = 'SupportCaseCreateError';
  }
}

function originalSupportRouteError(err: unknown): unknown {
  return err instanceof SupportCaseCreateError ? err.originalError : err;
}

function supportRouteErrorKind(err: unknown): string {
  const originalError = originalSupportRouteError(err);
  if (originalError instanceof TypeError) return 'network_error';
  if (originalError instanceof Error) return originalError.name || 'error';
  return typeof originalError;
}

function supportRouteErrorCode(err: unknown): string {
  const originalError = originalSupportRouteError(err);
  const cause = originalError instanceof Error ? originalError.cause : undefined;
  const details = [
    originalError instanceof Error ? originalError.message : '',
    cause instanceof Error ? cause.message : '',
    String(originalError),
  ].join(' ').toLowerCase();

  if (details.includes('foreign key')) return 'foreign_key_constraint';
  if (details.includes('check constraint')) return 'check_constraint';
  if (details.includes('not null')) return 'not_null_constraint';
  if (details.includes('unique constraint')) return 'unique_constraint';
  if (details.includes('no such table') || details.includes('no such column')) return 'schema_mismatch';
  if (details.includes('locked') || details.includes('busy')) return 'database_busy';
  if (details.includes('too many sql variables') || details.includes('statement too long')) return 'database_limit';
  if (details.includes('d1_error') || details.includes('sqlite_')) return 'database_error';
  if (originalError instanceof TypeError) return 'network_error';
  return 'unknown';
}

function persistSupportCaseCreateFailure(
  c: Context<Env>,
  diagnostic: { phase: string; code: string; kind: string; attempts?: number },
): string {
  const diagnosticId = crypto.randomUUID();
  const files = c.env.FILES;
  if (!files) return diagnosticId;

  const key = `diagnostics/support-case-create/${Date.now()}-${diagnosticId}`;
  const payload = JSON.stringify({
    diagnosticId,
    occurredAt: jstNow(),
    ...diagnostic,
  });
  const write = files.put(key, payload, { expirationTtl: SUPPORT_CASE_DIAGNOSTIC_TTL_SECONDS }).catch(() => {
    console.warn(`[support_case_create] diagnostic_write_failed id=${diagnosticId}`);
  });
  try {
    c.executionCtx.waitUntil(write);
  } catch {
    console.warn(`[support_case_create] diagnostic_wait_until_failed id=${diagnosticId}`);
  }
  return diagnosticId;
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

function parseOptionalBooleanFlag(raw: unknown, label: string): ValueResult<boolean> {
  if (raw === undefined || raw === null) return { ok: true, value: false };
  if (typeof raw === 'boolean') return { ok: true, value: raw };
  if (typeof raw === 'string') {
    const value = raw.trim().toLowerCase();
    if (value === 'true' || value === '1') return { ok: true, value: true };
    if (value === 'false' || value === '0' || value === '') return { ok: true, value: false };
  }
  return { ok: false, error: `${label} must be a boolean` };
}

function parseInternalMessageBaseVersion(raw: unknown): ValueResult<number> {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) return { ok: false, error: 'baseVersion must be a non-negative integer' };
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

function parseSecondaryAssigneeNames(raw: unknown, legacy: unknown): ValueResult<string[]> {
  const source = raw === undefined
    ? (typeof legacy === 'string' && legacy.trim() ? [legacy] : [])
    : raw;
  if (!Array.isArray(source)) return { ok: false, error: 'escalationAssignees must be an array' };
  if (source.length > SUPPORT_SECONDARY_ASSIGNEE_MAX) {
    return { ok: false, error: `二次対応先は${SUPPORT_SECONDARY_ASSIGNEE_MAX}名まで選択できます` };
  }
  const names: string[] = [];
  const seen = new Set<string>();
  for (const item of source) {
    const parsed = parseRequiredTextField(item, 'escalationAssignee');
    if (!parsed.ok) return parsed;
    if (!seen.has(parsed.value)) {
      seen.add(parsed.value);
      names.push(parsed.value);
    }
  }
  return { ok: true, value: names };
}

function parseAttachmentFilename(raw: string | undefined): ValueResult<string> {
  if (!raw) return { ok: false, error: 'X-File-Name is required' };
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Keep the original value and validate it below.
  }
  const value = decoded.trim();
  if (!value || value.length > 255 || /[\u0000-\u001f\u007f/\\]/u.test(value)) {
    return { ok: false, error: 'invalid file name' };
  }
  return { ok: true, value };
}

function validateAttachmentBytes(bytes: Uint8Array, contentType: string): boolean {
  if (contentType === 'image/png') {
    return bytes.length >= 8
      && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
      && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
  }
  if (contentType === 'image/jpeg') {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (contentType === 'image/webp') {
    return bytes.length >= 12
      && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF'
      && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
  }
  return false;
}

function attachmentExtension(contentType: string): string {
  if (contentType === 'image/png') return 'png';
  if (contentType === 'image/webp') return 'webp';
  return 'jpg';
}

function safeR2Segment(value: string): string {
  return value.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 128);
}

function attachmentContentDisposition(filename: string): string {
  return `inline; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

function parseCaseAssigneeNames(raw: string | null | undefined, fallback: string | null): string[] {
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        const names = parsed.filter((value): value is string => typeof value === 'string' && Boolean(value.trim()));
        if (names.length > 0) return names;
      }
    } catch {
      // Rolling deploys and old rows fall back to the legacy single assignee.
    }
  }
  return fallback?.trim() ? [fallback.trim()] : [];
}

async function activeStaffIdsByName(db: D1Database, names: string[]): Promise<Map<string, string>> {
  if (names.length === 0) return new Map();
  const placeholders = names.map(() => '?').join(',');
  const rows = await db
    .prepare(`SELECT id, name FROM staff_members WHERE is_active = 1 AND name IN (${placeholders})`)
    .bind(...names)
    .all<{ id: string; name: string }>();
  return new Map(rows.results.map((row) => [row.name, row.id]));
}

const SUPPORT_CASE_ASSIGNEES_SELECT = `(
  SELECT COALESCE(json_group_array(assigned.assignee), '[]')
  FROM (
    SELECT se_assignee.assignee
    FROM support_escalations se_assignee
    WHERE se_assignee.case_id = sc.id
      AND se_assignee.status IN ('pending', 'needs_info', 'transferred', 'expert_check')
    GROUP BY se_assignee.assignee
    ORDER BY MIN(se_assignee.created_at) ASC
  ) assigned
) AS escalation_assignees`;

const SUPPORT_CASE_LAST_HUMAN_REPLY_SELECT = `(
  SELECT MAX(ml_reply.created_at)
  FROM messages_log ml_reply
  WHERE ml_reply.friend_id = sc.friend_id
    AND ml_reply.direction = 'outgoing'
    AND ml_reply.source IN ('manual', 'scheduled_manual', 'line_official')
    AND (ml_reply.delivery_type IS NULL OR ml_reply.delivery_type != 'test')
    AND ml_reply.deleted_at IS NULL
) AS last_human_reply_at`;

const SUPPORT_CASE_FOLLOWUP_SELECT = `
  scr_followup.id AS followup_reminder_id,
  scr_followup.owner_staff_id AS followup_owner_staff_id,
  scr_followup.owner_name AS followup_owner_name,
  scr_followup.interval_days AS followup_interval_days,
  scr_followup.next_due_at AS followup_next_due_at,
  scr_followup.status AS followup_status,
  scr_followup.version AS followup_version,
  scr_followup.last_confirmed_at AS followup_last_confirmed_at,
  scr_followup.last_confirmed_by AS followup_last_confirmed_by,
  scr_followup.last_confirmed_name AS followup_last_confirmed_name,
  scr_followup.created_by AS followup_created_by,
  scr_followup.created_by_name AS followup_created_by_name,
  scr_followup.created_at AS followup_created_at,
  scr_followup.updated_at AS followup_updated_at`;

function parseMentionNames(raw: unknown, body: string): ValueResult<string[]> {
  if (raw === undefined || raw === null) {
    const names = new Set<string>();
    for (const match of body.matchAll(/@([^\s@,、。:：;；()[\]{}]{1,80})/gu)) {
      const name = match[1]?.trim();
      if (name) names.add(name);
    }
    return { ok: true, value: Array.from(names).slice(0, SUPPORT_INTERNAL_MENTION_MAX) };
  }
  if (!Array.isArray(raw)) return { ok: false, error: 'mentions must be an array' };
  if (raw.length > SUPPORT_INTERNAL_MENTION_MAX) return { ok: false, error: 'mentions is too long' };
  const names: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') return { ok: false, error: 'mentions must be strings' };
    const name = item.trim();
    if (!name) continue;
    if (name.length > SUPPORT_INTERNAL_MENTION_MAX_LENGTH) return { ok: false, error: 'mention is too long' };
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return { ok: true, value: names };
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

function parseKnowledgeImportStatus(raw: unknown): ValueResult<'draft' | 'published' | 'dismissed' | 'all'> {
  if (raw === undefined || raw === null) return { ok: true, value: 'draft' };
  if (typeof raw !== 'string') return { ok: false, error: 'status must be a string' };
  const value = raw.trim();
  if (value === 'all' || value === 'draft' || value === 'published' || value === 'dismissed') {
    return { ok: true, value };
  }
  return { ok: false, error: 'status is invalid' };
}

function parseManualKnowledgeStatus(raw: unknown): ValueResult<KnowledgeStatus | 'all'> {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: 'all' };
  if (typeof raw !== 'string') return { ok: false, error: 'knowledgeStatus must be a string' };
  const value = raw.trim() as KnowledgeStatus | 'all';
  if (value === 'all' || SUPPORT_MANUAL_KNOWLEDGE_STATUSES.has(value as KnowledgeStatus)) {
    return { ok: true, value };
  }
  return { ok: false, error: 'knowledgeStatus is invalid' };
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function prepareKnowledgeSourceSnapshot(
  db: D1Database,
  input: {
    knowledgeImportId: string;
    lineAccountId: string;
    channelId: string;
    threadTs: string;
    rawPayload: string;
    reconstructed: boolean;
    capturedAt: string;
  },
) {
  const contentHash = await sha256Hex(input.rawPayload);
  return db.prepare(
    `INSERT OR IGNORE INTO support_knowledge_source_snapshots (
      id, knowledge_import_id, line_account_id, source_channel_id, source_thread_ts,
      raw_payload, content_hash, is_reconstructed, captured_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    input.knowledgeImportId,
    input.lineAccountId,
    input.channelId,
    input.threadTs,
    input.rawPayload,
    contentHash,
    input.reconstructed ? 1 : 0,
    input.capturedAt,
  );
}

async function recordKnowledgeSourceSnapshot(
  db: D1Database,
  input: Parameters<typeof prepareKnowledgeSourceSnapshot>[1],
) {
  await (await prepareKnowledgeSourceSnapshot(db, input)).run();
}

function manualRevisionSnapshot(row: SupportManualRow): string {
  return JSON.stringify({
    title: row.title,
    category: row.category,
    body: row.body,
    url: row.url,
    keywords: row.keywords,
    owner: row.owner,
    approvedBy: row.approved_by,
    revisedAt: row.revised_at,
    isActive: Boolean(row.is_active),
    question: row.knowledge_question ?? '',
    resolution: row.knowledge_resolution ?? '',
    procedure: row.knowledge_procedure ?? '',
    applicability: row.knowledge_applicability ?? '',
    cautions: row.knowledge_cautions ?? '',
    sourceBody: row.knowledge_source_body ?? '',
    knowledgeStatus: row.knowledge_status ?? 'needs_review',
    qualityScore: row.knowledge_quality_score ?? 0,
    reviewNote: row.knowledge_review_note ?? '',
  });
}

function prepareManualRevision(
  db: D1Database,
  row: SupportManualRow,
  changeType: string,
  staff: SupportAccessStaff,
  now: string,
) {
  return db.prepare(
    `INSERT INTO support_manual_revisions (
      id, manual_id, line_account_id, change_type, snapshot, actor_id, actor_name, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    row.id,
    row.line_account_id,
    changeType,
    manualRevisionSnapshot(row),
    staff.id,
    staff.name,
    now,
  );
}

async function recordManualRevision(
  db: D1Database,
  row: SupportManualRow,
  changeType: string,
  staff: SupportAccessStaff,
  now: string,
) {
  await prepareManualRevision(db, row, changeType, staff, now).run();
}

function clampSlackImportLimit(raw: unknown): number {
  const n = Number(raw ?? SUPPORT_SLACK_IMPORT_DEFAULT_LIMIT);
  if (!Number.isFinite(n)) return SUPPORT_SLACK_IMPORT_DEFAULT_LIMIT;
  return Math.max(1, Math.min(SUPPORT_SLACK_IMPORT_MAX_LIMIT, Math.floor(n)));
}

function clampSlackNormalizeLimit(raw: unknown): number {
  const n = Number(raw ?? 50);
  if (!Number.isFinite(n)) return 50;
  return Math.max(1, Math.min(100, Math.floor(n)));
}

function slackTsToJst(ts: string | undefined): string | null {
  if (!ts) return null;
  const seconds = Number(ts);
  if (!Number.isFinite(seconds)) return null;
  return toJstString(new Date(seconds * 1000));
}

function normalizeWhitespace(value: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeSlackText(value: string | undefined): string {
  const raw = value ?? '';
  return normalizeWhitespace(
    raw
      .replace(/<@([A-Z0-9]+)\|([^>]+)>/g, '@$2')
      .replace(/<@([A-Z0-9]+)>/g, '@$1')
      .replace(/<#([A-Z0-9]+)\|([^>]+)>/g, '#$2')
      .replace(/<([^>|]+)\|([^>]+)>/g, '$2')
      .replace(/<([^>]+)>/g, '$1')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>'),
  );
}

function maskSensitiveText(value: string): string {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[メールアドレス]')
    .replace(/\b0\d{1,4}[-\s]?\d{1,4}[-\s]?\d{3,4}\b/g, '[電話番号]');
}

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength - 1).trimEnd() + '…' : value;
}

function inferKnowledgeCategory(textValue: string): string {
  const value = textValue.toLowerCase();
  if (/税務|税金|確定申告|税務調査|契約|請求書|領収書|通帳/.test(value)) return 'tax_contract';
  if (/報酬|支払|支払い|入金|振込|売上|成果/.test(value)) return 'reward';
  if (/商品|配送|発送|返品|未着|納品|受取/.test(value)) return 'delivery';
  if (/レビュー|クレーム|返金|苦情|炎上|低評価/.test(value)) return 'claim';
  if (/権利|商標|著作|侵害|画像使用|知的財産/.test(value)) return 'rights';
  if (/通達|運営|jo|確認|案内|手続/.test(value)) return 'operation';
  return 'other';
}

function buildKnowledgeTitle(question: string): string {
  const firstLine = question
    .split('\n')
    .map((line) => line.replace(/^```|```$/g, '').trim())
    .find((line) => line && !line.startsWith('@') && !/^cc[:：\s]/i.test(line) && !/^お疲れ様です/.test(line))
    ?? 'Slack二次対応ナレッジ';
  return truncateText(firstLine || 'Slack二次対応ナレッジ', 80);
}

function buildKnowledgeKeywords(textValue: string): string {
  const words = Array.from(new Set(
    textValue
      .replace(/[^\p{Letter}\p{Number}ー一-龯ぁ-んァ-ン]+/gu, ' ')
      .split(/\s+/)
      .map((word) => word.trim())
      .filter((word) => word.length >= 2 && word.length <= 18)
      .slice(0, 20),
  ));
  return words.join(' ');
}

function buildKnowledgeBody(input: { customerInfo?: string | null; question: string; answer: string }): string {
  const blocks: string[] = [];
  const customerInfo = normalizeWhitespace(input.customerInfo ?? '');
  const question = normalizeWhitespace(input.question);
  const answer = normalizeWhitespace(input.answer);
  if (customerInfo && customerInfo !== question) blocks.push(`【顧客・案件情報】\n${customerInfo}`);
  blocks.push(`【問い合わせ内容】\n${question}`);
  blocks.push(`【解決回答】\n${answer}`);
  return truncateText(normalizeWhitespace(blocks.join('\n\n')), SUPPORT_LONG_TEXT_MAX_LENGTH);
}

function extractKnowledgeBodySection(body: string, labels: string[]): string {
  const matches = Array.from(body.matchAll(/【([^】]+)】/g));
  for (const [index, match] of matches.entries()) {
    const label = normalizeWhitespace(match[1] ?? '');
    if (!labels.includes(label)) continue;
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? body.length;
    return normalizeWhitespace(body.slice(start, end));
  }
  return '';
}

function collectSlackMentionIds(value: string): string[] {
  const ids = new Set<string>();
  for (const match of value.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]+)?>/g)) {
    if (match[1]) ids.add(match[1]);
  }
  for (const match of value.matchAll(/(^|[^A-Za-z0-9_])@([UW][A-Z0-9]{4,})\b/g)) {
    if (match[2]) ids.add(match[2]);
  }
  return Array.from(ids);
}

function replaceSlackMentionIds(value: string, displayNames: Map<string, string>): string {
  if (!value) return value;
  return normalizeWhitespace(
    value
      .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]+))?>/g, (_match, id: string, fallback: string | undefined) => {
        const name = displayNames.get(id) || fallback || id;
        return `@${name}`;
      })
      .replace(/(^|[^A-Za-z0-9_])@([UW][A-Z0-9]{4,})\b/g, (match, prefix: string, id: string) => {
        const name = displayNames.get(id);
        return name ? `${prefix}@${name}` : match;
      }),
  );
}

function applyFallbackSlackMentionNames(ids: string[], displayNames: Map<string, string>): Map<string, string> {
  const names = new Map(displayNames);
  let fallbackIndex = 1;
  for (const id of Array.from(new Set(ids)).sort()) {
    if (names.has(id)) continue;
    names.set(id, `社内メンバー${String(fallbackIndex).padStart(2, '0')}`);
    fallbackIndex += 1;
  }
  return names;
}

function slackUserDisplayName(response: SlackUserInfoResponse): string | null {
  const user = response.user;
  if (!user) return null;
  return (
    user.profile?.display_name?.trim()
    || user.profile?.real_name?.trim()
    || user.real_name?.trim()
    || user.name?.trim()
    || null
  );
}

function isSlackMessageUsable(message: SlackMessage): boolean {
  return message.type === 'message' && !message.subtype && Boolean(message.ts);
}

function cleanedSlackMessageText(message: SlackMessage): string {
  return maskSensitiveText(normalizeSlackText(message.text));
}

function isMetadataOnlySlackText(value: string): boolean {
  const withoutMentions = value.replace(/@[^\s]+/g, '').trim();
  const lines = withoutMentions.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return true;
  const hasQuestionSignal = /問い合わせ|問合せ|ご確認|確認|相談|依頼|希望|対応|至急|早急|クレーム|購入者|お客様|JOより|内容/.test(withoutMentions);
  if (hasQuestionSignal) return false;
  return lines.length <= 4 && /^\d{2,6}[\s　]*$/.test(lines[0] ?? '');
}

function questionSignalScore(value: string): number {
  let score = 0;
  if (/問い合わせ|問合せ|ご確認|確認|相談|依頼|希望|対応|至急|早急|クレーム|購入者|お客様|JOより|内容/.test(value)) score += 3;
  if (/```[\s\S]+```/.test(value)) score += 2;
  if (value.length >= 60) score += 1;
  if (isMetadataOnlySlackText(value)) score -= 4;
  if (/^@|^cc[:：\s]/i.test(value.trim())) score -= 1;
  return score;
}

function findQuestionMessage(messages: Array<{ message: SlackMessage; text: string }>) {
  const candidates = messages.filter((item) => item.text);
  if (candidates.length === 0) return null;
  const scored = candidates
    .map((item, index) => ({ ...item, originalIndex: index, score: questionSignalScore(item.text) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.originalIndex - b.originalIndex);
  if (scored[0]) return scored[0];
  return candidates.find((item) => !isMetadataOnlySlackText(item.text)) ?? candidates[0];
}

function isLowValueSlackAnswer(value: string): boolean {
  const stripped = value.replace(/@[^\s]+/g, '').replace(/cc[:：]?/gi, '').trim();
  if (!stripped) return true;
  if (stripped.length <= 8) return true;
  return /^(承知しました|承知いたしました|確認します|確認いたします|ありがとうございます|ありがとう|はい|お願いします|よろしくお願いします)[\s!！。]*$/u.test(stripped);
}

function buildKnowledgeCandidate(
  parent: SlackMessage,
  replies: SlackMessage[],
  input: { channelId: string; channelName: string | null },
): KnowledgeCandidate | null {
  const parentTs = parent.ts;
  if (!parentTs) return null;
  const rawThreadMessages = [parent, ...replies.filter((message) => message.ts !== parentTs)]
    .filter(isSlackMessageUsable)
    .map((message) => ({
      type: message.type,
      text: message.text ?? '',
      user: message.user,
      username: message.username,
      bot_id: message.bot_id,
      ts: message.ts,
      thread_ts: message.thread_ts,
    }));
  const threadMessages = rawThreadMessages
    .map((message) => ({ message, text: cleanedSlackMessageText(message) }))
    .filter((item) => item.text);
  const questionMessage = findQuestionMessage(threadMessages);
  if (!questionMessage) return null;

  const questionIndex = threadMessages.findIndex((item) => item.message.ts === questionMessage.message.ts);
  const question = questionMessage.text;
  const rawAnswerMessages = threadMessages
    .slice(Math.max(0, questionIndex + 1))
    .map((item) => item.text)
    .filter(Boolean);
  const answerMessages = rawAnswerMessages.filter((message) => !isLowValueSlackAnswer(message));
  const effectiveAnswerMessages = answerMessages.length > 0 ? answerMessages : rawAnswerMessages;
  if (!question || effectiveAnswerMessages.length === 0) return null;

  const answer = normalizeWhitespace(effectiveAnswerMessages.join('\n\n---\n\n'));
  const parentInfo = cleanedSlackMessageText(parent);
  const body = buildKnowledgeBody({
    customerInfo: parentInfo && parentInfo !== question ? parentInfo : null,
    question,
    answer,
  });
  const title = buildKnowledgeTitle(question);
  const combined = `${title}\n${question}\n${answer}`;
  return {
    sourceChannelId: input.channelId,
    sourceChannelName: input.channelName,
    sourceMessageTs: parentTs,
    sourceThreadTs: parent.thread_ts ?? parentTs,
    sourceAuthor: parent.user ?? parent.username ?? parent.bot_id ?? null,
    sourcePostedAt: slackTsToJst(parentTs),
    title,
    category: inferKnowledgeCategory(combined),
    question: truncateText(question, SUPPORT_LONG_TEXT_MAX_LENGTH),
    answer: truncateText(answer, SUPPORT_LONG_TEXT_MAX_LENGTH),
    body,
    keywords: truncateText(buildKnowledgeKeywords(combined), SUPPORT_LONG_TEXT_MAX_LENGTH),
    sourceSnapshot: JSON.stringify(rawThreadMessages),
  };
}

async function fetchSlackApi<T>(
  token: string,
  method: string,
  params: Record<string, string | number | undefined>,
): Promise<SlackApiResponse<T>> {
  const url = new URL(method, SLACK_API_BASE);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error('Slack API request failed');
  }
  return await res.json() as SlackApiResponse<T>;
}

async function resolveSlackMentionDisplayNames(token: string, ids: string[]): Promise<Map<string, string>> {
  const displayNames = new Map<string, string>();
  for (const id of Array.from(new Set(ids))) {
    try {
      const response = await fetchSlackApi<SlackUserInfoResponse>(token, 'users.info', { user: id });
      if (!response.ok) continue;
      const displayName = slackUserDisplayName(response);
      if (displayName) displayNames.set(id, displayName);
    } catch {
      continue;
    }
  }
  return displayNames;
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

function kickSupportTicketSlackNotification(c: Context<Env>, outboxId: string): void {
  const task = deliverSupportTicketSlackNotification(c.env.DB, outboxId, {
    adminPublicUrl: c.env.ADMIN_PUBLIC_URL,
    slackBotToken: c.env.SLACK_BOT_TOKEN,
    slackChannelId: c.env.SUPPORT_TICKET_SLACK_CHANNEL_ID,
    slackMentionMap: c.env.SUPPORT_TICKET_SLACK_MENTION_MAP,
  }).catch((error) => {
    console.error(`support ticket Slack dispatch error: ${supportRouteErrorKind(error)}`);
    return { sent: false, reason: 'error' };
  });
  try {
    c.executionCtx.waitUntil(task);
  } catch {
    void task;
  }
}

function canManageSupportCaseRouting(staff: SupportAccessStaff): boolean {
  return staff.role === 'owner' || staff.role === 'admin';
}

function supportStaffMatchesText(staff: SupportAccessStaff, text: string | null | undefined): boolean {
  const name = staff.name.trim();
  return Boolean(name && (text ?? '').trim() === name);
}

function parseFollowUpIntervalDays(raw: unknown): ValueResult<number> {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > 365) {
    return { ok: false, error: 'リマインド間隔は1日から365日の整数で指定してください' };
  }
  return { ok: true, value: raw };
}

function lineAccountIdFrom(c: Context<Env>, body?: Record<string, unknown>): ValueResult<string> {
  const raw = body && Object.prototype.hasOwnProperty.call(body, 'lineAccountId')
    ? body.lineAccountId
    : c.req.query('lineAccountId');
  return parseRequiredVisibleId(raw, 'lineAccountId');
}

function followUpReminderFromCaseRow(row: SupportCaseRow): SupportCaseFollowUpReminderRow | null {
  if (
    !row.followup_reminder_id
    || !row.followup_owner_name
    || !row.followup_interval_days
    || !row.followup_next_due_at
    || !row.followup_status
    || !row.followup_created_at
    || !row.followup_updated_at
    || !row.line_account_id
  ) return null;
  return {
    id: row.followup_reminder_id,
    case_id: row.id,
    line_account_id: row.line_account_id,
    owner_staff_id: row.followup_owner_staff_id ?? null,
    owner_name: row.followup_owner_name,
    interval_days: row.followup_interval_days,
    next_due_at: row.followup_next_due_at,
    status: row.followup_status,
    version: row.followup_version ?? 1,
    last_confirmed_at: row.followup_last_confirmed_at ?? null,
    last_confirmed_by: row.followup_last_confirmed_by ?? null,
    last_confirmed_name: row.followup_last_confirmed_name ?? null,
    created_by: row.followup_created_by ?? null,
    created_by_name: row.followup_created_by_name ?? null,
    created_at: row.followup_created_at,
    updated_at: row.followup_updated_at,
  };
}

function serializeCase(row: SupportCaseRow, currentStaffId?: string) {
  const followUpReminder = followUpReminderFromCaseRow(row);
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
    escalationAssignees: parseCaseAssigneeNames(row.escalation_assignees, row.escalation_assignee),
    lastHumanReplyAt: row.last_human_reply_at ?? null,
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
    followUpReminder: followUpReminder
      ? serializeSupportCaseFollowUpReminder(followUpReminder, {
          caseStatus: row.status,
          currentStaffId,
        })
      : null,
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
    reopenedFromId: row.reopened_from_id ?? null,
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
    question: row.knowledge_question ?? '',
    resolution: row.knowledge_resolution ?? '',
    procedure: row.knowledge_procedure ?? '',
    applicability: row.knowledge_applicability ?? '',
    cautions: row.knowledge_cautions ?? '',
    sourceBody: row.knowledge_source_body || row.body,
    knowledgeStatus: SUPPORT_MANUAL_KNOWLEDGE_STATUSES.has((row.knowledge_status ?? '') as KnowledgeStatus)
      ? row.knowledge_status
      : 'needs_review',
    qualityScore: Math.max(0, Math.min(100, Number(row.knowledge_quality_score ?? 0))),
    reviewNote: row.knowledge_review_note ?? '',
    useCount: Math.max(0, Number(row.knowledge_use_count ?? 0)),
    lastUsedAt: row.knowledge_last_used_at ?? null,
    helpfulCount: Math.max(0, Number(row.knowledge_helpful_count ?? 0)),
    needsImprovementCount: Math.max(0, Number(row.knowledge_needs_improvement_count ?? 0)),
  };
}

function serializeKnowledgeImport(row: SupportKnowledgeImportRow) {
  return {
    id: row.id,
    lineAccountId: row.line_account_id,
    source: row.source,
    sourceChannelId: row.source_channel_id,
    sourceChannelName: row.source_channel_name,
    sourceMessageTs: row.source_message_ts,
    sourceThreadTs: row.source_thread_ts,
    sourcePermalink: row.source_permalink,
    sourceAuthor: row.source_author,
    sourcePostedAt: row.source_posted_at,
    title: row.title,
    category: row.category,
    question: row.question,
    answer: row.answer,
    body: row.body,
    keywords: row.keywords,
    status: row.status,
    manualId: row.manual_id,
    importedBy: row.imported_by,
    reviewedBy: row.reviewed_by,
    importedAt: row.imported_at,
    reviewedAt: row.reviewed_at,
    publishedAt: row.published_at,
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

function serializeInternalMessage(
  row: SupportInternalMessageRow,
  staff: SupportAccessStaff = { id: 'system', name: 'system', role: 'staff' },
  mentionStaffIds: string[] = [],
  event?: InternalMessageEventRow,
) {
  const projected = projectInternalMessage(row, event, staff);
  return {
    id: row.id,
    caseId: row.case_id,
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

function serializeCaseAttachment(row: SupportCaseAttachmentRow) {
  return {
    id: row.id,
    caseId: row.case_id,
    lineAccountId: row.line_account_id,
    fileName: row.file_name,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    createdAt: row.created_at,
    filePath: `/api/support/cases/${encodeURIComponent(row.case_id)}/attachments/${encodeURIComponent(row.id)}/file?lineAccountId=${encodeURIComponent(row.line_account_id)}`,
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
              f.line_user_id,
              ${SUPPORT_CASE_ASSIGNEES_SELECT},
              ${SUPPORT_CASE_LAST_HUMAN_REPLY_SELECT},
              ${SUPPORT_CASE_FOLLOWUP_SELECT}
       FROM support_cases sc
       LEFT JOIN friends f ON f.id = sc.friend_id
       LEFT JOIN support_case_followup_reminders scr_followup ON scr_followup.case_id = sc.id
       WHERE ${conditions.join(' AND ')}`,
    )
    .bind(...binds)
    .first<SupportCaseRow>();
}

async function getCaseFollowUpReminder(
  db: D1Database,
  caseId: string,
  lineAccountId: string,
): Promise<SupportCaseFollowUpReminderRow | null> {
  return db
    .prepare(
      `SELECT *
       FROM support_case_followup_reminders
       WHERE case_id = ? AND line_account_id = ?`,
    )
    .bind(caseId, lineAccountId)
    .first<SupportCaseFollowUpReminderRow>();
}

function prepareFollowUpReminderEvent(
  db: D1Database,
  reminderId: string,
  caseId: string,
  action: 'configured' | 'reconfigured' | 'confirmed' | 'completed' | 'disabled',
  staff: SupportAccessStaff,
  metadata: Record<string, unknown>,
  now: string,
  eventId = crypto.randomUUID(),
) {
  return db
    .prepare(
      `INSERT OR IGNORE INTO support_case_followup_reminder_events (
        id, reminder_id, case_id, action, metadata, actor_id, actor_name, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      eventId,
      reminderId,
      caseId,
      action,
      JSON.stringify(metadata),
      staff.id,
      staff.name,
      now,
    );
}

function prepareFollowUpConfirmationEvent(
  db: D1Database,
  reminder: SupportCaseFollowUpReminderRow,
  action: 'confirmed' | 'completed',
  staff: SupportAccessStaff,
  metadata: Record<string, unknown>,
  now: string,
) {
  return db
    .prepare(
      `INSERT OR IGNORE INTO support_case_followup_reminder_events (
        id, reminder_id, case_id, action, metadata, actor_id, actor_name, created_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1
        FROM support_case_followup_reminders
        WHERE id = ? AND version = ? AND last_confirmed_at = ? AND last_confirmed_by = ?
      )`,
    )
    .bind(
      `followup-confirm:${reminder.id}:${reminder.version}`,
      reminder.id,
      reminder.case_id,
      action,
      JSON.stringify(metadata),
      staff.id,
      staff.name,
      now,
      reminder.id,
      reminder.version + 1,
      now,
      staff.id,
    );
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

async function getKnowledgeImportRow(
  db: D1Database,
  id: string,
  lineAccountId: string,
): Promise<SupportKnowledgeImportRow | null> {
  return await db
    .prepare(`SELECT * FROM support_knowledge_imports WHERE id = ? AND line_account_id = ?`)
    .bind(id, lineAccountId)
    .first<SupportKnowledgeImportRow>();
}

async function getKnowledgeImportRowBySource(
  db: D1Database,
  lineAccountId: string,
  sourceChannelId: string,
  sourceThreadTs: string,
): Promise<SupportKnowledgeImportRow | null> {
  return await db
    .prepare(
      `SELECT * FROM support_knowledge_imports
       WHERE line_account_id = ? AND source_channel_id = ? AND source_thread_ts = ?`,
    )
    .bind(lineAccountId, sourceChannelId, sourceThreadTs)
    .first<SupportKnowledgeImportRow>();
}

async function publishKnowledgeImportRow(
  db: D1Database,
  lineAccountId: string,
  row: SupportKnowledgeImportRow,
  staff: SupportAccessStaff,
  now: string,
): Promise<{ outcome: 'created' | 'already_published' | 'skipped'; manualId: string | null }> {
  if (row.status === 'dismissed') return { outcome: 'skipped', manualId: null };
  if (row.status === 'published' && row.manual_id) return { outcome: 'already_published', manualId: row.manual_id };
  if (!row.title.trim() || !row.body.trim()) return { outcome: 'skipped', manualId: null };
  const knowledge = deriveOperationalKnowledge({
    title: row.title,
    body: row.body,
    question: row.question,
    answer: row.answer,
  });
  if (knowledge.status === 'unresolved') return { outcome: 'skipped', manualId: null };

  const manualId = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO support_manuals (
        id, line_account_id, title, category, body, url, keywords, owner, approved_by,
        revised_at, is_active, created_by, updated_by, created_at, updated_at,
        knowledge_question, knowledge_resolution, knowledge_procedure,
        knowledge_applicability, knowledge_cautions, knowledge_source_body,
        knowledge_status, knowledge_quality_score, knowledge_review_note
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      manualId,
      lineAccountId,
      knowledge.title,
      row.category || 'other',
      row.body,
      row.source_permalink,
      row.keywords,
      'Slack過去ログ',
      staff.name || staff.id,
      now.slice(0, 10),
      staff.id,
      staff.id,
      now,
      now,
      knowledge.question,
      knowledge.resolution,
      knowledge.procedure,
      knowledge.applicability,
      knowledge.cautions,
      knowledge.sourceBody,
      knowledge.status,
      knowledge.qualityScore,
      knowledge.reviewNote,
    )
    .run();
  await db
    .prepare(
      `UPDATE support_knowledge_imports
       SET status = 'published',
           manual_id = ?,
           reviewed_by = ?,
           reviewed_at = ?,
           published_at = ?,
           updated_at = ?
       WHERE id = ? AND line_account_id = ?`,
    )
    .bind(manualId, staff.id, now, now, now, row.id, lineAccountId)
    .run();
  return { outcome: 'created', manualId };
}

async function upsertKnowledgeImport(
  db: D1Database,
  lineAccountId: string,
  candidate: KnowledgeCandidate,
  staff: SupportAccessStaff,
  now: string,
): Promise<'created' | 'updated' | 'skipped'> {
  const existing = await getKnowledgeImportRowBySource(
    db,
    lineAccountId,
    candidate.sourceChannelId,
    candidate.sourceThreadTs,
  );

  if (existing) {
    if (existing.status !== 'draft') return 'skipped';
    await db
      .prepare(
        `UPDATE support_knowledge_imports
         SET source_channel_name = ?,
             source_message_ts = ?,
             source_author = ?,
             source_posted_at = ?,
             title = ?,
             category = ?,
             question = ?,
             answer = ?,
             body = ?,
             keywords = ?,
             updated_at = ?
         WHERE id = ? AND line_account_id = ?`,
      )
      .bind(
        candidate.sourceChannelName,
        candidate.sourceMessageTs,
        candidate.sourceAuthor,
        candidate.sourcePostedAt,
        candidate.title,
        candidate.category,
        candidate.question,
        candidate.answer,
        candidate.body,
        candidate.keywords,
        now,
        existing.id,
        lineAccountId,
      )
      .run();
    await recordKnowledgeSourceSnapshot(db, {
      knowledgeImportId: existing.id,
      lineAccountId,
      channelId: candidate.sourceChannelId,
      threadTs: candidate.sourceThreadTs,
      rawPayload: candidate.sourceSnapshot,
      reconstructed: false,
      capturedAt: now,
    });
    return 'updated';
  }

  const knowledgeImportId = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO support_knowledge_imports (
        id, line_account_id, source, source_channel_id, source_channel_name,
        source_message_ts, source_thread_ts, source_permalink, source_author, source_posted_at,
        title, category, question, answer, body, keywords, status, manual_id,
        imported_by, reviewed_by, imported_at, reviewed_at, published_at, created_at, updated_at
      ) VALUES (?, ?, 'slack', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', NULL, ?, NULL, ?, NULL, NULL, ?, ?)`,
    )
    .bind(
      knowledgeImportId,
      lineAccountId,
      candidate.sourceChannelId,
      candidate.sourceChannelName,
      candidate.sourceMessageTs,
      candidate.sourceThreadTs,
      null,
      candidate.sourceAuthor,
      candidate.sourcePostedAt,
      candidate.title,
      candidate.category,
      candidate.question,
      candidate.answer,
      candidate.body,
      candidate.keywords,
      staff.id,
      now,
      now,
      now,
    )
    .run();
  await recordKnowledgeSourceSnapshot(db, {
    knowledgeImportId,
    lineAccountId,
    channelId: candidate.sourceChannelId,
    threadTs: candidate.sourceThreadTs,
    rawPayload: candidate.sourceSnapshot,
    reconstructed: false,
    capturedAt: now,
  });
  return 'created';
}

function prepareCaseEvent(
  db: D1Database,
  caseId: string,
  eventType: string,
  actorId: string | null,
  actorName: string | null,
  body = '',
  metadata: Record<string, unknown> = {},
  id = crypto.randomUUID(),
  createdAt = jstNow(),
) {
  return db
    .prepare(
      `INSERT INTO support_case_events
       (id, case_id, event_type, actor_id, actor_name, body, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      caseId,
      eventType,
      actorId,
      actorName,
      body,
      JSON.stringify(metadata),
      createdAt,
    );
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
  await prepareCaseEvent(db, caseId, eventType, actorId, actorName, body, metadata).run();
}

async function createSupportCaseWithRetry(
  db: D1Database,
  prepareStatements: () => D1PreparedStatement[],
) {
  let lastError: unknown;
  let attempts = 0;
  const maxAttempts = SUPPORT_CASE_CREATE_RETRY_DELAYS_MS.length + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attempts = attempt;
    try {
      await db.batch(prepareStatements());
      return;
    } catch (err) {
      lastError = err;
      const code = supportRouteErrorCode(err);
      const retryable = SUPPORT_CASE_CREATE_RETRYABLE_CODES.has(code);
      if (!retryable || attempt >= maxAttempts) break;
      console.warn(`[support_case_create] retry attempt=${attempt} code=${code}`);
      const baseDelay = SUPPORT_CASE_CREATE_RETRY_DELAYS_MS[attempt - 1];
      const randomBytes = new Uint16Array(1);
      crypto.getRandomValues(randomBytes);
      const jitter = 0.75 + ((randomBytes[0] ?? 0) / 65_535) * 0.5;
      await new Promise((resolve) => setTimeout(resolve, Math.round(baseDelay * jitter)));
    }
  }
  throw new SupportCaseCreateError(lastError, attempts);
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
    const dueSoonAt = toJstString(new Date(Date.now() + 4 * 60 * 60 * 1000));
    const staff = currentStaff(c);
    const myEscalationName = supportStaffAssignmentName(staff);
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
          SUM(CASE WHEN sc.status IN ('open', 'in_progress', 'waiting_primary', 'on_hold', 'reopened') THEN 1 ELSE 0 END) AS primary_action,
          SUM(CASE WHEN sc.status IN ('escalated', 'waiting_secondary') THEN 1 ELSE 0 END) AS escalated,
          SUM(CASE WHEN sc.status = 'secondary_answered' THEN 1 ELSE 0 END) AS secondary_answered,
          SUM(CASE WHEN sc.status != 'resolved'
            AND (
              sc.escalation_assignee = ?
              OR EXISTS (
                SELECT 1
                FROM support_escalations se
                WHERE se.case_id = sc.id
                  AND se.status != 'closed'
                  AND se.assignee = ?
              )
            )
            THEN 1 ELSE 0 END) AS my_escalations,
          SUM(CASE WHEN sc.due_at IS NOT NULL AND sc.due_at < ? AND sc.status != 'resolved' THEN 1 ELSE 0 END) AS overdue,
          SUM(CASE WHEN sc.priority = 'urgent' AND sc.status != 'resolved' THEN 1 ELSE 0 END) AS urgent,
          SUM(CASE WHEN sc.due_at IS NOT NULL AND sc.due_at >= ? AND sc.due_at <= ? AND sc.status != 'resolved' THEN 1 ELSE 0 END) AS due_soon,
          SUM(CASE WHEN (sc.primary_assignee IS NULL OR sc.primary_assignee = '') AND sc.status != 'resolved' THEN 1 ELSE 0 END) AS unassigned,
          SUM(CASE WHEN sc.status = 'customer_reply' THEN 1 ELSE 0 END) AS waiting_customer,
          SUM(CASE WHEN sc.status = 'resolved' THEN 1 ELSE 0 END) AS resolved
         FROM support_cases sc
         WHERE ${caseWhere.join(' AND ')}`,
      )
      .bind(myEscalationName, myEscalationName, now, now, dueSoonAt, ...caseBinds)
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
          primaryAction: totals?.primary_action ?? 0,
          escalated: totals?.escalated ?? 0,
          secondaryAnswered: totals?.secondary_answered ?? 0,
          myEscalations: totals?.my_escalations ?? 0,
          overdue: totals?.overdue ?? 0,
          urgent: totals?.urgent ?? 0,
          dueSoon: totals?.due_soon ?? 0,
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
    } else if (queue.value === 'secondary_answered') {
      conditions.push(`sc.status = 'secondary_answered'`);
    } else if (queue.value === 'primary_action') {
      conditions.push(`sc.status IN ('open', 'in_progress', 'waiting_primary', 'on_hold', 'reopened')`);
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
      const assignmentName = supportStaffAssignmentName(staff);
      conditions.push(`sc.status != 'resolved' AND (
        sc.escalation_assignee = ?
        OR EXISTS (
          SELECT 1
          FROM support_escalations se
          WHERE se.case_id = sc.id
            AND se.status != 'closed'
            AND se.assignee = ?
        )
      )`);
      binds.push(assignmentName, assignmentName);
    }

    if (assignee.value) {
      conditions.push(`(sc.primary_assignee LIKE ? OR sc.escalation_assignee LIKE ? OR EXISTS (
        SELECT 1 FROM support_escalations se_assignee_filter
        WHERE se_assignee_filter.case_id = sc.id
          AND se_assignee_filter.status != 'closed'
          AND se_assignee_filter.assignee LIKE ?
      ))`);
      binds.push(`%${assignee.value}%`, `%${assignee.value}%`, `%${assignee.value}%`);
    }
    if (escalationAssignee.value) {
      conditions.push(`(sc.escalation_assignee LIKE ? OR EXISTS (
        SELECT 1 FROM support_escalations se_secondary_filter
        WHERE se_secondary_filter.case_id = sc.id
          AND se_secondary_filter.status != 'closed'
          AND se_secondary_filter.assignee LIKE ?
      ))`);
      binds.push(`%${escalationAssignee.value}%`, `%${escalationAssignee.value}%`);
    }

    if (q.value) {
      const pattern = `%${q.value}%`;
      conditions.push(
        `(sc.title LIKE ? OR sc.customer_summary LIKE ? OR sc.internal_note LIKE ? OR
          sc.customer_number LIKE ? OR sc.company_name LIKE ? OR sc.contact_name LIKE ? OR sc.store_name LIKE ? OR
          f.display_name LIKE ?)`,
      );
      binds.push(pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern);
    }

    const sql = `
      SELECT sc.*,
             f.display_name AS friend_name,
             f.picture_url AS friend_picture_url,
             f.line_user_id,
             ${SUPPORT_CASE_ASSIGNEES_SELECT},
             ${SUPPORT_CASE_LAST_HUMAN_REPLY_SELECT},
             ${SUPPORT_CASE_FOLLOWUP_SELECT}
      FROM support_cases sc
      LEFT JOIN friends f ON f.id = sc.friend_id
      LEFT JOIN support_case_followup_reminders scr_followup ON scr_followup.case_id = sc.id
      WHERE ${conditions.join(' AND ')}
      ORDER BY
        CASE sc.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
        CASE WHEN sc.due_at IS NULL THEN 1 ELSE 0 END,
        sc.due_at ASC,
        sc.updated_at DESC
      LIMIT ? OFFSET ?`;
    const result = await c.env.DB.prepare(sql).bind(...binds, limit, offset).all<SupportCaseRow>();
    return c.json({ success: true, data: result.results.map((row) => serializeCase(row, staff.id)) });
  } catch (err) {
    console.error(`GET /api/support/cases error: ${supportRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

support.post('/api/support/cases', async (c) => {
  let failurePhase = 'validation';
  try {
    const parsedBody = await readJsonRecord(c);
    if (!parsedBody.ok) return c.json({ success: false, error: parsedBody.error }, 400);
    const body = parsedBody.value;
    const parsedFriendId = parseOptionalVisibleId(body.friendId, 'friendId');
    if (!parsedFriendId.ok) return c.json({ success: false, error: parsedFriendId.error }, 400);
    // D1 bind values cannot contain undefined; manual tickets intentionally store SQL NULL.
    const friendId = parsedFriendId.value ?? null;
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
    if (isSecondaryOnlySupportStaff(staff)) {
      return c.json({ success: false, error: '二次対応専用権限ではチケットを作成できません' }, 403);
    }

    const parsedCategory = parseOptionalTextField(body.category, 'category');
    if (!parsedCategory.ok) return c.json({ success: false, error: parsedCategory.error }, 400);
    const parsedPriority = parseOptionalTextField(body.priority, 'priority');
    if (!parsedPriority.ok) return c.json({ success: false, error: parsedPriority.error }, 400);
    const parsedStatus = parseOptionalTextField(body.status, 'status');
    if (!parsedStatus.ok) return c.json({ success: false, error: parsedStatus.error }, 400);
    const category = parsedCategory.value ?? 'other';
    const priority = parsedPriority.value ?? 'medium';
    let status = parsedStatus.value ?? 'open';
    if (!PRIORITIES.has(priority)) return c.json({ success: false, error: 'invalid priority' }, 400);
    if (!CASE_STATUSES.has(status)) return c.json({ success: false, error: 'invalid status' }, 400);

    const parsedCustomerSummary = parseOptionalTextField(body.customerSummary, 'customerSummary', SUPPORT_LONG_TEXT_MAX_LENGTH);
    if (!parsedCustomerSummary.ok) return c.json({ success: false, error: parsedCustomerSummary.error }, 400);
    const customerSummary = parsedCustomerSummary.value ?? '';
    if (!friendId && !customerSummary.trim()) {
      return c.json({ success: false, error: 'LINE会話を選ぶか、問い合わせ内容を入力してください。' }, 400);
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
    const parsedEscalationAssignees = parseSecondaryAssigneeNames(body.escalationAssignees, body.escalationAssignee);
    if (!parsedEscalationAssignees.ok) return c.json({ success: false, error: parsedEscalationAssignees.error }, 400);
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
    const escalationAssignees = parsedEscalationAssignees.value;
    const escalationAssignee = escalationAssignees[0] ?? null;
    const assigneeStaffIds = await activeStaffIdsByName(c.env.DB, escalationAssignees);
    if (body.escalationAssignees !== undefined) {
      const missing = escalationAssignees.filter((name) => !assigneeStaffIds.has(name));
      if (missing.length > 0) {
        return c.json({ success: false, error: `選択できない二次対応先が含まれています: ${missing.join('、')}` }, 400);
      }
    }
    const escalationLevel = parsedEscalationLevel.value ?? 'L2';
    if (escalationAssignees.length > 0 && !ESCALATION_LEVELS.has(escalationLevel)) {
      return c.json({ success: false, error: 'invalid level' }, 400);
    }
    if (escalationAssignees.length > 0 && status === 'open') status = 'waiting_secondary';
    const createdEventId = crypto.randomUUID();
    const slackOutboxId = escalationAssignees.length > 0 ? crypto.randomUUID() : null;
    const effectiveEscalationLevel = escalationLevel === 'L1' ? 'L2' : escalationLevel;
    const question = customerSummary.trim() || title;
    const escalationEntries = escalationAssignees.map((assignee) => ({
      assignee,
      assigneeStaffId: assigneeStaffIds.get(assignee) ?? null,
      escalationId: crypto.randomUUID(),
      eventId: crypto.randomUUID(),
    }));

    failurePhase = 'database_write';
    await createSupportCaseWithRetry(c.env.DB, () => {
      const statements: D1PreparedStatement[] = [
        c.env.DB
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
            escalationAssignee,
            escalationLevel,
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
          ),
        prepareCaseEvent(
          c.env.DB,
          id,
          'created',
          staff.id,
          staff.name,
          'チケットを作成しました',
          { status, priority, category, friendId },
          createdEventId,
          now,
        ),
      ];
      for (const entry of escalationEntries) {
        statements.push(
          c.env.DB
            .prepare(
              `INSERT INTO support_escalations (
                id, case_id, line_account_id, assignee, assignee_staff_id, level, status, question, answer,
                due_at, answered_at, created_by, updated_by, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, '', ?, NULL, ?, ?, ?, ?)`,
            )
            .bind(
              entry.escalationId,
              id,
              lineAccountId,
              entry.assignee,
              entry.assigneeStaffId,
              effectiveEscalationLevel,
              question,
              parsedDueAt.value,
              staff.id,
              staff.id,
              now,
              now,
            ),
          prepareCaseEvent(
            c.env.DB,
            id,
            'escalated',
            staff.id,
            staff.name,
            question,
            {
              escalationId: entry.escalationId,
              assignee: entry.assignee,
              assigneeStaffId: entry.assigneeStaffId,
              level: effectiveEscalationLevel,
              dueAt: parsedDueAt.value,
              createdFrom: 'case_create',
            },
            entry.eventId,
            now,
          ),
        );
      }
      if (slackOutboxId) {
        statements.push(
          c.env.DB
            .prepare(
              `INSERT INTO support_slack_notification_outbox (
                id, case_id, line_account_id, notification_type, payload, status,
                attempts, next_attempt_at, created_at, updated_at
              ) VALUES (?, ?, ?, 'ticket_created', ?, 'pending', 0, ?, ?, ?)`,
            )
            .bind(
              slackOutboxId,
              id,
              lineAccountId,
              JSON.stringify({
                caseId: id,
                title,
                priority,
                primaryAssignee: parsedPrimaryAssignee.value ?? staff.name,
                secondaryAssignees: escalationEntries.map((entry) => ({
                  name: entry.assignee,
                  staffId: entry.assigneeStaffId,
                })),
                customerSummary: question,
                customerNumber: parsedCustomerNumber.value ?? null,
                companyName: parsedCompanyName.value ?? null,
                contactName: parsedContactName.value ?? null,
                dueAt: parsedDueAt.value ?? null,
              }),
              now,
              now,
              now,
            ),
        );
      }
      return statements;
    });
    failurePhase = 'notifications';
    if (slackOutboxId) {
      kickSupportTicketSlackNotification(c, slackOutboxId);
    }
    if (priority === 'urgent' && status !== 'resolved' && !slackOutboxId) {
      c.executionCtx.waitUntil(notifyUrgentSupportCase(c.env.DB, lineAccountId, id, {
        adminPublicUrl: c.env.ADMIN_PUBLIC_URL,
      }));
    }
    kickWebPushNotifications(c);

    failurePhase = 'database_readback';
    const created = await getCaseRow(c.env.DB, id, lineAccountId, staff);
    if (!created) throw new Error('Created support case could not be read back');
    return c.json({ success: true, data: serializeCase(created) }, 201);
  } catch (err) {
    const errorKind = supportRouteErrorKind(err);
    const errorCode = supportRouteErrorCode(err);
    const diagnosticId = persistSupportCaseCreateFailure(c, {
      phase: failurePhase,
      code: errorCode,
      kind: errorKind,
      attempts: err instanceof SupportCaseCreateError ? err.attempts : undefined,
    });
    console.error(
      `POST /api/support/cases error: ${errorKind} phase=${failurePhase} code=${errorCode} diagnostic=${diagnosticId}`,
    );
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

support.post('/api/support/notifications/slack/test-ticket', requireRole('owner', 'admin'), async (c) => {
  try {
    const parsedBody = await readJsonRecord(c);
    if (!parsedBody.ok) return c.json({ success: false, error: parsedBody.error }, 400);
    const mentionStaffName = parseOptionalTextField(parsedBody.value.mentionStaffName, 'mentionStaffName');
    if (!mentionStaffName.ok) return c.json({ success: false, error: mentionStaffName.error }, 400);
    const staffName = mentionStaffName.value ?? currentStaff(c).name;
    const result = await sendSupportTicketSlackTestNotification({
      adminPublicUrl: c.env.ADMIN_PUBLIC_URL,
      slackBotToken: c.env.SLACK_BOT_TOKEN,
      slackChannelId: c.env.SUPPORT_TICKET_SLACK_CHANNEL_ID,
      slackMentionMap: c.env.SUPPORT_TICKET_SLACK_MENTION_MAP,
    }, staffName);
    if (!result.sent) {
      return c.json({ success: false, error: result.reason }, 503);
    }
    return c.json({ success: true, data: { sent: true, messageTs: result.messageTs ?? null } });
  } catch (err) {
    console.error(`POST /api/support/notifications/slack/test-ticket error: ${supportRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

support.get('/api/support/notifications/slack/status', requireRole('owner', 'admin'), async (c) => {
  try {
    const health = await getSupportTicketSlackNotificationHealth(c.env.DB);
    return c.json({
      success: true,
      data: {
        ...health,
        tokenConfigured: Boolean(c.env.SLACK_BOT_TOKEN?.trim()),
        channelConfigured: Boolean(c.env.SUPPORT_TICKET_SLACK_CHANNEL_ID?.trim()),
      },
    });
  } catch (err) {
    console.error(`GET /api/support/notifications/slack/status error: ${supportRouteErrorKind(err)}`);
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

    const staff = currentStaff(c);
    const [events, escalations, internalMessages, attachments] = await Promise.all([
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
      c.env.DB.prepare(
        `SELECT *
         FROM support_internal_messages
         WHERE case_id = ? AND line_account_id = ?
         ORDER BY created_at ASC
         LIMIT 300`,
      ).bind(row.id, lineAccountId.value).all<SupportInternalMessageRow>(),
      c.env.DB.prepare(
        `SELECT *
         FROM support_case_attachments
         WHERE case_id = ? AND line_account_id = ?
         ORDER BY created_at ASC`,
      ).bind(row.id, lineAccountId.value).all<SupportCaseAttachmentRow>(),
    ]);

    const canViewLineConversation = !isSecondaryOnlySupportStaff(staff);
    const [internalMessageMentionIds, internalMessageEvents] = await Promise.all([
      mentionStaffIdsForMessages(
        c.env.DB,
        'support',
        internalMessages.results.map((message) => message.id),
      ),
      latestInternalMessageEvents(
        c.env.DB,
        'support',
        internalMessages.results.map((message) => message.id),
      ),
    ]);
    const messages = row.friend_id && canViewLineConversation
      ? await c.env.DB.prepare(
        `SELECT id, direction, message_type, content, source, created_at
         FROM messages_log
         WHERE friend_id = ? AND (delivery_type IS NULL OR delivery_type != 'test')
         ORDER BY created_at DESC LIMIT 50`,
      ).bind(row.friend_id).all<{ id: string; direction: string; message_type: string; content: string; source: string | null; created_at: string }>()
      : { results: [] as Array<{ id: string; direction: string; message_type: string; content: string; source: string | null; created_at: string }> };

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
        ...serializeCase(row, staff.id),
        events: events.results.map(serializeEvent),
        escalations: escalations.results.map(serializeEscalation),
        internalMessages: internalMessages.results.map((message) => serializeInternalMessage(
          message,
          staff,
          internalMessageMentionIds.get(message.id) ?? [],
          internalMessageEvents.get(message.id),
        )),
        attachments: attachments.results.map(serializeCaseAttachment),
        manuals: manuals.map(serializeManual),
        canViewLineConversation,
        recentMessages: [...messages.results].reverse().map((m) => ({
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
    console.error(`GET /api/support/cases/:id error: ${supportRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

support.post('/api/support/cases/:id/attachments', async (c) => {
  try {
    const caseId = parseRequiredVisibleId(c.req.param('id'), 'caseId');
    if (!caseId.ok) return c.json({ success: false, error: caseId.error }, 400);
    const lineAccountId = lineAccountIdFrom(c);
    if (!lineAccountId.ok) return c.json({ success: false, error: lineAccountId.error }, 400);
    const staff = currentStaff(c);
    const supportCase = await getCaseRow(c.env.DB, caseId.value, lineAccountId.value, staff);
    if (!supportCase) return c.json({ success: false, error: 'case not found' }, 404);

    const currentCount = await c.env.DB
      .prepare(`SELECT COUNT(*) AS count FROM support_case_attachments WHERE case_id = ? AND line_account_id = ?`)
      .bind(caseId.value, lineAccountId.value)
      .first<{ count: number }>();
    if ((currentCount?.count ?? 0) >= SUPPORT_ATTACHMENT_MAX_COUNT) {
      return c.json({ success: false, error: `画像は1チケットにつき${SUPPORT_ATTACHMENT_MAX_COUNT}枚まで添付できます` }, 400);
    }

    const contentType = (c.req.header('Content-Type') || '').split(';')[0].trim().toLowerCase();
    if (!SUPPORT_ATTACHMENT_MIME_TYPES.has(contentType)) {
      return c.json({ success: false, error: 'PNG JPEG WebP の画像を選択してください' }, 400);
    }
    const filename = parseAttachmentFilename(c.req.header('X-File-Name'));
    if (!filename.ok) return c.json({ success: false, error: filename.error }, 400);
    const declaredSize = Number(c.req.header('Content-Length') || 0);
    if (Number.isFinite(declaredSize) && declaredSize > SUPPORT_ATTACHMENT_MAX_BYTES) {
      return c.json({ success: false, error: '画像は1枚10MB以下にしてください' }, 400);
    }

    const data = await c.req.arrayBuffer();
    if (data.byteLength === 0) return c.json({ success: false, error: '画像ファイルが空です' }, 400);
    if (data.byteLength > SUPPORT_ATTACHMENT_MAX_BYTES) {
      return c.json({ success: false, error: '画像は1枚10MB以下にしてください' }, 400);
    }
    const bytes = new Uint8Array(data);
    if (!validateAttachmentBytes(bytes, contentType)) {
      return c.json({ success: false, error: '画像の形式を確認できませんでした' }, 400);
    }

    const attachmentId = crypto.randomUUID();
    const now = jstNow();
    const r2Key = `support/cases/${safeR2Segment(lineAccountId.value)}/${safeR2Segment(caseId.value)}/${attachmentId}.${attachmentExtension(contentType)}`;
    await c.env.IMAGES.put(r2Key, data, {
      httpMetadata: { contentType },
      customMetadata: { originalFilename: filename.value },
    });
    try {
      await c.env.DB
        .prepare(
          `INSERT INTO support_case_attachments (
            id, case_id, line_account_id, r2_key, file_name, content_type, size_bytes,
            created_by, created_by_name, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          attachmentId,
          caseId.value,
          lineAccountId.value,
          r2Key,
          filename.value,
          contentType,
          data.byteLength,
          staff.id,
          staff.name,
          now,
        )
        .run();
    } catch (err) {
      await c.env.IMAGES.delete(r2Key).catch(() => undefined);
      throw err;
    }

    const created = await c.env.DB
      .prepare(`SELECT * FROM support_case_attachments WHERE id = ? AND case_id = ?`)
      .bind(attachmentId, caseId.value)
      .first<SupportCaseAttachmentRow>();
    return c.json({ success: true, data: serializeCaseAttachment(created!) }, 201);
  } catch (err) {
    console.error(`POST /api/support/cases/:id/attachments error: ${supportRouteErrorKind(err)}`);
    return c.json({ success: false, error: '画像の添付に失敗しました' }, 500);
  }
});

support.get('/api/support/cases/:id/attachments/:attachmentId/file', async (c) => {
  try {
    const caseId = parseRequiredVisibleId(c.req.param('id'), 'caseId');
    if (!caseId.ok) return c.json({ success: false, error: caseId.error }, 400);
    const attachmentId = parseRequiredVisibleId(c.req.param('attachmentId'), 'attachmentId');
    if (!attachmentId.ok) return c.json({ success: false, error: attachmentId.error }, 400);
    const lineAccountId = lineAccountIdFrom(c);
    if (!lineAccountId.ok) return c.json({ success: false, error: lineAccountId.error }, 400);
    const supportCase = await getCaseRow(c.env.DB, caseId.value, lineAccountId.value, currentStaff(c));
    if (!supportCase) return c.json({ success: false, error: 'case not found' }, 404);
    const attachment = await c.env.DB
      .prepare(`SELECT * FROM support_case_attachments WHERE id = ? AND case_id = ? AND line_account_id = ?`)
      .bind(attachmentId.value, caseId.value, lineAccountId.value)
      .first<SupportCaseAttachmentRow>();
    if (!attachment) return c.json({ success: false, error: 'attachment not found' }, 404);
    const object = await c.env.IMAGES.get(attachment.r2_key);
    if (!object) return c.json({ success: false, error: 'attachment not found' }, 404);
    const headers = new Headers({
      'Content-Type': attachment.content_type,
      'Content-Disposition': attachmentContentDisposition(attachment.file_name),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    return new Response(object.body, { headers });
  } catch (err) {
    console.error(`GET /api/support/cases/:id/attachments/:attachmentId/file error: ${supportRouteErrorKind(err)}`);
    return c.json({ success: false, error: '画像の取得に失敗しました' }, 500);
  }
});

support.put('/api/support/cases/:id/follow-up-reminder', async (c) => {
  try {
    const caseId = parseRequiredVisibleId(c.req.param('id'), 'caseId');
    if (!caseId.ok) return c.json({ success: false, error: caseId.error }, 400);
    const parsedBody = await readJsonRecord(c);
    if (!parsedBody.ok) return c.json({ success: false, error: parsedBody.error }, 400);
    const body = parsedBody.value;
    const lineAccountId = lineAccountIdFrom(c, body);
    if (!lineAccountId.ok) return c.json({ success: false, error: lineAccountId.error }, 400);
    const intervalDays = parseFollowUpIntervalDays(body.intervalDays);
    if (!intervalDays.ok) return c.json({ success: false, error: intervalDays.error }, 400);
    const staff = currentStaff(c);
    const supportCase = await getCaseRow(c.env.DB, caseId.value, lineAccountId.value, staff);
    if (!supportCase) return c.json({ success: false, error: 'case not found' }, 404);
    if (!canManageSupportCaseRouting(staff) && !supportStaffMatchesText(staff, supportCase.primary_assignee)) {
      return c.json({ success: false, error: 'リマインドを設定できるのは一次対応者または管理者です' }, 403);
    }
    const primaryAssignee = supportCase.primary_assignee?.trim() ?? '';
    if (!primaryAssignee) {
      return c.json({ success: false, error: '先に一次対応者を設定してください' }, 400);
    }
    const staffIds = await activeStaffIdsByName(c.env.DB, [primaryAssignee]);
    const ownerStaffId = staffIds.get(primaryAssignee);
    if (!ownerStaffId) {
      return c.json({ success: false, error: '一次対応者を在籍中のスタッフから選択してください' }, 400);
    }

    const existing = await getCaseFollowUpReminder(c.env.DB, caseId.value, lineAccountId.value);
    const reminderId = existing?.id ?? crypto.randomUUID();
    const now = jstNow();
    const preservePendingConfirmation = existing
      ? isFollowUpReminderDue(existing, supportCase.status, new Date(now))
      : false;
    const nextDueAt = preservePendingConfirmation
      ? existing!.next_due_at
      : nextFollowUpDueAt(intervalDays.value, new Date(now));
    const statements: D1PreparedStatement[] = [];
    if (existing) {
      statements.push(
        c.env.DB
          .prepare(
            `UPDATE support_case_followup_reminders
             SET owner_staff_id = ?, owner_name = ?, interval_days = ?, next_due_at = ?,
                 status = 'active', version = version + 1, updated_at = ?
             WHERE id = ? AND case_id = ? AND line_account_id = ?`,
          )
          .bind(
            ownerStaffId,
            primaryAssignee,
            intervalDays.value,
            nextDueAt,
            now,
            reminderId,
            caseId.value,
            lineAccountId.value,
          ),
      );
    } else {
      statements.push(
        c.env.DB
          .prepare(
            `INSERT INTO support_case_followup_reminders (
              id, case_id, line_account_id, owner_staff_id, owner_name, interval_days,
              next_due_at, status, created_by, created_by_name, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
          )
          .bind(
            reminderId,
            caseId.value,
            lineAccountId.value,
            ownerStaffId,
            primaryAssignee,
            intervalDays.value,
            nextDueAt,
            staff.id,
            staff.name,
            now,
            now,
          ),
      );
    }
    statements.push(
      prepareFollowUpReminderEvent(
        c.env.DB,
        reminderId,
        caseId.value,
        existing ? 'reconfigured' : 'configured',
        staff,
        {
          intervalDays: intervalDays.value,
          nextDueAt,
          ownerStaffId,
          ownerName: primaryAssignee,
          previousIntervalDays: existing?.interval_days ?? null,
          previousOwnerStaffId: existing?.owner_staff_id ?? null,
          preservedPendingConfirmation: preservePendingConfirmation,
        },
        now,
      ),
    );
    await c.env.DB.batch(statements);
    const updated = await getCaseFollowUpReminder(c.env.DB, caseId.value, lineAccountId.value);
    return c.json({
      success: true,
      data: serializeSupportCaseFollowUpReminder(updated!, {
        caseStatus: supportCase.status,
        currentStaffId: staff.id,
      }),
    });
  } catch (err) {
    console.error(`PUT /api/support/cases/:id/follow-up-reminder error: ${supportRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'リマインドの設定に失敗しました' }, 500);
  }
});

support.post('/api/support/cases/:id/follow-up-reminder/confirm', async (c) => {
  try {
    const caseId = parseRequiredVisibleId(c.req.param('id'), 'caseId');
    if (!caseId.ok) return c.json({ success: false, error: caseId.error }, 400);
    const parsedBody = await readJsonRecord(c);
    if (!parsedBody.ok) return c.json({ success: false, error: parsedBody.error }, 400);
    const lineAccountId = lineAccountIdFrom(c, parsedBody.value);
    if (!lineAccountId.ok) return c.json({ success: false, error: lineAccountId.error }, 400);
    const staff = currentStaff(c);
    const supportCase = await getCaseRow(c.env.DB, caseId.value, lineAccountId.value, staff);
    if (!supportCase) return c.json({ success: false, error: 'case not found' }, 404);
    const reminder = await getCaseFollowUpReminder(c.env.DB, caseId.value, lineAccountId.value);
    if (!reminder) return c.json({ success: false, error: 'リマインドが設定されていません' }, 404);
    if (reminder.owner_staff_id !== staff.id) {
      return c.json({ success: false, error: '確認できるのは一次対応者本人だけです' }, 403);
    }
    if (reminder.status !== 'active') {
      return c.json({ success: false, error: 'このリマインドは終了しています' }, 400);
    }

    const now = jstNow();
    if (!isFollowUpReminderDue(reminder, supportCase.status, new Date(now))) {
      return c.json({ success: false, error: 'まだ確認予定日になっていません' }, 400);
    }
    const completed = supportCase.status === 'resolved';
    const nextDueAt = completed
      ? reminder.next_due_at
      : nextFollowUpDueAt(reminder.interval_days, new Date(now));
    await c.env.DB.batch([
      c.env.DB
        .prepare(
          `UPDATE support_case_followup_reminders
           SET status = ?, next_due_at = ?, last_confirmed_at = ?, last_confirmed_by = ?,
               last_confirmed_name = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND owner_staff_id = ? AND status = 'active' AND version = ?`,
        )
        .bind(
          completed ? 'completed' : 'active',
          nextDueAt,
          now,
          staff.id,
          staff.name,
          now,
          reminder.id,
          staff.id,
          reminder.version,
        ),
      prepareFollowUpConfirmationEvent(
        c.env.DB,
        reminder,
        completed ? 'completed' : 'confirmed',
        staff,
        { caseStatus: supportCase.status, nextDueAt, intervalDays: reminder.interval_days },
        now,
      ),
      c.env.DB
        .prepare(
          `UPDATE app_notification_inbox
           SET dismissed_at = ?, updated_at = ?
           WHERE recipient_staff_id = ? AND line_account_id = ?
             AND notification_key LIKE ?`,
        )
        .bind(now, now, staff.id, lineAccountId.value, `case_followup:${reminder.id}:%`),
    ]);
    const updated = await getCaseFollowUpReminder(c.env.DB, caseId.value, lineAccountId.value);
    if (!updated || updated.last_confirmed_at !== now || updated.last_confirmed_by !== staff.id) {
      return c.json({ success: false, error: '他の操作が先に反映されました 最新状態を確認してください' }, 409);
    }
    return c.json({
      success: true,
      data: serializeSupportCaseFollowUpReminder(updated!, {
        caseStatus: supportCase.status,
        currentStaffId: staff.id,
      }),
    });
  } catch (err) {
    console.error(`POST /api/support/cases/:id/follow-up-reminder/confirm error: ${supportRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'リマインドの確認に失敗しました' }, 500);
  }
});

support.post('/api/support/cases/:id/follow-up-reminder/disable', async (c) => {
  try {
    const caseId = parseRequiredVisibleId(c.req.param('id'), 'caseId');
    if (!caseId.ok) return c.json({ success: false, error: caseId.error }, 400);
    const parsedBody = await readJsonRecord(c);
    if (!parsedBody.ok) return c.json({ success: false, error: parsedBody.error }, 400);
    const lineAccountId = lineAccountIdFrom(c, parsedBody.value);
    if (!lineAccountId.ok) return c.json({ success: false, error: lineAccountId.error }, 400);
    const staff = currentStaff(c);
    const supportCase = await getCaseRow(c.env.DB, caseId.value, lineAccountId.value, staff);
    if (!supportCase) return c.json({ success: false, error: 'case not found' }, 404);
    const reminder = await getCaseFollowUpReminder(c.env.DB, caseId.value, lineAccountId.value);
    if (!reminder) return c.json({ success: false, error: 'リマインドが設定されていません' }, 404);
    if (!canManageSupportCaseRouting(staff) && reminder.owner_staff_id !== staff.id) {
      return c.json({ success: false, error: 'リマインドを停止できるのは一次対応者または管理者です' }, 403);
    }
    if (reminder.status === 'disabled') {
      return c.json({
        success: true,
        data: serializeSupportCaseFollowUpReminder(reminder, {
          caseStatus: supportCase.status,
          currentStaffId: staff.id,
        }),
      });
    }
    const now = jstNow();
    await c.env.DB.batch([
      c.env.DB
        .prepare(
          `UPDATE support_case_followup_reminders
           SET status = 'disabled', version = version + 1, updated_at = ?
           WHERE id = ? AND case_id = ? AND line_account_id = ?`,
        )
        .bind(now, reminder.id, caseId.value, lineAccountId.value),
      prepareFollowUpReminderEvent(
        c.env.DB,
        reminder.id,
        caseId.value,
        'disabled',
        staff,
        { intervalDays: reminder.interval_days, nextDueAt: reminder.next_due_at },
        now,
      ),
      c.env.DB
        .prepare(
          `UPDATE app_notification_inbox
           SET dismissed_at = ?, updated_at = ?
           WHERE recipient_staff_id = ? AND line_account_id = ?
             AND notification_key LIKE ?`,
        )
        .bind(now, now, reminder.owner_staff_id, lineAccountId.value, `case_followup:${reminder.id}:%`),
    ]);
    const updated = await getCaseFollowUpReminder(c.env.DB, caseId.value, lineAccountId.value);
    return c.json({
      success: true,
      data: serializeSupportCaseFollowUpReminder(updated!, {
        caseStatus: supportCase.status,
        currentStaffId: staff.id,
      }),
    });
  } catch (err) {
    console.error(`POST /api/support/cases/:id/follow-up-reminder/disable error: ${supportRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'リマインドの停止に失敗しました' }, 500);
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
    if (isSecondaryOnlySupportStaff(staff)) {
      return c.json({ success: false, error: '二次対応専用権限ではチケット本体を編集できません' }, 403);
    }

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

    const existingFollowUpReminder = followUpReminderFromCaseRow(existing);
    const primaryAssigneeChanged = existing.primary_assignee !== next.primary_assignee;
    let nextReminderOwnerStaffId: string | null = null;
    if (primaryAssigneeChanged && existingFollowUpReminder?.status === 'active') {
      const nextPrimaryAssignee = next.primary_assignee?.trim() ?? '';
      if (!nextPrimaryAssignee) {
        return c.json({ success: false, error: 'リマインド中は一次対応者を未設定にできません 先にリマインドを停止してください' }, 400);
      }
      const staffIds = await activeStaffIdsByName(c.env.DB, [nextPrimaryAssignee]);
      nextReminderOwnerStaffId = staffIds.get(nextPrimaryAssignee) ?? null;
      if (!nextReminderOwnerStaffId) {
        return c.json({ success: false, error: 'リマインド中の一次対応者は在籍中のスタッフから選択してください' }, 400);
      }
    }

    if (fields.length === 0) {
      return c.json({ success: true, data: serializeCase(existing, staff.id) });
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
    const statements = [
      c.env.DB
        .prepare(`UPDATE support_cases SET ${setSql} WHERE id = ? AND line_account_id = ?`)
        .bind(...fields.map(([, value]) => value), id.value, lineAccountId.value),
    ];
    if (next.status === 'resolved') {
      statements.push(
        c.env.DB
          .prepare(
            `UPDATE support_escalations
             SET status = 'closed', updated_by = ?, updated_at = ?
             WHERE case_id = ? AND line_account_id = ?
               AND status IN ('pending', 'needs_info', 'transferred', 'expert_check')`,
          )
          .bind(staff.id, now, id.value, lineAccountId.value),
      );
    }
    if (primaryAssigneeChanged && existingFollowUpReminder?.status === 'active' && nextReminderOwnerStaffId) {
      statements.push(
        c.env.DB
          .prepare(
            `UPDATE support_case_followup_reminders
             SET owner_staff_id = ?, owner_name = ?, version = version + 1, updated_at = ?
             WHERE id = ? AND case_id = ? AND line_account_id = ? AND status = 'active'`,
          )
          .bind(
            nextReminderOwnerStaffId,
            next.primary_assignee,
            now,
            existingFollowUpReminder.id,
            id.value,
            lineAccountId.value,
          ),
        prepareFollowUpReminderEvent(
          c.env.DB,
          existingFollowUpReminder.id,
          id.value,
          'reconfigured',
          staff,
          {
            reason: 'primary_assignee_changed',
            previousOwnerStaffId: existingFollowUpReminder.owner_staff_id,
            previousOwnerName: existingFollowUpReminder.owner_name,
            ownerStaffId: nextReminderOwnerStaffId,
            ownerName: next.primary_assignee,
          },
          now,
        ),
      );
      if (existingFollowUpReminder.owner_staff_id) {
        statements.push(
          c.env.DB
            .prepare(
              `UPDATE app_notification_inbox
               SET dismissed_at = ?, updated_at = ?
               WHERE recipient_staff_id = ? AND line_account_id = ?
                 AND notification_key LIKE ?`,
            )
            .bind(
              now,
              now,
              existingFollowUpReminder.owner_staff_id,
              lineAccountId.value,
              `case_followup:${existingFollowUpReminder.id}:%`,
            ),
        );
      }
    }
    statements.push(
      prepareCaseEvent(
        c.env.DB,
        id.value,
        'updated',
        staff.id,
        staff.name,
        text(body.eventBody) ?? '案件を更新しました',
        {
          changed: fields.map(([column]) => column),
          fromStatus: existing.status,
          toStatus: next.status,
        },
        crypto.randomUUID(),
        now,
      ),
    );
    await c.env.DB.batch(statements);
    if (existing.priority !== 'urgent' && next.priority === 'urgent' && next.status !== 'resolved') {
      c.executionCtx.waitUntil(notifyUrgentSupportCase(c.env.DB, lineAccountId.value, id.value, {
        adminPublicUrl: c.env.ADMIN_PUBLIC_URL,
      }));
    }

    const updated = await getCaseRow(c.env.DB, id.value, lineAccountId.value, staff);
    return c.json({ success: true, data: serializeCase(updated!, staff.id) });
  } catch (err) {
    console.error(`PATCH /api/support/cases/:id error: ${supportRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

support.put('/api/support/cases/:id/secondary-assignees', async (c) => {
  try {
    const caseId = parseRequiredVisibleId(c.req.param('id'), 'caseId');
    if (!caseId.ok) return c.json({ success: false, error: caseId.error }, 400);
    const parsedBody = await readJsonRecord(c);
    if (!parsedBody.ok) return c.json({ success: false, error: parsedBody.error }, 400);
    const body = parsedBody.value;
    const lineAccountId = lineAccountIdFrom(c, body);
    if (!lineAccountId.ok) return c.json({ success: false, error: lineAccountId.error }, 400);
    const staff = currentStaff(c);
    if (!canManageSupportCaseRouting(staff)) {
      return c.json({ success: false, error: '二次対応先を変更できるのはオーナーまたは管理者です' }, 403);
    }
    const supportCase = await getCaseRow(c.env.DB, caseId.value, lineAccountId.value, staff);
    if (!supportCase) return c.json({ success: false, error: 'case not found' }, 404);
    if (supportCase.status === 'resolved') {
      return c.json({ success: false, error: '完了済みチケットの二次対応先は変更できません' }, 400);
    }
    const parsedAssignees = parseSecondaryAssigneeNames(body.escalationAssignees, undefined);
    if (!parsedAssignees.ok) return c.json({ success: false, error: parsedAssignees.error }, 400);
    const staffIds = await activeStaffIdsByName(c.env.DB, parsedAssignees.value);
    const missing = parsedAssignees.value.filter((name) => !staffIds.has(name));
    if (missing.length > 0) {
      return c.json({ success: false, error: `選択できない二次対応先が含まれています: ${missing.join('、')}` }, 400);
    }

    const current = await c.env.DB
      .prepare(
        `SELECT id, assignee
         FROM support_escalations
         WHERE case_id = ? AND line_account_id = ?
           AND status IN ('pending', 'needs_info', 'transferred', 'expert_check')`,
      )
      .bind(caseId.value, lineAccountId.value)
      .all<{ id: string; assignee: string }>();
    const selected = new Set(parsedAssignees.value);
    const currentNames = new Set(current.results.map((row) => row.assignee));
    const now = jstNow();
    const statements: D1PreparedStatement[] = [];

    for (const row of current.results) {
      if (selected.has(row.assignee)) continue;
      statements.push(
        c.env.DB
          .prepare(`UPDATE support_escalations SET status = 'closed', updated_by = ?, updated_at = ? WHERE id = ?`)
          .bind(staff.id, now, row.id),
      );
    }
    for (const assignee of parsedAssignees.value) {
      if (currentNames.has(assignee)) continue;
      statements.push(
        c.env.DB
          .prepare(
            `INSERT INTO support_escalations (
              id, case_id, line_account_id, assignee, assignee_staff_id, level, status,
              question, answer, due_at, answered_at, created_by, updated_by, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, '', ?, NULL, ?, ?, ?, ?)`,
          )
          .bind(
            crypto.randomUUID(),
            caseId.value,
            lineAccountId.value,
            assignee,
            staffIds.get(assignee) ?? null,
            supportCase.escalation_level === 'L3' ? 'L3' : 'L2',
            supportCase.customer_summary.trim() || supportCase.title,
            supportCase.due_at,
            staff.id,
            staff.id,
            now,
            now,
          ),
      );
    }

    let nextStatus = supportCase.status;
    if (
      parsedAssignees.value.length > 0
      && ['open', 'in_progress', 'waiting_primary', 'escalated', 'waiting_secondary', 'reopened'].includes(supportCase.status)
    ) {
      nextStatus = 'waiting_secondary';
    } else if (
      parsedAssignees.value.length === 0
      && ['escalated', 'waiting_secondary'].includes(supportCase.status)
    ) {
      nextStatus = 'in_progress';
    }
    statements.push(
      c.env.DB
        .prepare(`UPDATE support_cases SET escalation_assignee = ?, status = ?, updated_by = ?, updated_at = ? WHERE id = ? AND line_account_id = ?`)
        .bind(parsedAssignees.value[0] ?? null, nextStatus, staff.id, now, caseId.value, lineAccountId.value),
      prepareCaseEvent(
        c.env.DB,
        caseId.value,
        'secondary_assignees_updated',
        staff.id,
        staff.name,
        parsedAssignees.value.length > 0
          ? `二次対応先を更新しました: ${parsedAssignees.value.join('、')}`
          : '二次対応先を未設定にしました',
        {
          previous: Array.from(currentNames),
          next: parsedAssignees.value,
        },
        crypto.randomUUID(),
        now,
      ),
    );
    await c.env.DB.batch(statements);
    kickWebPushNotifications(c);
    const updated = await getCaseRow(c.env.DB, caseId.value, lineAccountId.value, staff);
    return c.json({ success: true, data: serializeCase(updated!) });
  } catch (err) {
    console.error(`PUT /api/support/cases/:id/secondary-assignees error: ${supportRouteErrorKind(err)}`);
    return c.json({ success: false, error: '二次対応先の更新に失敗しました' }, 500);
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

support.post('/api/support/cases/:id/internal-messages', async (c) => {
  try {
    const id = parseRequiredVisibleId(c.req.param('id'), 'caseId');
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const parsedBody = await readJsonRecord(c);
    if (!parsedBody.ok) return c.json({ success: false, error: parsedBody.error }, 400);
    const body = parsedBody.value;
    const lineAccountId = lineAccountIdFrom(c, body);
    if (!lineAccountId.ok) return c.json({ success: false, error: lineAccountId.error }, 400);
    const staff = currentStaff(c);
    const row = await getCaseRow(c.env.DB, id.value, lineAccountId.value, staff);
    if (!row) return c.json({ success: false, error: 'case not found' }, 404);

    const parsedMessage = parseRequiredTextField(body.body, 'body', SUPPORT_LONG_TEXT_MAX_LENGTH);
    if (!parsedMessage.ok) return c.json({ success: false, error: parsedMessage.error }, 400);
    const parsedParentId = parseOptionalVisibleId(body.parentId, 'parentId');
    if (!parsedParentId.ok) return c.json({ success: false, error: parsedParentId.error }, 400);
    if (parsedParentId.value) {
      const parent = await c.env.DB
        .prepare(
          `SELECT id
           FROM support_internal_messages
           WHERE id = ? AND case_id = ? AND line_account_id = ?`,
        )
        .bind(parsedParentId.value, id.value, lineAccountId.value)
        .first<{ id: string }>();
      if (!parent) return c.json({ success: false, error: 'parent message not found' }, 404);
    }
    const mentions = parseMentionNames(body.mentions, parsedMessage.value);
    if (!mentions.ok) return c.json({ success: false, error: mentions.error }, 400);
    const mentionStaffIds = parseMentionStaffIds(body.mentionStaffIds, SUPPORT_INTERNAL_MENTION_MAX);
    if (!mentionStaffIds.ok) return c.json({ success: false, error: mentionStaffIds.error }, 400);
    const resolvedMentions = await resolveMentionStaffTargets(c.env.DB, mentionStaffIds.value);
    if (resolvedMentions.missingIds.length > 0) {
      return c.json({ success: false, error: 'mention target not found' }, 400);
    }
    if (!mentionTargetsMatchBody(parsedMessage.value, resolvedMentions.targets)) {
      return c.json({ success: false, error: 'mention target must appear in body' }, 400);
    }
    const mentionNames = Array.from(new Set([
      ...mentions.value,
      ...resolvedMentions.targets.map((target) => target.name),
    ]));

    const now = jstNow();
    const messageId = crypto.randomUUID();
    await c.env.DB
      .prepare(
        `INSERT INTO support_internal_messages (
          id, case_id, line_account_id, parent_id, body, mentions,
          created_by, created_by_name, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        messageId,
        id.value,
        lineAccountId.value,
        parsedParentId.value ?? null,
        parsedMessage.value,
        JSON.stringify(mentionNames),
        staff.id,
        staff.name,
        now,
      )
      .run();

    await recordInternalMessageMentions(
      c.env.DB,
      'support',
      messageId,
      resolvedMentions.targets,
      now,
    );

    await addCaseEvent(
      c.env.DB,
      id.value,
      parsedParentId.value ? 'internal_thread_reply' : 'internal_chat',
      staff.id,
      staff.name,
      parsedParentId.value ? '社内スレッドに返信しました' : '社内チャットに投稿しました',
      {
        messageId,
        parentId: parsedParentId.value ?? null,
        mentions: mentionNames,
        mentionStaffIds: mentionStaffIds.value,
      },
    );

    const created = await c.env.DB
      .prepare(`SELECT * FROM support_internal_messages WHERE id = ? AND line_account_id = ?`)
      .bind(messageId, lineAccountId.value)
      .first<SupportInternalMessageRow>();

    kickWebPushNotifications(c);
    return c.json({
      success: true,
      data: serializeInternalMessage(created!, staff, mentionStaffIds.value),
    }, 201);
  } catch (err) {
    console.error(`POST /api/support/cases/:id/internal-messages error: ${supportRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

support.patch('/api/support/cases/:id/internal-messages/:messageId', async (c) => {
  try {
    const caseId = parseRequiredVisibleId(c.req.param('id'), 'caseId');
    if (!caseId.ok) return c.json({ success: false, error: caseId.error }, 400);
    const messageId = parseRequiredVisibleId(c.req.param('messageId'), 'messageId');
    if (!messageId.ok) return c.json({ success: false, error: messageId.error }, 400);
    const parsedBody = await readJsonRecord(c);
    if (!parsedBody.ok) return c.json({ success: false, error: parsedBody.error }, 400);
    const body = parsedBody.value;
    const lineAccountId = lineAccountIdFrom(c, body);
    if (!lineAccountId.ok) return c.json({ success: false, error: lineAccountId.error }, 400);
    const baseVersion = parseInternalMessageBaseVersion(body.baseVersion);
    if (!baseVersion.ok) return c.json({ success: false, error: baseVersion.error }, 400);
    const editedBody = parseRequiredTextField(body.body, 'body', SUPPORT_LONG_TEXT_MAX_LENGTH);
    if (!editedBody.ok) return c.json({ success: false, error: editedBody.error }, 400);
    const staff = currentStaff(c);
    const supportCase = await getCaseRow(c.env.DB, caseId.value, lineAccountId.value, staff);
    if (!supportCase) return c.json({ success: false, error: 'case not found' }, 404);
    const message = await c.env.DB
      .prepare(`SELECT * FROM support_internal_messages WHERE id = ? AND case_id = ? AND line_account_id = ?`)
      .bind(messageId.value, caseId.value, lineAccountId.value)
      .first<SupportInternalMessageRow>();
    if (!message) return c.json({ success: false, error: 'message not found' }, 404);

    const mentions = parseMentionNames(body.mentions, editedBody.value);
    if (!mentions.ok) return c.json({ success: false, error: mentions.error }, 400);
    const mentionStaffIds = parseMentionStaffIds(body.mentionStaffIds, SUPPORT_INTERNAL_MENTION_MAX);
    if (!mentionStaffIds.ok) return c.json({ success: false, error: mentionStaffIds.error }, 400);
    const resolvedMentions = await resolveMentionStaffTargets(c.env.DB, mentionStaffIds.value);
    if (resolvedMentions.missingIds.length > 0) {
      return c.json({ success: false, error: 'mention target not found' }, 400);
    }
    if (!mentionTargetsMatchBody(editedBody.value, resolvedMentions.targets)) {
      return c.json({ success: false, error: 'mention target must appear in body' }, 400);
    }
    const mentionNames = Array.from(new Set([
      ...mentions.value,
      ...resolvedMentions.targets.map((target) => target.name),
    ]));
    const result = await appendInternalMessageEvent({
      db: c.env.DB,
      source: 'support',
      message,
      staff,
      baseVersion: baseVersion.value,
      action: 'edit',
      body: editedBody.value,
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
      data: serializeInternalMessage(message, staff, mentionStaffIds.value, result.event),
    });
  } catch (err) {
    console.error(`PATCH /api/support/cases/:id/internal-messages/:messageId error: ${supportRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'メッセージの編集に失敗しました' }, 500);
  }
});

support.post('/api/support/cases/:id/internal-messages/:messageId/soft-delete', async (c) => {
  try {
    const caseId = parseRequiredVisibleId(c.req.param('id'), 'caseId');
    if (!caseId.ok) return c.json({ success: false, error: caseId.error }, 400);
    const messageId = parseRequiredVisibleId(c.req.param('messageId'), 'messageId');
    if (!messageId.ok) return c.json({ success: false, error: messageId.error }, 400);
    const parsedBody = await readJsonRecord(c);
    if (!parsedBody.ok) return c.json({ success: false, error: parsedBody.error }, 400);
    const body = parsedBody.value;
    const lineAccountId = lineAccountIdFrom(c, body);
    if (!lineAccountId.ok) return c.json({ success: false, error: lineAccountId.error }, 400);
    const baseVersion = parseInternalMessageBaseVersion(body.baseVersion);
    if (!baseVersion.ok) return c.json({ success: false, error: baseVersion.error }, 400);
    const reason = parseOptionalTextField(body.reason, 'reason', 500);
    if (!reason.ok) return c.json({ success: false, error: reason.error }, 400);
    const staff = currentStaff(c);
    const supportCase = await getCaseRow(c.env.DB, caseId.value, lineAccountId.value, staff);
    if (!supportCase) return c.json({ success: false, error: 'case not found' }, 404);
    const message = await c.env.DB
      .prepare(`SELECT * FROM support_internal_messages WHERE id = ? AND case_id = ? AND line_account_id = ?`)
      .bind(messageId.value, caseId.value, lineAccountId.value)
      .first<SupportInternalMessageRow>();
    if (!message) return c.json({ success: false, error: 'message not found' }, 404);
    if (message.created_by !== staff.id && !reason.value) {
      return c.json({ success: false, error: '他のスタッフの投稿を削除する場合は理由を入力してください' }, 400);
    }
    const result = await appendInternalMessageEvent({
      db: c.env.DB,
      source: 'support',
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
    return c.json({
      success: true,
      data: serializeInternalMessage(message, staff, [], result.event),
    });
  } catch (err) {
    console.error(`POST /api/support/cases/:id/internal-messages/:messageId/soft-delete error: ${supportRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'メッセージの削除に失敗しました' }, 500);
  }
});

support.post('/api/support/cases/:id/internal-messages/:messageId/reactions', async (c) => {
  try {
    const id = parseRequiredVisibleId(c.req.param('id'), 'caseId');
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const messageId = parseRequiredVisibleId(c.req.param('messageId'), 'messageId');
    if (!messageId.ok) return c.json({ success: false, error: messageId.error }, 400);
    const parsedBody = await readJsonRecord(c);
    if (!parsedBody.ok) return c.json({ success: false, error: parsedBody.error }, 400);
    const body = parsedBody.value;
    const lineAccountId = lineAccountIdFrom(c, body);
    if (!lineAccountId.ok) return c.json({ success: false, error: lineAccountId.error }, 400);
    const emoji = normalizeInternalReactionEmoji(body.emoji);
    if (!emoji.ok) return c.json({ success: false, error: emoji.error }, 400);

    const staff = currentStaff(c);
    const supportCase = await getCaseRow(c.env.DB, id.value, lineAccountId.value, staff);
    if (!supportCase) return c.json({ success: false, error: 'case not found' }, 404);

    const message = await c.env.DB
      .prepare(
        `SELECT *
         FROM support_internal_messages
         WHERE id = ? AND case_id = ? AND line_account_id = ?`,
      )
      .bind(messageId.value, id.value, lineAccountId.value)
      .first<SupportInternalMessageRow>();
    if (!message) return c.json({ success: false, error: 'message not found' }, 404);
    const messageEvent = (await latestInternalMessageEvents(c.env.DB, 'support', [messageId.value])).get(messageId.value);
    if (messageEvent?.action === 'delete') {
      return c.json({ success: false, error: '削除済みメッセージにはリアクションできません' }, 400);
    }

    const { reactionsJson } = toggleInternalReaction(message.reactions, emoji.value, staff);
    await c.env.DB
      .prepare(`UPDATE support_internal_messages SET reactions = ? WHERE id = ? AND case_id = ? AND line_account_id = ?`)
      .bind(reactionsJson, messageId.value, id.value, lineAccountId.value)
      .run();

    const updated = await c.env.DB
      .prepare(`SELECT * FROM support_internal_messages WHERE id = ? AND line_account_id = ?`)
      .bind(messageId.value, lineAccountId.value)
      .first<SupportInternalMessageRow>();
    const mentionIds = await mentionStaffIdsForMessages(c.env.DB, 'support', [messageId.value]);

    return c.json({
      success: true,
      data: serializeInternalMessage(updated!, staff, mentionIds.get(messageId.value) ?? [], messageEvent),
    });
  } catch (err) {
    console.error(`POST /api/support/cases/:id/internal-messages/:messageId/reactions error: ${supportRouteErrorKind(err)}`);
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
    if (isSecondaryOnlySupportStaff(staff)) {
      return c.json({ success: false, error: '二次対応専用権限ではエスカレーションを新規作成できません' }, 403);
    }
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
    const escalationInsert = c.env.DB
      .prepare(
        `INSERT INTO support_escalations (
          id, case_id, line_account_id, assignee, level, status, question, answer,
          due_at, answered_at, created_by, updated_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?, '', ?, NULL, ?, ?, ?, ?)`,
      )
      .bind(id, caseId.value, row.line_account_id, assignee, level, question, dueAt, staff.id, staff.id, now, now);

    let caseUpdate: D1PreparedStatement;
    if (canRouteEscalation) {
      caseUpdate = c.env.DB
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
        .bind(assignee, level, dueAt, staff.id, now, caseId.value, lineAccountId.value);
    } else {
      caseUpdate = c.env.DB
        .prepare(
          `UPDATE support_cases
           SET status = 'waiting_secondary',
               updated_by = ?,
               updated_at = ?
           WHERE id = ? AND line_account_id = ?`,
        )
        .bind(staff.id, now, caseId.value, lineAccountId.value);
    }

    await c.env.DB.batch([
      escalationInsert,
      caseUpdate,
      prepareCaseEvent(
        c.env.DB,
        caseId.value,
        'escalated',
        staff.id,
        staff.name,
        question,
        { escalationId: id, assignee, level, dueAt },
        crypto.randomUUID(),
        now,
      ),
    ]);

    const escalation = await c.env.DB
      .prepare(`SELECT * FROM support_escalations WHERE id = ? AND line_account_id = ?`)
      .bind(id, lineAccountId.value)
      .first<SupportEscalationRow>();
    kickWebPushNotifications(c);
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

    if (status.value && status.value !== 'all') {
      if (!ESCALATION_STATUSES.has(status.value)) return c.json({ success: false, error: 'invalid status' }, 400);
      conditions.push('se.status = ?');
      binds.push(status.value);
    }
    if (isSecondaryOnlySupportStaff(staff)) {
      const assignmentName = supportStaffAssignmentName(staff);
      if (!assignmentName) return c.json({ success: true, data: [] });
      conditions.push(`se.assignee = ?`);
      binds.push(assignmentName);
    } else if (assignee.value) {
      conditions.push('se.assignee LIKE ?');
      binds.push(`%${assignee.value}%`);
    }
    if (!isSecondaryOnlySupportStaff(staff) && (scope.value === 'my_escalations' || queue.value === 'my_escalations')) {
      const assignmentName = supportStaffAssignmentName(staff);
      if (!assignmentName) return c.json({ success: true, data: [] });
      conditions.push(`se.assignee = ?`);
      binds.push(assignmentName);
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
    const conditions = ['se.id = ?', 'se.line_account_id = ?'];
    const binds: unknown[] = [id.value, lineAccountId.value];
    const existing = await c.env.DB
      .prepare(`SELECT se.* FROM support_escalations se WHERE ${conditions.join(' AND ')}`)
      .bind(...binds)
      .first<SupportEscalationRow>();
    if (!existing) return c.json({ success: false, error: 'escalation not found' }, 404);
    const staffForScope = currentStaff(c);
    if (isSecondaryOnlySupportStaff(staffForScope) && !supportStaffMatchesText(staffForScope, existing.assignee)) {
      return c.json({ success: false, error: 'escalation not found' }, 404);
    }
    if (TERMINAL_ESCALATION_STATUSES.has(existing.status)) {
      return c.json({
        success: false,
        error: '回答済み・クローズ済みの二次対応は編集できません。変更が必要な場合は再開してください',
      }, 409);
    }

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
      if (status === 'answered') nextCaseStatus = 'secondary_answered';
      if (status === 'needs_info') nextCaseStatus = 'waiting_primary';
      if (status === 'pending' || status === 'transferred' || status === 'expert_check') nextCaseStatus = 'waiting_secondary';
      if (status === 'closed') nextCaseStatus = 'in_progress';
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

    const setSql = fields.map(([column]) => `${column} = ?`).join(', ');
    const statements = [
      c.env.DB.prepare(`UPDATE support_escalations SET ${setSql} WHERE id = ? AND line_account_id = ?`)
        .bind(...fields.map(([, value]) => value), id.value, lineAccountId.value),
    ];

    if (nextCaseStatus) {
      statements.push(
        c.env.DB.prepare(
          `UPDATE support_cases
           SET status = CASE
                 WHEN EXISTS (
                   SELECT 1 FROM support_escalations se
                   WHERE se.case_id = support_cases.id AND se.status = 'needs_info'
                 ) THEN 'waiting_primary'
                 WHEN EXISTS (
                   SELECT 1 FROM support_escalations se
                   WHERE se.case_id = support_cases.id
                     AND se.status IN ('pending', 'transferred', 'expert_check')
                 ) THEN 'waiting_secondary'
                 WHEN EXISTS (
                   SELECT 1 FROM support_escalations se
                   WHERE se.case_id = support_cases.id AND se.status = 'answered'
                 ) THEN 'secondary_answered'
                 ELSE ?
               END,
               updated_by = ?,
               updated_at = ?
           WHERE id = ? AND line_account_id = ?`,
        ).bind(nextCaseStatus, staff.id, now, existing.case_id, lineAccountId.value),
      );
    }

    statements.push(
      prepareCaseEvent(
        c.env.DB,
        existing.case_id,
        'escalation_updated',
        staff.id,
        staff.name,
        parsedEventBody.value ?? parsedAnswer.value ?? 'エスカレーションを更新しました',
        { escalationId: id.value, status, nextCaseStatus },
        crypto.randomUUID(),
        now,
      ),
    );
    await c.env.DB.batch(statements);

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
    kickWebPushNotifications(c);
    return c.json({ success: true, data: serializeEscalation(updated!) });
  } catch (err) {
    console.error(`PATCH /api/support/escalations/:id error: ${supportRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

support.post('/api/support/escalations/:id/reopen', async (c) => {
  try {
    const id = parseRequiredVisibleId(c.req.param('id'), 'escalationId');
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const parsedBody = await readJsonRecord(c);
    if (!parsedBody.ok) return c.json({ success: false, error: parsedBody.error }, 400);
    const body = parsedBody.value;
    const unexpectedKeys = Object.keys(body).filter((key) => key !== 'lineAccountId');
    if (unexpectedKeys.length > 0) {
      return c.json({ success: false, error: `再開時には変更できない項目です: ${unexpectedKeys.join(', ')}` }, 400);
    }
    const lineAccountId = lineAccountIdFrom(c, body);
    if (!lineAccountId.ok) return c.json({ success: false, error: lineAccountId.error }, 400);

    const existing = await c.env.DB
      .prepare(`SELECT se.* FROM support_escalations se WHERE se.id = ? AND se.line_account_id = ?`)
      .bind(id.value, lineAccountId.value)
      .first<SupportEscalationRow>();
    if (!existing) return c.json({ success: false, error: 'escalation not found' }, 404);

    const staff = currentStaff(c);
    if (isSecondaryOnlySupportStaff(staff) && !supportStaffMatchesText(staff, existing.assignee)) {
      return c.json({ success: false, error: 'escalation not found' }, 404);
    }
    if (!TERMINAL_ESCALATION_STATUSES.has(existing.status)) {
      return c.json({ success: false, error: '未回答の二次対応は再開できません' }, 409);
    }
    const existingReopen = await c.env.DB
      .prepare(`SELECT id FROM support_escalations WHERE reopened_from_id = ? AND line_account_id = ? LIMIT 1`)
      .bind(existing.id, lineAccountId.value)
      .first<{ id: string }>();
    if (existingReopen) {
      return c.json({ success: false, error: 'この二次対応はすでに再開されています' }, 409);
    }

    const linkedCase = await c.env.DB
      .prepare(`SELECT status FROM support_cases WHERE id = ? AND line_account_id = ?`)
      .bind(existing.case_id, lineAccountId.value)
      .first<{ status: string }>();
    if (!linkedCase) return c.json({ success: false, error: 'case not found' }, 404);

    const now = jstNow();
    const reopenedId = crypto.randomUUID();
    const reopenedInsert = c.env.DB
      .prepare(
        `INSERT INTO support_escalations (
          id, case_id, line_account_id, assignee, level, status, question, answer,
          due_at, answered_at, created_by, updated_by, created_at, updated_at, reopened_from_id
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?, '', ?, NULL, ?, ?, ?, ?, ?)`,
      )
      .bind(
        reopenedId,
        existing.case_id,
        existing.line_account_id,
        existing.assignee,
        existing.level,
        existing.question,
        existing.due_at,
        staff.id,
        staff.id,
        now,
        now,
        existing.id,
      );

    const caseFields: Array<[string, unknown]> = [
      ['status', 'waiting_secondary'],
      ['updated_by', staff.id],
      ['updated_at', now],
    ];
    if (linkedCase.status === 'resolved') {
      caseFields.splice(1, 0, ['reopened_at', now], ['closed_at', null]);
    }
    const caseUpdate = c.env.DB
      .prepare(
        `UPDATE support_cases SET ${caseFields.map(([column]) => `${column} = ?`).join(', ')} WHERE id = ? AND line_account_id = ?`,
      )
      .bind(...caseFields.map(([, value]) => value), existing.case_id, lineAccountId.value);

    await c.env.DB.batch([
      reopenedInsert,
      caseUpdate,
      prepareCaseEvent(
        c.env.DB,
        existing.case_id,
        'escalation_reopened',
        staff.id,
        staff.name,
        '完了済みの二次対応を未回答として再開しました',
        {
          previousEscalationId: existing.id,
          previousStatus: existing.status,
          reopenedEscalationId: reopenedId,
          previousCaseStatus: linkedCase.status,
          nextCaseStatus: 'waiting_secondary',
        },
        crypto.randomUUID(),
        now,
      ),
    ]);

    const reopened = await c.env.DB
      .prepare(
        `SELECT se.*, sc.title AS case_title, f.display_name AS friend_name
         FROM support_escalations se
         LEFT JOIN support_cases sc ON sc.id = se.case_id
         LEFT JOIN friends f ON f.id = sc.friend_id
         WHERE se.id = ? AND se.line_account_id = ?`,
      )
      .bind(reopenedId, lineAccountId.value)
      .first<SupportEscalationRow>();
    kickWebPushNotifications(c);
    return c.json({ success: true, data: serializeEscalation(reopened!) }, 201);
  } catch (err) {
    console.error(`POST /api/support/escalations/:id/reopen error: ${supportRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

support.get('/api/support/manuals', async (c) => {
  try {
    const lineAccountId = parseRequiredVisibleId(c.req.query('lineAccountId'), 'lineAccountId');
    if (!lineAccountId.ok) return c.json({ success: false, error: lineAccountId.error }, 400);
    const category = parseOptionalQueryText(c.req.query('category'), 'category');
    if (!category.ok) return c.json({ success: false, error: category.error }, 400);
    const q = parseOptionalQueryText(c.req.query('q'), 'q');
    if (!q.ok) return c.json({ success: false, error: q.error }, 400);
    const active = parseActiveFilter(c.req.query('active'));
    if (!active.ok) return c.json({ success: false, error: active.error }, 400);
    const knowledgeStatus = parseManualKnowledgeStatus(c.req.query('knowledgeStatus'));
    if (!knowledgeStatus.ok) return c.json({ success: false, error: knowledgeStatus.error }, 400);
    const conditions: string[] = [];
    const binds: unknown[] = [];

    conditions.push('(line_account_id = ? OR line_account_id IS NULL)');
    binds.push(lineAccountId.value);
    if (category.value && category.value !== 'all') {
      conditions.push('category = ?');
      binds.push(category.value);
    }
    if (active.value !== 'all') {
      conditions.push('is_active = ?');
      binds.push(active.value === '0' ? 0 : 1);
    }
    if (knowledgeStatus.value !== 'all') {
      conditions.push('knowledge_status = ?');
      binds.push(knowledgeStatus.value);
    }
    if (q.value) {
      const pattern = `%${q.value}%`;
      conditions.push(`(
        title LIKE ? OR body LIKE ? OR keywords LIKE ? OR
        knowledge_question LIKE ? OR knowledge_resolution LIKE ? OR
        knowledge_procedure LIKE ? OR knowledge_applicability LIKE ? OR knowledge_cautions LIKE ?
      )`);
      binds.push(pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await c.env.DB
      .prepare(
        `SELECT * FROM support_manuals
         ${where}
         ORDER BY is_active DESC,
           CASE knowledge_status
             WHEN 'verified' THEN 0
             WHEN 'ready' THEN 1
             WHEN 'needs_review' THEN 2
             ELSE 3
           END,
           knowledge_quality_score DESC,
           revised_at DESC,
           title ASC
         LIMIT 500`,
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
    const derivedKnowledge = deriveOperationalKnowledge({ title, body: manualBody });
    const knowledgeTextInputs: Record<string, string> = {};
    for (const key of ['question', 'resolution', 'procedure', 'applicability', 'cautions', 'reviewNote'] as const) {
      const parsed = parseOptionalTextField(body[key], key, SUPPORT_LONG_TEXT_MAX_LENGTH);
      if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);
      knowledgeTextInputs[key] = parsed.value ?? '';
    }
    const knowledgeStatus = parseManualKnowledgeStatus(body.knowledgeStatus);
    if (!knowledgeStatus.ok) return c.json({ success: false, error: knowledgeStatus.error }, 400);
    const requestedStatus = knowledgeStatus.value === 'all' ? derivedKnowledge.status : knowledgeStatus.value;
    const knowledgeQuestion = knowledgeTextInputs.question || derivedKnowledge.question;
    const knowledgeResolution = knowledgeTextInputs.resolution || derivedKnowledge.resolution;
    const scoredKnowledge = deriveOperationalKnowledge({
      title,
      body: manualBody,
      question: knowledgeQuestion,
      answer: knowledgeResolution,
    });

    const staff = currentStaff(c);
    const now = jstNow();
    const id = crypto.randomUUID();
    await c.env.DB.prepare(
      `INSERT INTO support_manuals (
        id, line_account_id, title, category, body, url, keywords, owner, approved_by,
        revised_at, is_active, created_by, updated_by, created_at, updated_at,
        knowledge_question, knowledge_resolution, knowledge_procedure,
        knowledge_applicability, knowledge_cautions, knowledge_source_body,
        knowledge_status, knowledge_quality_score, knowledge_review_note
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      knowledgeQuestion,
      knowledgeResolution,
      knowledgeTextInputs.procedure || derivedKnowledge.procedure,
      knowledgeTextInputs.applicability || derivedKnowledge.applicability,
      knowledgeTextInputs.cautions || derivedKnowledge.cautions,
      manualBody,
      requestedStatus,
      requestedStatus === 'verified' ? 100 : scoredKnowledge.qualityScore,
      knowledgeTextInputs.reviewNote || (requestedStatus === 'verified' ? '' : scoredKnowledge.reviewNote),
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
      question: SUPPORT_LONG_TEXT_MAX_LENGTH,
      resolution: SUPPORT_LONG_TEXT_MAX_LENGTH,
      procedure: SUPPORT_LONG_TEXT_MAX_LENGTH,
      applicability: SUPPORT_LONG_TEXT_MAX_LENGTH,
      cautions: SUPPORT_LONG_TEXT_MAX_LENGTH,
      reviewNote: SUPPORT_LONG_TEXT_MAX_LENGTH,
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
      ['knowledge_question', 'question'],
      ['knowledge_resolution', 'resolution'],
      ['knowledge_procedure', 'procedure'],
      ['knowledge_applicability', 'applicability'],
      ['knowledge_cautions', 'cautions'],
      ['knowledge_review_note', 'reviewNote'],
    ];
    for (const [column, key] of mapping) {
      if (key in body) fields.push([column, manualInputs[key] ?? null]);
    }
    let requestedKnowledgeStatus: KnowledgeStatus | null = null;
    if ('knowledgeStatus' in body) {
      const parsedStatus = parseManualKnowledgeStatus(body.knowledgeStatus);
      if (!parsedStatus.ok) return c.json({ success: false, error: parsedStatus.error }, 400);
      if (parsedStatus.value === 'all') return c.json({ success: false, error: 'knowledgeStatus is required' }, 400);
      requestedKnowledgeStatus = parsedStatus.value;
      fields.push(['knowledge_status', requestedKnowledgeStatus]);
    }
    if ('body' in body && !(existing.knowledge_source_body ?? '').trim()) {
      fields.push(['knowledge_source_body', existing.body]);
    }
    if ('isActive' in body) fields.push(['is_active', body.isActive === false ? 0 : 1]);
    const staff = currentStaff(c);
    const now = jstNow();
    const knowledgeChanged = ['title', 'body', 'question', 'resolution'].some((key) => key in body);
    if (knowledgeChanged) {
      const nextTitle = manualInputs.title ?? existing.title;
      const nextBody = manualInputs.body ?? existing.body;
      const nextQuestion = manualInputs.question ?? existing.knowledge_question ?? '';
      const nextResolution = manualInputs.resolution ?? existing.knowledge_resolution ?? '';
      const derived = deriveOperationalKnowledge({
        title: nextTitle,
        body: nextBody,
        question: nextQuestion,
        answer: nextResolution,
      });
      fields.push(['knowledge_quality_score', requestedKnowledgeStatus === 'verified' ? 100 : derived.qualityScore]);
      if (!requestedKnowledgeStatus && (existing.knowledge_status ?? 'needs_review') !== 'verified') {
        fields.push(['knowledge_status', derived.status]);
      }
      if (!('reviewNote' in body) && (requestedKnowledgeStatus ?? existing.knowledge_status) !== 'verified') {
        fields.push(['knowledge_review_note', derived.reviewNote]);
      }
    } else if (requestedKnowledgeStatus === 'verified') {
      fields.push(['knowledge_quality_score', 100], ['knowledge_review_note', '']);
    }
    fields.push(['updated_by', staff.id], ['updated_at', now]);

    await recordManualRevision(c.env.DB, existing, 'edited', staff, now);
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

    const now = jstNow();
    await recordManualRevision(c.env.DB, existing, 'archived', staff, now);
    await c.env.DB
      .prepare(`UPDATE support_manuals SET is_active = 0, updated_by = ?, updated_at = ? WHERE id = ? AND line_account_id = ?`)
      .bind(staff.id, now, id.value, lineAccountId.value)
      .run();
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error(`DELETE /api/support/manuals/:id error: ${supportRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

support.post('/api/support/manuals/:id/usage', requireRole('owner', 'admin', 'staff', 'secondary'), async (c) => {
  try {
    const id = parseRequiredVisibleId(c.req.param('id'), 'manualId');
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const parsedBody = await readJsonRecord(c);
    if (!parsedBody.ok) return c.json({ success: false, error: parsedBody.error }, 400);
    const body = parsedBody.value;
    const lineAccountId = parseRequiredVisibleId(body.lineAccountId, 'lineAccountId');
    if (!lineAccountId.ok) return c.json({ success: false, error: lineAccountId.error }, 400);
    const action = typeof body.action === 'string' ? body.action.trim() : '';
    if (!SUPPORT_MANUAL_USAGE_ACTIONS.has(action)) {
      return c.json({ success: false, error: 'action is invalid' }, 400);
    }
    const existing = await c.env.DB
      .prepare(`SELECT * FROM support_manuals WHERE id = ? AND line_account_id = ? AND is_active = 1`)
      .bind(id.value, lineAccountId.value)
      .first<SupportManualRow>();
    if (!existing) return c.json({ success: false, error: 'manual not found' }, 404);
    const staff = currentStaff(c);
    const now = jstNow();
    await c.env.DB.prepare(
      `INSERT INTO support_manual_usage_events (
        id, manual_id, line_account_id, action, actor_id, actor_name, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), existing.id, lineAccountId.value, action, staff.id, staff.name, now).run();
    if (action === 'copied') {
      await c.env.DB.prepare(
        `UPDATE support_manuals
         SET knowledge_use_count = knowledge_use_count + 1,
             knowledge_last_used_at = ?
         WHERE id = ? AND line_account_id = ?`,
      ).bind(now, existing.id, lineAccountId.value).run();
    } else if (action === 'helpful') {
      await c.env.DB.prepare(
        `UPDATE support_manuals
         SET knowledge_helpful_count = knowledge_helpful_count + 1
         WHERE id = ? AND line_account_id = ?`,
      ).bind(existing.id, lineAccountId.value).run();
    } else {
      await c.env.DB.prepare(
        `UPDATE support_manuals
         SET knowledge_needs_improvement_count = knowledge_needs_improvement_count + 1
         WHERE id = ? AND line_account_id = ?`,
      ).bind(existing.id, lineAccountId.value).run();
    }
    const updated = await c.env.DB
      .prepare(`SELECT * FROM support_manuals WHERE id = ? AND line_account_id = ?`)
      .bind(existing.id, lineAccountId.value)
      .first<SupportManualRow>();
    return c.json({ success: true, data: serializeManual(updated ?? existing) });
  } catch (err) {
    console.error(`POST /api/support/manuals/:id/usage error: ${supportRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

support.post('/api/support/manuals/slack-normalize', requireRole('owner', 'admin'), async (c) => {
  try {
    const parsedBody = await readJsonRecord(c);
    if (!parsedBody.ok) return c.json({ success: false, error: parsedBody.error }, 400);
    const body = parsedBody.value;
    const lineAccountId = parseRequiredVisibleId(body.lineAccountId, 'lineAccountId');
    if (!lineAccountId.ok) return c.json({ success: false, error: lineAccountId.error }, 400);
    const resolveProfiles = parseOptionalBooleanFlag(body.resolveProfiles, 'resolveProfiles');
    if (!resolveProfiles.ok) return c.json({ success: false, error: resolveProfiles.error }, 400);
    const limit = clampSlackNormalizeLimit(body.limit);
    const offset = clampOffset(body.offset === undefined ? undefined : String(body.offset));

    const rowsResult = await c.env.DB
      .prepare(
        `SELECT *
         FROM support_knowledge_imports
         WHERE line_account_id = ?
           AND source = 'slack'
           AND status = 'published'
         ORDER BY updated_at DESC
         LIMIT ? OFFSET ?`,
      )
      .bind(lineAccountId.value, limit, offset)
      .all<SupportKnowledgeImportRow>();
    const rows = rowsResult.results;
    const mentionIds = Array.from(new Set(
      rows.flatMap((row) => [
        ...collectSlackMentionIds(row.title),
        ...collectSlackMentionIds(row.question),
        ...collectSlackMentionIds(row.answer),
        ...collectSlackMentionIds(row.body),
        ...collectSlackMentionIds(row.keywords),
      ]),
    ));

    const token = c.env.SLACK_BOT_TOKEN?.trim();
    if (mentionIds.length > 0 && resolveProfiles.value && !token) {
      return c.json({ success: false, error: 'Slack token is not configured' }, 400);
    }
    const displayNames = token && resolveProfiles.value ? await resolveSlackMentionDisplayNames(token, mentionIds) : new Map<string, string>();
    const replacementNames = applyFallbackSlackMentionNames(mentionIds, displayNames);
    const staff = currentStaff(c);
    const now = jstNow();
    let updatedImports = 0;
    let updatedManuals = 0;
    const qualityCounts: Record<KnowledgeStatus, number> = {
      verified: 0,
      ready: 0,
      needs_review: 0,
      unresolved: 0,
    };
    const manualIds = Array.from(new Set(rows.map((row) => row.manual_id).filter((id): id is string => Boolean(id))));
    const manualMap = new Map<string, SupportManualRow>();
    if (manualIds.length > 0) {
      const placeholders = manualIds.map(() => '?').join(',');
      const manualsResult = await c.env.DB
        .prepare(`SELECT * FROM support_manuals WHERE line_account_id = ? AND id IN (${placeholders})`)
        .bind(lineAccountId.value, ...manualIds)
        .all<SupportManualRow>();
      for (const manual of manualsResult.results) manualMap.set(manual.id, manual);
    }
    const writes: D1PreparedStatement[] = [];

    for (const row of rows) {
      writes.push(await prepareKnowledgeSourceSnapshot(c.env.DB, {
        knowledgeImportId: row.id,
        lineAccountId: lineAccountId.value,
        channelId: row.source_channel_id,
        threadTs: row.source_thread_ts,
        rawPayload: JSON.stringify({
          title: row.title,
          question: row.question,
          answer: row.answer,
          body: row.body,
          author: row.source_author,
          postedAt: row.source_posted_at,
        }),
        reconstructed: true,
        capturedAt: now,
      }));
      const customerInfo = replaceSlackMentionIds(
        extractKnowledgeBodySection(row.body, ['顧客・案件情報', '顧客情報', '案件情報']),
        replacementNames,
      );
      const questionSource = row.question || extractKnowledgeBodySection(row.body, ['問い合わせ内容', '一次対応の問い合わせ', '質問', '問い']);
      const answerSource = row.answer || extractKnowledgeBodySection(row.body, ['解決回答', '対応ナレッジ', '二次対応の回答', '回答']);
      const title = truncateText(replaceSlackMentionIds(row.title, replacementNames), SUPPORT_SHORT_TEXT_MAX_LENGTH);
      const question = truncateText(replaceSlackMentionIds(questionSource, replacementNames), SUPPORT_LONG_TEXT_MAX_LENGTH);
      const answer = truncateText(replaceSlackMentionIds(answerSource, replacementNames), SUPPORT_LONG_TEXT_MAX_LENGTH);
      const knowledgeBody = buildKnowledgeBody({ customerInfo, question, answer });
      const derived = deriveOperationalKnowledge({ title, body: knowledgeBody, question, answer });
      const keywords = truncateText(
        buildKnowledgeKeywords(`${derived.title}\n${derived.question}\n${derived.resolution}\n${derived.procedure}`),
        SUPPORT_LONG_TEXT_MAX_LENGTH,
      );

      if (!row.manual_id) continue;
      const manual = manualMap.get(row.manual_id);
      if (!manual) continue;
      const currentStatus = (manual.knowledge_status ?? 'needs_review') as KnowledgeStatus;
      if (currentStatus === 'verified') {
        qualityCounts.verified += 1;
        continue;
      }
      qualityCounts[derived.status] += 1;
      const sourceBody = manual.knowledge_source_body || manual.body;
      if (
        derived.title === manual.title &&
        keywords === manual.keywords &&
        derived.question === (manual.knowledge_question ?? '') &&
        derived.resolution === (manual.knowledge_resolution ?? '') &&
        derived.procedure === (manual.knowledge_procedure ?? '') &&
        derived.applicability === (manual.knowledge_applicability ?? '') &&
        derived.cautions === (manual.knowledge_cautions ?? '') &&
        sourceBody === (manual.knowledge_source_body ?? '') &&
        derived.status === currentStatus &&
        derived.qualityScore === (manual.knowledge_quality_score ?? 0) &&
        derived.reviewNote === (manual.knowledge_review_note ?? '')
      ) {
        continue;
      }
      writes.push(prepareManualRevision(c.env.DB, manual, 'auto_structured', staff, now));
      writes.push(c.env.DB
        .prepare(
          `UPDATE support_manuals
           SET title = ?,
               keywords = ?,
               knowledge_question = ?,
               knowledge_resolution = ?,
               knowledge_procedure = ?,
               knowledge_applicability = ?,
               knowledge_cautions = ?,
               knowledge_source_body = ?,
               knowledge_status = ?,
               knowledge_quality_score = ?,
               knowledge_review_note = ?,
               updated_by = ?,
               updated_at = ?
           WHERE id = ? AND line_account_id = ?`,
        )
        .bind(
          derived.title,
          keywords,
          derived.question,
          derived.resolution,
          derived.procedure,
          derived.applicability,
          derived.cautions,
          sourceBody,
          derived.status,
          derived.qualityScore,
          derived.reviewNote,
          staff.id,
          now,
          manual.id,
          lineAccountId.value,
        ));
      updatedManuals += 1;
    }

    if (writes.length > 0) await c.env.DB.batch(writes);

    return c.json({
      success: true,
      data: {
        checked: rows.length,
        offset,
        nextOffset: rows.length === limit ? offset + rows.length : null,
        slackMemberIds: mentionIds.length,
        profileLookupEnabled: resolveProfiles.value,
        resolvedMemberIds: displayNames.size,
        fallbackMemberIds: Math.max(0, mentionIds.length - displayNames.size),
        unresolvedMemberIds: 0,
        updatedImports,
        updatedManuals,
        qualityCounts,
      },
    });
  } catch (err) {
    console.error(`POST /api/support/manuals/slack-normalize error: ${supportRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

support.get('/api/support/knowledge-imports', requireRole('owner', 'admin'), async (c) => {
  try {
    const lineAccountId = parseRequiredVisibleId(c.req.query('lineAccountId'), 'lineAccountId');
    if (!lineAccountId.ok) return c.json({ success: false, error: lineAccountId.error }, 400);
    const status = parseKnowledgeImportStatus(c.req.query('status'));
    if (!status.ok) return c.json({ success: false, error: status.error }, 400);
    const q = parseOptionalQueryText(c.req.query('q'), 'q');
    if (!q.ok) return c.json({ success: false, error: q.error }, 400);
    const limit = clampLimit(c.req.query('limit'), 50);
    const offset = clampOffset(c.req.query('offset'));

    const conditions = ['line_account_id = ?'];
    const binds: unknown[] = [lineAccountId.value];
    if (status.value !== 'all') {
      conditions.push('status = ?');
      binds.push(status.value);
    }
    if (q.value) {
      const pattern = `%${q.value}%`;
      conditions.push('(title LIKE ? OR question LIKE ? OR answer LIKE ? OR keywords LIKE ?)');
      binds.push(pattern, pattern, pattern, pattern);
    }

    const result = await c.env.DB
      .prepare(
        `SELECT *
         FROM support_knowledge_imports
         WHERE ${conditions.join(' AND ')}
         ORDER BY updated_at DESC
         LIMIT ? OFFSET ?`,
      )
      .bind(...binds, limit, offset)
      .all<SupportKnowledgeImportRow>();
    return c.json({ success: true, data: result.results.map(serializeKnowledgeImport) });
  } catch (err) {
    console.error(`GET /api/support/knowledge-imports error: ${supportRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

support.post('/api/support/knowledge-imports/slack/sync', requireRole('owner', 'admin'), async (c) => {
  try {
    const parsedBody = await readJsonRecord(c);
    if (!parsedBody.ok) return c.json({ success: false, error: parsedBody.error }, 400);
    const body = parsedBody.value;
    const lineAccountId = parseRequiredVisibleId(body.lineAccountId, 'lineAccountId');
    if (!lineAccountId.ok) return c.json({ success: false, error: lineAccountId.error }, 400);
    const channelIdInput = parseOptionalVisibleId(body.channelId, 'channelId');
    if (!channelIdInput.ok) return c.json({ success: false, error: channelIdInput.error }, 400);
    const channelNameInput = parseOptionalTextField(body.channelName, 'channelName');
    if (!channelNameInput.ok) return c.json({ success: false, error: channelNameInput.error }, 400);
    const cursorInput = parseOptionalTextField(body.cursor, 'cursor', SUPPORT_URL_MAX_LENGTH);
    if (!cursorInput.ok) return c.json({ success: false, error: cursorInput.error }, 400);
    const oldestInput = parseOptionalTextField(body.oldest, 'oldest', SUPPORT_SHORT_TEXT_MAX_LENGTH);
    if (!oldestInput.ok) return c.json({ success: false, error: oldestInput.error }, 400);
    const latestInput = parseOptionalTextField(body.latest, 'latest', SUPPORT_SHORT_TEXT_MAX_LENGTH);
    if (!latestInput.ok) return c.json({ success: false, error: latestInput.error }, 400);
    const publishInput = parseOptionalBooleanFlag(body.publish, 'publish');
    if (!publishInput.ok) return c.json({ success: false, error: publishInput.error }, 400);

    const token = c.env.SLACK_BOT_TOKEN?.trim();
    if (!token) return c.json({ success: false, error: 'Slack token is not configured' }, 400);
    const channelId = channelIdInput.value ?? c.env.SUPPORT_KNOWLEDGE_SLACK_CHANNEL_ID?.trim();
    if (!channelId) return c.json({ success: false, error: 'channelId is required' }, 400);
    const limit = clampSlackImportLimit(body.limit);
    const now = jstNow();
    const staff = currentStaff(c);

    const history = await fetchSlackApi<SlackHistoryResponse>(token, 'conversations.history', {
      channel: channelId,
      limit,
      cursor: cursorInput.value ?? undefined,
      oldest: oldestInput.value ?? undefined,
      latest: latestInput.value ?? undefined,
    });
    if (!history.ok) {
      return c.json({ success: false, error: `Slack history fetch failed: ${history.error ?? 'unknown_error'}` }, 502);
    }

    let imported = 0;
    let updated = 0;
    let skipped = 0;
    let failed = 0;
    let published = 0;

    for (const parent of history.messages ?? []) {
      if (parent.type !== 'message' || parent.subtype || !parent.ts || (parent.reply_count ?? 0) < 1) {
        skipped += 1;
        continue;
      }
      const threadTs = parent.thread_ts ?? parent.ts;
      const replies = await fetchSlackApi<SlackRepliesResponse>(token, 'conversations.replies', {
        channel: channelId,
        ts: threadTs,
        limit: 1000,
      });
      if (!replies.ok) {
        failed += 1;
        continue;
      }
      const candidate = buildKnowledgeCandidate(parent, replies.messages ?? [], {
        channelId,
        channelName: channelNameInput.value,
      });
      if (!candidate) {
        skipped += 1;
        continue;
      }
      const outcome = await upsertKnowledgeImport(c.env.DB, lineAccountId.value, candidate, staff, now);
      if (outcome === 'created') imported += 1;
      if (outcome === 'updated') updated += 1;
      if (outcome === 'skipped') skipped += 1;
      if (publishInput.value) {
        const row = await getKnowledgeImportRowBySource(c.env.DB, lineAccountId.value, candidate.sourceChannelId, candidate.sourceThreadTs);
        if (!row) {
          failed += 1;
          continue;
        }
        const publishOutcome = await publishKnowledgeImportRow(c.env.DB, lineAccountId.value, row, staff, now);
        if (publishOutcome.outcome === 'created') published += 1;
        if (publishOutcome.outcome === 'skipped') skipped += 1;
      }
    }

    const nextCursor = history.response_metadata?.next_cursor || null;
    return c.json({
      success: true,
      data: {
        imported,
        updated,
        skipped,
        failed,
        published,
        nextCursor,
        hasMore: Boolean(nextCursor || history.has_more),
      },
    });
  } catch (err) {
    console.error(`POST /api/support/knowledge-imports/slack/sync error: ${supportRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

support.patch('/api/support/knowledge-imports/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = parseRequiredVisibleId(c.req.param('id'), 'knowledgeImportId');
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const parsedBody = await readJsonRecord(c);
    if (!parsedBody.ok) return c.json({ success: false, error: parsedBody.error }, 400);
    const body = parsedBody.value;
    const lineAccountId = lineAccountIdFrom(c, body);
    if (!lineAccountId.ok) return c.json({ success: false, error: lineAccountId.error }, 400);
    const existing = await getKnowledgeImportRow(c.env.DB, id.value, lineAccountId.value);
    if (!existing) return c.json({ success: false, error: 'knowledge import not found' }, 404);
    if (existing.status === 'published') {
      return c.json({ success: false, error: 'published knowledge imports cannot be edited' }, 409);
    }

    const fields: Array<[string, unknown]> = [];
    const textFields: Array<[string, string, number]> = [
      ['title', 'title', SUPPORT_SHORT_TEXT_MAX_LENGTH],
      ['category', 'category', SUPPORT_SHORT_TEXT_MAX_LENGTH],
      ['question', 'question', SUPPORT_LONG_TEXT_MAX_LENGTH],
      ['answer', 'answer', SUPPORT_LONG_TEXT_MAX_LENGTH],
      ['body', 'body', SUPPORT_LONG_TEXT_MAX_LENGTH],
      ['keywords', 'keywords', SUPPORT_LONG_TEXT_MAX_LENGTH],
    ];
    for (const [column, key, maxLength] of textFields) {
      if (!(key in body)) continue;
      const parsed = column === 'title' || column === 'body'
        ? parseRequiredTextField(body[key], key, maxLength)
        : parseOptionalTextField(body[key], key, maxLength);
      if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);
      fields.push([column, parsed.value ?? '']);
    }
    if ('status' in body) {
      const rawStatus = parseOptionalTextField(body.status, 'status');
      if (!rawStatus.ok) return c.json({ success: false, error: rawStatus.error }, 400);
      const status = rawStatus.value ?? 'draft';
      if (!SUPPORT_KNOWLEDGE_IMPORT_STATUSES.has(status) || status === 'published') {
        return c.json({ success: false, error: 'status is invalid' }, 400);
      }
      fields.push(['status', status]);
      if (status === 'dismissed') {
        fields.push(['reviewed_by', currentStaff(c).id], ['reviewed_at', jstNow()]);
      }
    }
    if (fields.length === 0) return c.json({ success: true, data: serializeKnowledgeImport(existing) });
    fields.push(['updated_at', jstNow()]);

    await c.env.DB
      .prepare(`UPDATE support_knowledge_imports SET ${fields.map(([column]) => `${column} = ?`).join(', ')} WHERE id = ? AND line_account_id = ?`)
      .bind(...fields.map(([, value]) => value), id.value, lineAccountId.value)
      .run();
    const updated = await getKnowledgeImportRow(c.env.DB, id.value, lineAccountId.value);
    return c.json({ success: true, data: serializeKnowledgeImport(updated!) });
  } catch (err) {
    console.error(`PATCH /api/support/knowledge-imports/:id error: ${supportRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

support.post('/api/support/knowledge-imports/:id/publish', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = parseRequiredVisibleId(c.req.param('id'), 'knowledgeImportId');
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const parsedBody = await readJsonRecord(c);
    if (!parsedBody.ok) return c.json({ success: false, error: parsedBody.error }, 400);
    const lineAccountId = lineAccountIdFrom(c, parsedBody.value);
    if (!lineAccountId.ok) return c.json({ success: false, error: lineAccountId.error }, 400);
    const row = await getKnowledgeImportRow(c.env.DB, id.value, lineAccountId.value);
    if (!row) return c.json({ success: false, error: 'knowledge import not found' }, 404);
    if (row.status === 'dismissed') return c.json({ success: false, error: 'dismissed knowledge imports cannot be published' }, 409);

    const existingManual = row.manual_id
      ? await c.env.DB.prepare(`SELECT * FROM support_manuals WHERE id = ? AND line_account_id = ?`).bind(row.manual_id, lineAccountId.value).first<SupportManualRow>()
      : null;
    if (row.status === 'published' && existingManual) {
      return c.json({ success: true, data: { import: serializeKnowledgeImport(row), manual: serializeManual(existingManual) } });
    }
    if (!row.title.trim() || !row.body.trim()) return c.json({ success: false, error: 'title and body are required' }, 400);

    const staff = currentStaff(c);
    const now = jstNow();
    const publishOutcome = await publishKnowledgeImportRow(c.env.DB, lineAccountId.value, row, staff, now);
    if (publishOutcome.outcome === 'skipped' || !publishOutcome.manualId) {
      return c.json({ success: false, error: 'knowledge import cannot be published' }, 409);
    }
    const [updated, manual] = await Promise.all([
      getKnowledgeImportRow(c.env.DB, row.id, lineAccountId.value),
      c.env.DB.prepare(`SELECT * FROM support_manuals WHERE id = ? AND line_account_id = ?`).bind(publishOutcome.manualId, lineAccountId.value).first<SupportManualRow>(),
    ]);
    return c.json({ success: true, data: { import: serializeKnowledgeImport(updated!), manual: serializeManual(manual!) } });
  } catch (err) {
    console.error(`POST /api/support/knowledge-imports/:id/publish error: ${supportRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { support };

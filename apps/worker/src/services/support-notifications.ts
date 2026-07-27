import { jstNow, toJstString } from '@line-crm/db';

export const SUPPORT_NOTIFICATION_SETTING_KEY = 'support_slack_notifications';
const SUPPORT_NOTIFICATION_STATE_KEY = 'support_slack_notification_state';
const SUPPORT_NOTIFICATION_DIGEST_EVENT = 'slack_digest_sent';
const SUPPORT_NOTIFICATION_URGENT_EVENT = 'slack_urgent_sent';
const SUPPORT_TICKET_CREATED_EVENT = 'slack_ticket_created_sent';
const SUPPORT_TICKET_STATE_CONFLICT_EVENT = 'slack_ticket_created_state_conflict';
const SUPPORT_SECONDARY_ASSIGNED_EVENT = 'slack_secondary_assigned_sent';
const SUPPORT_SECONDARY_REOPENED_EVENT = 'slack_secondary_reopened_sent';
const SUPPORT_SECONDARY_STATE_CONFLICT_EVENT = 'slack_secondary_state_conflict';
const SUPPORT_SLACK_NOTIFICATION_REISSUED_EVENT = 'slack_notification_reissued';

const DEFAULT_DIGEST_HOURS = [12, 14, 17];
const DEFAULT_DUE_SOON_HOURS = 4;
const MAX_DIGEST_CASES = 80;
const MAX_TICKET_NOTIFICATION_BATCH = 30;
const TICKET_NOTIFICATION_STALE_MINUTES = 10;
const MAX_TICKET_NOTIFICATION_ATTEMPTS = 8;
const SLACK_API_TIMEOUT_MS = 10_000;
const URGENT_SLACK_ATTACHMENT_COLOR = '#e01e5a';
const SLACK_SECTION_TEXT_LIMIT = 3000;
const SLACK_FIELD_TEXT_LIMIT = 2000;

export type SupportNotificationSettings = {
  enabled: boolean;
  webhookUrl: string | null;
  immediateUrgent: boolean;
  digestEnabled: boolean;
  digestHours: number[];
  dueSoonHours: number;
};

export type PublicSupportNotificationSettings = Omit<SupportNotificationSettings, 'webhookUrl'> & {
  webhookConfigured: boolean;
};

export type SupportNotificationSettingsPatch = Partial<Omit<SupportNotificationSettings, 'webhookUrl'>> & {
  webhookUrl?: string | null;
};

type SupportNotificationState = {
  lastDigestKey: string | null;
};

type SupportNotificationCaseRow = {
  id: string;
  line_account_id: string | null;
  friend_name?: string | null;
  title: string;
  priority: string;
  status: string;
  primary_assignee: string | null;
  escalation_assignee: string | null;
  due_at: string | null;
  customer_number?: string | null;
  company_name?: string | null;
  contact_name?: string | null;
  customer_summary?: string | null;
  created_at?: string | null;
  updated_at: string;
};

type WebhookSender = (url: string, payload: Record<string, unknown>) => Promise<void>;

type NotificationRuntime = {
  adminPublicUrl?: string;
  sendWebhook?: WebhookSender;
  now?: Date;
};

export type SupportTicketSlackSnapshot = {
  notificationId?: string;
  notificationKind?: 'ticket_created' | 'secondary_assigned' | 'secondary_reopened';
  caseId: string;
  title: string;
  priority: string;
  primaryAssignee: string;
  secondaryAssignees: Array<{
    name: string;
    staffId: string | null;
  }>;
  customerSummary: string;
  customerNumber: string | null;
  companyName: string | null;
  contactName: string | null;
  dueAt: string | null;
};

type SupportSlackOutboxRow = {
  id: string;
  case_id: string;
  line_account_id: string;
  payload: string;
  status: 'pending' | 'sending' | 'failed' | 'dead_letter' | 'sent';
  attempts: number;
  next_attempt_at: string;
  claim_token: string | null;
  slack_message_ts: string | null;
  sent_at: string | null;
  updated_at: string;
};

type SupportSlackQueue = 'ticket_created' | 'secondary_event';

const SUPPORT_SLACK_QUEUE_CONFIG: Record<SupportSlackQueue, {
  tableName: string;
  notificationFilter: string;
}> = {
  ticket_created: {
    tableName: 'support_slack_notification_outbox',
    notificationFilter: "notification_type = 'ticket_created'",
  },
  secondary_event: {
    tableName: 'support_secondary_slack_notification_outbox',
    notificationFilter: "notification_type IN ('secondary_assigned', 'secondary_reopened')",
  },
};

type SlackMessageSender = (
  token: string,
  payload: Record<string, unknown>,
) => Promise<{ messageTs: string | null }>;

type SlackMessageDeleter = (
  token: string,
  channelId: string,
  messageTs: string,
) => Promise<void>;

type SlackMessageUpdater = (
  token: string,
  channelId: string,
  messageTs: string,
  payload: Record<string, unknown>,
) => Promise<void>;

export type SupportTicketSlackRuntime = {
  adminPublicUrl?: string;
  slackBotToken?: string;
  slackChannelId?: string;
  slackMentionMap?: string;
  sendSlackMessage?: SlackMessageSender;
  deleteSlackMessage?: SlackMessageDeleter;
  updateSlackMessage?: SlackMessageUpdater;
  now?: Date;
};

export type SupportSlackReissueResult = {
  selected: number;
  previewOnly: boolean;
  reissued: number;
  updatedInPlace: number;
  oldMessagesDeleted: number;
  extraMessagesDeleted: number;
  failures: Array<{
    queue: 'ticket_created' | 'secondary_event' | 'extra';
    outboxId: string | null;
    messageTs: string | null;
    reason: string;
  }>;
};

export type SupportTicketSlackHealth = {
  pending: number;
  sending: number;
  failed: number;
  deadLetter: number;
  sent: number;
  lastUpdatedAt: string | null;
};

class SlackDeliveryError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | null;

  constructor(code: string, retryable: boolean, retryAfterSeconds: number | null = null) {
    super('Slack message delivery failed');
    this.name = 'SlackDeliveryError';
    this.code = code;
    this.retryable = retryable;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function defaultSettings(): SupportNotificationSettings {
  return {
    enabled: false,
    webhookUrl: null,
    immediateUrgent: true,
    digestEnabled: true,
    digestHours: DEFAULT_DIGEST_HOURS,
    dueSoonHours: DEFAULT_DUE_SOON_HOURS,
  };
}

function safeText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizedStaffName(value: string): string {
  return value.trim().replace(/[\s　]+/g, ' ');
}

function validSlackUserId(value: unknown): value is string {
  return typeof value === 'string' && /^[UW][A-Z0-9]+$/.test(value);
}

export function parseSupportSlackMentionMap(raw: string | null | undefined): Map<string, string> {
  const result = new Map<string, string>();
  if (!raw) return result;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return result;
    for (const [name, userId] of Object.entries(parsed as Record<string, unknown>)) {
      const normalizedName = normalizedStaffName(name);
      if (normalizedName && validSlackUserId(userId)) result.set(normalizedName, userId);
    }
  } catch {
    return result;
  }
  return result;
}

function normalizedHours(raw: unknown, fallback = DEFAULT_DIGEST_HOURS): number[] {
  if (!Array.isArray(raw)) return fallback;
  const seen = new Set<number>();
  const hours: number[] = [];
  for (const item of raw) {
    const hour = typeof item === 'number' ? item : Number(item);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23 || seen.has(hour)) continue;
    seen.add(hour);
    hours.push(hour);
  }
  return hours.length > 0 ? hours.sort((a, b) => a - b) : fallback;
}

function normalizedDueSoonHours(raw: unknown, fallback = DEFAULT_DUE_SOON_HOURS): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(72, Math.floor(value)));
}

export function parseSupportNotificationSettings(raw: string | null | undefined): SupportNotificationSettings {
  const fallback = defaultSettings();
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;
    const row = parsed as Record<string, unknown>;
    return {
      enabled: row.enabled === true,
      webhookUrl: safeText(row.webhookUrl),
      immediateUrgent: row.immediateUrgent !== false,
      digestEnabled: row.digestEnabled !== false,
      digestHours: normalizedHours(row.digestHours),
      dueSoonHours: normalizedDueSoonHours(row.dueSoonHours),
    };
  } catch {
    return fallback;
  }
}

export function publicSupportNotificationSettings(
  settings: SupportNotificationSettings,
): PublicSupportNotificationSettings {
  return {
    enabled: settings.enabled,
    webhookConfigured: Boolean(settings.webhookUrl),
    immediateUrgent: settings.immediateUrgent,
    digestEnabled: settings.digestEnabled,
    digestHours: settings.digestHours,
    dueSoonHours: settings.dueSoonHours,
  };
}

async function readAccountSetting(db: D1Database, accountId: string, key: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT value FROM account_settings WHERE line_account_id = ? AND key = ?`)
    .bind(accountId, key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

async function upsertAccountSetting(db: D1Database, accountId: string, key: string, value: string): Promise<void> {
  const now = jstNow();
  await db
    .prepare(
      `INSERT INTO account_settings (id, line_account_id, key, value, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (line_account_id, key) DO UPDATE SET value = ?, updated_at = ?`,
    )
    .bind(crypto.randomUUID(), accountId, key, value, now, now, value, now)
    .run();
}

export async function getSupportNotificationSettings(
  db: D1Database,
  accountId: string,
): Promise<SupportNotificationSettings> {
  return parseSupportNotificationSettings(await readAccountSetting(db, accountId, SUPPORT_NOTIFICATION_SETTING_KEY));
}

export async function setSupportNotificationSettings(
  db: D1Database,
  accountId: string,
  patch: SupportNotificationSettingsPatch,
): Promise<SupportNotificationSettings> {
  const current = await getSupportNotificationSettings(db, accountId);
  const next: SupportNotificationSettings = {
    enabled: patch.enabled ?? current.enabled,
    webhookUrl: patch.webhookUrl === undefined ? current.webhookUrl : safeText(patch.webhookUrl),
    immediateUrgent: patch.immediateUrgent ?? current.immediateUrgent,
    digestEnabled: patch.digestEnabled ?? current.digestEnabled,
    digestHours: normalizedHours(patch.digestHours, current.digestHours),
    dueSoonHours: normalizedDueSoonHours(patch.dueSoonHours, current.dueSoonHours),
  };
  await upsertAccountSetting(db, accountId, SUPPORT_NOTIFICATION_SETTING_KEY, JSON.stringify(next));
  return next;
}

function parseNotificationState(raw: string | null | undefined): SupportNotificationState {
  if (!raw) return { lastDigestKey: null };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { lastDigestKey: null };
    const value = safeText((parsed as Record<string, unknown>).lastDigestKey);
    return { lastDigestKey: value };
  } catch {
    return { lastDigestKey: null };
  }
}

async function getNotificationState(db: D1Database, accountId: string): Promise<SupportNotificationState> {
  return parseNotificationState(await readAccountSetting(db, accountId, SUPPORT_NOTIFICATION_STATE_KEY));
}

async function setNotificationState(db: D1Database, accountId: string, state: SupportNotificationState): Promise<void> {
  await upsertAccountSetting(db, accountId, SUPPORT_NOTIFICATION_STATE_KEY, JSON.stringify(state));
}

function supportUrl(adminPublicUrl: string | undefined, caseId?: string): string {
  const base = (adminPublicUrl || '').replace(/\/+$/, '');
  if (!base) return caseId ? `/support?case=${encodeURIComponent(caseId)}` : '/support';
  return caseId ? `${base}/support?case=${encodeURIComponent(caseId)}` : `${base}/support`;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function slackEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function plainValue(value: unknown, fallback = '未入力'): string {
  return safeText(value) ?? fallback;
}

function slackField(label: string, value: unknown): { type: 'mrkdwn'; text: string } {
  const text = `*${label}*\n${slackEscape(plainValue(value))}`;
  return { type: 'mrkdwn', text: truncateText(text, SLACK_FIELD_TEXT_LIMIT) };
}

function parseJstTimestamp(value: string | null | undefined): Date | null {
  const raw = safeText(value);
  if (!raw) return null;
  const normalized = /(?:Z|[+-]\d{2}:\d{2})$/i.test(raw) ? raw : `${raw}+09:00`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatJstShort(value: string | null | undefined, now: Date): string | null {
  const date = parseJstTimestamp(value);
  if (!date) return null;
  const target = toJstString(date);
  const current = toJstString(now);
  const time = target.slice(11, 16);
  if (target.slice(0, 10) === current.slice(0, 10)) return `本日 ${time}`;
  const month = Number(target.slice(5, 7));
  const day = Number(target.slice(8, 10));
  return `${month}/${day} ${time}`;
}

function formatElapsedSince(value: string | null | undefined, now: Date): string {
  const date = parseJstTimestamp(value);
  if (!date) return '不明';
  const diffMs = Math.max(0, now.getTime() - date.getTime());
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return '1分未満';
  if (minutes < 60) return `約${minutes}分`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `約${hours}時間`;
  return `約${Math.floor(hours / 24)}日`;
}

function customerName(row: SupportNotificationCaseRow): string {
  return plainValue(row.contact_name ?? row.friend_name);
}

function inquiryText(row: SupportNotificationCaseRow): string {
  return plainValue(row.customer_summary, row.title);
}

function buildUrgentSlackPayload(
  row: SupportNotificationCaseRow,
  url: string,
  now: Date,
): Record<string, unknown> {
  const title = plainValue(row.title, '件名未入力');
  const summary = inquiryText(row);
  const created = formatJstShort(row.created_at, now) ?? '不明';
  const elapsed = formatElapsedSince(row.created_at, now);
  const due = row.due_at ? `${formatJstShort(row.due_at, now) ?? row.due_at} まで` : '未設定';
  const assignee = ownerLabel(row);
  const fallback = [
    `:rotating_light: 【大至急】${title}`,
    `顧客番号: ${plainValue(row.customer_number)}`,
    `法人名: ${plainValue(row.company_name)}`,
    `顧客名: ${customerName(row)}`,
    `問い合わせ概要: ${truncateText(summary, 180)}`,
    `発生: ${created} (経過:${elapsed})`,
    `期限: ${due}`,
    `チケットURL: ${url}`,
  ].join('\n');
  const blocks: Array<Record<string, unknown>> = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: '大至急チケット',
        emoji: true,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: truncateText(`*${slackEscape(title)}*`, SLACK_SECTION_TEXT_LIMIT),
      },
    },
    {
      type: 'section',
      fields: [
        slackField('顧客番号', row.customer_number),
        slackField('法人名', row.company_name),
        slackField('顧客名', customerName(row)),
        slackField('担当者', assignee),
        slackField('発生', `${created} (経過:${elapsed})`),
        slackField('期限', due),
      ],
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: truncateText(`*問い合わせ概要*\n${slackEscape(summary)}`, SLACK_SECTION_TEXT_LIMIT),
      },
    },
  ];
  if (isHttpUrl(url)) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'チケットを開く',
            emoji: true,
          },
          style: 'danger',
          url,
          value: row.id,
          action_id: 'open_urgent_support_case',
        },
      ],
    });
  }
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: '通知条件: 緊急度が「大至急」のチケット',
      },
    ],
  });
  return {
    text: truncateText(fallback, 4000),
    attachments: [
      {
        color: URGENT_SLACK_ATTACHMENT_COLOR,
        blocks,
      },
    ],
  };
}

function priorityLabel(priority: string): string {
  switch (priority) {
    case 'urgent':
      return ':rotating_light: 大至急';
    case 'high':
      return ':warning: 緊急';
    case 'low':
      return ':white_circle: 低';
    default:
      return ':large_blue_circle: 通常';
  }
}

function compactSlackSummary(value: string): string {
  return truncateText(value.replace(/\s+/g, ' ').trim(), 160);
}

function parseTicketSlackSnapshot(raw: string): SupportTicketSlackSnapshot | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const row = parsed as Record<string, unknown>;
    const caseId = safeText(row.caseId);
    const title = safeText(row.title);
    const primaryAssignee = safeText(row.primaryAssignee);
    const customerSummary = safeText(row.customerSummary);
    if (!caseId || !title || !primaryAssignee || !customerSummary) return null;
    if (!Array.isArray(row.secondaryAssignees)) return null;

    const secondaryAssignees: SupportTicketSlackSnapshot['secondaryAssignees'] = [];
    const seen = new Set<string>();
    for (const value of row.secondaryAssignees.slice(0, 10)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const assignee = value as Record<string, unknown>;
      const name = safeText(assignee.name);
      if (!name) continue;
      const normalized = normalizedStaffName(name);
      if (!seen.has(normalized)) {
        seen.add(normalized);
        secondaryAssignees.push({
          name,
          staffId: safeText(assignee.staffId),
        });
      }
    }
    if (secondaryAssignees.length === 0) return null;
    const notificationKind = safeText(row.notificationKind);
    if (
      notificationKind
      && !['ticket_created', 'secondary_assigned', 'secondary_reopened'].includes(notificationKind)
    ) {
      return null;
    }

    return {
      notificationId: safeText(row.notificationId) ?? undefined,
      notificationKind: (notificationKind as SupportTicketSlackSnapshot['notificationKind']) ?? 'ticket_created',
      caseId,
      title,
      priority: safeText(row.priority) ?? 'medium',
      primaryAssignee,
      secondaryAssignees,
      customerSummary,
      customerNumber: safeText(row.customerNumber),
      companyName: safeText(row.companyName),
      contactName: safeText(row.contactName),
      dueAt: safeText(row.dueAt),
    };
  } catch {
    return null;
  }
}

function ticketMentionText(
  assignees: SupportTicketSlackSnapshot['secondaryAssignees'],
  mentionMap: Map<string, string>,
): { text: string; unmappedAssignees: string[] } {
  const unmappedAssignees: string[] = [];
  const targets = assignees.map((assignee) => {
    const slackUserId = (
      (assignee.staffId ? mentionMap.get(assignee.staffId) : null)
      ?? mentionMap.get(normalizedStaffName(assignee.name))
    );
    if (slackUserId) return `<@${slackUserId}>`;
    unmappedAssignees.push(assignee.name);
    return `*${slackEscape(assignee.name)}*`;
  });
  return { text: targets.join(' '), unmappedAssignees };
}

function supportSlackNotificationLabel(
  kind: SupportTicketSlackSnapshot['notificationKind'],
): { title: string; fallbackPrefix: string; actionId: string } {
  if (kind === 'secondary_assigned') {
    return {
      title: '二次対応が追加されました',
      fallbackPrefix: 'L-Link 二次対応追加',
      actionId: 'open_assigned_support_case',
    };
  }
  if (kind === 'secondary_reopened') {
    return {
      title: '二次対応が再開されました',
      fallbackPrefix: 'L-Link 二次対応再開',
      actionId: 'open_reopened_support_case',
    };
  }
  return {
    title: '二次対応をお願いします',
    fallbackPrefix: 'L-Link 二次対応チケット',
    actionId: 'open_created_support_case',
  };
}

export function buildTicketCreatedSlackPayload(
  snapshot: SupportTicketSlackSnapshot,
  input: {
    channelId: string;
    url: string;
    mentionMap: Map<string, string>;
    now?: Date;
  },
): { payload: Record<string, unknown>; unmappedAssignees: string[] } {
  if (!isHttpUrl(input.url)) {
    throw new SlackDeliveryError('ticket_url_invalid', false);
  }
  const mentions = ticketMentionText(snapshot.secondaryAssignees, input.mentionMap);
  const label = supportSlackNotificationLabel(snapshot.notificationKind ?? 'ticket_created');
  const title = truncateText(snapshot.title, 120);
  const summary = compactSlackSummary(snapshot.customerSummary);
  const priority = priorityLabel(snapshot.priority);
  const due = snapshot.dueAt
    ? (formatJstShort(snapshot.dueAt, input.now ?? new Date()) ?? snapshot.dueAt)
    : '未設定';
  const fallback = [
    mentions.text,
    `${priority} ${label.title}`,
    `【${label.fallbackPrefix}】${slackEscape(title)}`,
    `確認内容: ${slackEscape(summary)}`,
    `一次対応: ${slackEscape(snapshot.primaryAssignee)}`,
    `期限: ${slackEscape(due)}`,
    `チケットURL: ${input.url}`,
  ].join('\n');
  const blocks: Array<Record<string, unknown>> = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: truncateText(
          `${mentions.text}\n${priority} *${slackEscape(label.title)}*`,
          SLACK_SECTION_TEXT_LIMIT,
        ),
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: truncateText(
          `:ticket: *${slackEscape(title)}*\n\n*確認してほしいこと*\n${slackEscape(summary)}`,
          SLACK_SECTION_TEXT_LIMIT,
        ),
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: truncateText(
          `*一次対応*　${slackEscape(snapshot.primaryAssignee)}\n*期限*　${slackEscape(due)}`,
          SLACK_SECTION_TEXT_LIMIT,
        ),
      },
    },
  ];
  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: {
          type: 'plain_text',
          text: '今すぐチケットを確認する →',
          emoji: true,
        },
        url: input.url,
        value: snapshot.caseId,
        action_id: label.actionId,
        style: 'primary',
      },
    ],
  });
  return {
    payload: {
      channel: input.channelId,
      text: truncateText(fallback, 4000),
      blocks,
      unfurl_links: false,
      unfurl_media: false,
      client_msg_id: snapshot.notificationId ?? snapshot.caseId,
    },
    unmappedAssignees: mentions.unmappedAssignees,
  };
}

function jstParts(now: Date): { date: string; hour: number; minute: number; nowText: string } {
  const iso = toJstString(now);
  return {
    date: iso.slice(0, 10),
    hour: Number(iso.slice(11, 13)),
    minute: Number(iso.slice(14, 16)),
    nowText: iso,
  };
}

function isSecondaryWaiting(status: string): boolean {
  return status === 'escalated' || status === 'waiting_secondary';
}

function ownerLabel(row: SupportNotificationCaseRow): string {
  if (row.status === 'secondary_answered') return '二次対応回答済み';
  if (row.status === 'customer_reply') return '顧客返信待ち';
  if (isSecondaryWaiting(row.status)) return row.escalation_assignee || '二次対応先未設定';
  return row.primary_assignee || '担当者なし';
}

function formatCaseLine(row: SupportNotificationCaseRow): string {
  const customer = row.friend_name ? ` / ${row.friend_name}` : '';
  const due = row.due_at ? ` / 期限 ${row.due_at}` : '';
  return `- ${row.title}${customer} / ${ownerLabel(row)}${due}`;
}

async function sendWebhook(url: string, payload: Record<string, unknown>, sender?: WebhookSender): Promise<void> {
  if (sender) {
    await sender(url, payload);
    return;
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`support notification webhook failed: ${res.status}`);
}

async function sendSlackMessage(
  token: string,
  payload: Record<string, unknown>,
  sender?: SlackMessageSender,
): Promise<{ messageTs: string | null }> {
  if (sender) return sender(token, payload);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SLACK_API_TIMEOUT_MS);
  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      const retryAfter = Number(res.headers.get('Retry-After'));
      throw new SlackDeliveryError(
        `http_${res.status}`,
        res.status === 429 || res.status >= 500,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
      );
    }
    const parsed = await res.json() as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new SlackDeliveryError('invalid_response', false);
    }
    const response = parsed as Record<string, unknown>;
    if (response.ok !== true) {
      const errorCode = safeText(response.error) ?? 'slack_api_error';
      const retryable = new Set([
        'ratelimited',
        'internal_error',
        'fatal_error',
        'request_timeout',
        'service_unavailable',
      ]).has(errorCode);
      throw new SlackDeliveryError(errorCode, retryable);
    }
    return { messageTs: safeText(response.ts) };
  } catch (error) {
    if (error instanceof SlackDeliveryError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new SlackDeliveryError('timeout', true);
    }
    throw new SlackDeliveryError('network_error', true);
  } finally {
    clearTimeout(timeout);
  }
}

async function deleteSlackMessage(
  token: string,
  channelId: string,
  messageTs: string,
  deleter?: SlackMessageDeleter,
): Promise<void> {
  if (deleter) {
    await deleter(token, channelId, messageTs);
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SLACK_API_TIMEOUT_MS);
  try {
    const res = await fetch('https://slack.com/api/chat.delete', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ channel: channelId, ts: messageTs }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const retryAfter = Number(res.headers.get('Retry-After'));
      throw new SlackDeliveryError(
        `http_${res.status}`,
        res.status === 429 || res.status >= 500,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
      );
    }
    const parsed = await res.json() as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new SlackDeliveryError('invalid_response', false);
    }
    const response = parsed as Record<string, unknown>;
    if (response.ok === true || response.error === 'message_not_found') return;
    const errorCode = safeText(response.error) ?? 'slack_api_error';
    const retryable = new Set([
      'ratelimited',
      'internal_error',
      'fatal_error',
      'request_timeout',
      'service_unavailable',
    ]).has(errorCode);
    throw new SlackDeliveryError(errorCode, retryable);
  } catch (error) {
    if (error instanceof SlackDeliveryError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new SlackDeliveryError('timeout', true);
    }
    throw new SlackDeliveryError('network_error', true);
  } finally {
    clearTimeout(timeout);
  }
}

async function updateSlackMessage(
  token: string,
  channelId: string,
  messageTs: string,
  payload: Record<string, unknown>,
  updater?: SlackMessageUpdater,
): Promise<void> {
  const { channel: _channel, client_msg_id: _clientMessageId, ...message } = payload;
  const updatePayload = {
    ...message,
    channel: channelId,
    ts: messageTs,
    attachments: Array.isArray(message.attachments) ? message.attachments : [],
  };
  if (updater) {
    await updater(token, channelId, messageTs, updatePayload);
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SLACK_API_TIMEOUT_MS);
  try {
    const res = await fetch('https://slack.com/api/chat.update', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(updatePayload),
      signal: controller.signal,
    });
    if (!res.ok) {
      const retryAfter = Number(res.headers.get('Retry-After'));
      throw new SlackDeliveryError(
        `http_${res.status}`,
        res.status === 429 || res.status >= 500,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
      );
    }
    const parsed = await res.json() as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new SlackDeliveryError('invalid_response', false);
    }
    const response = parsed as Record<string, unknown>;
    if (response.ok === true) return;
    const errorCode = safeText(response.error) ?? 'slack_api_error';
    const retryable = new Set([
      'ratelimited',
      'internal_error',
      'fatal_error',
      'request_timeout',
      'service_unavailable',
    ]).has(errorCode);
    throw new SlackDeliveryError(errorCode, retryable);
  } catch (error) {
    if (error instanceof SlackDeliveryError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new SlackDeliveryError('timeout', true);
    }
    throw new SlackDeliveryError('network_error', true);
  } finally {
    clearTimeout(timeout);
  }
}

async function addNotificationEvent(
  db: D1Database,
  caseId: string,
  eventType: string,
  body: string,
  metadata: Record<string, unknown>,
): Promise<void> {
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
      'system',
      'system',
      body,
      JSON.stringify(metadata),
      jstNow(),
    )
    .run();
}

async function getCaseForNotification(
  db: D1Database,
  caseId: string,
  accountId: string,
): Promise<SupportNotificationCaseRow | null> {
  return db
    .prepare(
      `SELECT sc.id, sc.line_account_id, sc.title, sc.priority, sc.status,
              sc.primary_assignee, sc.escalation_assignee, sc.due_at, sc.updated_at,
              sc.customer_number, sc.company_name, sc.contact_name, sc.customer_summary,
              sc.created_at,
              f.display_name AS friend_name
       FROM support_cases sc
       LEFT JOIN friends f ON f.id = sc.friend_id
       WHERE sc.id = ? AND sc.line_account_id = ?`,
    )
    .bind(caseId, accountId)
    .first<SupportNotificationCaseRow>();
}

async function hasUrgentNotificationEvent(db: D1Database, caseId: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT id FROM support_case_events WHERE case_id = ? AND event_type = ? LIMIT 1`)
    .bind(caseId, SUPPORT_NOTIFICATION_URGENT_EVENT)
    .first<{ id: string }>();
  return Boolean(row);
}

export async function notifyUrgentSupportCase(
  db: D1Database,
  accountId: string,
  caseId: string,
  runtime: NotificationRuntime = {},
): Promise<{ sent: boolean; reason: string }> {
  try {
    const settings = await getSupportNotificationSettings(db, accountId);
    if (!settings.enabled) return { sent: false, reason: 'disabled' };
    if (!settings.immediateUrgent) return { sent: false, reason: 'urgent_disabled' };
    if (!settings.webhookUrl) return { sent: false, reason: 'webhook_missing' };
    if (await hasUrgentNotificationEvent(db, caseId)) return { sent: false, reason: 'already_sent' };

    const row = await getCaseForNotification(db, caseId, accountId);
    if (!row) return { sent: false, reason: 'case_not_found' };
    if (row.priority !== 'urgent' || row.status === 'resolved') return { sent: false, reason: 'not_urgent' };

    const url = supportUrl(runtime.adminPublicUrl, row.id);
    const payload = buildUrgentSlackPayload(row, url, runtime.now ?? new Date());

    await sendWebhook(settings.webhookUrl, payload, runtime.sendWebhook);
    await addNotificationEvent(db, row.id, SUPPORT_NOTIFICATION_URGENT_EVENT, '大至急Slack通知を送信しました', {
      channel: 'slack',
      priority: row.priority,
      status: row.status,
    });
    return { sent: true, reason: 'sent' };
  } catch (err) {
    console.error(`support urgent notification error: ${err instanceof Error ? err.name : typeof err}`);
    return { sent: false, reason: 'error' };
  }
}

function ticketRetryAt(now: Date, attempt: number, retryAfterSeconds: number | null = null): string {
  const delayMs = retryAfterSeconds
    ? Math.min(60 * 60, Math.max(1, retryAfterSeconds)) * 1000
    : Math.min(60, 2 ** Math.min(Math.max(attempt - 1, 0), 6)) * 60_000;
  return toJstString(new Date(now.getTime() + delayMs));
}

function slackDeliveryFailure(error: unknown): {
  code: string;
  retryable: boolean;
  retryAfterSeconds: number | null;
} {
  if (error instanceof SlackDeliveryError) {
    return {
      code: error.code,
      retryable: error.retryable,
      retryAfterSeconds: error.retryAfterSeconds,
    };
  }
  return { code: 'delivery_error', retryable: true, retryAfterSeconds: null };
}

async function getSupportSlackOutboxRow(
  db: D1Database,
  outboxId: string,
  queue: SupportSlackQueue,
): Promise<SupportSlackOutboxRow | null> {
  const config = SUPPORT_SLACK_QUEUE_CONFIG[queue];
  return db
    .prepare(
      `SELECT id, case_id, line_account_id, payload, status, attempts, next_attempt_at, claim_token, updated_at
       FROM ${config.tableName}
       WHERE id = ? AND ${config.notificationFilter}`,
    )
    .bind(outboxId)
    .first<SupportSlackOutboxRow>();
}

async function markSupportSlackDeliveryFailed(
  db: D1Database,
  outboxId: string,
  claimToken: string,
  failure: { code: string; retryable: boolean; retryAfterSeconds: number | null },
  attempt: number,
  now: Date,
  queue: SupportSlackQueue,
): Promise<void> {
  const config = SUPPORT_SLACK_QUEUE_CONFIG[queue];
  const nowText = toJstString(now);
  const shouldRetry = failure.retryable && attempt < MAX_TICKET_NOTIFICATION_ATTEMPTS;
  await db
    .prepare(
      `UPDATE ${config.tableName}
       SET status = ?, last_error_code = ?, next_attempt_at = ?, updated_at = ?
       WHERE id = ? AND status = 'sending' AND claim_token = ?`,
    )
    .bind(
      shouldRetry ? 'failed' : 'dead_letter',
      failure.code,
      ticketRetryAt(now, attempt, failure.retryAfterSeconds),
      nowText,
      outboxId,
      claimToken,
    )
    .run();
}

async function resolveTicketSlackMentionMap(
  db: D1Database,
  snapshot: SupportTicketSlackSnapshot,
  configuredMap: string | undefined,
): Promise<Map<string, string>> {
  const mentionMap = new Map<string, string>();
  const staffIds = snapshot.secondaryAssignees
    .map((assignee) => assignee.staffId)
    .filter((staffId): staffId is string => Boolean(staffId));
  if (staffIds.length > 0) {
    const placeholders = staffIds.map(() => '?').join(', ');
    const rows = await db
      .prepare(
        `SELECT id, slack_user_id
         FROM staff_members
         WHERE id IN (${placeholders}) AND is_active = 1 AND slack_user_id IS NOT NULL`,
      )
      .bind(...staffIds)
      .all<{ id: string; slack_user_id: string }>();
    for (const row of rows.results) {
      if (validSlackUserId(row.slack_user_id)) mentionMap.set(row.id, row.slack_user_id);
    }
  }

  // Environment mapping is a deployment-time fallback for staff not configured in DB yet.
  const fallbackMap = parseSupportSlackMentionMap(configuredMap);
  for (const assignee of snapshot.secondaryAssignees) {
    if (assignee.staffId && mentionMap.has(assignee.staffId)) continue;
    const fallback = (
      (assignee.staffId ? fallbackMap.get(assignee.staffId) : null)
      ?? fallbackMap.get(normalizedStaffName(assignee.name))
    );
    if (fallback) mentionMap.set(assignee.staffId ?? normalizedStaffName(assignee.name), fallback);
  }
  return mentionMap;
}

async function deliverSupportSlackNotification(
  db: D1Database,
  outboxId: string,
  runtime: SupportTicketSlackRuntime = {},
  queue: SupportSlackQueue,
): Promise<{ sent: boolean; reason: string }> {
  const token = runtime.slackBotToken?.trim();
  const channelId = runtime.slackChannelId?.trim();
  if (!token) return { sent: false, reason: 'token_missing' };
  if (!channelId) return { sent: false, reason: 'channel_missing' };

  const now = runtime.now ?? new Date();
  const nowText = toJstString(now);
  const config = SUPPORT_SLACK_QUEUE_CONFIG[queue];
  const row = await getSupportSlackOutboxRow(db, outboxId, queue);
  if (!row) return { sent: false, reason: 'outbox_not_found' };
  if (row.status === 'sent') return { sent: false, reason: 'already_sent' };

  const staleBefore = toJstString(new Date(now.getTime() - TICKET_NOTIFICATION_STALE_MINUTES * 60_000));
  const claimToken = crypto.randomUUID();
  const claim = await db
    .prepare(
      `UPDATE ${config.tableName}
       SET status = 'sending', attempts = attempts + 1, claim_token = ?,
           last_error_code = NULL, updated_at = ?
       WHERE id = ?
         AND (
           (status IN ('pending', 'failed') AND next_attempt_at <= ?)
           OR (status = 'sending' AND updated_at <= ?)
         )`,
    )
    .bind(claimToken, nowText, outboxId, nowText, staleBefore)
    .run();
  if (Number(claim.meta.changes ?? 0) === 0) return { sent: false, reason: 'not_due_or_claimed' };

  const attempt = row.attempts + 1;
  const snapshot = parseTicketSlackSnapshot(row.payload);
  if (!snapshot) {
    await markSupportSlackDeliveryFailed(
      db,
      outboxId,
      claimToken,
      { code: 'invalid_payload', retryable: false, retryAfterSeconds: null },
      attempt,
      now,
      queue,
    );
    return { sent: false, reason: 'invalid_payload' };
  }

  const mentionMap = await resolveTicketSlackMentionMap(db, snapshot, runtime.slackMentionMap);
  const url = supportUrl(runtime.adminPublicUrl, snapshot.caseId);
  let built: ReturnType<typeof buildTicketCreatedSlackPayload>;
  try {
    built = buildTicketCreatedSlackPayload(snapshot, {
      channelId,
      url,
      mentionMap,
      now,
    });
  } catch (error) {
    const failure = slackDeliveryFailure(error);
    await markSupportSlackDeliveryFailed(
      db,
      outboxId,
      claimToken,
      failure,
      attempt,
      now,
      queue,
    );
    console.error(`support ticket Slack notification error: ${failure.code}`);
    return { sent: false, reason: 'delivery_failed' };
  }
  if (built.unmappedAssignees.length > 0) {
    await markSupportSlackDeliveryFailed(
      db,
      outboxId,
      claimToken,
      { code: 'mention_mapping_missing', retryable: true, retryAfterSeconds: 60 * 60 },
      attempt,
      now,
      queue,
    );
    console.error('support ticket Slack notification error: mention_mapping_missing');
    return { sent: false, reason: 'delivery_failed' };
  }

  try {
    const delivered = await sendSlackMessage(token, built.payload, runtime.sendSlackMessage);
    const marked = await db
      .prepare(
        `UPDATE ${config.tableName}
         SET status = 'sent', slack_message_ts = ?, sent_at = ?, updated_at = ?
         WHERE id = ? AND status = 'sending' AND claim_token = ?`,
      )
      .bind(delivered.messageTs, nowText, nowText, outboxId, claimToken)
      .run();
    const stateConflict = Number(marked.meta.changes ?? 0) === 0;
    try {
      const notificationKind = snapshot.notificationKind ?? 'ticket_created';
      const successEventType = notificationKind === 'secondary_assigned'
        ? SUPPORT_SECONDARY_ASSIGNED_EVENT
        : notificationKind === 'secondary_reopened'
          ? SUPPORT_SECONDARY_REOPENED_EVENT
          : SUPPORT_TICKET_CREATED_EVENT;
      const successBody = notificationKind === 'secondary_assigned'
        ? '二次対応追加のSlack通知を送信しました'
        : notificationKind === 'secondary_reopened'
          ? '二次対応再開のSlack通知を送信しました'
          : 'チケット発行Slack通知を送信しました';
      await addNotificationEvent(
        db,
        snapshot.caseId,
        stateConflict
          ? (queue === 'secondary_event' ? SUPPORT_SECONDARY_STATE_CONFLICT_EVENT : SUPPORT_TICKET_STATE_CONFLICT_EVENT)
          : successEventType,
        stateConflict
          ? 'Slack送信後の通知状態更新が競合しました'
          : successBody,
        {
          channel: 'slack',
          channelId,
          priority: snapshot.priority,
          secondaryAssignees: snapshot.secondaryAssignees.map((assignee) => assignee.name),
          unmappedAssignees: built.unmappedAssignees,
          slackMessageTs: delivered.messageTs,
        },
      );
    } catch (error) {
      console.error(`support ticket Slack audit event error: ${error instanceof Error ? error.name : typeof error}`);
    }
    if (stateConflict) {
      console.error('support ticket Slack notification state conflict');
      return { sent: true, reason: 'sent_state_conflict' };
    }
    return { sent: true, reason: 'sent' };
  } catch (error) {
    const failure = slackDeliveryFailure(error);
    await markSupportSlackDeliveryFailed(db, outboxId, claimToken, failure, attempt, now, queue);
    console.error(`support ticket Slack notification error: ${failure.code}`);
    return { sent: false, reason: 'delivery_failed' };
  }
}

export async function deliverSupportTicketSlackNotification(
  db: D1Database,
  outboxId: string,
  runtime: SupportTicketSlackRuntime = {},
): Promise<{ sent: boolean; reason: string }> {
  return deliverSupportSlackNotification(db, outboxId, runtime, 'ticket_created');
}

export async function deliverSupportSecondarySlackNotification(
  db: D1Database,
  outboxId: string,
  runtime: SupportTicketSlackRuntime = {},
): Promise<{ sent: boolean; reason: string }> {
  return deliverSupportSlackNotification(db, outboxId, runtime, 'secondary_event');
}

async function getSupportSlackQueueHealth(
  db: D1Database,
  queue: SupportSlackQueue,
): Promise<SupportTicketSlackHealth> {
  const config = SUPPORT_SLACK_QUEUE_CONFIG[queue];
  const rows = await db
    .prepare(
      `SELECT status, COUNT(*) AS count, MAX(updated_at) AS last_updated_at
       FROM ${config.tableName}
       GROUP BY status`,
    )
    .all<{ status: string; count: number; last_updated_at: string | null }>();
  const health: SupportTicketSlackHealth = {
    pending: 0,
    sending: 0,
    failed: 0,
    deadLetter: 0,
    sent: 0,
    lastUpdatedAt: null,
  };
  for (const row of rows.results) {
    if (row.status === 'pending') health.pending = Number(row.count) || 0;
    else if (row.status === 'sending') health.sending = Number(row.count) || 0;
    else if (row.status === 'failed') health.failed = Number(row.count) || 0;
    else if (row.status === 'dead_letter') health.deadLetter = Number(row.count) || 0;
    else if (row.status === 'sent') health.sent = Number(row.count) || 0;
    if (row.last_updated_at && (!health.lastUpdatedAt || row.last_updated_at > health.lastUpdatedAt)) {
      health.lastUpdatedAt = row.last_updated_at;
    }
  }
  return health;
}

export async function getSupportTicketSlackNotificationHealth(
  db: D1Database,
): Promise<SupportTicketSlackHealth> {
  const [ticketHealth, secondaryHealth] = await Promise.all([
    getSupportSlackQueueHealth(db, 'ticket_created'),
    getSupportSlackQueueHealth(db, 'secondary_event'),
  ]);
  return {
    pending: ticketHealth.pending + secondaryHealth.pending,
    sending: ticketHealth.sending + secondaryHealth.sending,
    failed: ticketHealth.failed + secondaryHealth.failed,
    deadLetter: ticketHealth.deadLetter + secondaryHealth.deadLetter,
    sent: ticketHealth.sent + secondaryHealth.sent,
    lastUpdatedAt: [ticketHealth.lastUpdatedAt, secondaryHealth.lastUpdatedAt]
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? null,
  };
}

async function processPendingSupportSlackNotifications(
  db: D1Database,
  runtime: SupportTicketSlackRuntime = {},
  queue: SupportSlackQueue,
): Promise<{ sent: number; skipped: number; failed: number }> {
  if (!runtime.slackBotToken?.trim() || !runtime.slackChannelId?.trim()) {
    return { sent: 0, skipped: 1, failed: 0 };
  }
  const config = SUPPORT_SLACK_QUEUE_CONFIG[queue];
  const now = runtime.now ?? new Date();
  const nowText = toJstString(now);
  const staleBefore = toJstString(new Date(now.getTime() - TICKET_NOTIFICATION_STALE_MINUTES * 60_000));
  const rows = await db
    .prepare(
      `SELECT id
       FROM ${config.tableName}
       WHERE ${config.notificationFilter}
         AND (
           (status IN ('pending', 'failed') AND next_attempt_at <= ?)
           OR (status = 'sending' AND updated_at <= ?)
         )
       ORDER BY created_at ASC
       LIMIT ?`,
    )
    .bind(nowText, staleBefore, MAX_TICKET_NOTIFICATION_BATCH)
    .all<{ id: string }>();

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  for (const row of rows.results) {
    const result = await deliverSupportSlackNotification(db, row.id, { ...runtime, now }, queue);
    if (result.sent) sent += 1;
    else if (result.reason === 'delivery_failed' || result.reason === 'invalid_payload') failed += 1;
    else skipped += 1;
  }
  return { sent, skipped, failed };
}

export async function processPendingSupportTicketSlackNotifications(
  db: D1Database,
  runtime: SupportTicketSlackRuntime = {},
): Promise<{ sent: number; skipped: number; failed: number }> {
  return processPendingSupportSlackNotifications(db, runtime, 'ticket_created');
}

export async function processPendingSupportSecondarySlackNotifications(
  db: D1Database,
  runtime: SupportTicketSlackRuntime = {},
): Promise<{ sent: number; skipped: number; failed: number }> {
  return processPendingSupportSlackNotifications(db, runtime, 'secondary_event');
}

export async function requeueDeadLetterSupportSlackNotifications(
  db: D1Database,
  now: Date = new Date(),
): Promise<{ ticketCreated: number; secondaryEvents: number; total: number }> {
  const nowText = toJstString(now);
  const results: number[] = [];
  for (const queue of ['ticket_created', 'secondary_event'] as const) {
    const config = SUPPORT_SLACK_QUEUE_CONFIG[queue];
    const result = await db
      .prepare(
        `UPDATE ${config.tableName}
         SET status = 'pending', attempts = 0, next_attempt_at = ?,
             claim_token = NULL, last_error_code = NULL, updated_at = ?
         WHERE status = 'dead_letter'`,
      )
      .bind(nowText, nowText)
      .run();
    results.push(Number(result.meta.changes ?? 0));
  }
  return {
    ticketCreated: results[0] ?? 0,
    secondaryEvents: results[1] ?? 0,
    total: (results[0] ?? 0) + (results[1] ?? 0),
  };
}

export async function reissueSentSupportSlackNotifications(
  db: D1Database,
  runtime: SupportTicketSlackRuntime,
  input: {
    sentAfter: Date;
    sentBefore: Date;
    expectedCount: number;
    checkedMessageTs: string[];
    preserveMessageTs?: string[];
    previewOnly?: boolean;
    extraMessageTs?: string[];
  },
): Promise<SupportSlackReissueResult> {
  const result: SupportSlackReissueResult = {
    selected: 0,
    previewOnly: input.previewOnly === true,
    reissued: 0,
    updatedInPlace: 0,
    oldMessagesDeleted: 0,
    extraMessagesDeleted: 0,
    failures: [],
  };
  const token = runtime.slackBotToken?.trim();
  const channelId = runtime.slackChannelId?.trim();
  if (!token || !channelId) {
    result.failures.push({
      queue: 'extra',
      outboxId: null,
      messageTs: null,
      reason: token ? 'channel_missing' : 'token_missing',
    });
    return result;
  }

  const now = runtime.now ?? new Date();
  const nowText = toJstString(now);
  const sentAfter = toJstString(input.sentAfter);
  const sentBefore = toJstString(input.sentBefore);
  const selectedRows: Array<{
    queue: SupportSlackQueue;
    row: SupportSlackOutboxRow;
  }> = [];
  for (const queue of ['ticket_created', 'secondary_event'] as const) {
    const config = SUPPORT_SLACK_QUEUE_CONFIG[queue];
    const rows = await db
      .prepare(
        `SELECT id, case_id, line_account_id, payload, status, attempts,
                next_attempt_at, claim_token, slack_message_ts, sent_at, updated_at
         FROM ${config.tableName}
         WHERE ${config.notificationFilter}
           AND status = 'sent'
           AND slack_message_ts IS NOT NULL
           AND sent_at IS NOT NULL
           AND sent_at >= ?
           AND sent_at <= ?
         ORDER BY sent_at ASC, id ASC
         LIMIT 100`,
      )
      .bind(sentAfter, sentBefore)
      .all<SupportSlackOutboxRow>();
    selectedRows.push(...rows.results.map((row) => ({ queue, row })));
  }

  result.selected = selectedRows.length;
  if (result.selected !== input.expectedCount) {
    result.failures.push({
      queue: 'extra',
      outboxId: null,
      messageTs: null,
      reason: `selection_mismatch_expected_${input.expectedCount}_actual_${result.selected}`,
    });
    return result;
  }
  const selectedMessageTs = selectedRows
    .map(({ row }) => row.slack_message_ts)
    .filter((value): value is string => Boolean(value))
    .sort();
  const checkedMessageTs = Array.from(new Set(input.checkedMessageTs)).sort();
  if (
    selectedMessageTs.length !== checkedMessageTs.length
    || selectedMessageTs.some((messageTs, index) => messageTs !== checkedMessageTs[index])
  ) {
    result.failures.push({
      queue: 'extra',
      outboxId: null,
      messageTs: null,
      reason: 'checked_message_set_mismatch',
    });
    return result;
  }
  const preserveMessageTs = new Set(input.preserveMessageTs ?? []);
  if (Array.from(preserveMessageTs).some((messageTs) => !checkedMessageTs.includes(messageTs))) {
    result.failures.push({
      queue: 'extra',
      outboxId: null,
      messageTs: null,
      reason: 'preserve_message_set_invalid',
    });
    return result;
  }
  if (result.previewOnly) return result;

  for (const { queue, row } of selectedRows) {
    const config = SUPPORT_SLACK_QUEUE_CONFIG[queue];
    const oldMessageTs = row.slack_message_ts;
    const snapshot = parseTicketSlackSnapshot(row.payload);
    if (!snapshot || !oldMessageTs) {
      result.failures.push({
        queue,
        outboxId: row.id,
        messageTs: oldMessageTs,
        reason: 'invalid_payload',
      });
      continue;
    }

    const mentionMap = await resolveTicketSlackMentionMap(db, snapshot, runtime.slackMentionMap);
    let built: ReturnType<typeof buildTicketCreatedSlackPayload>;
    try {
      built = buildTicketCreatedSlackPayload({
        ...snapshot,
        notificationId: crypto.randomUUID(),
      }, {
        channelId,
        url: supportUrl(runtime.adminPublicUrl, snapshot.caseId),
        mentionMap,
        now,
      });
    } catch (error) {
      result.failures.push({
        queue,
        outboxId: row.id,
        messageTs: oldMessageTs,
        reason: `reissue_${slackDeliveryFailure(error).code}`,
      });
      continue;
    }
    if (built.unmappedAssignees.length > 0) {
      result.failures.push({
        queue,
        outboxId: row.id,
        messageTs: oldMessageTs,
        reason: 'mention_mapping_missing',
      });
      continue;
    }

    if (preserveMessageTs.has(oldMessageTs)) {
      try {
        await updateSlackMessage(
          token,
          channelId,
          oldMessageTs,
          built.payload,
          runtime.updateSlackMessage,
        );
        result.updatedInPlace += 1;
        try {
          await addNotificationEvent(
            db,
            snapshot.caseId,
            SUPPORT_SLACK_NOTIFICATION_REISSUED_EVENT,
            '返信やリアクションを保持したままSlack通知の表示を更新しました',
            {
              channel: 'slack',
              channelId,
              notificationKind: snapshot.notificationKind ?? 'ticket_created',
              oldSlackMessageTs: oldMessageTs,
              newSlackMessageTs: oldMessageTs,
              preservedInteractions: true,
            },
          );
        } catch (error) {
          console.error(`support Slack update audit event error: ${error instanceof Error ? error.name : typeof error}`);
        }
      } catch (error) {
        result.failures.push({
          queue,
          outboxId: row.id,
          messageTs: oldMessageTs,
          reason: `update_${slackDeliveryFailure(error).code}`,
        });
      }
      continue;
    }

    let newMessageTs: string | null = null;
    try {
      const delivered = await sendSlackMessage(token, built.payload, runtime.sendSlackMessage);
      newMessageTs = delivered.messageTs;
      if (!newMessageTs) throw new SlackDeliveryError('message_ts_missing', false);

      const updated = await db
        .prepare(
          `UPDATE ${config.tableName}
           SET slack_message_ts = ?, sent_at = ?, updated_at = ?
           WHERE id = ? AND status = 'sent' AND slack_message_ts = ?`,
        )
        .bind(newMessageTs, nowText, nowText, row.id, oldMessageTs)
        .run();
      if (Number(updated.meta.changes ?? 0) === 0) {
        await deleteSlackMessage(token, channelId, newMessageTs, runtime.deleteSlackMessage);
        result.failures.push({
          queue,
          outboxId: row.id,
          messageTs: oldMessageTs,
          reason: 'state_conflict',
        });
        continue;
      }

      result.reissued += 1;
      try {
        await deleteSlackMessage(token, channelId, oldMessageTs, runtime.deleteSlackMessage);
        result.oldMessagesDeleted += 1;
      } catch (error) {
        result.failures.push({
          queue,
          outboxId: row.id,
          messageTs: oldMessageTs,
          reason: `old_delete_${slackDeliveryFailure(error).code}`,
        });
      }

      try {
        await addNotificationEvent(
          db,
          snapshot.caseId,
          SUPPORT_SLACK_NOTIFICATION_REISSUED_EVENT,
          'Slack通知を新しい表示へ差し替えました',
          {
            channel: 'slack',
            channelId,
            notificationKind: snapshot.notificationKind ?? 'ticket_created',
            oldSlackMessageTs: oldMessageTs,
            newSlackMessageTs: newMessageTs,
          },
        );
      } catch (error) {
        console.error(`support Slack reissue audit event error: ${error instanceof Error ? error.name : typeof error}`);
      }
    } catch (error) {
      result.failures.push({
        queue,
        outboxId: row.id,
        messageTs: oldMessageTs,
        reason: `reissue_${slackDeliveryFailure(error).code}`,
      });
    }
  }

  const reissueFailures = result.failures.some((failure) => failure.queue !== 'extra');
  if (reissueFailures) return result;

  for (const messageTs of Array.from(new Set(input.extraMessageTs ?? []))) {
    try {
      await deleteSlackMessage(token, channelId, messageTs, runtime.deleteSlackMessage);
      result.extraMessagesDeleted += 1;
    } catch (error) {
      result.failures.push({
        queue: 'extra',
        outboxId: null,
        messageTs,
        reason: `extra_delete_${slackDeliveryFailure(error).code}`,
      });
    }
  }
  return result;
}

export async function sendSupportTicketSlackTestNotification(
  runtime: SupportTicketSlackRuntime,
  mentionStaffName: string,
): Promise<{ sent: boolean; reason: string; messageTs?: string | null }> {
  const token = runtime.slackBotToken?.trim();
  const channelId = runtime.slackChannelId?.trim();
  if (!token) return { sent: false, reason: 'token_missing' };
  if (!channelId) return { sent: false, reason: 'channel_missing' };

  const mentionMap = parseSupportSlackMentionMap(runtime.slackMentionMap);
  if (!mentionMap.has(normalizedStaffName(mentionStaffName))) {
    return { sent: false, reason: 'mention_mapping_missing' };
  }
  const snapshot: SupportTicketSlackSnapshot = {
    caseId: crypto.randomUUID(),
    title: 'L-Link Slack通知 動作確認',
    priority: 'medium',
    primaryAssignee: 'L-Link 動作確認',
    secondaryAssignees: [{ name: mentionStaffName, staffId: null }],
    customerSummary: 'チケット発行時のSlack通知設定を確認しています',
    customerNumber: null,
    companyName: null,
    contactName: null,
    dueAt: null,
  };
  let built: ReturnType<typeof buildTicketCreatedSlackPayload>;
  try {
    built = buildTicketCreatedSlackPayload(snapshot, {
      channelId,
      url: supportUrl(runtime.adminPublicUrl),
      mentionMap,
      now: runtime.now,
    });
  } catch (error) {
    return { sent: false, reason: slackDeliveryFailure(error).code };
  }
  try {
    const delivered = await sendSlackMessage(token, built.payload, runtime.sendSlackMessage);
    return { sent: true, reason: 'sent', messageTs: delivered.messageTs };
  } catch (error) {
    const failure = slackDeliveryFailure(error);
    console.error(`support ticket Slack test error: ${failure.code}`);
    return { sent: false, reason: failure.code };
  }
}

async function listDigestCases(
  db: D1Database,
  accountId: string,
  nowText: string,
  dueSoonAt: string,
): Promise<SupportNotificationCaseRow[]> {
  const result = await db
    .prepare(
      `SELECT sc.id, sc.line_account_id, sc.title, sc.priority, sc.status,
              sc.primary_assignee, sc.escalation_assignee, sc.due_at, sc.updated_at,
              f.display_name AS friend_name
       FROM support_cases sc
       LEFT JOIN friends f ON f.id = sc.friend_id
       WHERE sc.line_account_id = ?
         AND sc.status != 'resolved'
       ORDER BY
         CASE sc.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
         CASE WHEN sc.due_at IS NOT NULL AND sc.due_at < ? THEN 0 ELSE 1 END,
         CASE WHEN sc.due_at IS NOT NULL AND sc.due_at <= ? THEN 0 ELSE 1 END,
         sc.due_at ASC,
         sc.updated_at DESC
       LIMIT ?`,
    )
    .bind(accountId, nowText, dueSoonAt, MAX_DIGEST_CASES)
    .all<SupportNotificationCaseRow>();
  return result.results;
}

function buildDigestText(input: {
  accountId: string;
  rows: SupportNotificationCaseRow[];
  nowText: string;
  dueSoonAt: string;
  adminPublicUrl?: string;
}): string {
  const byOwner = new Map<string, number>();
  let urgent = 0;
  let overdue = 0;
  let dueSoon = 0;

  for (const row of input.rows) {
    byOwner.set(ownerLabel(row), (byOwner.get(ownerLabel(row)) ?? 0) + 1);
    if (row.priority === 'urgent') urgent += 1;
    if (row.due_at && row.due_at < input.nowText) overdue += 1;
    if (row.due_at && row.due_at >= input.nowText && row.due_at <= input.dueSoonAt) dueSoon += 1;
  }

  const ownerLines = Array.from(byOwner.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ja'))
    .map(([owner, count]) => `- ${owner}: ${count}件`);
  const caseLines = input.rows.slice(0, 10).map(formatCaseLine);
  const extra = input.rows.length > caseLines.length ? `\nほか ${input.rows.length - caseLines.length}件` : '';

  return [
    ':bell: サポートCRM 定時リマインド',
    `未完了 ${input.rows.length}件 / 大至急 ${urgent}件 / 期限超過 ${overdue}件 / 期限間近 ${dueSoon}件`,
    '',
    '担当者別',
    ownerLines.join('\n') || '- なし',
    '',
    '先に見る案件',
    caseLines.join('\n') || '- なし',
    extra,
    '',
    supportUrl(input.adminPublicUrl),
  ].filter((line) => line !== '').join('\n');
}

export async function processSupportNotificationDigests(
  db: D1Database,
  runtime: NotificationRuntime & { accountIds: string[]; now?: Date } = { accountIds: [] },
): Promise<{ sent: number; skipped: number; failed: number }> {
  const now = runtime.now ?? new Date();
  const parts = jstParts(now);
  const dueSoonAt = toJstString(new Date(now.getTime() + DEFAULT_DUE_SOON_HOURS * 60 * 60_000));
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const accountId of runtime.accountIds) {
    try {
      const settings = await getSupportNotificationSettings(db, accountId);
      if (!settings.enabled || !settings.digestEnabled || !settings.webhookUrl) {
        skipped += 1;
        continue;
      }
      if (!settings.digestHours.includes(parts.hour) || parts.minute >= 10) {
        skipped += 1;
        continue;
      }
      const digestKey = `${parts.date}-${String(parts.hour).padStart(2, '0')}`;
      const state = await getNotificationState(db, accountId);
      if (state.lastDigestKey === digestKey) {
        skipped += 1;
        continue;
      }

      const accountDueSoonAt = toJstString(new Date(now.getTime() + settings.dueSoonHours * 60 * 60_000));
      const rows = await listDigestCases(db, accountId, parts.nowText, accountDueSoonAt || dueSoonAt);
      if (rows.length === 0) {
        await setNotificationState(db, accountId, { lastDigestKey: digestKey });
        skipped += 1;
        continue;
      }

      const text = buildDigestText({
        accountId,
        rows,
        nowText: parts.nowText,
        dueSoonAt: accountDueSoonAt,
        adminPublicUrl: runtime.adminPublicUrl,
      });
      await sendWebhook(settings.webhookUrl, { text }, runtime.sendWebhook);
      await setNotificationState(db, accountId, { lastDigestKey: digestKey });
      await addNotificationEvent(db, rows[0].id, SUPPORT_NOTIFICATION_DIGEST_EVENT, '定時Slackリマインドを送信しました', {
        channel: 'slack',
        digestKey,
        accountId,
        count: rows.length,
      });
      sent += 1;
    } catch (err) {
      console.error(`support digest notification error: ${err instanceof Error ? err.name : typeof err}`);
      failed += 1;
    }
  }

  return { sent, skipped, failed };
}

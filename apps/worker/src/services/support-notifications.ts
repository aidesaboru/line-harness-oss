import { jstNow, toJstString } from '@line-crm/db';

export const SUPPORT_NOTIFICATION_SETTING_KEY = 'support_slack_notifications';
const SUPPORT_NOTIFICATION_STATE_KEY = 'support_slack_notification_state';
const SUPPORT_NOTIFICATION_DIGEST_EVENT = 'slack_digest_sent';
const SUPPORT_NOTIFICATION_URGENT_EVENT = 'slack_urgent_sent';

const DEFAULT_DIGEST_HOURS = [12, 14, 17];
const DEFAULT_DUE_SOON_HOURS = 4;
const MAX_DIGEST_CASES = 80;
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

import { Hono, type Context } from 'hono';
import type { Env } from '../index.js';
import { requireRole } from '../middleware/role-guard.js';
import { supportFriendVisibilitySql } from '../services/support-access.js';
import { getLineSafetyMode, setLineSafetyMode } from '../services/line-safety.js';
import {
  getSupportNotificationSettings,
  publicSupportNotificationSettings,
  setSupportNotificationSettings,
  type SupportNotificationSettingsPatch,
} from '../services/support-notifications.js';
import { currentSupportStaff } from './support-friend-access.js';

const accountSettings = new Hono<Env>();

const ACCOUNT_SETTINGS_ID_MAX_LENGTH = 128;
const ACCOUNT_SETTINGS_MAX_TEST_RECIPIENTS = 100;
const ACCOUNT_SETTINGS_VISIBLE_ASCII_PATTERN = /^[!-~]+$/;

type ValueResult<T> = { ok: true; value: T } | { ok: false; error: string };

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

function parseVisibleId(raw: unknown, label: string): ValueResult<string> {
  if (typeof raw !== 'string') return { ok: false, error: `invalid_${label}` };
  const value = raw.trim();
  if (!value || value.length > ACCOUNT_SETTINGS_ID_MAX_LENGTH || !ACCOUNT_SETTINGS_VISIBLE_ASCII_PATTERN.test(value)) {
    return { ok: false, error: `invalid_${label}` };
  }
  return { ok: true, value };
}

function parseFriendIds(raw: unknown): ValueResult<string[]> {
  if (!Array.isArray(raw) || raw.length > ACCOUNT_SETTINGS_MAX_TEST_RECIPIENTS) {
    return { ok: false, error: 'invalid_friend_ids' };
  }

  const friendIds: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const parsed = parseVisibleId(item, 'friend_id');
    if (!parsed.ok) return parsed;
    if (!seen.has(parsed.value)) {
      seen.add(parsed.value);
      friendIds.push(parsed.value);
    }
  }
  return { ok: true, value: friendIds };
}

function parseBoolean(raw: unknown, label: string): ValueResult<boolean> {
  if (typeof raw !== 'boolean') return { ok: false, error: `invalid_${label}` };
  return { ok: true, value: raw };
}

function parseOptionalReason(raw: unknown): ValueResult<string | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: 'invalid_reason' };
  const value = raw.trim();
  if (value.length > 500) return { ok: false, error: 'invalid_reason' };
  return { ok: true, value: value || null };
}

function parseOptionalHttpsUrl(raw: unknown): ValueResult<string | null | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: 'invalid_webhook_url' };
  const value = raw.trim();
  if (!value) return { ok: true, value: null };
  if (value.length > 2048) return { ok: false, error: 'invalid_webhook_url' };
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:') return { ok: false, error: 'invalid_webhook_url' };
    return { ok: true, value };
  } catch {
    return { ok: false, error: 'invalid_webhook_url' };
  }
}

function parseOptionalBooleanSetting(raw: unknown, label: string): ValueResult<boolean | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== 'boolean') return { ok: false, error: `invalid_${label}` };
  return { ok: true, value: raw };
}

function parseDigestHours(raw: unknown): ValueResult<number[] | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 8) {
    return { ok: false, error: 'invalid_digest_hours' };
  }
  const seen = new Set<number>();
  const hours: number[] = [];
  for (const item of raw) {
    const hour = typeof item === 'number' ? item : Number(item);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
      return { ok: false, error: 'invalid_digest_hours' };
    }
    if (!seen.has(hour)) {
      seen.add(hour);
      hours.push(hour);
    }
  }
  return { ok: true, value: hours.sort((a, b) => a - b) };
}

function parseDueSoonHours(raw: unknown): ValueResult<number | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 72) {
    return { ok: false, error: 'invalid_due_soon_hours' };
  }
  return { ok: true, value };
}

function parseSupportNotificationPatch(raw: Record<string, unknown>): ValueResult<SupportNotificationSettingsPatch> {
  const enabled = parseOptionalBooleanSetting(raw.enabled, 'enabled');
  if (!enabled.ok) return enabled;
  const webhookUrl = parseOptionalHttpsUrl(raw.webhookUrl);
  if (!webhookUrl.ok) return webhookUrl;
  const immediateUrgent = parseOptionalBooleanSetting(raw.immediateUrgent, 'immediate_urgent');
  if (!immediateUrgent.ok) return immediateUrgent;
  const digestEnabled = parseOptionalBooleanSetting(raw.digestEnabled, 'digest_enabled');
  if (!digestEnabled.ok) return digestEnabled;
  const digestHours = parseDigestHours(raw.digestHours);
  if (!digestHours.ok) return digestHours;
  const dueSoonHours = parseDueSoonHours(raw.dueSoonHours);
  if (!dueSoonHours.ok) return dueSoonHours;

  return {
    ok: true,
    value: {
      ...(enabled.value !== undefined ? { enabled: enabled.value } : {}),
      ...(webhookUrl.value !== undefined ? { webhookUrl: webhookUrl.value } : {}),
      ...(immediateUrgent.value !== undefined ? { immediateUrgent: immediateUrgent.value } : {}),
      ...(digestEnabled.value !== undefined ? { digestEnabled: digestEnabled.value } : {}),
      ...(digestHours.value !== undefined ? { digestHours: digestHours.value } : {}),
      ...(dueSoonHours.value !== undefined ? { dueSoonHours: dueSoonHours.value } : {}),
    },
  };
}

function parseStoredFriendIds(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const friendIds: string[] = [];
    const seen = new Set<string>();
    for (const item of parsed.slice(0, ACCOUNT_SETTINGS_MAX_TEST_RECIPIENTS)) {
      const id = parseVisibleId(item, 'friend_id');
      if (id.ok && !seen.has(id.value)) {
        seen.add(id.value);
        friendIds.push(id.value);
      }
    }
    return friendIds;
  } catch {
    return [];
  }
}

// GET /api/account-settings/line-safety?accountId=xxx
accountSettings.get('/api/account-settings/line-safety', async (c) => {
  const accountId = parseVisibleId(c.req.query('accountId'), 'account_id');
  if (!accountId.ok) return c.json({ success: false, error: accountId.error }, 400);

  const mode = await getLineSafetyMode(c.env.DB, accountId.value);
  return c.json({ success: true, data: mode });
});

// PUT /api/account-settings/line-safety
accountSettings.put('/api/account-settings/line-safety', requireRole('owner'), async (c) => {
  const rawBody = await readJsonObject(c);
  if (!rawBody.ok) return c.json({ success: false, error: rawBody.error }, 400);
  const accountId = parseVisibleId(rawBody.value.accountId, 'account_id');
  if (!accountId.ok) return c.json({ success: false, error: accountId.error }, 400);
  const frozen = parseBoolean(rawBody.value.frozen, 'frozen');
  if (!frozen.ok) return c.json({ success: false, error: frozen.error }, 400);
  const reason = parseOptionalReason(rawBody.value.reason);
  if (!reason.ok) return c.json({ success: false, error: reason.error }, 400);

  const staff = currentSupportStaff(c);
  const mode = await setLineSafetyMode(c.env.DB, accountId.value, {
    frozen: frozen.value,
    reason: reason.value,
    updatedBy: staff.name ? `${staff.name} (${staff.id})` : staff.id,
  });

  return c.json({ success: true, data: mode });
});

// GET /api/account-settings/support-notifications?accountId=xxx
accountSettings.get('/api/account-settings/support-notifications', requireRole('owner', 'admin'), async (c) => {
  const accountId = parseVisibleId(c.req.query('accountId'), 'account_id');
  if (!accountId.ok) return c.json({ success: false, error: accountId.error }, 400);

  const settings = await getSupportNotificationSettings(c.env.DB, accountId.value);
  return c.json({ success: true, data: publicSupportNotificationSettings(settings) });
});

// PUT /api/account-settings/support-notifications
accountSettings.put('/api/account-settings/support-notifications', requireRole('owner', 'admin'), async (c) => {
  const rawBody = await readJsonObject(c);
  if (!rawBody.ok) return c.json({ success: false, error: rawBody.error }, 400);
  const accountId = parseVisibleId(rawBody.value.accountId, 'account_id');
  if (!accountId.ok) return c.json({ success: false, error: accountId.error }, 400);
  const patch = parseSupportNotificationPatch(rawBody.value);
  if (!patch.ok) return c.json({ success: false, error: patch.error }, 400);

  const settings = await setSupportNotificationSettings(c.env.DB, accountId.value, patch.value);
  return c.json({ success: true, data: publicSupportNotificationSettings(settings) });
});

// GET /api/account-settings/test-recipients?accountId=xxx
accountSettings.get('/api/account-settings/test-recipients', async (c) => {
  const accountId = parseVisibleId(c.req.query('accountId'), 'account_id');
  if (!accountId.ok) return c.json({ success: false, error: accountId.error }, 400);

  const row = await c.env.DB.prepare(
    `SELECT value FROM account_settings WHERE line_account_id = ? AND key = 'test_recipients'`
  ).bind(accountId.value).first<{ value: string }>();

  const friendIds = row ? parseStoredFriendIds(row.value) : [];

  if (friendIds.length === 0) {
    return c.json({ success: true, data: [] });
  }
  const placeholders = friendIds.map(() => '?').join(',');
  const visibility = supportFriendVisibilitySql(currentSupportStaff(c), 'f.id');
  const friends = await c.env.DB.prepare(
    `SELECT f.id, f.display_name, f.picture_url
     FROM friends f
     WHERE f.id IN (${placeholders})${visibility.sql ? ` AND ${visibility.sql}` : ''}`
  ).bind(...friendIds, ...visibility.binds).all<{ id: string; display_name: string; picture_url: string | null }>();

  return c.json({
    success: true,
    data: friendIds
      .map((id) => friends.results.find((f) => f.id === id))
      .filter((f): f is { id: string; display_name: string; picture_url: string | null } => Boolean(f))
      .map(f => ({
        id: f.id,
        displayName: f.display_name,
        pictureUrl: f.picture_url,
      })),
  });
});

// PUT /api/account-settings/test-recipients
accountSettings.put('/api/account-settings/test-recipients', requireRole('owner', 'admin'), async (c) => {
  const rawBody = await readJsonObject(c);
  if (!rawBody.ok) return c.json({ success: false, error: rawBody.error }, 400);
  const accountId = parseVisibleId(rawBody.value.accountId, 'account_id');
  if (!accountId.ok) return c.json({ success: false, error: accountId.error }, 400);
  const friendIds = parseFriendIds(rawBody.value.friendIds);
  if (!friendIds.ok) return c.json({ success: false, error: friendIds.error }, 400);

  const id = crypto.randomUUID();
  const now = new Date(Date.now() + 9 * 60 * 60_000).toISOString().replace('Z', '+09:00');
  const value = JSON.stringify(friendIds.value);

  await c.env.DB.prepare(
    `INSERT INTO account_settings (id, line_account_id, key, value, created_at, updated_at)
     VALUES (?, ?, 'test_recipients', ?, ?, ?)
     ON CONFLICT (line_account_id, key) DO UPDATE SET value = ?, updated_at = ?`
  ).bind(
    id, accountId.value, value, now, now,
    value, now,
  ).run();

  return c.json({ success: true });
});

export { accountSettings };

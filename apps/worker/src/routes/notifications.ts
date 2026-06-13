import { Hono, type Context } from 'hono';
import {
  getNotificationRules,
  getNotificationRuleById,
  createNotificationRule,
  updateNotificationRule,
  deleteNotificationRule,
  getNotifications,
} from '@line-crm/db';
import type { Env } from '../index.js';
import { requireRole } from '../middleware/role-guard.js';

const notifications = new Hono<Env>();

const NOTIFICATION_ID_MAX_LENGTH = 128;
const NOTIFICATION_NAME_MAX_LENGTH = 120;
const NOTIFICATION_TOKEN_MAX_LENGTH = 128;
const NOTIFICATION_CHANNEL_MAX_LENGTH = 64;
const NOTIFICATION_CHANNEL_MAX_COUNT = 16;
const NOTIFICATION_CONDITIONS_MAX_BYTES = 5000;
const NOTIFICATION_VISIBLE_ASCII_PATTERN = /^[!-~]+$/;

type ValueResult<T> = { ok: true; value: T } | { ok: false; error: string };

function clampLimit(raw: string | undefined, fallback = 100): number {
  const n = Number(raw ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(500, Math.floor(n)));
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

function parseVisibleString(raw: unknown, label: string, maxLength = NOTIFICATION_TOKEN_MAX_LENGTH): ValueResult<string> {
  if (typeof raw !== 'string') return { ok: false, error: `invalid_${label}` };
  const value = raw.trim();
  if (!value || value.length > maxLength || !NOTIFICATION_VISIBLE_ASCII_PATTERN.test(value)) {
    return { ok: false, error: `invalid_${label}` };
  }
  return { ok: true, value };
}

function parseOptionalVisibleString(
  raw: unknown,
  label: string,
  maxLength = NOTIFICATION_TOKEN_MAX_LENGTH,
): ValueResult<string | undefined> {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: undefined };
  const parsed = parseVisibleString(raw, label, maxLength);
  if (!parsed.ok) return parsed;
  return { ok: true, value: parsed.value };
}

function parseName(raw: unknown): ValueResult<string> {
  if (typeof raw !== 'string') return { ok: false, error: 'invalid_name' };
  const value = raw.trim();
  if (!value || value.length > NOTIFICATION_NAME_MAX_LENGTH) {
    return { ok: false, error: 'invalid_name' };
  }
  return { ok: true, value };
}

function parseConditions(raw: unknown): ValueResult<Record<string, unknown> | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'invalid_conditions' };
  }
  if (JSON.stringify(raw).length > NOTIFICATION_CONDITIONS_MAX_BYTES) {
    return { ok: false, error: 'invalid_conditions' };
  }
  return { ok: true, value: raw as Record<string, unknown> };
}

function parseChannels(raw: unknown): ValueResult<string[] | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > NOTIFICATION_CHANNEL_MAX_COUNT) {
    return { ok: false, error: 'invalid_channels' };
  }
  const channels: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const parsed = parseVisibleString(item, 'channel', NOTIFICATION_CHANNEL_MAX_LENGTH);
    if (!parsed.ok) return { ok: false, error: 'invalid_channels' };
    if (!seen.has(parsed.value)) {
      seen.add(parsed.value);
      channels.push(parsed.value);
    }
  }
  return { ok: true, value: channels };
}

function parseOptionalBoolean(raw: unknown): ValueResult<boolean | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== 'boolean') return { ok: false, error: 'invalid_is_active' };
  return { ok: true, value: raw };
}

function parseNotificationRuleCreate(
  body: Record<string, unknown>,
): ValueResult<{ name: string; eventType: string; conditions?: Record<string, unknown>; channels?: string[] }> {
  const name = parseName(body.name);
  if (!name.ok) return name;
  const eventType = parseVisibleString(body.eventType, 'event_type');
  if (!eventType.ok) return eventType;
  const conditions = parseConditions(body.conditions);
  if (!conditions.ok) return conditions;
  const channels = parseChannels(body.channels);
  if (!channels.ok) return channels;

  return {
    ok: true,
    value: {
      name: name.value,
      eventType: eventType.value,
      ...(conditions.value !== undefined ? { conditions: conditions.value } : {}),
      ...(channels.value !== undefined ? { channels: channels.value } : {}),
    },
  };
}

function parseNotificationRuleUpdate(
  body: Record<string, unknown>,
): ValueResult<Partial<{ name: string; eventType: string; conditions: Record<string, unknown>; channels: string[]; isActive: boolean }>> {
  const input: Partial<{ name: string; eventType: string; conditions: Record<string, unknown>; channels: string[]; isActive: boolean }> = {};

  if ('name' in body) {
    const name = parseName(body.name);
    if (!name.ok) return name;
    input.name = name.value;
  }
  if ('eventType' in body) {
    const eventType = parseVisibleString(body.eventType, 'event_type');
    if (!eventType.ok) return eventType;
    input.eventType = eventType.value;
  }
  if ('conditions' in body) {
    const conditions = parseConditions(body.conditions);
    if (!conditions.ok) return conditions;
    input.conditions = conditions.value;
  }
  if ('channels' in body) {
    const channels = parseChannels(body.channels);
    if (!channels.ok) return channels;
    input.channels = channels.value;
  }
  if ('isActive' in body) {
    const isActive = parseOptionalBoolean(body.isActive);
    if (!isActive.ok) return isActive;
    input.isActive = isActive.value;
  }

  if (Object.keys(input).length === 0) return { ok: false, error: 'empty_update' };
  return { ok: true, value: input };
}

function notificationRouteErrorKind(err: unknown): string {
  if (err instanceof TypeError) return 'network_error';
  if (err instanceof Error) return err.name || 'error';
  return typeof err;
}

// ========== 通知ルールCRUD ==========

notifications.get('/api/notifications/rules', requireRole('owner', 'admin'), async (c) => {
  try {
    const lineAccountId = parseOptionalVisibleString(c.req.query('lineAccountId'), 'line_account_id');
    if (!lineAccountId.ok) return c.json({ success: false, error: lineAccountId.error }, 400);
    let items;
    if (lineAccountId.value) {
      const result = await c.env.DB
        .prepare(`SELECT * FROM notification_rules WHERE line_account_id = ? ORDER BY created_at DESC`)
        .bind(lineAccountId.value)
        .all();
      items = result.results as unknown as Awaited<ReturnType<typeof getNotificationRules>>;
    } else {
      items = await getNotificationRules(c.env.DB);
    }
    return c.json({
      success: true,
      data: items.map((r) => ({
        id: r.id,
        name: r.name,
        eventType: r.event_type,
        conditions: JSON.parse(r.conditions),
        channels: JSON.parse(r.channels),
        isActive: Boolean(r.is_active),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    });
  } catch (err) {
    console.error(`GET /api/notifications/rules error: ${notificationRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

notifications.get('/api/notifications/rules/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = parseVisibleString(c.req.param('id'), 'notification_rule_id');
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const item = await getNotificationRuleById(c.env.DB, id.value);
    if (!item) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({
      success: true,
      data: {
        id: item.id,
        name: item.name,
        eventType: item.event_type,
        conditions: JSON.parse(item.conditions),
        channels: JSON.parse(item.channels),
        isActive: Boolean(item.is_active),
        createdAt: item.created_at,
      },
    });
  } catch (err) {
    console.error(`GET /api/notifications/rules/:id error: ${notificationRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

notifications.post('/api/notifications/rules', requireRole('owner', 'admin'), async (c) => {
  try {
    const rawBody = await readJsonObject(c);
    if (!rawBody.ok) return c.json({ success: false, error: rawBody.error }, 400);
    const body = parseNotificationRuleCreate(rawBody.value);
    if (!body.ok) return c.json({ success: false, error: body.error }, 400);
    const item = await createNotificationRule(c.env.DB, body.value);
    return c.json({
      success: true,
      data: { id: item.id, name: item.name, eventType: item.event_type, channels: JSON.parse(item.channels), createdAt: item.created_at },
    }, 201);
  } catch (err) {
    console.error(`POST /api/notifications/rules error: ${notificationRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

notifications.put('/api/notifications/rules/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = parseVisibleString(c.req.param('id'), 'notification_rule_id');
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const rawBody = await readJsonObject(c);
    if (!rawBody.ok) return c.json({ success: false, error: rawBody.error }, 400);
    const body = parseNotificationRuleUpdate(rawBody.value);
    if (!body.ok) return c.json({ success: false, error: body.error }, 400);
    await updateNotificationRule(c.env.DB, id.value, body.value);
    const updated = await getNotificationRuleById(c.env.DB, id.value);
    if (!updated) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({
      success: true,
      data: { id: updated.id, name: updated.name, eventType: updated.event_type, channels: JSON.parse(updated.channels), isActive: Boolean(updated.is_active) },
    });
  } catch (err) {
    console.error(`PUT /api/notifications/rules/:id error: ${notificationRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

notifications.delete('/api/notifications/rules/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = parseVisibleString(c.req.param('id'), 'notification_rule_id');
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    await deleteNotificationRule(c.env.DB, id.value);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error(`DELETE /api/notifications/rules/:id error: ${notificationRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ========== 通知一覧 ==========

notifications.get('/api/notifications', requireRole('owner', 'admin'), async (c) => {
  try {
    const status = parseOptionalVisibleString(c.req.query('status'), 'status', NOTIFICATION_CHANNEL_MAX_LENGTH);
    if (!status.ok) return c.json({ success: false, error: status.error }, 400);
    const limit = clampLimit(c.req.query('limit'), 100);
    const lineAccountId = parseOptionalVisibleString(c.req.query('lineAccountId'), 'line_account_id');
    if (!lineAccountId.ok) return c.json({ success: false, error: lineAccountId.error }, 400);
    let items;
    if (lineAccountId.value) {
      const conditions: string[] = ['line_account_id = ?'];
      const bindings: unknown[] = [lineAccountId.value];
      if (status.value) {
        conditions.push('status = ?');
        bindings.push(status.value);
      }
      bindings.push(limit);
      const result = await c.env.DB
        .prepare(`SELECT * FROM notifications WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT ?`)
        .bind(...bindings)
        .all();
      items = result.results as unknown as Awaited<ReturnType<typeof getNotifications>>;
    } else {
      items = await getNotifications(c.env.DB, { status: status.value, limit });
    }
    return c.json({
      success: true,
      data: items.map((n) => ({
        id: n.id,
        ruleId: n.rule_id,
        eventType: n.event_type,
        title: n.title,
        body: n.body,
        channel: n.channel,
        status: n.status,
        metadata: n.metadata ? JSON.parse(n.metadata) : null,
        createdAt: n.created_at,
      })),
    });
  } catch (err) {
    console.error(`GET /api/notifications error: ${notificationRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { notifications };

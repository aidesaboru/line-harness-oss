import { Hono, type Context } from 'hono';
import {
  getAutomations,
  getAutomationById,
  createAutomation,
  updateAutomation,
  deleteAutomation,
  getAutomationLogs,
} from '@line-crm/db';
import type { Env } from '../index.js';
import { requireRole } from '../middleware/role-guard.js';

const automations = new Hono<Env>();

const AUTOMATION_ID_MAX_LENGTH = 128;
const AUTOMATION_NAME_MAX_LENGTH = 120;
const AUTOMATION_DESCRIPTION_MAX_LENGTH = 1000;
const AUTOMATION_TOKEN_MAX_LENGTH = 128;
const AUTOMATION_CONDITIONS_MAX_BYTES = 10000;
const AUTOMATION_ACTIONS_MAX_BYTES = 20000;
const AUTOMATION_ACTIONS_MAX_COUNT = 50;
const AUTOMATION_PRIORITY_MIN = -1000;
const AUTOMATION_PRIORITY_MAX = 1000;
const AUTOMATION_VISIBLE_ASCII_PATTERN = /^[!-~]+$/;

type ValueResult<T> = { ok: true; value: T } | { ok: false; error: string };
type AutomationCreateInput = {
  name: string;
  description?: string;
  eventType: string;
  conditions?: Record<string, unknown>;
  actions: unknown[];
  priority?: number;
  lineAccountId?: string | null;
};
type AutomationUpdateInput = Partial<{
  name: string;
  description: string;
  eventType: string;
  conditions: Record<string, unknown>;
  actions: unknown[];
  isActive: boolean;
  priority: number;
  lineAccountId: string | null;
}>;

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

function parseVisibleString(raw: unknown, label: string, maxLength = AUTOMATION_TOKEN_MAX_LENGTH): ValueResult<string> {
  if (typeof raw !== 'string') return { ok: false, error: `invalid_${label}` };
  const value = raw.trim();
  if (!value || value.length > maxLength || !AUTOMATION_VISIBLE_ASCII_PATTERN.test(value)) {
    return { ok: false, error: `invalid_${label}` };
  }
  return { ok: true, value };
}

function parseOptionalVisibleString(
  raw: unknown,
  label: string,
  maxLength = AUTOMATION_TOKEN_MAX_LENGTH,
): ValueResult<string | undefined> {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: undefined };
  const parsed = parseVisibleString(raw, label, maxLength);
  if (!parsed.ok) return parsed;
  return { ok: true, value: parsed.value };
}

function parseOptionalNullableVisibleString(
  raw: unknown,
  label: string,
  maxLength = AUTOMATION_TOKEN_MAX_LENGTH,
): ValueResult<string | null | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null || raw === '') return { ok: true, value: null };
  const parsed = parseVisibleString(raw, label, maxLength);
  if (!parsed.ok) return parsed;
  return { ok: true, value: parsed.value };
}

function parseName(raw: unknown): ValueResult<string> {
  if (typeof raw !== 'string') return { ok: false, error: 'invalid_name' };
  const value = raw.trim();
  if (!value || value.length > AUTOMATION_NAME_MAX_LENGTH) {
    return { ok: false, error: 'invalid_name' };
  }
  return { ok: true, value };
}

function parseOptionalDescription(raw: unknown): ValueResult<string | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== 'string') return { ok: false, error: 'invalid_description' };
  const value = raw.trim();
  if (value.length > AUTOMATION_DESCRIPTION_MAX_LENGTH) {
    return { ok: false, error: 'invalid_description' };
  }
  return { ok: true, value };
}

function parseRecord(raw: unknown, label: string, maxBytes: number): ValueResult<Record<string, unknown> | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: `invalid_${label}` };
  }
  if (JSON.stringify(raw).length > maxBytes) {
    return { ok: false, error: `invalid_${label}` };
  }
  return { ok: true, value: raw as Record<string, unknown> };
}

function parseActions(raw: unknown): ValueResult<unknown[] | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(raw) || raw.length > AUTOMATION_ACTIONS_MAX_COUNT || JSON.stringify(raw).length > AUTOMATION_ACTIONS_MAX_BYTES) {
    return { ok: false, error: 'invalid_actions' };
  }
  const actions: Array<Record<string, unknown>> = [];
  for (const action of raw) {
    if (!action || typeof action !== 'object' || Array.isArray(action)) {
      return { ok: false, error: 'invalid_actions' };
    }
    const record = action as Record<string, unknown>;
    const type = parseVisibleString(record.type, 'action_type');
    if (!type.ok) return { ok: false, error: 'invalid_actions' };
    if ('params' in record && (!record.params || typeof record.params !== 'object' || Array.isArray(record.params))) {
      return { ok: false, error: 'invalid_actions' };
    }
    actions.push({ ...record, type: type.value, params: (record.params as Record<string, unknown> | undefined) ?? {} });
  }
  return { ok: true, value: actions };
}

function parseOptionalBoolean(raw: unknown): ValueResult<boolean | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== 'boolean') return { ok: false, error: 'invalid_is_active' };
  return { ok: true, value: raw };
}

function parseOptionalPriority(raw: unknown): ValueResult<number | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (
    typeof raw !== 'number' ||
    !Number.isInteger(raw) ||
    raw < AUTOMATION_PRIORITY_MIN ||
    raw > AUTOMATION_PRIORITY_MAX
  ) {
    return { ok: false, error: 'invalid_priority' };
  }
  return { ok: true, value: raw };
}

function parseAutomationCreate(body: Record<string, unknown>): ValueResult<AutomationCreateInput> {
  const name = parseName(body.name);
  if (!name.ok) return name;
  const description = parseOptionalDescription(body.description);
  if (!description.ok) return description;
  const eventType = parseVisibleString(body.eventType, 'event_type');
  if (!eventType.ok) return eventType;
  const conditions = parseRecord(body.conditions, 'conditions', AUTOMATION_CONDITIONS_MAX_BYTES);
  if (!conditions.ok) return conditions;
  const actions = parseActions(body.actions);
  if (!actions.ok) return actions;
  if (!actions.value) return { ok: false, error: 'invalid_actions' };
  const priority = parseOptionalPriority(body.priority);
  if (!priority.ok) return priority;
  const lineAccountId = parseOptionalNullableVisibleString(body.lineAccountId, 'line_account_id');
  if (!lineAccountId.ok) return lineAccountId;

  return {
    ok: true,
    value: {
      name: name.value,
      ...(description.value !== undefined ? { description: description.value } : {}),
      eventType: eventType.value,
      ...(conditions.value !== undefined ? { conditions: conditions.value } : {}),
      actions: actions.value,
      ...(priority.value !== undefined ? { priority: priority.value } : {}),
      ...(lineAccountId.value !== undefined ? { lineAccountId: lineAccountId.value } : {}),
    },
  };
}

function parseAutomationUpdate(body: Record<string, unknown>): ValueResult<AutomationUpdateInput> {
  const input: AutomationUpdateInput = {};

  if ('name' in body) {
    const name = parseName(body.name);
    if (!name.ok) return name;
    input.name = name.value;
  }
  if ('description' in body) {
    const description = parseOptionalDescription(body.description);
    if (!description.ok) return description;
    input.description = description.value ?? '';
  }
  if ('eventType' in body) {
    const eventType = parseVisibleString(body.eventType, 'event_type');
    if (!eventType.ok) return eventType;
    input.eventType = eventType.value;
  }
  if ('conditions' in body) {
    const conditions = parseRecord(body.conditions, 'conditions', AUTOMATION_CONDITIONS_MAX_BYTES);
    if (!conditions.ok) return conditions;
    input.conditions = conditions.value;
  }
  if ('actions' in body) {
    const actions = parseActions(body.actions);
    if (!actions.ok) return actions;
    input.actions = actions.value;
  }
  if ('isActive' in body) {
    const isActive = parseOptionalBoolean(body.isActive);
    if (!isActive.ok) return isActive;
    input.isActive = isActive.value;
  }
  if ('priority' in body) {
    const priority = parseOptionalPriority(body.priority);
    if (!priority.ok) return priority;
    input.priority = priority.value;
  }
  if ('lineAccountId' in body) {
    const lineAccountId = parseOptionalNullableVisibleString(body.lineAccountId, 'line_account_id');
    if (!lineAccountId.ok) return lineAccountId;
    input.lineAccountId = lineAccountId.value ?? null;
  }

  if (Object.keys(input).length === 0) return { ok: false, error: 'empty_update' };
  return { ok: true, value: input };
}

// ========== 自動化ルールCRUD ==========

automations.get('/api/automations', requireRole('owner', 'admin'), async (c) => {
  try {
    const lineAccountId = parseOptionalVisibleString(c.req.query('lineAccountId'), 'line_account_id');
    if (!lineAccountId.ok) return c.json({ success: false, error: lineAccountId.error }, 400);
    let items;
    if (lineAccountId.value) {
      const result = await c.env.DB
        .prepare(`SELECT * FROM automations WHERE line_account_id IS NULL OR line_account_id = ? ORDER BY priority DESC, created_at DESC`)
        .bind(lineAccountId.value)
        .all();
      items = result.results as unknown as Awaited<ReturnType<typeof getAutomations>>;
    } else {
      items = await getAutomations(c.env.DB);
    }
    return c.json({
      success: true,
      data: items.map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description,
        eventType: a.event_type,
        conditions: JSON.parse(a.conditions),
        actions: JSON.parse(a.actions),
        lineAccountId: (a as { line_account_id?: string | null }).line_account_id ?? null,
        isActive: Boolean(a.is_active),
        priority: a.priority,
        createdAt: a.created_at,
        updatedAt: a.updated_at,
      })),
    });
  } catch (err) {
    console.error('GET /api/automations error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

automations.get('/api/automations/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = parseVisibleString(c.req.param('id'), 'automation_id');
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const item = await getAutomationById(c.env.DB, id.value);
    if (!item) return c.json({ success: false, error: 'Automation not found' }, 404);

    // ログも取得
    const logs = await getAutomationLogs(c.env.DB, item.id, 50);

    return c.json({
      success: true,
      data: {
        id: item.id,
        name: item.name,
        description: item.description,
        eventType: item.event_type,
        conditions: JSON.parse(item.conditions),
        actions: JSON.parse(item.actions),
        isActive: Boolean(item.is_active),
        priority: item.priority,
        createdAt: item.created_at,
        updatedAt: item.updated_at,
        logs: logs.map((l) => ({
          id: l.id,
          friendId: l.friend_id,
          eventData: l.event_data ? JSON.parse(l.event_data) : null,
          actionsResult: l.actions_result ? JSON.parse(l.actions_result) : null,
          status: l.status,
          createdAt: l.created_at,
        })),
      },
    });
  } catch (err) {
    console.error('GET /api/automations/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

automations.post('/api/automations', requireRole('owner', 'admin'), async (c) => {
  try {
    const rawBody = await readJsonObject(c);
    if (!rawBody.ok) return c.json({ success: false, error: rawBody.error }, 400);
    const body = parseAutomationCreate(rawBody.value);
    if (!body.ok) return c.json({ success: false, error: body.error }, 400);
    const item = await createAutomation(c.env.DB, body.value);
    // Save line_account_id if provided
    if (body.value.lineAccountId) {
      await c.env.DB.prepare(`UPDATE automations SET line_account_id = ? WHERE id = ?`)
        .bind(body.value.lineAccountId, item.id).run();
    }
    return c.json({
      success: true,
      data: {
        id: item.id,
        name: item.name,
        eventType: item.event_type,
        actions: JSON.parse(item.actions),
        isActive: Boolean(item.is_active),
        priority: item.priority,
        createdAt: item.created_at,
      },
    }, 201);
  } catch (err) {
    console.error('POST /api/automations error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

automations.put('/api/automations/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = parseVisibleString(c.req.param('id'), 'automation_id');
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const rawBody = await readJsonObject(c);
    if (!rawBody.ok) return c.json({ success: false, error: rawBody.error }, 400);
    const body = parseAutomationUpdate(rawBody.value);
    if (!body.ok) return c.json({ success: false, error: body.error }, 400);

    const { lineAccountId, ...updates } = body.value;
    await updateAutomation(c.env.DB, id.value, updates);
    if ('lineAccountId' in body.value) {
      await c.env.DB.prepare(`UPDATE automations SET line_account_id = ? WHERE id = ?`)
        .bind(lineAccountId ?? null, id.value)
        .run();
    }
    const updated = await getAutomationById(c.env.DB, id.value);
    if (!updated) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({
      success: true,
      data: {
        id: updated.id,
        name: updated.name,
        eventType: updated.event_type,
        conditions: JSON.parse(updated.conditions),
        actions: JSON.parse(updated.actions),
        isActive: Boolean(updated.is_active),
        priority: updated.priority,
      },
    });
  } catch (err) {
    console.error('PUT /api/automations/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

automations.delete('/api/automations/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = parseVisibleString(c.req.param('id'), 'automation_id');
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    await deleteAutomation(c.env.DB, id.value);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/automations/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ========== 自動化ログ ==========

automations.get('/api/automations/:id/logs', requireRole('owner', 'admin'), async (c) => {
  try {
    const automationId = parseVisibleString(c.req.param('id'), 'automation_id');
    if (!automationId.ok) return c.json({ success: false, error: automationId.error }, 400);
    const limit = clampLimit(c.req.query('limit'), 100);
    const logs = await getAutomationLogs(c.env.DB, automationId.value, limit);
    return c.json({
      success: true,
      data: logs.map((l) => ({
        id: l.id,
        automationId: l.automation_id,
        friendId: l.friend_id,
        eventData: l.event_data ? JSON.parse(l.event_data) : null,
        actionsResult: l.actions_result ? JSON.parse(l.actions_result) : null,
        status: l.status,
        createdAt: l.created_at,
      })),
    });
  } catch (err) {
    console.error('GET /api/automations/:id/logs error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { automations };

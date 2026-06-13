import { Hono, type Context } from 'hono';
import {
  getReminders,
  getReminderById,
  createReminder,
  updateReminder,
  deleteReminder,
  getReminderSteps,
  createReminderStep,
  deleteReminderStep,
  enrollFriendInReminder,
  getFriendReminders,
  cancelFriendReminder,
} from '@line-crm/db';
import type { Env } from '../index.js';
import { ensureSupportFriendAccess } from './support-friend-access.js';
import { requireRole } from '../middleware/role-guard.js';

const reminders = new Hono<Env>();

const REMINDER_VISIBLE_ID_MAX_LENGTH = 128;
const REMINDER_TEXT_MAX_LENGTH = 128;
const REMINDER_DESCRIPTION_MAX_LENGTH = 2048;
const REMINDER_MESSAGE_CONTENT_MAX_LENGTH = 16_000;
const REMINDER_URL_MAX_LENGTH = 2048;
const REMINDER_OFFSET_MINUTES_MAX = 525_600;
const REMINDER_VISIBLE_ASCII_PATTERN = /^[!-~]+$/;
const REMINDER_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const REMINDER_MESSAGE_TYPES = new Set(['text', 'image', 'flex']);

type ValueResult<T> = { ok: true; value: T } | { ok: false; error: string };
type ReminderCreateInput = {
  name: string;
  description?: string | null;
  lineAccountId?: string;
};
type ReminderUpdateInput = {
  name?: string;
  description?: string | null;
  isActive?: boolean;
};
type ReminderStepInput = {
  offsetMinutes: number;
  messageType: string;
  messageContent: string;
};

function hasOwn(body: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key);
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

function parseVisibleString(raw: unknown, label: string): ValueResult<string> {
  if (typeof raw !== 'string') return { ok: false, error: `invalid_${label}` };
  const value = raw.trim();
  if (!value || value.length > REMINDER_VISIBLE_ID_MAX_LENGTH || !REMINDER_VISIBLE_ASCII_PATTERN.test(value)) {
    return { ok: false, error: `invalid_${label}` };
  }
  return { ok: true, value };
}

function parseOptionalVisibleString(raw: unknown, label: string): ValueResult<string | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== 'string') return { ok: false, error: `invalid_${label}` };
  const value = raw.trim();
  if (!value) return { ok: true, value: undefined };
  return parseVisibleString(value, label);
}

function parseRequiredText(raw: unknown, error: string, maxLength = REMINDER_TEXT_MAX_LENGTH): ValueResult<string> {
  if (typeof raw !== 'string') return { ok: false, error };
  const value = raw.trim();
  if (!value || value.length > maxLength) return { ok: false, error };
  return { ok: true, value };
}

function parseOptionalText(
  raw: unknown,
  error: string,
  maxLength: number,
): ValueResult<string | null | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error };
  const value = raw.trim();
  if (!value) return { ok: true, value: null };
  if (value.length > maxLength) return { ok: false, error };
  return { ok: true, value };
}

function parseInteger(raw: unknown, error: string, min: number, max: number): ValueResult<number> {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return { ok: false, error };
  if (raw < min || raw > max) return { ok: false, error };
  return { ok: true, value: raw };
}

function parseOptionalFlag(raw: unknown, error: string): ValueResult<boolean | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw === 'boolean') return { ok: true, value: raw };
  if (raw === 0 || raw === 1) return { ok: true, value: raw === 1 };
  return { ok: false, error };
}

function parseDateOnly(raw: unknown, error: string): ValueResult<string> {
  const parsed = parseVisibleString(raw, 'target_date');
  if (!parsed.ok) return { ok: false, error };
  if (!REMINDER_DATE_PATTERN.test(parsed.value)) return { ok: false, error };
  const date = new Date(`${parsed.value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== parsed.value) {
    return { ok: false, error };
  }
  return parsed;
}

function isHttpUrl(value: string): boolean {
  if (value.length > REMINDER_URL_MAX_LENGTH) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function parseMessageContent(messageType: string, raw: unknown): ValueResult<string> {
  const content = parseRequiredText(raw, 'invalid_message_content', REMINDER_MESSAGE_CONTENT_MAX_LENGTH);
  if (!content.ok) return content;
  if (messageType === 'text') return content;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.value);
  } catch {
    return { ok: false, error: 'invalid_message_content' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'invalid_message_content' };
  }
  if (messageType === 'image') {
    const image = parsed as { originalContentUrl?: unknown; previewImageUrl?: unknown };
    if (
      typeof image.originalContentUrl !== 'string' ||
      typeof image.previewImageUrl !== 'string' ||
      !isHttpUrl(image.originalContentUrl) ||
      !isHttpUrl(image.previewImageUrl)
    ) {
      return { ok: false, error: 'invalid_message_content' };
    }
  }
  return content;
}

function parseReminderCreateInput(body: Record<string, unknown>): ValueResult<ReminderCreateInput> {
  const name = parseRequiredText(body.name, 'invalid_name');
  if (!name.ok) return name;
  const description = parseOptionalText(body.description, 'invalid_description', REMINDER_DESCRIPTION_MAX_LENGTH);
  if (!description.ok) return description;
  const lineAccountId = parseOptionalVisibleString(body.lineAccountId, 'line_account_id');
  if (!lineAccountId.ok) return lineAccountId;
  return {
    ok: true,
    value: {
      name: name.value,
      description: description.value,
      lineAccountId: lineAccountId.value,
    },
  };
}

function parseReminderUpdateInput(body: Record<string, unknown>): ValueResult<ReminderUpdateInput> {
  const input: ReminderUpdateInput = {};
  if (hasOwn(body, 'name')) {
    const name = parseRequiredText(body.name, 'invalid_name');
    if (!name.ok) return name;
    input.name = name.value;
  }
  if (hasOwn(body, 'description')) {
    const description = parseOptionalText(body.description, 'invalid_description', REMINDER_DESCRIPTION_MAX_LENGTH);
    if (!description.ok) return description;
    input.description = description.value ?? null;
  }
  if (hasOwn(body, 'isActive')) {
    const isActive = parseOptionalFlag(body.isActive, 'invalid_is_active');
    if (!isActive.ok || isActive.value === undefined) return { ok: false, error: 'invalid_is_active' };
    input.isActive = isActive.value;
  }
  if (Object.keys(input).length === 0) return { ok: false, error: 'invalid_payload' };
  return { ok: true, value: input };
}

function parseReminderStepInput(body: Record<string, unknown>): ValueResult<ReminderStepInput> {
  const offsetMinutes = parseInteger(
    body.offsetMinutes,
    'invalid_offset_minutes',
    -REMINDER_OFFSET_MINUTES_MAX,
    REMINDER_OFFSET_MINUTES_MAX,
  );
  if (!offsetMinutes.ok) return offsetMinutes;
  const messageType = parseRequiredText(body.messageType, 'invalid_message_type', 32);
  if (!messageType.ok || !REMINDER_MESSAGE_TYPES.has(messageType.value)) {
    return { ok: false, error: 'invalid_message_type' };
  }
  const messageContent = parseMessageContent(messageType.value, body.messageContent);
  if (!messageContent.ok) return messageContent;
  return {
    ok: true,
    value: {
      offsetMinutes: offsetMinutes.value,
      messageType: messageType.value,
      messageContent: messageContent.value,
    },
  };
}

function reminderRouteErrorKind(err: unknown): string {
  if (err instanceof TypeError) return 'network_error';
  if (err instanceof Error) return err.name || 'error';
  return typeof err;
}

// ========== リマインダCRUD ==========

reminders.get('/api/reminders', requireRole('owner', 'admin'), async (c) => {
  try {
    const lineAccountId = parseOptionalVisibleString(c.req.query('lineAccountId'), 'line_account_id');
    if (!lineAccountId.ok) return c.json({ success: false, error: lineAccountId.error }, 400);
    let items: Awaited<ReturnType<typeof getReminders>>;
    if (lineAccountId.value) {
      const result = await c.env.DB
        .prepare(`SELECT * FROM reminders WHERE line_account_id = ? ORDER BY created_at DESC`)
        .bind(lineAccountId.value)
        .all();
      items = result.results as unknown as Awaited<ReturnType<typeof getReminders>>;
    } else {
      items = await getReminders(c.env.DB);
    }
    return c.json({
      success: true,
      data: items.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        isActive: Boolean(r.is_active),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    });
  } catch (err) {
    console.error(`GET /api/reminders error: ${reminderRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

reminders.get('/api/reminders/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = parseVisibleString(c.req.param('id'), 'reminder_id');
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const [reminder, steps] = await Promise.all([
      getReminderById(c.env.DB, id.value),
      getReminderSteps(c.env.DB, id.value),
    ]);
    if (!reminder) return c.json({ success: false, error: 'Reminder not found' }, 404);
    return c.json({
      success: true,
      data: {
        id: reminder.id,
        name: reminder.name,
        description: reminder.description,
        isActive: Boolean(reminder.is_active),
        createdAt: reminder.created_at,
        updatedAt: reminder.updated_at,
        steps: steps.map((s) => ({
          id: s.id,
          reminderId: s.reminder_id,
          offsetMinutes: s.offset_minutes,
          messageType: s.message_type,
          messageContent: s.message_content,
          createdAt: s.created_at,
        })),
      },
    });
  } catch (err) {
    console.error(`GET /api/reminders/:id error: ${reminderRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

reminders.post('/api/reminders', requireRole('owner', 'admin'), async (c) => {
  try {
    const rawBody = await readJsonObject(c);
    if (!rawBody.ok) return c.json({ success: false, error: rawBody.error }, 400);
    const body = parseReminderCreateInput(rawBody.value);
    if (!body.ok) return c.json({ success: false, error: body.error }, 400);
    const { lineAccountId, ...reminderInput } = body.value;
    const item = await createReminder(c.env.DB, reminderInput);
    // Save line_account_id if provided
    if (lineAccountId) {
      await c.env.DB.prepare(`UPDATE reminders SET line_account_id = ? WHERE id = ?`)
        .bind(lineAccountId, item.id).run();
    }
    return c.json({ success: true, data: { id: item.id, name: item.name, createdAt: item.created_at } }, 201);
  } catch (err) {
    console.error(`POST /api/reminders error: ${reminderRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

reminders.put('/api/reminders/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = parseVisibleString(c.req.param('id'), 'reminder_id');
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const rawBody = await readJsonObject(c);
    if (!rawBody.ok) return c.json({ success: false, error: rawBody.error }, 400);
    const body = parseReminderUpdateInput(rawBody.value);
    if (!body.ok) return c.json({ success: false, error: body.error }, 400);
    await updateReminder(c.env.DB, id.value, body.value);
    const updated = await getReminderById(c.env.DB, id.value);
    if (!updated) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({ success: true, data: { id: updated.id, name: updated.name, isActive: Boolean(updated.is_active) } });
  } catch (err) {
    console.error(`PUT /api/reminders/:id error: ${reminderRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

reminders.delete('/api/reminders/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = parseVisibleString(c.req.param('id'), 'reminder_id');
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    await deleteReminder(c.env.DB, id.value);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error(`DELETE /api/reminders/:id error: ${reminderRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ========== リマインダステップ ==========

reminders.post('/api/reminders/:id/steps', requireRole('owner', 'admin'), async (c) => {
  try {
    const reminderId = parseVisibleString(c.req.param('id'), 'reminder_id');
    if (!reminderId.ok) return c.json({ success: false, error: reminderId.error }, 400);
    const rawBody = await readJsonObject(c);
    if (!rawBody.ok) return c.json({ success: false, error: rawBody.error }, 400);
    const body = parseReminderStepInput(rawBody.value);
    if (!body.ok) return c.json({ success: false, error: body.error }, 400);
    const step = await createReminderStep(c.env.DB, { reminderId: reminderId.value, ...body.value });
    return c.json({
      success: true,
      data: { id: step.id, reminderId: step.reminder_id, offsetMinutes: step.offset_minutes, messageType: step.message_type, createdAt: step.created_at },
    }, 201);
  } catch (err) {
    console.error(`POST /api/reminders/:id/steps error: ${reminderRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

reminders.delete('/api/reminders/:reminderId/steps/:stepId', requireRole('owner', 'admin'), async (c) => {
  try {
    const reminderId = parseVisibleString(c.req.param('reminderId'), 'reminder_id');
    if (!reminderId.ok) return c.json({ success: false, error: reminderId.error }, 400);
    const stepId = parseVisibleString(c.req.param('stepId'), 'step_id');
    if (!stepId.ok) return c.json({ success: false, error: stepId.error }, 400);
    await deleteReminderStep(c.env.DB, stepId.value);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error(`DELETE /api/reminders/:reminderId/steps/:stepId error: ${reminderRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ========== 友だちリマインダ登録 ==========

reminders.post('/api/reminders/:id/enroll/:friendId', async (c) => {
  try {
    const reminderId = parseVisibleString(c.req.param('id'), 'reminder_id');
    if (!reminderId.ok) return c.json({ success: false, error: reminderId.error }, 400);
    const friendId = parseVisibleString(c.req.param('friendId'), 'friend_id');
    if (!friendId.ok) return c.json({ success: false, error: friendId.error }, 400);
    const denied = await ensureSupportFriendAccess(c, friendId.value);
    if (denied) return denied;
    const rawBody = await readJsonObject(c);
    if (!rawBody.ok) return c.json({ success: false, error: rawBody.error }, 400);
    const targetDate = parseDateOnly(rawBody.value.targetDate, 'invalid_target_date');
    if (!targetDate.ok) return c.json({ success: false, error: targetDate.error }, 400);
    const enrollment = await enrollFriendInReminder(c.env.DB, {
      friendId: friendId.value,
      reminderId: reminderId.value,
      targetDate: targetDate.value,
    });
    return c.json({
      success: true,
      data: { id: enrollment.id, friendId: enrollment.friend_id, reminderId: enrollment.reminder_id, targetDate: enrollment.target_date, status: enrollment.status },
    }, 201);
  } catch (err) {
    console.error(`POST /api/reminders/:id/enroll/:friendId error: ${reminderRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

reminders.get('/api/friends/:friendId/reminders', async (c) => {
  try {
    const friendId = parseVisibleString(c.req.param('friendId'), 'friend_id');
    if (!friendId.ok) return c.json({ success: false, error: friendId.error }, 400);
    const denied = await ensureSupportFriendAccess(c, friendId.value);
    if (denied) return denied;
    const items = await getFriendReminders(c.env.DB, friendId.value);
    return c.json({
      success: true,
      data: items.map((fr) => ({
        id: fr.id,
        friendId: fr.friend_id,
        reminderId: fr.reminder_id,
        targetDate: fr.target_date,
        status: fr.status,
        createdAt: fr.created_at,
      })),
    });
  } catch (err) {
    console.error(`GET /api/friends/:friendId/reminders error: ${reminderRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

reminders.delete('/api/friend-reminders/:id', async (c) => {
  try {
    const reminderId = parseVisibleString(c.req.param('id'), 'friend_reminder_id');
    if (!reminderId.ok) return c.json({ success: false, error: reminderId.error }, 400);
    const row = await c.env.DB
      .prepare('SELECT friend_id FROM friend_reminders WHERE id = ?')
      .bind(reminderId.value)
      .first<{ friend_id: string }>();
    if (!row) return c.json({ success: false, error: 'Friend reminder not found' }, 404);
    const denied = await ensureSupportFriendAccess(c, row.friend_id, 'Friend reminder not found');
    if (denied) return denied;
    await cancelFriendReminder(c.env.DB, reminderId.value);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error(`DELETE /api/friend-reminders/:id error: ${reminderRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { reminders };

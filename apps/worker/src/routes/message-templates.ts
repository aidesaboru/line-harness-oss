import { Hono } from 'hono';
import {
  listMessageTemplates,
  getMessageTemplateById,
  createMessageTemplate,
  updateMessageTemplate,
  deleteMessageTemplate,
} from '@line-crm/db';
import type { MessageTemplate } from '@line-crm/db';
import type { Env } from '../index.js';
import { requireRole } from '../middleware/role-guard.js';

const messageTemplates = new Hono<Env>();

const MESSAGE_TEMPLATE_ID_MAX_LENGTH = 128;
const MESSAGE_TEMPLATE_NAME_MAX_LENGTH = 120;
const MESSAGE_TEMPLATE_CONTENT_MAX_LENGTH = 64 * 1024;
const MESSAGE_TEMPLATE_TYPES = new Set(['text', 'flex']);
const MESSAGE_TEMPLATE_ID_PATTERN = /^[!-~]+$/;

type MessageTemplateInput = {
  name: string;
  messageType: 'text' | 'flex';
  messageContent: string;
};

type MessageTemplateUpdateInput = Partial<MessageTemplateInput>;
type ParseResult<T> = { ok: true; body: T } | { ok: false; error: string };
type ValueResult<T> = { ok: true; value: T } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function readJsonBody(c: { req: { json(): Promise<unknown> } }): Promise<unknown | null> {
  return c.req.json().catch(() => null);
}

function parseRequiredString(raw: unknown, label: string, maxLength: number): ValueResult<string> {
  if (typeof raw !== 'string') return { ok: false, error: `${label} must be a string` };
  const value = raw.trim();
  if (!value) return { ok: false, error: `${label} is required` };
  if (value.length > maxLength) return { ok: false, error: `${label} is too long` };
  return { ok: true, value };
}

function parseOptionalString(raw: unknown, label: string, maxLength: number): ValueResult<string | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  return parseRequiredString(raw, label, maxLength);
}

function parseMessageTemplatePathId(raw: unknown): ValueResult<string> {
  const id = parseRequiredString(raw, 'messageTemplateId', MESSAGE_TEMPLATE_ID_MAX_LENGTH);
  if (!id.ok) return id;
  if (!MESSAGE_TEMPLATE_ID_PATTERN.test(id.value)) return { ok: false, error: 'messageTemplateId is invalid' };
  return id;
}

function parseMessageType(raw: unknown, required: boolean): ValueResult<'text' | 'flex' | undefined> {
  if (raw === undefined && !required) return { ok: true, value: undefined };
  const parsed = parseRequiredString(raw, 'messageType', 32);
  if (!parsed.ok) return parsed;
  if (!MESSAGE_TEMPLATE_TYPES.has(parsed.value)) return { ok: false, error: 'messageType must be text or flex' };
  return { ok: true, value: parsed.value as 'text' | 'flex' };
}

function validateMessageContent(messageType: 'text' | 'flex', messageContent: string): { ok: true } | { ok: false; error: string } {
  if (messageType !== 'flex') return { ok: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(messageContent);
  } catch {
    return { ok: false, error: 'messageContent must be valid JSON for flex type' };
  }
  if (!isRecord(parsed)) return { ok: false, error: 'messageContent must be a JSON object for flex type' };
  return { ok: true };
}

function parseMessageTemplateCreateBody(raw: unknown): ParseResult<MessageTemplateInput> {
  if (!isRecord(raw)) return { ok: false, error: 'Invalid payload' };
  const name = parseRequiredString(raw.name, 'name', MESSAGE_TEMPLATE_NAME_MAX_LENGTH);
  if (!name.ok) return name;
  const messageType = parseMessageType(raw.messageType, true);
  if (!messageType.ok || messageType.value === undefined) {
    return { ok: false, error: messageType.ok ? 'messageType is required' : messageType.error };
  }
  const messageContent = parseRequiredString(raw.messageContent, 'messageContent', MESSAGE_TEMPLATE_CONTENT_MAX_LENGTH);
  if (!messageContent.ok) return messageContent;
  const content = validateMessageContent(messageType.value, messageContent.value);
  if (!content.ok) return content;
  return {
    ok: true,
    body: { name: name.value, messageType: messageType.value, messageContent: messageContent.value },
  };
}

function parseMessageTemplateUpdateBody(raw: unknown): ParseResult<MessageTemplateUpdateInput> {
  if (!isRecord(raw)) return { ok: false, error: 'Invalid payload' };
  const name = parseOptionalString(raw.name, 'name', MESSAGE_TEMPLATE_NAME_MAX_LENGTH);
  if (!name.ok) return name;
  const messageType = parseMessageType(raw.messageType, false);
  if (!messageType.ok) return messageType;
  const messageContent = parseOptionalString(raw.messageContent, 'messageContent', MESSAGE_TEMPLATE_CONTENT_MAX_LENGTH);
  if (!messageContent.ok) return messageContent;
  if (name.value === undefined && messageType.value === undefined && messageContent.value === undefined) {
    return { ok: false, error: 'At least one field is required' };
  }
  return {
    ok: true,
    body: { name: name.value, messageType: messageType.value, messageContent: messageContent.value },
  };
}

function serialize(t: MessageTemplate) {
  return {
    id: t.id,
    name: t.name,
    messageType: t.message_type,
    messageContent: t.message_content,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  };
}

// GET /api/message-templates — list all
messageTemplates.get('/api/message-templates', requireRole('owner', 'admin'), async (c) => {
  try {
    const templates = await listMessageTemplates(c.env.DB);
    return c.json({ success: true, data: templates.map(serialize) });
  } catch (err) {
    console.error('GET /api/message-templates error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/message-templates/:id — get by id
messageTemplates.get('/api/message-templates/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = parseMessageTemplatePathId(c.req.param('id'));
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const t = await getMessageTemplateById(c.env.DB, id.value);
    if (!t) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({ success: true, data: serialize(t) });
  } catch (err) {
    console.error('GET /api/message-templates/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/message-templates — create
messageTemplates.post('/api/message-templates', requireRole('owner', 'admin'), async (c) => {
  try {
    const rawBody = await readJsonBody(c);
    const parsed = parseMessageTemplateCreateBody(rawBody);
    if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);
    const body = parsed.body;

    const t = await createMessageTemplate(c.env.DB, {
      name: body.name,
      messageType: body.messageType,
      messageContent: body.messageContent,
    });
    return c.json({ success: true, data: serialize(t) }, 201);
  } catch (err) {
    console.error('POST /api/message-templates error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PUT /api/message-templates/:id — update
messageTemplates.put('/api/message-templates/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = parseMessageTemplatePathId(c.req.param('id'));
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const rawBody = await readJsonBody(c);
    const parsed = parseMessageTemplateUpdateBody(rawBody);
    if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);
    const body = parsed.body;

    // Resolve effective type and content for validation
    const existing = await getMessageTemplateById(c.env.DB, id.value);
    if (!existing) return c.json({ success: false, error: 'Not found' }, 404);
    const effectiveType = body.messageType ?? existing.message_type;
    const effectiveContent = body.messageContent ?? existing.message_content;
    const content = validateMessageContent(effectiveType, effectiveContent);
    if (!content.ok) return c.json({ success: false, error: content.error }, 400);

    const t = await updateMessageTemplate(c.env.DB, id.value, {
      name: body.name,
      messageType: body.messageType,
      messageContent: body.messageContent,
    });
    if (!t) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({ success: true, data: serialize(t) });
  } catch (err) {
    console.error('PUT /api/message-templates/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/message-templates/:id — delete
messageTemplates.delete('/api/message-templates/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = parseMessageTemplatePathId(c.req.param('id'));
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const deleted = await deleteMessageTemplate(c.env.DB, id.value);
    if (!deleted) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/message-templates/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { messageTemplates };

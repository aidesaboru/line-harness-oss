import { Hono } from 'hono';
import {
  getTemplatesWithUsageCount,
  getTemplateById,
  getTemplateUsage,
  createTemplate,
  updateTemplate,
  deleteTemplate,
} from '@line-crm/db';
import type { Env } from '../index.js';
import { requireTemplateAccess } from '../middleware/template-access.js';

const templates = new Hono<Env>();

const TEMPLATE_NAME_MAX_LENGTH = 120;
const TEMPLATE_ID_MAX_LENGTH = 128;
const TEMPLATE_CATEGORY_MAX_LENGTH = 64;
const TEMPLATE_CONTENT_MAX_LENGTH = 64 * 1024;
const TEMPLATE_IMAGE_URL_MAX_LENGTH = 2048;
const TEMPLATE_MESSAGE_TYPES = new Set(['text', 'image', 'flex', 'carousel']);
const TEMPLATE_ID_PATTERN = /^[!-~]+$/;

type TemplateInput = {
  name: string;
  category?: string;
  messageType: string;
  messageContent: string;
};

type TemplateUpdateInput = Partial<TemplateInput>;
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

function parseOptionalQueryString(raw: string | undefined, label: string, maxLength: number): ValueResult<string | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  const value = raw.trim();
  if (!value) return { ok: true, value: undefined };
  if (value.length > maxLength) return { ok: false, error: `${label} is too long` };
  return { ok: true, value };
}

function parseTemplatePathId(raw: unknown): ValueResult<string> {
  const id = parseRequiredString(raw, 'templateId', TEMPLATE_ID_MAX_LENGTH);
  if (!id.ok) return id;
  if (!TEMPLATE_ID_PATTERN.test(id.value)) return { ok: false, error: 'templateId is invalid' };
  return id;
}

function parseMessageType(raw: unknown, required: boolean): ValueResult<string | undefined> {
  if (raw === undefined && !required) return { ok: true, value: undefined };
  const parsed = parseRequiredString(raw, 'messageType', 32);
  if (!parsed.ok) return parsed;
  if (!TEMPLATE_MESSAGE_TYPES.has(parsed.value)) return { ok: false, error: 'messageType is invalid' };
  return { ok: true, value: parsed.value };
}

function parseJsonRecord(raw: string, label: string): ValueResult<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: `${label} must be valid JSON` };
  }
  if (!isRecord(parsed)) return { ok: false, error: `${label} must be a JSON object` };
  return { ok: true, value: parsed };
}

function validateMessageContent(messageType: string, messageContent: string): { ok: true } | { ok: false; error: string } {
  if (messageType === 'image') {
    const parsed = parseJsonRecord(messageContent, 'messageContent');
    if (!parsed.ok) return parsed;
    for (const key of ['originalContentUrl', 'previewImageUrl']) {
      const value = parsed.value[key];
      if (typeof value !== 'string' || !value.trim()) {
        return { ok: false, error: `messageContent.${key} is required` };
      }
      if (value.length > TEMPLATE_IMAGE_URL_MAX_LENGTH) {
        return { ok: false, error: `messageContent.${key} is too long` };
      }
    }
  }
  if (messageType === 'flex' || messageType === 'carousel') {
    const parsed = parseJsonRecord(messageContent, 'messageContent');
    if (!parsed.ok) return parsed;
  }
  return { ok: true };
}

function parseTemplateCreateBody(raw: unknown): ParseResult<TemplateInput> {
  if (!isRecord(raw)) return { ok: false, error: 'Invalid payload' };
  const name = parseRequiredString(raw.name, 'name', TEMPLATE_NAME_MAX_LENGTH);
  if (!name.ok) return name;
  const category = parseOptionalString(raw.category, 'category', TEMPLATE_CATEGORY_MAX_LENGTH);
  if (!category.ok) return category;
  const messageType = parseMessageType(raw.messageType, true);
  if (!messageType.ok || messageType.value === undefined) {
    return { ok: false, error: messageType.ok ? 'messageType is required' : messageType.error };
  }
  const messageContent = parseRequiredString(raw.messageContent, 'messageContent', TEMPLATE_CONTENT_MAX_LENGTH);
  if (!messageContent.ok) return messageContent;
  const content = validateMessageContent(messageType.value, messageContent.value);
  if (!content.ok) return content;
  return {
    ok: true,
    body: {
      name: name.value,
      category: category.value,
      messageType: messageType.value,
      messageContent: messageContent.value,
    },
  };
}

function parseTemplateUpdateBody(raw: unknown): ParseResult<TemplateUpdateInput> {
  if (!isRecord(raw)) return { ok: false, error: 'Invalid payload' };
  const name = parseOptionalString(raw.name, 'name', TEMPLATE_NAME_MAX_LENGTH);
  if (!name.ok) return name;
  const category = parseOptionalString(raw.category, 'category', TEMPLATE_CATEGORY_MAX_LENGTH);
  if (!category.ok) return category;
  const messageType = parseMessageType(raw.messageType, false);
  if (!messageType.ok) return messageType;
  const messageContent = parseOptionalString(raw.messageContent, 'messageContent', TEMPLATE_CONTENT_MAX_LENGTH);
  if (!messageContent.ok) return messageContent;
  if (
    name.value === undefined &&
    category.value === undefined &&
    messageType.value === undefined &&
    messageContent.value === undefined
  ) {
    return { ok: false, error: 'At least one field is required' };
  }
  return {
    ok: true,
    body: {
      name: name.value,
      category: category.value,
      messageType: messageType.value,
      messageContent: messageContent.value,
    },
  };
}

function templateRouteErrorKind(err: unknown): string {
  if (err instanceof TypeError) return 'network_error';
  if (err instanceof Error) return err.name || 'error';
  return typeof err;
}

templates.get('/api/templates', requireTemplateAccess, async (c) => {
  try {
    const category = parseOptionalQueryString(c.req.query('category'), 'category', TEMPLATE_CATEGORY_MAX_LENGTH);
    if (!category.ok) return c.json({ success: false, error: category.error }, 400);
    const items = await getTemplatesWithUsageCount(c.env.DB, category.value);
    return c.json({
      success: true,
      data: items.map((t) => ({
        id: t.id,
        name: t.name,
        category: t.category,
        messageType: t.message_type,
        messageContent: t.message_content,
        usageCount: t.usage_count,
        createdAt: t.created_at,
        updatedAt: t.updated_at,
      })),
    });
  } catch (err) {
    console.error(`GET /api/templates error: ${templateRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

templates.get('/api/templates/:id', requireTemplateAccess, async (c) => {
  try {
    const id = parseTemplatePathId(c.req.param('id'));
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const item = await getTemplateById(c.env.DB, id.value);
    if (!item) return c.json({ success: false, error: 'Template not found' }, 404);
    const usedBy = await getTemplateUsage(c.env.DB, id.value);
    return c.json({
      success: true,
      data: {
        id: item.id,
        name: item.name,
        category: item.category,
        messageType: item.message_type,
        messageContent: item.message_content,
        usedBy,
        createdAt: item.created_at,
        updatedAt: item.updated_at,
      },
    });
  } catch (err) {
    console.error(`GET /api/templates/:id error: ${templateRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/templates/:id/usages — auto_replies + scenario_steps での使用箇所
templates.get('/api/templates/:id/usages', requireTemplateAccess, async (c) => {
  try {
    const templateId = parseTemplatePathId(c.req.param('id'));
    if (!templateId.ok) return c.json({ success: false, error: templateId.error }, 400);

    const tpl = await c.env.DB
      .prepare(`SELECT id FROM templates WHERE id = ?`)
      .bind(templateId.value)
      .first<{ id: string }>();
    if (!tpl) {
      return c.json({ success: false, error: 'Template not found' }, 404);
    }

    const autoRepliesResult = await c.env.DB
      .prepare(
        `SELECT id, keyword, line_account_id FROM auto_replies WHERE template_id = ?`,
      )
      .bind(templateId.value)
      .all<{ id: string; keyword: string; line_account_id: string | null }>();

    const scenarioStepsResult = await c.env.DB
      .prepare(
        `SELECT ss.id AS step_id, ss.step_order, ss.scenario_id,
                s.name AS scenario_name
         FROM scenario_steps ss
         JOIN scenarios s ON ss.scenario_id = s.id
         WHERE ss.template_id = ?
         ORDER BY s.name, ss.step_order`,
      )
      .bind(templateId.value)
      .all<{
        step_id: string;
        step_order: number;
        scenario_id: string;
        scenario_name: string;
      }>();

    return c.json({
      success: true,
      data: {
        autoReplies: autoRepliesResult.results.map((r) => ({
          id: r.id,
          keyword: r.keyword,
          lineAccountId: r.line_account_id ?? null,
        })),
        scenarioSteps: scenarioStepsResult.results.map((r) => ({
          scenarioId: r.scenario_id,
          scenarioName: r.scenario_name,
          stepId: r.step_id,
          stepOrder: r.step_order,
        })),
      },
    });
  } catch (err) {
    console.error(`GET /api/templates/:id/usages error: ${templateRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

templates.post('/api/templates', requireTemplateAccess, async (c) => {
  try {
    const rawBody = await readJsonBody(c);
    const parsed = parseTemplateCreateBody(rawBody);
    if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);
    const body = parsed.body;
    const item = await createTemplate(c.env.DB, body);
    return c.json({ success: true, data: { id: item.id, name: item.name, category: item.category, messageType: item.message_type, createdAt: item.created_at } }, 201);
  } catch (err) {
    console.error(`POST /api/templates error: ${templateRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

templates.put('/api/templates/:id', requireTemplateAccess, async (c) => {
  try {
    const id = parseTemplatePathId(c.req.param('id'));
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const rawBody = await readJsonBody(c);
    const parsed = parseTemplateUpdateBody(rawBody);
    if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);
    const body = parsed.body;
    const existing = await getTemplateById(c.env.DB, id.value);
    if (!existing) return c.json({ success: false, error: 'Not found' }, 404);
    const effectiveType = body.messageType ?? existing.message_type;
    const effectiveContent = body.messageContent ?? existing.message_content;
    const content = validateMessageContent(effectiveType, effectiveContent);
    if (!content.ok) return c.json({ success: false, error: content.error }, 400);
    await updateTemplate(c.env.DB, id.value, body);
    const updated = await getTemplateById(c.env.DB, id.value);
    if (!updated) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({
      success: true,
      data: { id: updated.id, name: updated.name, category: updated.category, messageType: updated.message_type, messageContent: updated.message_content },
    });
  } catch (err) {
    console.error(`PUT /api/templates/:id error: ${templateRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

templates.delete('/api/templates/:id', requireTemplateAccess, async (c) => {
  try {
    const id = parseTemplatePathId(c.req.param('id'));
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    // automations.actions JSON には FK が無いので、削除すると orphan な template_id が
    // 残って実行時に空メッセージ送信→partial fail を引き起こす。auto_replies は
    // ON DELETE SET NULL + inline fallback (responseContent snapshot) で大丈夫だが、
    // automations は安全な fallback パスがないので、参照があれば削除を拒否する。
    const usage = await getTemplateUsage(c.env.DB, id.value);
    if (usage.automations.length > 0) {
      return c.json({
        success: false,
        error: `automation rule (${usage.automations.length} 件) でこのテンプレートを参照しています。先にそちらの参照を解除してください。`,
        usedBy: usage,
      }, 409);
    }
    await deleteTemplate(c.env.DB, id.value);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error(`DELETE /api/templates/:id error: ${templateRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { templates };

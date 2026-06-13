import { Hono } from 'hono';
import { getTags, createTag, deleteTag } from '@line-crm/db';
import type { Tag as DbTag } from '@line-crm/db';
import type { Env } from '../index.js';
import { requireRole } from '../middleware/role-guard.js';

const tags = new Hono<Env>();

const TAG_NAME_MAX_LENGTH = 80;
const TAG_ID_MAX_LENGTH = 128;
const TAG_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;
const TAG_ID_PATTERN = /^[!-~]+$/;

type ParsedTagCreateBody =
  | { ok: true; body: { name: string; color?: string } }
  | { ok: false; error: string };
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

function parseTagPathId(raw: unknown): ValueResult<string> {
  const id = parseRequiredString(raw, 'tagId', TAG_ID_MAX_LENGTH);
  if (!id.ok) return id;
  if (!TAG_ID_PATTERN.test(id.value)) return { ok: false, error: 'tagId is invalid' };
  return id;
}

function parseTagColor(raw: unknown): ValueResult<string | undefined> {
  if (raw == null) return { ok: true, value: undefined };
  if (typeof raw !== 'string') return { ok: false, error: 'color must be a string' };
  const value = raw.trim();
  if (!value) return { ok: true, value: undefined };
  if (!TAG_COLOR_PATTERN.test(value)) return { ok: false, error: 'color must be a #RRGGBB hex color' };
  return { ok: true, value };
}

function parseTagCreateBody(raw: unknown): ParsedTagCreateBody {
  if (!isRecord(raw)) return { ok: false, error: 'Invalid payload' };
  const name = parseRequiredString(raw.name, 'name', TAG_NAME_MAX_LENGTH);
  if (!name.ok) return name;
  const color = parseTagColor(raw.color);
  if (!color.ok) return color;
  return { ok: true, body: { name: name.value, color: color.value } };
}

function serializeTag(row: DbTag) {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    createdAt: row.created_at,
  };
}

function tagRouteErrorKind(err: unknown): string {
  if (err instanceof TypeError) return 'network_error';
  if (err instanceof Error) return err.name || 'error';
  return typeof err;
}

// GET /api/tags - list all tags
tags.get('/api/tags', async (c) => {
  try {
    const items = await getTags(c.env.DB);
    return c.json({ success: true, data: items.map(serializeTag) });
  } catch (err) {
    console.error(`GET /api/tags error: ${tagRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/tags - create tag
tags.post('/api/tags', requireRole('owner', 'admin'), async (c) => {
  try {
    const rawBody = await readJsonBody(c);
    const parsed = parseTagCreateBody(rawBody);
    if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);
    const body = parsed.body;

    const tag = await createTag(c.env.DB, {
      name: body.name,
      color: body.color,
    });

    return c.json({ success: true, data: serializeTag(tag) }, 201);
  } catch (err) {
    console.error(`POST /api/tags error: ${tagRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/tags/:id - delete tag
tags.delete('/api/tags/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = parseTagPathId(c.req.param('id'));
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    await deleteTag(c.env.DB, id.value);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error(`DELETE /api/tags/:id error: ${tagRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { tags };

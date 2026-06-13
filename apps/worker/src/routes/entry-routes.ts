import { Hono } from 'hono';
import {
  getEntryRoutes,
  getEntryRouteById,
  createEntryRoute,
  updateEntryRoute,
  deleteEntryRoute,
  getEntryRouteFunnel,
} from '@line-crm/db';
import type { EntryRoute } from '@line-crm/db';
import type { Env } from '../index.js';
import { requireRole } from '../middleware/role-guard.js';

const entryRoutes = new Hono<Env>();

entryRoutes.use('/api/entry-routes', requireRole('owner', 'admin'));
entryRoutes.use('/api/entry-routes/*', requireRole('owner', 'admin'));

const ENTRY_ROUTE_REF_CODE_MAX_LENGTH = 128;
const ENTRY_ROUTE_NAME_MAX_LENGTH = 120;
const ENTRY_ROUTE_ID_MAX_LENGTH = 128;
const ENTRY_ROUTE_REDIRECT_URL_MAX_LENGTH = 2048;
const ENTRY_ROUTE_REF_CODE_PATTERN = /^[A-Za-z0-9_-]+$/;
const ENTRY_ROUTE_ID_PATTERN = /^[!-~]+$/;

type ParsedEntryRouteCreateBody =
  | {
      ok: true;
      body: {
        refCode: string;
        name: string;
        tagId: string | null;
        scenarioId: string | null;
        redirectUrl: string | null;
        poolId: string | null;
        introTemplateId: string | null;
        runAccountFriendAddScenarios?: boolean;
        isActive?: boolean;
      };
    }
  | { ok: false; error: string };
type ParsedEntryRouteUpdateBody =
  | {
      ok: true;
      body: {
        refCode?: string;
        name?: string;
        tagId?: string | null;
        scenarioId?: string | null;
        redirectUrl?: string | null;
        poolId?: string | null;
        introTemplateId?: string | null;
        runAccountFriendAddScenarios?: boolean;
        isActive?: boolean;
      };
    }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function readJsonBody(c: { req: { json(): Promise<unknown> } }): Promise<unknown | null> {
  return c.req.json().catch(() => null);
}

function parseRequiredString(
  raw: unknown,
  label: string,
  maxLength: number,
  pattern?: RegExp,
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: false, error: `${label} must be a string` };
  const value = raw.trim();
  if (!value) return { ok: false, error: `${label} is required` };
  if (value.length > maxLength) return { ok: false, error: `${label} is too long` };
  if (pattern && !pattern.test(value)) return { ok: false, error: `${label} is invalid` };
  return { ok: true, value };
}

function parseEntryRoutePathId(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  return parseRequiredString(raw, 'entryRouteId', ENTRY_ROUTE_ID_MAX_LENGTH, ENTRY_ROUTE_ID_PATTERN);
}

function parseOptionalString(
  raw: unknown,
  label: string,
  maxLength: number,
  pattern?: RegExp,
): { ok: true; value?: string } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true };
  return parseRequiredString(raw, label, maxLength, pattern);
}

function parseOptionalNullableString(
  raw: unknown,
  label: string,
  maxLength: number,
  pattern?: RegExp,
): { ok: true; value?: string | null } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true };
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: `${label} must be a string` };
  const value = raw.trim();
  if (!value) return { ok: true, value: null };
  if (value.length > maxLength) return { ok: false, error: `${label} is too long` };
  if (pattern && !pattern.test(value)) return { ok: false, error: `${label} is invalid` };
  return { ok: true, value };
}

function parseOptionalBoolean(raw: unknown, label: string): { ok: true; value?: boolean } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true };
  if (typeof raw !== 'boolean') return { ok: false, error: `${label} must be a boolean` };
  return { ok: true, value: raw };
}

function parseOptionalRedirectUrl(raw: unknown): { ok: true; value?: string | null } | { ok: false; error: string } {
  const parsed = parseOptionalNullableString(raw, 'redirectUrl', ENTRY_ROUTE_REDIRECT_URL_MAX_LENGTH);
  if (!parsed.ok || parsed.value == null) return parsed;
  try {
    const url = new URL(parsed.value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { ok: false, error: 'redirectUrl must be http(s)' };
    }
  } catch {
    return { ok: false, error: 'redirectUrl must be valid' };
  }
  return parsed;
}

function parseEntryRouteCreateBody(raw: unknown): ParsedEntryRouteCreateBody {
  if (!isRecord(raw)) return { ok: false, error: 'Invalid payload' };
  const refCode = parseRequiredString(
    raw.refCode,
    'refCode',
    ENTRY_ROUTE_REF_CODE_MAX_LENGTH,
    ENTRY_ROUTE_REF_CODE_PATTERN,
  );
  if (!refCode.ok) return refCode;
  const name = parseRequiredString(raw.name, 'name', ENTRY_ROUTE_NAME_MAX_LENGTH);
  if (!name.ok) return name;
  const tagId = parseOptionalNullableString(raw.tagId, 'tagId', ENTRY_ROUTE_ID_MAX_LENGTH, ENTRY_ROUTE_ID_PATTERN);
  if (!tagId.ok) return tagId;
  const scenarioId = parseOptionalNullableString(raw.scenarioId, 'scenarioId', ENTRY_ROUTE_ID_MAX_LENGTH, ENTRY_ROUTE_ID_PATTERN);
  if (!scenarioId.ok) return scenarioId;
  const redirectUrl = parseOptionalRedirectUrl(raw.redirectUrl);
  if (!redirectUrl.ok) return redirectUrl;
  const poolId = parseOptionalNullableString(raw.poolId, 'poolId', ENTRY_ROUTE_ID_MAX_LENGTH, ENTRY_ROUTE_ID_PATTERN);
  if (!poolId.ok) return poolId;
  const introTemplateId = parseOptionalNullableString(raw.introTemplateId, 'introTemplateId', ENTRY_ROUTE_ID_MAX_LENGTH, ENTRY_ROUTE_ID_PATTERN);
  if (!introTemplateId.ok) return introTemplateId;
  const runAccountFriendAddScenarios = parseOptionalBoolean(
    raw.runAccountFriendAddScenarios,
    'runAccountFriendAddScenarios',
  );
  if (!runAccountFriendAddScenarios.ok) return runAccountFriendAddScenarios;
  const isActive = parseOptionalBoolean(raw.isActive, 'isActive');
  if (!isActive.ok) return isActive;
  return {
    ok: true,
    body: {
      refCode: refCode.value,
      name: name.value,
      tagId: tagId.value ?? null,
      scenarioId: scenarioId.value ?? null,
      redirectUrl: redirectUrl.value ?? null,
      poolId: poolId.value ?? null,
      introTemplateId: introTemplateId.value ?? null,
      runAccountFriendAddScenarios: runAccountFriendAddScenarios.value,
      isActive: isActive.value,
    },
  };
}

function parseEntryRouteUpdateBody(raw: unknown): ParsedEntryRouteUpdateBody {
  if (!isRecord(raw)) return { ok: false, error: 'Invalid payload' };
  const refCode = parseOptionalString(
    raw.refCode,
    'refCode',
    ENTRY_ROUTE_REF_CODE_MAX_LENGTH,
    ENTRY_ROUTE_REF_CODE_PATTERN,
  );
  if (!refCode.ok) return refCode;
  const name = parseOptionalString(raw.name, 'name', ENTRY_ROUTE_NAME_MAX_LENGTH);
  if (!name.ok) return name;
  const tagId = parseOptionalNullableString(raw.tagId, 'tagId', ENTRY_ROUTE_ID_MAX_LENGTH, ENTRY_ROUTE_ID_PATTERN);
  if (!tagId.ok) return tagId;
  const scenarioId = parseOptionalNullableString(raw.scenarioId, 'scenarioId', ENTRY_ROUTE_ID_MAX_LENGTH, ENTRY_ROUTE_ID_PATTERN);
  if (!scenarioId.ok) return scenarioId;
  const redirectUrl = parseOptionalRedirectUrl(raw.redirectUrl);
  if (!redirectUrl.ok) return redirectUrl;
  const poolId = parseOptionalNullableString(raw.poolId, 'poolId', ENTRY_ROUTE_ID_MAX_LENGTH, ENTRY_ROUTE_ID_PATTERN);
  if (!poolId.ok) return poolId;
  const introTemplateId = parseOptionalNullableString(raw.introTemplateId, 'introTemplateId', ENTRY_ROUTE_ID_MAX_LENGTH, ENTRY_ROUTE_ID_PATTERN);
  if (!introTemplateId.ok) return introTemplateId;
  const runAccountFriendAddScenarios = parseOptionalBoolean(
    raw.runAccountFriendAddScenarios,
    'runAccountFriendAddScenarios',
  );
  if (!runAccountFriendAddScenarios.ok) return runAccountFriendAddScenarios;
  const isActive = parseOptionalBoolean(raw.isActive, 'isActive');
  if (!isActive.ok) return isActive;
  const body = {
    refCode: refCode.value,
    name: name.value,
    tagId: tagId.value,
    scenarioId: scenarioId.value,
    redirectUrl: redirectUrl.value,
    poolId: poolId.value,
    introTemplateId: introTemplateId.value,
    runAccountFriendAddScenarios: runAccountFriendAddScenarios.value,
    isActive: isActive.value,
  };
  if (Object.values(body).every((value) => value === undefined)) {
    return { ok: false, error: 'At least one field is required' };
  }
  return { ok: true, body };
}

function entryRouteErrorKind(err: unknown): string {
  if (err instanceof TypeError) return 'network_error';
  if (err instanceof Error) return err.name || 'error';
  return typeof err;
}

function serialize(row: EntryRoute) {
  return {
    id: row.id,
    refCode: row.ref_code,
    name: row.name,
    tagId: row.tag_id,
    scenarioId: row.scenario_id,
    redirectUrl: row.redirect_url,
    poolId: row.pool_id,
    introTemplateId: row.intro_template_id,
    runAccountFriendAddScenarios: row.run_account_friend_add_scenarios === 1,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// GET /api/entry-routes — list all
entryRoutes.get('/api/entry-routes', async (c) => {
  try {
    const rows = await getEntryRoutes(c.env.DB);
    return c.json({ success: true, data: rows.map(serialize) });
  } catch (err) {
    console.error(`GET /api/entry-routes error: ${entryRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/entry-routes/:id — single
entryRoutes.get('/api/entry-routes/:id', async (c) => {
  try {
    const id = parseEntryRoutePathId(c.req.param('id'));
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const row = await getEntryRouteById(c.env.DB, id.value);
    if (!row) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({ success: true, data: serialize(row) });
  } catch (err) {
    console.error(`GET /api/entry-routes/:id error: ${entryRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/entry-routes — create
entryRoutes.post('/api/entry-routes', async (c) => {
  try {
    const rawBody = await readJsonBody(c);
    const parsed = parseEntryRouteCreateBody(rawBody);
    if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);
    const body = parsed.body;
    const row = await createEntryRoute(c.env.DB, body);
    return c.json({ success: true, data: serialize(row) }, 201);
  } catch (err) {
    console.error(`POST /api/entry-routes error: ${entryRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PATCH /api/entry-routes/:id — update
entryRoutes.patch('/api/entry-routes/:id', async (c) => {
  try {
    const id = parseEntryRoutePathId(c.req.param('id'));
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const rawBody = await readJsonBody(c);
    const parsed = parseEntryRouteUpdateBody(rawBody);
    if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);
    const body = parsed.body;
    const row = await updateEntryRoute(c.env.DB, id.value, body);
    if (!row) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({ success: true, data: serialize(row) });
  } catch (err) {
    console.error(`PATCH /api/entry-routes/:id error: ${entryRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/entry-routes/:id
entryRoutes.delete('/api/entry-routes/:id', async (c) => {
  try {
    const id = parseEntryRoutePathId(c.req.param('id'));
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    await deleteEntryRoute(c.env.DB, id.value);
    return c.json({ success: true });
  } catch (err) {
    console.error(`DELETE /api/entry-routes/:id error: ${entryRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/entry-routes/:id/funnel
entryRoutes.get('/api/entry-routes/:id/funnel', async (c) => {
  try {
    const id = parseEntryRoutePathId(c.req.param('id'));
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const route = await getEntryRouteById(c.env.DB, id.value);
    if (!route) return c.json({ success: false, error: 'Not found' }, 404);
    const funnel = await getEntryRouteFunnel(c.env.DB, id.value);
    return c.json({ success: true, data: funnel });
  } catch (err) {
    console.error(`GET /api/entry-routes/:id/funnel error: ${entryRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { entryRoutes };

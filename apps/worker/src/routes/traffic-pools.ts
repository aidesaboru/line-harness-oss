import { Hono } from 'hono';
import {
  getTrafficPools,
  getTrafficPoolById,
  getTrafficPoolBySlug,
  createTrafficPool,
  updateTrafficPool,
  deleteTrafficPool,
  getPoolAccounts,
  addPoolAccount,
  removePoolAccount,
  togglePoolAccount,
} from '@line-crm/db';
import type { TrafficPoolWithAccount, PoolAccountWithDetails } from '@line-crm/db';
import type { Env } from '../index.js';
import { requireRole } from '../middleware/role-guard.js';

const trafficPools = new Hono<Env>();

const TRAFFIC_POOL_SLUG_MAX_LENGTH = 64;
const TRAFFIC_POOL_NAME_MAX_LENGTH = 120;
const TRAFFIC_POOL_ID_MAX_LENGTH = 128;
const TRAFFIC_POOL_PUBLIC_REF_MAX_LENGTH = 512;
const TRAFFIC_POOL_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const TRAFFIC_POOL_ID_PATTERN = /^[!-~]+$/;
const TRAFFIC_POOL_PUBLIC_FORWARD_PARAMS: Array<[string, number]> = [
  ['ref', TRAFFIC_POOL_PUBLIC_REF_MAX_LENGTH],
  ['form', TRAFFIC_POOL_ID_MAX_LENGTH],
  ['gate', TRAFFIC_POOL_PUBLIC_REF_MAX_LENGTH],
  ['xh', TRAFFIC_POOL_PUBLIC_REF_MAX_LENGTH],
  ['ig', TRAFFIC_POOL_PUBLIC_REF_MAX_LENGTH],
];

type ParsedTrafficPoolCreateBody =
  | { ok: true; body: { slug: string; name: string; activeAccountId: string } }
  | { ok: false; error: string };
type ParsedTrafficPoolUpdateBody =
  | { ok: true; body: { name?: string; activeAccountId?: string; isActive?: boolean } }
  | { ok: false; error: string };
type ParsedPoolAccountCreateBody =
  | { ok: true; body: { lineAccountId: string } }
  | { ok: false; error: string };
type ParsedPoolAccountToggleBody =
  | { ok: true; body: { isActive: boolean } }
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

function parseOptionalString(
  raw: unknown,
  label: string,
  maxLength: number,
  pattern?: RegExp,
): { ok: true; value?: string } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true };
  return parseRequiredString(raw, label, maxLength, pattern);
}

function parseTrafficPoolPathId(raw: unknown, label: string): { ok: true; value: string } | { ok: false; error: string } {
  return parseRequiredString(raw, label, TRAFFIC_POOL_ID_MAX_LENGTH, TRAFFIC_POOL_ID_PATTERN);
}

function parseTrafficPoolPublicSlug(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  return parseRequiredString(raw, 'slug', TRAFFIC_POOL_SLUG_MAX_LENGTH, TRAFFIC_POOL_SLUG_PATTERN);
}

function parsePublicForwardQuery(
  searchParams: URLSearchParams,
): { ok: true; value: URLSearchParams } | { ok: false; error: string } {
  const safeParams = new URLSearchParams();
  for (const [key, maxLength] of TRAFFIC_POOL_PUBLIC_FORWARD_PARAMS) {
    const parsed = parseOptionalString(searchParams.get(key) ?? undefined, key, maxLength, TRAFFIC_POOL_ID_PATTERN);
    if (!parsed.ok) return parsed;
    if (parsed.value) safeParams.set(key, parsed.value);
  }
  return { ok: true, value: safeParams };
}

function parseOptionalBoolean(raw: unknown, label: string): { ok: true; value?: boolean } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true };
  if (typeof raw !== 'boolean') return { ok: false, error: `${label} must be a boolean` };
  return { ok: true, value: raw };
}

function parseTrafficPoolCreateBody(raw: unknown): ParsedTrafficPoolCreateBody {
  if (!isRecord(raw)) return { ok: false, error: 'Invalid payload' };
  const slug = parseRequiredString(raw.slug, 'slug', TRAFFIC_POOL_SLUG_MAX_LENGTH, TRAFFIC_POOL_SLUG_PATTERN);
  if (!slug.ok) return slug;
  const name = parseRequiredString(raw.name, 'name', TRAFFIC_POOL_NAME_MAX_LENGTH);
  if (!name.ok) return name;
  const activeAccountId = parseRequiredString(
    raw.activeAccountId,
    'activeAccountId',
    TRAFFIC_POOL_ID_MAX_LENGTH,
    TRAFFIC_POOL_ID_PATTERN,
  );
  if (!activeAccountId.ok) return activeAccountId;
  return { ok: true, body: { slug: slug.value, name: name.value, activeAccountId: activeAccountId.value } };
}

function parseTrafficPoolUpdateBody(raw: unknown): ParsedTrafficPoolUpdateBody {
  if (!isRecord(raw)) return { ok: false, error: 'Invalid payload' };
  const name = parseOptionalString(raw.name, 'name', TRAFFIC_POOL_NAME_MAX_LENGTH);
  if (!name.ok) return name;
  const activeAccountId = parseOptionalString(
    raw.activeAccountId,
    'activeAccountId',
    TRAFFIC_POOL_ID_MAX_LENGTH,
    TRAFFIC_POOL_ID_PATTERN,
  );
  if (!activeAccountId.ok) return activeAccountId;
  const isActive = parseOptionalBoolean(raw.isActive, 'isActive');
  if (!isActive.ok) return isActive;
  if (name.value === undefined && activeAccountId.value === undefined && isActive.value === undefined) {
    return { ok: false, error: 'At least one field is required' };
  }
  return { ok: true, body: { name: name.value, activeAccountId: activeAccountId.value, isActive: isActive.value } };
}

function parsePoolAccountCreateBody(raw: unknown): ParsedPoolAccountCreateBody {
  if (!isRecord(raw)) return { ok: false, error: 'Invalid payload' };
  const lineAccountId = parseRequiredString(
    raw.lineAccountId,
    'lineAccountId',
    TRAFFIC_POOL_ID_MAX_LENGTH,
    TRAFFIC_POOL_ID_PATTERN,
  );
  if (!lineAccountId.ok) return lineAccountId;
  return { ok: true, body: { lineAccountId: lineAccountId.value } };
}

function parsePoolAccountToggleBody(raw: unknown): ParsedPoolAccountToggleBody {
  if (!isRecord(raw)) return { ok: false, error: 'Invalid payload' };
  if (typeof raw.isActive !== 'boolean') return { ok: false, error: 'isActive must be a boolean' };
  return { ok: true, body: { isActive: raw.isActive } };
}

function serialize(pool: TrafficPoolWithAccount) {
  return {
    id: pool.id,
    slug: pool.slug,
    name: pool.name,
    activeAccountId: pool.active_account_id,
    accountName: pool.account_name,
    liffId: pool.liff_id,
    isActive: Boolean(pool.is_active),
    createdAt: pool.created_at,
    updatedAt: pool.updated_at,
  };
}

// ── Public: GET /pool/:slug → 302 redirect to LIFF auth URL ────────────────

trafficPools.get('/pool/:slug', async (c) => {
  const slug = parseTrafficPoolPublicSlug(c.req.param('slug'));
  if (!slug.ok) return c.json({ success: false, error: slug.error }, 400);
  const parsedForwardParams = parsePublicForwardQuery(new URL(c.req.url).searchParams);
  if (!parsedForwardParams.ok) return c.json({ success: false, error: parsedForwardParams.error }, 400);

  const pool = await getTrafficPoolBySlug(c.env.DB, slug.value);

  if (!pool) {
    return c.json({ success: false, error: 'Pool not found' }, 404);
  }

  const baseUrl = new URL(c.req.url).origin;
  const params = new URLSearchParams();
  params.set('pool', slug.value);
  for (const [key, value] of parsedForwardParams.value) params.set(key, value);
  return c.redirect(`${baseUrl}/auth/line?${params.toString()}`, 302);
});

// ── Admin API ───────────────────────────────────────────────────────────────

// GET /api/traffic-pools — list all
trafficPools.get('/api/traffic-pools', requireRole('owner', 'admin'), async (c) => {
  try {
    const pools = await getTrafficPools(c.env.DB);
    return c.json({ success: true, data: pools.map(serialize) });
  } catch (err) {
    console.error('GET /api/traffic-pools error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/traffic-pools — create
trafficPools.post('/api/traffic-pools', requireRole('owner', 'admin'), async (c) => {
  try {
    const rawBody = await readJsonBody(c);
    const parsed = parseTrafficPoolCreateBody(rawBody);
    if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);
    const body = parsed.body;

    const pool = await createTrafficPool(c.env.DB, {
      slug: body.slug,
      name: body.name,
      activeAccountId: body.activeAccountId,
    });
    return c.json({ success: true, data: serialize(pool) }, 201);
  } catch (err) {
    console.error('POST /api/traffic-pools error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PUT /api/traffic-pools/:id — update (switch account here)
trafficPools.put('/api/traffic-pools/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = parseTrafficPoolPathId(c.req.param('id'), 'poolId');
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const rawBody = await readJsonBody(c);
    const parsed = parseTrafficPoolUpdateBody(rawBody);
    if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);
    const body = parsed.body;

    const updated = await updateTrafficPool(c.env.DB, id.value, {
      name: body.name,
      activeAccountId: body.activeAccountId,
      isActive: body.isActive,
    });

    if (!updated) {
      return c.json({ success: false, error: 'Traffic pool not found' }, 404);
    }
    return c.json({ success: true, data: serialize(updated) });
  } catch (err) {
    console.error('PUT /api/traffic-pools/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/traffic-pools/:id
trafficPools.delete('/api/traffic-pools/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = parseTrafficPoolPathId(c.req.param('id'), 'poolId');
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const existing = await getTrafficPoolById(c.env.DB, id.value);
    if (!existing) {
      return c.json({ success: false, error: 'Traffic pool not found' }, 404);
    }
    // The 'main' pool is the default fallback for /r/:ref / /auth/line and
    // for new LINE account auto-enrollment; deleting it breaks single-account
    // onboarding silently. Surface as 400 instead.
    if (existing.slug === 'main') {
      return c.json({ success: false, error: 'main pool cannot be deleted' }, 400);
    }
    await deleteTrafficPool(c.env.DB, id.value);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/traffic-pools/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

function serializePoolAccount(pa: PoolAccountWithDetails) {
  return {
    id: pa.id,
    poolId: pa.pool_id,
    lineAccountId: pa.line_account_id,
    accountName: pa.account_name,
    liffId: pa.liff_id,
    isActive: Boolean(pa.is_active),
    createdAt: pa.created_at,
  };
}

// GET /api/traffic-pools/:id/accounts — list pool accounts
trafficPools.get('/api/traffic-pools/:id/accounts', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = parseTrafficPoolPathId(c.req.param('id'), 'poolId');
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const accounts = await getPoolAccounts(c.env.DB, id.value);
    return c.json({ success: true, data: accounts.map(serializePoolAccount) });
  } catch (err) {
    console.error('GET /api/traffic-pools/:id/accounts error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/traffic-pools/:id/accounts — add account to pool
trafficPools.post('/api/traffic-pools/:id/accounts', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = parseTrafficPoolPathId(c.req.param('id'), 'poolId');
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const rawBody = await readJsonBody(c);
    const parsed = parsePoolAccountCreateBody(rawBody);
    if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);
    const body = parsed.body;
    const account = await addPoolAccount(c.env.DB, id.value, body.lineAccountId);
    return c.json({ success: true, data: account }, 201);
  } catch (err: any) {
    if (err?.message?.includes('UNIQUE constraint')) {
      return c.json({ success: false, error: 'Account already in this pool' }, 409);
    }
    console.error('POST /api/traffic-pools/:id/accounts error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PUT /api/traffic-pools/:id/accounts/:accountId — toggle active
trafficPools.put('/api/traffic-pools/:id/accounts/:accountId', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = parseTrafficPoolPathId(c.req.param('id'), 'poolId');
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const accountId = parseTrafficPoolPathId(c.req.param('accountId'), 'poolAccountId');
    if (!accountId.ok) return c.json({ success: false, error: accountId.error }, 400);
    const rawBody = await readJsonBody(c);
    const parsed = parsePoolAccountToggleBody(rawBody);
    if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);
    const body = parsed.body;
    const result = await togglePoolAccount(c.env.DB, accountId.value, body.isActive);
    if (!result) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({ success: true, data: result });
  } catch (err) {
    console.error('PUT /api/traffic-pools/:id/accounts/:accountId error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/traffic-pools/:id/accounts/:accountId — remove account from pool
trafficPools.delete('/api/traffic-pools/:id/accounts/:accountId', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = parseTrafficPoolPathId(c.req.param('id'), 'poolId');
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const accountId = parseTrafficPoolPathId(c.req.param('accountId'), 'poolAccountId');
    if (!accountId.ok) return c.json({ success: false, error: accountId.error }, 400);
    const deleted = await removePoolAccount(c.env.DB, accountId.value);
    if (!deleted) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/traffic-pools/:id/accounts/:accountId error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { trafficPools };

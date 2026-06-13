import { Hono } from 'hono';
import {
  getAffiliates,
  getAffiliateById,
  getAffiliateByCode,
  createAffiliate,
  updateAffiliate,
  deleteAffiliate,
  recordAffiliateClick,
  getAffiliateReport,
} from '@line-crm/db';
import type { Env } from '../index.js';
import { requireRole } from '../middleware/role-guard.js';

const affiliates = new Hono<Env>();
const AFFILIATE_NAME_MAX_LENGTH = 120;
const AFFILIATE_CLICK_CODE_MAX_LENGTH = 128;
const AFFILIATE_CLICK_URL_MAX_LENGTH = 2048;
const AFFILIATE_CLICK_IP_MAX_LENGTH = 128;
const AFFILIATE_CODE_PATTERN = /^[A-Za-z0-9_-]+$/;
const AFFILIATE_ID_MAX_LENGTH = 128;
const AFFILIATE_DATE_MAX_LENGTH = 64;
const VISIBLE_ASCII_PATTERN = /^[!-~]+$/;

type ParsedAffiliateClickBody =
  | { ok: true; code: string; url: string | null }
  | { ok: false; error: string };
type ParsedCreateAffiliateBody =
  | { ok: true; body: { name: string; code: string; commissionRate?: number } }
  | { ok: false; error: string };
type ParsedUpdateAffiliateBody =
  | { ok: true; body: { name?: string; commissionRate?: number; isActive?: boolean } }
  | { ok: false; error: string };
type ValueResult<T> = { ok: true; value: T } | { ok: false; error: string };

function serializeAffiliate(row: { id: string; name: string; code: string; commission_rate: number; is_active: number; created_at: string }) {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    commissionRate: row.commission_rate,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function readJsonBody(c: { req: { json(): Promise<unknown> } }): Promise<unknown | null> {
  return c.req.json().catch(() => null);
}

function parseAffiliateName(raw: unknown, required: boolean): { ok: true; value?: string } | { ok: false; error: string } {
  if (raw == null) {
    return required ? { ok: false, error: 'name is required' } : { ok: true };
  }
  if (typeof raw !== 'string') return { ok: false, error: 'name must be a string' };
  const value = raw.trim();
  if (!value) return { ok: false, error: 'name is required' };
  if (value.length > AFFILIATE_NAME_MAX_LENGTH) return { ok: false, error: 'name is too long' };
  return { ok: true, value };
}

function parseAffiliateCode(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return { ok: false, error: 'code is required' };
  if (value.length > AFFILIATE_CLICK_CODE_MAX_LENGTH) return { ok: false, error: 'code is too long' };
  if (!AFFILIATE_CODE_PATTERN.test(value)) return { ok: false, error: 'code must be URL-safe' };
  return { ok: true, value };
}

function parseVisibleString(raw: unknown, label: string, maxLength: number): ValueResult<string> {
  if (typeof raw !== 'string') return { ok: false, error: `${label} must be a string` };
  const value = raw.trim();
  if (!value) return { ok: false, error: `${label} is required` };
  if (value.length > maxLength) return { ok: false, error: `${label} is too long` };
  if (!VISIBLE_ASCII_PATTERN.test(value)) return { ok: false, error: `${label} is invalid` };
  return { ok: true, value };
}

function parseOptionalDateQuery(raw: string | undefined, label: string): ValueResult<string | undefined> {
  if (raw == null) return { ok: true, value: undefined };
  const parsed = parseVisibleString(raw, label, AFFILIATE_DATE_MAX_LENGTH);
  if (!parsed.ok && parsed.error === `${label} is required`) return { ok: true, value: undefined };
  if (!parsed.ok) return parsed;
  if (!Number.isFinite(new Date(parsed.value).getTime())) {
    return { ok: false, error: `${label} is invalid` };
  }
  return parsed;
}

function parseAffiliateReportDateRange(
  startRaw: string | undefined,
  endRaw: string | undefined,
): ValueResult<{ startDate?: string; endDate?: string }> {
  const startDate = parseOptionalDateQuery(startRaw, 'startDate');
  if (!startDate.ok) return startDate;
  const endDate = parseOptionalDateQuery(endRaw, 'endDate');
  if (!endDate.ok) return endDate;
  if (
    startDate.value &&
    endDate.value &&
    new Date(startDate.value).getTime() > new Date(endDate.value).getTime()
  ) {
    return { ok: false, error: 'startDate must be before or equal to endDate' };
  }
  return { ok: true, value: { startDate: startDate.value, endDate: endDate.value } };
}

function parseCommissionRate(raw: unknown, required = false): { ok: true; value?: number } | { ok: false; error: string } {
  if (raw == null) {
    return required ? { ok: false, error: 'commissionRate is required' } : { ok: true };
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 1) {
    return { ok: false, error: 'commissionRate must be between 0 and 1' };
  }
  return { ok: true, value: raw };
}

function parseCreateAffiliateBody(raw: unknown): ParsedCreateAffiliateBody {
  if (!isRecord(raw)) return { ok: false, error: 'Invalid payload' };

  const name = parseAffiliateName(raw.name, true);
  if (!name.ok) return name;
  const code = parseAffiliateCode(raw.code);
  if (!code.ok) return code;
  const commissionRate = parseCommissionRate(raw.commissionRate);
  if (!commissionRate.ok) return commissionRate;

  return {
    ok: true,
    body: {
      name: name.value!,
      code: code.value,
      commissionRate: commissionRate.value,
    },
  };
}

function parseUpdateAffiliateBody(raw: unknown): ParsedUpdateAffiliateBody {
  if (!isRecord(raw)) return { ok: false, error: 'Invalid payload' };

  const name = parseAffiliateName(raw.name, false);
  if (!name.ok) return name;
  const commissionRate = parseCommissionRate(raw.commissionRate);
  if (!commissionRate.ok) return commissionRate;
  if (raw.isActive !== undefined && typeof raw.isActive !== 'boolean') {
    return { ok: false, error: 'isActive must be boolean' };
  }

  return {
    ok: true,
    body: {
      name: name.value,
      commissionRate: commissionRate.value,
      isActive: raw.isActive,
    },
  };
}

function parseAffiliateClickBody(raw: unknown): ParsedAffiliateClickBody {
  if (!isRecord(raw)) return { ok: false, error: 'Invalid payload' };

  const code = parseAffiliateCode(raw.code);
  if (!code.ok) return code;

  if (raw.url == null || raw.url === '') {
    return { ok: true, code: code.value, url: null };
  }
  if (typeof raw.url !== 'string') return { ok: false, error: 'url must be a string' };

  const url = raw.url.trim();
  if (!url) return { ok: true, code: code.value, url: null };
  if (url.length > AFFILIATE_CLICK_URL_MAX_LENGTH) {
    return { ok: false, error: 'url is too long' };
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, error: 'url must be http(s)' };
    }
  } catch {
    return { ok: false, error: 'url must be valid' };
  }

  return { ok: true, code: code.value, url };
}

function getClientIp(c: { req: { header(name: string): string | undefined } }): string | null {
  const rawIp = c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For') ?? null;
  if (!rawIp) return null;
  const ip = rawIp.split(',')[0]?.trim() ?? '';
  if (!ip || ip.length > AFFILIATE_CLICK_IP_MAX_LENGTH) return null;
  return ip;
}

function affiliateRouteErrorKind(err: unknown): string {
  if (err instanceof TypeError) return 'network_error';
  if (err instanceof Error) return err.name || 'error';
  return typeof err;
}

// GET /api/affiliates - list all
affiliates.get('/api/affiliates', requireRole('owner', 'admin'), async (c) => {
  try {
    const items = await getAffiliates(c.env.DB);
    return c.json({ success: true, data: items.map(serializeAffiliate) });
  } catch (err) {
    console.error(`GET /api/affiliates error: ${affiliateRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/affiliates/:id - get single
affiliates.get('/api/affiliates/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = parseVisibleString(c.req.param('id'), 'id', AFFILIATE_ID_MAX_LENGTH);
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const item = await getAffiliateById(c.env.DB, id.value);
    if (!item) {
      return c.json({ success: false, error: 'Affiliate not found' }, 404);
    }
    return c.json({ success: true, data: serializeAffiliate(item) });
  } catch (err) {
    console.error(`GET /api/affiliates/:id error: ${affiliateRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/affiliates - create
affiliates.post('/api/affiliates', requireRole('owner', 'admin'), async (c) => {
  try {
    const rawBody = await readJsonBody(c);
    const parsed = parseCreateAffiliateBody(rawBody);
    if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);

    const item = await createAffiliate(c.env.DB, parsed.body);
    return c.json({ success: true, data: serializeAffiliate(item) }, 201);
  } catch (err) {
    console.error(`POST /api/affiliates error: ${affiliateRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PUT /api/affiliates/:id - update
affiliates.put('/api/affiliates/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = parseVisibleString(c.req.param('id'), 'id', AFFILIATE_ID_MAX_LENGTH);
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const rawBody = await readJsonBody(c);
    const parsed = parseUpdateAffiliateBody(rawBody);
    if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);
    const body = parsed.body;

    const updated = await updateAffiliate(c.env.DB, id.value, {
      name: body.name,
      commission_rate: body.commissionRate,
      is_active: body.isActive !== undefined ? (body.isActive ? 1 : 0) : undefined,
    });

    if (!updated) {
      return c.json({ success: false, error: 'Affiliate not found' }, 404);
    }
    return c.json({ success: true, data: serializeAffiliate(updated) });
  } catch (err) {
    console.error(`PUT /api/affiliates/:id error: ${affiliateRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/affiliates/:id - delete
affiliates.delete('/api/affiliates/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = parseVisibleString(c.req.param('id'), 'id', AFFILIATE_ID_MAX_LENGTH);
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    await deleteAffiliate(c.env.DB, id.value);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error(`DELETE /api/affiliates/:id error: ${affiliateRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/affiliates/:id/report - affiliate performance report
affiliates.get('/api/affiliates/:id/report', requireRole('owner', 'admin'), async (c) => {
  try {
    const affiliateId = parseVisibleString(c.req.param('id'), 'id', AFFILIATE_ID_MAX_LENGTH);
    if (!affiliateId.ok) return c.json({ success: false, error: affiliateId.error }, 400);
    const dates = parseAffiliateReportDateRange(c.req.query('startDate'), c.req.query('endDate'));
    if (!dates.ok) return c.json({ success: false, error: dates.error }, 400);
    const report = await getAffiliateReport(c.env.DB, affiliateId.value, dates.value);

    if (report.length === 0) {
      return c.json({ success: false, error: 'Affiliate not found' }, 404);
    }
    return c.json({ success: true, data: report[0] });
  } catch (err) {
    console.error(`GET /api/affiliates/:id/report error: ${affiliateRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/affiliates/click - record click (public endpoint tracked by ref param)
affiliates.post('/api/affiliates/click', async (c) => {
  try {
    const rawBody = await readJsonBody(c);
    const body = parseAffiliateClickBody(rawBody);
    if (!body.ok) return c.json({ success: false, error: body.error }, 400);

    const affiliate = await getAffiliateByCode(c.env.DB, body.code);
    if (!affiliate) {
      return c.json({ success: false, error: 'Affiliate not found' }, 404);
    }

    const ipAddress = getClientIp(c);
    await recordAffiliateClick(c.env.DB, affiliate.id, body.url, ipAddress);
    return c.json({ success: true, data: null }, 201);
  } catch (err) {
    console.error(`POST /api/affiliates/click error: ${affiliateRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/affiliates/report - all affiliates report
affiliates.get('/api/affiliates-report', requireRole('owner', 'admin'), async (c) => {
  try {
    const dates = parseAffiliateReportDateRange(c.req.query('startDate'), c.req.query('endDate'));
    if (!dates.ok) return c.json({ success: false, error: dates.error }, 400);
    const report = await getAffiliateReport(c.env.DB, undefined, dates.value);
    return c.json({ success: true, data: report });
  } catch (err) {
    console.error(`GET /api/affiliates-report error: ${affiliateRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { affiliates };

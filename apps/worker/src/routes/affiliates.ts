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
const AFFILIATE_CLICK_CODE_MAX_LENGTH = 128;
const AFFILIATE_CLICK_URL_MAX_LENGTH = 2048;
const AFFILIATE_CLICK_IP_MAX_LENGTH = 128;

type ParsedAffiliateClickBody =
  | { ok: true; code: string; url: string | null }
  | { ok: false; error: string };

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

function parseAffiliateClickBody(raw: unknown): ParsedAffiliateClickBody {
  if (!isRecord(raw)) return { ok: false, error: 'Invalid payload' };

  const code = typeof raw.code === 'string' ? raw.code.trim() : '';
  if (!code) return { ok: false, error: 'code is required' };
  if (code.length > AFFILIATE_CLICK_CODE_MAX_LENGTH) {
    return { ok: false, error: 'code is too long' };
  }

  if (raw.url == null || raw.url === '') {
    return { ok: true, code, url: null };
  }
  if (typeof raw.url !== 'string') return { ok: false, error: 'url must be a string' };

  const url = raw.url.trim();
  if (!url) return { ok: true, code, url: null };
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

  return { ok: true, code, url };
}

function getClientIp(c: { req: { header(name: string): string | undefined } }): string | null {
  const rawIp = c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For') ?? null;
  if (!rawIp) return null;
  const ip = rawIp.split(',')[0]?.trim() ?? '';
  if (!ip || ip.length > AFFILIATE_CLICK_IP_MAX_LENGTH) return null;
  return ip;
}

// GET /api/affiliates - list all
affiliates.get('/api/affiliates', requireRole('owner', 'admin'), async (c) => {
  try {
    const items = await getAffiliates(c.env.DB);
    return c.json({ success: true, data: items.map(serializeAffiliate) });
  } catch (err) {
    console.error('GET /api/affiliates error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/affiliates/:id - get single
affiliates.get('/api/affiliates/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    const item = await getAffiliateById(c.env.DB, c.req.param('id')!);
    if (!item) {
      return c.json({ success: false, error: 'Affiliate not found' }, 404);
    }
    return c.json({ success: true, data: serializeAffiliate(item) });
  } catch (err) {
    console.error('GET /api/affiliates/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/affiliates - create
affiliates.post('/api/affiliates', requireRole('owner', 'admin'), async (c) => {
  try {
    const body = await c.req.json<{
      name: string;
      code: string;
      commissionRate?: number;
    }>();

    if (!body.name || !body.code) {
      return c.json({ success: false, error: 'name and code are required' }, 400);
    }

    const item = await createAffiliate(c.env.DB, body);
    return c.json({ success: true, data: serializeAffiliate(item) }, 201);
  } catch (err) {
    console.error('POST /api/affiliates error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PUT /api/affiliates/:id - update
affiliates.put('/api/affiliates/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = c.req.param('id')!;
    const body = await c.req.json<{
      name?: string;
      commissionRate?: number;
      isActive?: boolean;
    }>();

    const updated = await updateAffiliate(c.env.DB, id, {
      name: body.name,
      commission_rate: body.commissionRate,
      is_active: body.isActive !== undefined ? (body.isActive ? 1 : 0) : undefined,
    });

    if (!updated) {
      return c.json({ success: false, error: 'Affiliate not found' }, 404);
    }
    return c.json({ success: true, data: serializeAffiliate(updated) });
  } catch (err) {
    console.error('PUT /api/affiliates/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/affiliates/:id - delete
affiliates.delete('/api/affiliates/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    await deleteAffiliate(c.env.DB, c.req.param('id')!);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/affiliates/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/affiliates/:id/report - affiliate performance report
affiliates.get('/api/affiliates/:id/report', requireRole('owner', 'admin'), async (c) => {
  try {
    const report = await getAffiliateReport(c.env.DB, c.req.param('id')!, {
      startDate: c.req.query('startDate'),
      endDate: c.req.query('endDate'),
    });

    if (report.length === 0) {
      return c.json({ success: false, error: 'Affiliate not found' }, 404);
    }
    return c.json({ success: true, data: report[0] });
  } catch (err) {
    console.error('GET /api/affiliates/:id/report error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/affiliates/click - record click (public endpoint tracked by ref param)
affiliates.post('/api/affiliates/click', async (c) => {
  try {
    const rawBody = await c.req.json().catch(() => null);
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
    console.error('POST /api/affiliates/click error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/affiliates/report - all affiliates report
affiliates.get('/api/affiliates-report', requireRole('owner', 'admin'), async (c) => {
  try {
    const report = await getAffiliateReport(c.env.DB, undefined, {
      startDate: c.req.query('startDate'),
      endDate: c.req.query('endDate'),
    });
    return c.json({ success: true, data: report });
  } catch (err) {
    console.error('GET /api/affiliates-report error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { affiliates };

import { Hono, type Context } from 'hono';
import {
  getConversionPoints,
  getConversionPointById,
  createConversionPoint,
  deleteConversionPoint,
  trackConversion,
} from '@line-crm/db';
import type { Env } from '../index.js';
import { supportFriendVisibilitySql } from '../services/support-access.js';
import { currentSupportStaff, ensureSupportFriendAccess } from './support-friend-access.js';
import { requireRole } from '../middleware/role-guard.js';

const conversions = new Hono<Env>();

const CONVERSION_POINT_NAME_MAX_LENGTH = 120;
const CONVERSION_POINT_EVENT_TYPE_MAX_LENGTH = 128;
const CONVERSION_POINT_VALUE_MAX = 1_000_000_000_000;
const CONVERSION_ID_MAX_LENGTH = 128;
const CONVERSION_METADATA_MAX_KEYS = 50;
const CONVERSION_METADATA_MAX_JSON_LENGTH = 16 * 1024;
const CONVERSION_POINT_EVENT_TYPE_PATTERN = /^[!-~]+$/;
const CONVERSION_ID_PATTERN = /^[!-~]+$/;

type ValueResult<T> = { ok: true; value: T } | { ok: false; error: string };

type ParsedConversionPointCreateBody = ValueResult<{
  name: string;
  eventType: string;
  value: number | null;
}>;
type ParsedConversionTrackBody = ValueResult<{
  conversionPointId: string;
  friendId: string;
  userId: string | null;
  affiliateCode: string | null;
  metadata: string | null;
}>;

interface ConversionEventRow {
  id: string;
  conversion_point_id: string;
  friend_id: string;
  user_id: string | null;
  affiliate_code: string | null;
  metadata: string | null;
  created_at: string;
}

interface ConversionEventFilters {
  conversionPointId?: string;
  friendId?: string;
  affiliateCode?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
  offset?: number;
}

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
): ValueResult<string> {
  if (typeof raw !== 'string') return { ok: false, error: `${label} must be a string` };
  const value = raw.trim();
  if (!value) return { ok: false, error: `${label} is required` };
  if (value.length > maxLength) return { ok: false, error: `${label} is too long` };
  if (pattern && !pattern.test(value)) return { ok: false, error: `${label} is invalid` };
  return { ok: true, value };
}

function parseOptionalNullableValue(raw: unknown): ValueResult<number | null | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return { ok: false, error: 'value must be a finite number' };
  }
  if (raw < 0 || raw > CONVERSION_POINT_VALUE_MAX) {
    return { ok: false, error: 'value is out of range' };
  }
  return { ok: true, value: raw };
}

function parseOptionalNullableString(
  raw: unknown,
  label: string,
  maxLength: number,
  pattern?: RegExp,
): ValueResult<string | null | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: `${label} must be a string` };
  const value = raw.trim();
  if (!value) return { ok: true, value: null };
  if (value.length > maxLength) return { ok: false, error: `${label} is too long` };
  if (pattern && !pattern.test(value)) return { ok: false, error: `${label} is invalid` };
  return { ok: true, value };
}

function parseOptionalMetadata(raw: unknown): ValueResult<string | null | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null) return { ok: true, value: null };
  if (!isRecord(raw)) return { ok: false, error: 'metadata must be an object' };
  if (Object.keys(raw).length > CONVERSION_METADATA_MAX_KEYS) {
    return { ok: false, error: 'metadata has too many keys' };
  }
  const serialized = JSON.stringify(raw);
  if (serialized.length > CONVERSION_METADATA_MAX_JSON_LENGTH) {
    return { ok: false, error: 'metadata is too large' };
  }
  return { ok: true, value: serialized };
}

function parseConversionPointCreateBody(raw: unknown): ParsedConversionPointCreateBody {
  if (!isRecord(raw)) return { ok: false, error: 'Invalid payload' };

  const name = parseRequiredString(raw.name, 'name', CONVERSION_POINT_NAME_MAX_LENGTH);
  if (!name.ok) return name;

  const eventType = parseRequiredString(
    raw.eventType,
    'eventType',
    CONVERSION_POINT_EVENT_TYPE_MAX_LENGTH,
    CONVERSION_POINT_EVENT_TYPE_PATTERN,
  );
  if (!eventType.ok) return eventType;

  const value = parseOptionalNullableValue(raw.value);
  if (!value.ok) return value;

  return {
    ok: true,
    value: {
      name: name.value,
      eventType: eventType.value,
      value: value.value ?? null,
    },
  };
}

function parseConversionTrackBody(raw: unknown): ParsedConversionTrackBody {
  if (!isRecord(raw)) return { ok: false, error: 'Invalid payload' };

  const conversionPointId = parseRequiredString(
    raw.conversionPointId,
    'conversionPointId',
    CONVERSION_ID_MAX_LENGTH,
    CONVERSION_ID_PATTERN,
  );
  if (!conversionPointId.ok) return conversionPointId;

  const friendId = parseRequiredString(raw.friendId, 'friendId', CONVERSION_ID_MAX_LENGTH, CONVERSION_ID_PATTERN);
  if (!friendId.ok) return friendId;

  const userId = parseOptionalNullableString(raw.userId, 'userId', CONVERSION_ID_MAX_LENGTH, CONVERSION_ID_PATTERN);
  if (!userId.ok) return userId;

  const affiliateCode = parseOptionalNullableString(
    raw.affiliateCode,
    'affiliateCode',
    CONVERSION_ID_MAX_LENGTH,
    CONVERSION_ID_PATTERN,
  );
  if (!affiliateCode.ok) return affiliateCode;

  const metadata = parseOptionalMetadata(raw.metadata);
  if (!metadata.ok) return metadata;

  return {
    ok: true,
    value: {
      conversionPointId: conversionPointId.value,
      friendId: friendId.value,
      userId: userId.value ?? null,
      affiliateCode: affiliateCode.value ?? null,
      metadata: metadata.value ?? null,
    },
  };
}

function clampLimit(raw: string | undefined, fallback = 100): number {
  const n = Number(raw ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(500, Math.floor(n)));
}

function clampOffset(raw: string | undefined): number {
  const n = Number(raw ?? 0);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}

function conversionFriendScope(c: Context<Env>, friendIdExpression: string) {
  return supportFriendVisibilitySql(currentSupportStaff(c), friendIdExpression);
}

async function getScopedConversionEvents(
  c: Context<Env>,
  opts: ConversionEventFilters,
): Promise<ConversionEventRow[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (opts.conversionPointId) {
    conditions.push('ce.conversion_point_id = ?');
    values.push(opts.conversionPointId);
  }
  if (opts.friendId) {
    conditions.push('ce.friend_id = ?');
    values.push(opts.friendId);
  }
  if (opts.affiliateCode) {
    conditions.push('ce.affiliate_code = ?');
    values.push(opts.affiliateCode);
  }
  if (opts.startDate) {
    conditions.push('ce.created_at >= ?');
    values.push(opts.startDate);
  }
  if (opts.endDate) {
    conditions.push('ce.created_at <= ?');
    values.push(opts.endDate);
  }

  const visibility = conversionFriendScope(c, 'ce.friend_id');
  if (visibility.sql) {
    conditions.push(visibility.sql);
    values.push(...visibility.binds);
  }

  values.push(opts.limit ?? 100, opts.offset ?? 0);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await c.env.DB
    .prepare(`SELECT ce.* FROM conversion_events ce ${where} ORDER BY ce.created_at DESC LIMIT ? OFFSET ?`)
    .bind(...values)
    .all<ConversionEventRow>();
  return result.results;
}

async function getScopedConversionReport(
  c: Context<Env>,
  opts: { startDate?: string; endDate?: string },
) {
  const joinConditions = ['ce.conversion_point_id = cp.id'];
  const values: unknown[] = [];

  if (opts.startDate) {
    joinConditions.push('ce.created_at >= ?');
    values.push(opts.startDate);
  }
  if (opts.endDate) {
    joinConditions.push('ce.created_at <= ?');
    values.push(opts.endDate);
  }

  const visibility = conversionFriendScope(c, 'ce.friend_id');
  if (visibility.sql) {
    joinConditions.push(visibility.sql);
    values.push(...visibility.binds);
  }

  const result = await c.env.DB
    .prepare(
      `SELECT
         cp.id as conversion_point_id,
         cp.name as conversion_point_name,
         cp.event_type,
         COUNT(ce.id) as total_count,
         COALESCE(SUM(cp.value), 0) as total_value
       FROM conversion_points cp
       LEFT JOIN conversion_events ce ON ${joinConditions.join(' AND ')}
       GROUP BY cp.id
       ORDER BY total_count DESC`,
    )
    .bind(...values)
    .all<{
      conversion_point_id: string;
      conversion_point_name: string;
      event_type: string;
      total_count: number;
      total_value: number;
    }>();

  return result.results.map((r) => ({
    conversionPointId: r.conversion_point_id,
    conversionPointName: r.conversion_point_name,
    eventType: r.event_type,
    totalCount: r.total_count,
    totalValue: r.total_value,
  }));
}

// ── Conversion Points ───────────────────────────────────────────────────────

// GET /api/conversions/points - list all
conversions.get('/api/conversions/points', requireRole('owner', 'admin'), async (c) => {
  try {
    const items = await getConversionPoints(c.env.DB);
    return c.json({
      success: true,
      data: items.map((p) => ({
        id: p.id,
        name: p.name,
        eventType: p.event_type,
        value: p.value,
        createdAt: p.created_at,
      })),
    });
  } catch (err) {
    console.error('GET /api/conversions/points error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/conversions/points - create
conversions.post('/api/conversions/points', requireRole('owner', 'admin'), async (c) => {
  try {
    const rawBody = await readJsonBody(c);
    const parsed = parseConversionPointCreateBody(rawBody);
    if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);

    const point = await createConversionPoint(c.env.DB, parsed.value);
    return c.json({
      success: true,
      data: {
        id: point.id,
        name: point.name,
        eventType: point.event_type,
        value: point.value,
        createdAt: point.created_at,
      },
    }, 201);
  } catch (err) {
    console.error('POST /api/conversions/points error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/conversions/points/:id - delete
conversions.delete('/api/conversions/points/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    await deleteConversionPoint(c.env.DB, c.req.param('id')!);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/conversions/points/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ── Conversion Tracking ─────────────────────────────────────────────────────

// POST /api/conversions/track - record conversion
conversions.post('/api/conversions/track', async (c) => {
  try {
    const rawBody = await readJsonBody(c);
    const parsed = parseConversionTrackBody(rawBody);
    if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);
    const body = parsed.value;

    const denied = await ensureSupportFriendAccess(c, body.friendId);
    if (denied) return denied;

    const event = await trackConversion(c.env.DB, {
      conversionPointId: body.conversionPointId,
      friendId: body.friendId,
      userId: body.userId,
      affiliateCode: body.affiliateCode,
      metadata: body.metadata,
    });

    return c.json({
      success: true,
      data: {
        id: event.id,
        conversionPointId: event.conversion_point_id,
        friendId: event.friend_id,
        userId: event.user_id,
        affiliateCode: event.affiliate_code,
        metadata: event.metadata,
        createdAt: event.created_at,
      },
    }, 201);
  } catch (err) {
    console.error('POST /api/conversions/track error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/conversions/events - list events with filters
conversions.get('/api/conversions/events', async (c) => {
  try {
    const friendId = c.req.query('friendId');
    if (friendId) {
      const denied = await ensureSupportFriendAccess(c, friendId);
      if (denied) return denied;
    }

    const events = await getScopedConversionEvents(c, {
      conversionPointId: c.req.query('conversionPointId'),
      friendId,
      affiliateCode: c.req.query('affiliateCode'),
      startDate: c.req.query('startDate'),
      endDate: c.req.query('endDate'),
      limit: clampLimit(c.req.query('limit'), 100),
      offset: clampOffset(c.req.query('offset')),
    });

    return c.json({
      success: true,
      data: events.map((e) => ({
        id: e.id,
        conversionPointId: e.conversion_point_id,
        friendId: e.friend_id,
        userId: e.user_id,
        affiliateCode: e.affiliate_code,
        metadata: e.metadata,
        createdAt: e.created_at,
      })),
    });
  } catch (err) {
    console.error('GET /api/conversions/events error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/conversions/report - aggregated report
conversions.get('/api/conversions/report', async (c) => {
  try {
    const report = await getScopedConversionReport(c, {
      startDate: c.req.query('startDate'),
      endDate: c.req.query('endDate'),
    });

    return c.json({ success: true, data: report });
  } catch (err) {
    console.error('GET /api/conversions/report error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { conversions };

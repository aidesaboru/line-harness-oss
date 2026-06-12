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

const conversions = new Hono<Env>();

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
conversions.get('/api/conversions/points', async (c) => {
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
conversions.post('/api/conversions/points', async (c) => {
  try {
    const body = await c.req.json<{
      name: string;
      eventType: string;
      value?: number | null;
    }>();

    if (!body.name || !body.eventType) {
      return c.json({ success: false, error: 'name and eventType are required' }, 400);
    }

    const point = await createConversionPoint(c.env.DB, body);
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
conversions.delete('/api/conversions/points/:id', async (c) => {
  try {
    await deleteConversionPoint(c.env.DB, c.req.param('id'));
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
    const body = await c.req.json<{
      conversionPointId: string;
      friendId: string;
      userId?: string | null;
      affiliateCode?: string | null;
      metadata?: Record<string, unknown> | null;
    }>();

    if (!body.conversionPointId || !body.friendId) {
      return c.json(
        { success: false, error: 'conversionPointId and friendId are required' },
        400,
      );
    }

    const denied = await ensureSupportFriendAccess(c, body.friendId);
    if (denied) return denied;

    const event = await trackConversion(c.env.DB, {
      conversionPointId: body.conversionPointId,
      friendId: body.friendId,
      userId: body.userId,
      affiliateCode: body.affiliateCode,
      metadata: body.metadata ? JSON.stringify(body.metadata) : null,
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
      limit: Number(c.req.query('limit') ?? '100'),
      offset: Number(c.req.query('offset') ?? '0'),
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

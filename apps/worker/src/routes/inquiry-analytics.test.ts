import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { fillInquiryTrendPeriods, inquiryAnalytics, inquiryTrendPeriodSql } from './inquiry-analytics.js';

type Role = 'owner' | 'admin' | 'staff' | 'secondary';

function setup(role: Role) {
  const all = vi.fn(async () => ({ results: [] }));
  const first = vi.fn(async () => ({ total: 0, customers: 0, resolved: 0, needs_review: 0 }));
  const batch = vi.fn(async () => []);
  const db = { prepare: vi.fn(() => ({ bind: vi.fn(() => ({ all, first })) })), batch } as unknown as D1Database;
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('staff' as never, { id: 'staff-1', name: '担当', role, salesOnly: false } as never);
    await next();
  });
  app.route('/', inquiryAnalytics);
  return { app, db, batch, prepare: db.prepare as unknown as ReturnType<typeof vi.fn> };
}

describe('inquiry analytics routes', () => {
  it('lets support staff read aggregate and case data', async () => {
    const { app, db } = setup('staff');
    const response = await app.request('/api/inquiry-analytics?limit=50', {}, { DB: db });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, data: { totals: { total: 0 }, cases: [] } });
  });

  it('does not let staff bulk-import historical customer data', async () => {
    const { app, db, batch } = setup('staff');
    const response = await app.request('/api/inquiry-analytics/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'import_inquiry_analytics', cases: [{}] }),
    }, { DB: db });
    expect(response.status).toBe(403);
    expect(batch).not.toHaveBeenCalled();
  });

  it('requires an explicit confirmation token for an owner import', async () => {
    const { app, db, batch } = setup('owner');
    const response = await app.request('/api/inquiry-analytics/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cases: [{}] }),
    }, { DB: db });
    expect(response.status).toBe(409);
    expect(batch).not.toHaveBeenCalled();
  });

  it('uses Monday as the start of a weekly trend period', () => {
    expect(inquiryTrendPeriodSql('day')).toBe('substr(opened_at, 1, 10)');
    expect(inquiryTrendPeriodSql('month')).toBe('substr(opened_at, 1, 7)');
    expect(inquiryTrendPeriodSql('week')).toContain("(CAST(strftime('%w', opened_at) AS INTEGER) + 6) % 7");
  });

  it('keeps zero-count periods visible instead of connecting across a gap', () => {
    expect(fillInquiryTrendPeriods([
      { period: '2026-09-01', count: 3 },
      { period: '2026-09-03', count: 2 },
    ], 'day', 3)).toEqual([
      { period: '2026-09-01', count: 3 },
      { period: '2026-09-02', count: 0 },
      { period: '2026-09-03', count: 2 },
    ]);
    expect(fillInquiryTrendPeriods([{ period: '2026-09-07', count: 4 }], 'week', 2)).toEqual([
      { period: '2026-08-31', count: 0 },
      { period: '2026-09-07', count: 4 },
    ]);
    expect(fillInquiryTrendPeriods([{ period: '2026-09', count: 5 }], 'month', 2)).toEqual([
      { period: '2026-08', count: 0 },
      { period: '2026-09', count: 5 },
    ]);
  });

  it('rejects a genre outside the selected category before querying D1', async () => {
    const { app, db, prepare } = setup('staff');
    const response = await app.request('/api/inquiry-analytics?category=事務所への電話&genre=楽天', {}, { DB: db });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ success: false, error: 'invalid_genre' });
    expect(prepare).not.toHaveBeenCalled();
  });

  it('returns drilldown metadata and applies the requested trend granularity', async () => {
    const { app, db, prepare } = setup('staff');
    const response = await app.request('/api/inquiry-analytics?category=事務所への電話&genre=着信・折り返し&granularity=week', {}, { DB: db });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: { genres: [], trends: [], filtered_total: 0, trend_granularity: 'week' },
    });
    expect(prepare).toHaveBeenCalledTimes(6);
    expect(prepare.mock.calls.some(([sql]) => String(sql).includes("strftime('%w', opened_at)"))).toBe(true);
    expect(prepare.mock.calls.some(([sql]) => String(sql).includes('AS genre'))).toBe(true);
  });
});

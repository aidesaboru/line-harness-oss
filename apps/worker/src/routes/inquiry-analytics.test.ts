import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { inquiryAnalytics } from './inquiry-analytics.js';

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
  return { app, db, batch };
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
});

import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

const statsMocks = {
  computeDuplicatesStats: vi.fn(),
};

vi.mock('../services/duplicates-stats.js', () => statsMocks);

const { duplicates } = await import('./duplicates.js');

type StaffRole = 'owner' | 'admin' | 'staff';

type TestEnv = {
  Bindings: { DB: D1Database };
  Variables: { staff: { id: string; name: string; role: StaffRole } };
};

function setupApp(role: StaffRole = 'staff') {
  const app = new Hono<TestEnv>();
  const db = {} as D1Database;
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'staff-1', name: 'Tajima', role });
    c.env = { DB: db };
    await next();
  });
  app.route('/', duplicates);
  return { app, db };
}

beforeEach(() => {
  vi.clearAllMocks();
  statsMocks.computeDuplicatesStats.mockResolvedValue({
    total_following: 10,
    unique_people: 8,
    friend_dups: 2,
    duplicate_groups: 1,
    wasted_per_broadcast_yen: 3,
    msg_unit_yen: 1.5,
    per_account: [],
    pairwise_overlap: [],
    computed_at: '2026-06-13T10:00:00.000+09:00',
  });
});

describe('duplicates stats role guard', () => {
  test('staff cannot read cross-account duplicate stats', async () => {
    const { app } = setupApp('staff');

    const res = await app.request('/api/duplicates/stats');

    expect(res.status).toBe(403);
    expect(statsMocks.computeDuplicatesStats).not.toHaveBeenCalled();
  });

  test('owner can read duplicate stats with refresh option', async () => {
    const { app, db } = setupApp('owner');

    const res = await app.request('/api/duplicates/stats?refresh=1');

    expect(res.status).toBe(200);
    expect(statsMocks.computeDuplicatesStats).toHaveBeenCalledWith(db, { forceRefresh: true });
    const json = await res.json() as { success: boolean; data: { totalFollowing: number; uniquePeople: number } };
    expect(json).toMatchObject({
      success: true,
      data: {
        totalFollowing: 10,
        uniquePeople: 8,
      },
    });
  });
});

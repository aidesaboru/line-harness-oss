import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

const usersGroupedMocks = {
  computeUsersGrouped: vi.fn(),
};

vi.mock('../services/users-grouped.js', () => usersGroupedMocks);

const { usersGrouped } = await import('./users-grouped.js');

type TestEnv = {
  Bindings: { DB: D1Database };
  Variables: { staff: { id: string; name: string; role: 'owner' | 'admin' | 'staff' } };
};

function setupApp(db: D1Database) {
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'staff-1', name: '田島', role: 'staff' });
    c.env = { DB: db };
    await next();
  });
  app.route('/', usersGrouped);
  return app;
}

describe('GET /api/users-grouped support visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usersGroupedMocks.computeUsersGrouped.mockResolvedValue({
      total: 0,
      page: 1,
      pageSize: 50,
      rows: [],
      computedAt: '2026-06-13T00:00:00.000Z',
    });
  });

  test('passes current staff into users grouped service scope', async () => {
    const db = {} as D1Database;

    const res = await setupApp(db).request(
      '/api/users-grouped?q=%E5%B1%B1%E7%94%B0&onlyDups=1&account=acc-1&page=2&pageSize=20&refresh=1',
    );

    expect(res.status).toBe(200);
    expect(usersGroupedMocks.computeUsersGrouped).toHaveBeenCalledWith(db, {
      q: '山田',
      onlyDups: true,
      account: 'acc-1',
      page: 2,
      pageSize: 20,
      forceRefresh: true,
      staff: { id: 'staff-1', name: '田島', role: 'staff' },
    });
  });
});

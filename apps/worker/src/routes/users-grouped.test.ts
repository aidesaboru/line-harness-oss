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

function loggedText(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.flat().map(String).join(' ');
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
      '/api/users-grouped?q=%20%E5%B1%B1%E7%94%B0%20&onlyDups=1&account=%20acc-1%20&page=2&pageSize=999&refresh=1',
    );

    expect(res.status).toBe(200);
    expect(usersGroupedMocks.computeUsersGrouped).toHaveBeenCalledWith(db, {
      q: '山田',
      onlyDups: true,
      account: 'acc-1',
      page: 2,
      pageSize: 200,
      forceRefresh: true,
      staff: { id: 'staff-1', name: '田島', role: 'staff' },
    });
  });

  test('rejects malformed users grouped query before aggregation', async () => {
    const db = {} as D1Database;
    const cases = [
      `/api/users-grouped?q=${'x'.repeat(257)}`,
      '/api/users-grouped?account=bad%20account',
      '/api/users-grouped?onlyDups=true',
      '/api/users-grouped?refresh=true',
      '/api/users-grouped?page=1.5',
      '/api/users-grouped?page=0',
      '/api/users-grouped?pageSize=NaN',
    ];

    for (const path of cases) {
      const res = await setupApp(db).request(path);
      expect(res.status, path).toBe(400);
    }
    expect(usersGroupedMocks.computeUsersGrouped).not.toHaveBeenCalled();
  });

  test('users grouped failure logs only the error kind', async () => {
    const db = {} as D1Database;
    usersGroupedMocks.computeUsersGrouped.mockRejectedValueOnce(
      new Error('users grouped secret 山田 account-token U-visible friend-visible acc-1'),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const res = await setupApp(db).request('/api/users-grouped?q=%E5%B1%B1%E7%94%B0&account=acc-1');

      expect(res.status).toBe(500);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body).toEqual({ success: false, error: 'Internal server error' });
      const logged = loggedText(errorSpy);
      expect(logged).toContain('GET /api/users-grouped error: Error');
      expect(logged).not.toContain('users grouped secret');
      expect(logged).not.toContain('山田');
      expect(logged).not.toContain('account-token');
      expect(logged).not.toContain('U-visible');
      expect(logged).not.toContain('friend-visible');
      expect(logged).not.toContain('acc-1');
    } finally {
      errorSpy.mockRestore();
    }
  });
});

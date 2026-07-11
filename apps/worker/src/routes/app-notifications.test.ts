import { describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { appNotifications } from './app-notifications.js';

type Staff = { id: string; name: string; role: 'owner' | 'admin' | 'staff' | 'secondary' };

type TestEnv = {
  Variables: { staff: Staff };
  Bindings: { DB: D1Database };
};

type DbCall = {
  sql: string;
  binds: unknown[];
};

function makeDb() {
  const calls: DbCall[] = [];
  const prepare = vi.fn((sql: string) => ({
    bind: (...binds: unknown[]) => {
      calls.push({ sql, binds });
      return {
        all: vi.fn(async () => {
          if (sql.includes('sc.friend_name')) {
            throw new Error('no such column: sc.friend_name');
          }
          if (sql.includes('sc.priority = ?')) {
            return {
              results: [
                {
                  id: 'case-urgent',
                  title: '至急確認',
                  friend_name: '山田 太郎',
                  updated_at: '2026-07-11T09:00:00.000',
                },
              ],
            };
          }
          return { results: [] };
        }),
      };
    },
  }));
  return { db: { prepare } as unknown as D1Database, calls };
}

function setupApp(db: D1Database) {
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'owner-1', name: 'Owner', role: 'owner' });
    c.env = { DB: db };
    await next();
  });
  app.route('/', appNotifications);
  return app;
}

describe('app notifications', () => {
  test('recent urgent notifications read customer names without support_cases.friend_name', async () => {
    const { db, calls } = makeDb();
    const res = await setupApp(db).request('/api/app-notifications/recent?after=2026-07-10T00:00:00.000Z&lineAccountId=acc-1');
    const body = await res.json() as {
      success: boolean;
      data: {
        items: Array<{ kind: string; body: string }>;
      };
    };

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.items).toEqual([
      expect.objectContaining({
        kind: 'urgent_case',
        body: '至急確認 / 山田 太郎',
      }),
    ]);

    const urgentCall = calls.find((call) => call.sql.includes('sc.priority = ?'));
    expect(urgentCall?.sql).toContain('LEFT JOIN friends f ON f.id = sc.friend_id');
    expect(urgentCall?.sql).toContain('f.display_name');
    expect(urgentCall?.sql).not.toContain('sc.friend_name');
  });
});

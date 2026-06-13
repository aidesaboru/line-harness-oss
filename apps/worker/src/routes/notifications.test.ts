import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

const dbMocks = {
  getNotificationRules: vi.fn(),
  getNotificationRuleById: vi.fn(),
  createNotificationRule: vi.fn(),
  updateNotificationRule: vi.fn(),
  deleteNotificationRule: vi.fn(),
  getNotifications: vi.fn(),
};

vi.mock('@line-crm/db', () => dbMocks);

const { notifications } = await import('./notifications.js');

type NotificationRow = {
  id: string;
  rule_id: string | null;
  event_type: string;
  title: string;
  body: string;
  channel: string;
  status: string;
  metadata: string | null;
  created_at: string;
};

function makeNotificationsDb(rows: NotificationRow[] = []) {
  const calls: Array<{ sql: string; binds: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          bound = args;
          return stmt;
        },
        async all() {
          calls.push({ sql, binds: bound });
          return { results: rows };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
  return { db, calls };
}

function setupApp(db: D1Database) {
  const app = new Hono<{
    Bindings: { DB: D1Database };
    Variables: { staff: { id: string; name: string; role: 'owner' } };
  }>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'owner-1', name: 'Owner', role: 'owner' });
    c.env = { DB: db };
    await next();
  });
  app.route('/', notifications);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getNotifications.mockResolvedValue([]);
});

describe('GET /api/notifications', () => {
  test('clamps invalid helper-path limit query values', async () => {
    const { db } = makeNotificationsDb();
    const app = setupApp(db);

    expect((await app.request('/api/notifications?limit=abc')).status).toBe(200);
    expect((await app.request('/api/notifications?limit=2.9')).status).toBe(200);
    expect((await app.request('/api/notifications?limit=9999')).status).toBe(200);

    expect(dbMocks.getNotifications).toHaveBeenNthCalledWith(1, db, {
      status: undefined,
      limit: 100,
    });
    expect(dbMocks.getNotifications).toHaveBeenNthCalledWith(2, db, {
      status: undefined,
      limit: 2,
    });
    expect(dbMocks.getNotifications).toHaveBeenNthCalledWith(3, db, {
      status: undefined,
      limit: 500,
    });
  });

  test('clamps line-account filtered limit before SQL bind', async () => {
    const { db, calls } = makeNotificationsDb();
    const app = setupApp(db);

    expect((await app.request('/api/notifications?lineAccountId=acc-1&limit=Infinity')).status).toBe(200);
    expect((await app.request('/api/notifications?lineAccountId=acc-1&limit=0')).status).toBe(200);
    expect((await app.request('/api/notifications?lineAccountId=acc-1&limit=9999')).status).toBe(200);

    const listBinds = calls
      .filter((call) => call.sql.includes('FROM notifications'))
      .map((call) => call.binds.at(-1));
    expect(listBinds).toEqual([100, 1, 500]);
  });
});

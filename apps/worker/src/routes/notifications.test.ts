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

describe('notification rule payload validation', () => {
  test('rejects malformed rule inputs before DB helpers or SQL', async () => {
    const { db, calls } = makeNotificationsDb();
    const app = setupApp(db);
    const cases: Array<{ method: string; path: string; body?: string }> = [
      { method: 'GET', path: '/api/notifications/rules?lineAccountId=bad account' },
      { method: 'GET', path: '/api/notifications/rules/bad id' },
      { method: 'GET', path: '/api/notifications?status=bad status' },
      { method: 'POST', path: '/api/notifications/rules', body: '{not-json' },
      {
        method: 'POST',
        path: '/api/notifications/rules',
        body: JSON.stringify({ name: 'Booking', eventType: 'bad event', channels: ['dashboard'] }),
      },
      {
        method: 'POST',
        path: '/api/notifications/rules',
        body: JSON.stringify({ name: 'Booking', eventType: 'booking_created', channels: [] }),
      },
      {
        method: 'PUT',
        path: '/api/notifications/rules/rule-1',
        body: JSON.stringify({}),
      },
      {
        method: 'PUT',
        path: '/api/notifications/rules/rule-1',
        body: JSON.stringify({ isActive: 1 }),
      },
      { method: 'DELETE', path: '/api/notifications/rules/bad id' },
    ];

    for (const item of cases) {
      const res = await app.request(item.path, {
        method: item.method,
        headers: item.body ? { 'Content-Type': 'application/json' } : undefined,
        body: item.body,
      });
      expect(res.status, `${item.method} ${item.path}`).toBe(400);
    }

    expect(dbMocks.getNotificationRules).not.toHaveBeenCalled();
    expect(dbMocks.getNotificationRuleById).not.toHaveBeenCalled();
    expect(dbMocks.createNotificationRule).not.toHaveBeenCalled();
    expect(dbMocks.updateNotificationRule).not.toHaveBeenCalled();
    expect(dbMocks.deleteNotificationRule).not.toHaveBeenCalled();
    expect(dbMocks.getNotifications).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  test('trims and dedupes valid rule payloads before DB helpers', async () => {
    const { db } = makeNotificationsDb();
    const created = {
      id: 'rule-1',
      name: 'Booking',
      event_type: 'booking_created',
      conditions: '{}',
      channels: '["dashboard"]',
      line_account_id: null,
      is_active: 1,
      created_at: '2026-06-13T00:00:00.000+09:00',
      updated_at: '2026-06-13T00:00:00.000+09:00',
    };
    dbMocks.createNotificationRule.mockResolvedValue(created);
    dbMocks.getNotificationRuleById.mockResolvedValue({
      ...created,
      name: 'Updated',
      event_type: 'form_submit',
      conditions: '{"tagId":"tag-1"}',
      channels: '["dashboard","email"]',
      is_active: 0,
    });

    const app = setupApp(db);
    const createRes = await app.request('/api/notifications/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: ' Booking ',
        eventType: ' booking_created ',
        conditions: { tagId: ' tag-1 ' },
        channels: [' dashboard ', 'dashboard'],
      }),
    });
    const updateRes = await app.request('/api/notifications/rules/rule-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: ' Updated ',
        eventType: ' form_submit ',
        conditions: { tagId: 'tag-1' },
        channels: [' dashboard ', ' email '],
        isActive: false,
      }),
    });

    expect(createRes.status).toBe(201);
    expect(updateRes.status).toBe(200);
    expect(dbMocks.createNotificationRule).toHaveBeenCalledWith(db, {
      name: 'Booking',
      eventType: 'booking_created',
      conditions: { tagId: ' tag-1 ' },
      channels: ['dashboard'],
    });
    expect(dbMocks.updateNotificationRule).toHaveBeenCalledWith(db, 'rule-1', {
      name: 'Updated',
      eventType: 'form_submit',
      conditions: { tagId: 'tag-1' },
      channels: ['dashboard', 'email'],
      isActive: false,
    });
  });
});

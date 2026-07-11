import { describe, expect, test } from 'vitest';
import { Hono } from 'hono';
import { accountSettings } from './account-settings.js';

type StaffRole = 'owner' | 'admin' | 'staff';

type TestEnv = {
  Bindings: { DB: D1Database };
  Variables: { staff: { id: string; name: string; role: StaffRole } };
};

type FriendRow = {
  id: string;
  display_name: string;
  picture_url: string | null;
};

type DbCall = { method: 'all' | 'first' | 'run'; sql: string; binds: unknown[] };

function makeDb(state: {
  configuredFriendIds?: string[];
  visibleFriendIds?: string[];
  friends?: FriendRow[];
  settings?: Record<string, string>;
} = {}) {
  const configuredFriendIds = state.configuredFriendIds ?? ['friend-visible', 'friend-hidden'];
  const visibleFriendIds = new Set(state.visibleFriendIds ?? []);
  const friends = state.friends ?? [
    { id: 'friend-visible', display_name: 'Visible Friend', picture_url: 'https://example.com/visible.png' },
    { id: 'friend-hidden', display_name: 'Hidden Friend', picture_url: 'https://example.com/hidden.png' },
  ];
  const settings = new Map<string, string>(Object.entries(state.settings ?? {}));
  const calls: DbCall[] = [];

  const db = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          bound = args;
          return stmt;
        },
        async first<T>() {
          calls.push({ method: 'first', sql, binds: bound });
          if (sql.includes('FROM account_settings') && sql.includes('key = ?')) {
            const [accountId, key] = bound as [string, string];
            const value = settings.get(`${accountId}:${key}`);
            return (value ? { value } : null) as T | null;
          }
          if (sql.includes("key = 'test_recipients'")) {
            return { value: JSON.stringify(configuredFriendIds) } as T;
          }
          return null as T | null;
        },
        async all<T>() {
          calls.push({ method: 'all', sql, binds: bound });
          if (sql.includes('FROM friends f')) {
            const scoped = sql.includes('sc_friend_scope.friend_id = f.id');
            const ids = new Set(configuredFriendIds);
            return {
              results: friends.filter((friend) => {
                if (!ids.has(friend.id)) return false;
                if (!scoped) return true;
                return visibleFriendIds.has(friend.id);
              }) as T[],
            };
          }
          return { results: [] as T[] };
        },
        async run() {
          calls.push({ method: 'run', sql, binds: bound });
          if (sql.includes('INSERT INTO account_settings') && bound.length >= 8) {
            const [, accountId, key, value] = bound as [string, string, string, string];
            settings.set(`${accountId}:${key}`, value);
          }
          return { success: true, meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  } as unknown as D1Database & { calls: DbCall[] };
  db.calls = calls;
  return db;
}

function setupApp(db: D1Database, role: StaffRole = 'staff') {
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'staff-1', name: 'Tajima', role });
    c.env = { DB: db };
    await next();
  });
  app.route('/', accountSettings);
  return app;
}

describe('account settings test recipients support visibility', () => {
  test('staff sees only support-visible test recipients', async () => {
    const db = makeDb({ visibleFriendIds: ['friend-visible'] });

    const res = await setupApp(db, 'staff').request('/api/account-settings/test-recipients?accountId=acc-1');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string; displayName: string; pictureUrl: string | null }> };
    expect(body.data).toEqual([
      {
        id: 'friend-visible',
        displayName: 'Visible Friend',
        pictureUrl: 'https://example.com/visible.png',
      },
    ]);
    const friendCall = db.calls.find((call) => call.sql.includes('FROM friends f'));
    expect(friendCall?.sql).toContain('sc_friend_scope.friend_id = f.id');
  });

  test('test recipient reads reject unsafe account IDs before DB access', async () => {
    const db = makeDb({ visibleFriendIds: ['friend-visible'] });

    const res = await setupApp(db, 'staff').request('/api/account-settings/test-recipients?accountId=bad%20account');

    expect(res.status).toBe(400);
    expect(db.calls).toHaveLength(0);
  });

  test('test recipient reads trim account IDs before DB access and ignore unsafe stored IDs', async () => {
    const db = makeDb({
      configuredFriendIds: [' friend-visible ', 'bad friend', 'friend-visible'],
      visibleFriendIds: ['friend-visible'],
    });

    const res = await setupApp(db, 'staff').request('/api/account-settings/test-recipients?accountId=%20acc-1%20');

    expect(res.status).toBe(200);
    const settingCall = db.calls.find((call) => call.sql.includes('FROM account_settings'));
    expect(settingCall?.binds).toEqual(['acc-1']);
    const friendCall = db.calls.find((call) => call.sql.includes('FROM friends f'));
    expect(friendCall?.binds).toEqual(['friend-visible', 'staff-1', '%Tajima%', '%Tajima%', '%Tajima%']);
  });

  test('owner keeps the global test recipient scope', async () => {
    const db = makeDb({ visibleFriendIds: [] });

    const res = await setupApp(db, 'owner').request('/api/account-settings/test-recipients?accountId=acc-1');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((friend) => friend.id)).toEqual(['friend-visible', 'friend-hidden']);
    const friendCall = db.calls.find((call) => call.sql.includes('FROM friends f'));
    expect(friendCall?.sql).not.toContain('sc_friend_scope');
  });

  test('staff cannot update global test recipients', async () => {
    const db = makeDb({ visibleFriendIds: ['friend-visible'] });

    const res = await setupApp(db, 'staff').request('/api/account-settings/test-recipients', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: 'acc-1', friendIds: ['friend-visible'] }),
    });

    expect(res.status).toBe(403);
    expect(db.calls.some((call) => call.method === 'run')).toBe(false);
  });

  test('test recipient updates reject invalid payloads before DB writes', async () => {
    const requests = [
      '{',
      JSON.stringify({}),
      JSON.stringify({ accountId: 'bad account', friendIds: ['friend-visible'] }),
      JSON.stringify({ accountId: 'acc-1', friendIds: 'friend-visible' }),
      JSON.stringify({ accountId: 'acc-1', friendIds: ['bad friend'] }),
      JSON.stringify({ accountId: 'acc-1', friendIds: Array.from({ length: 101 }, (_, i) => `friend-${i}`) }),
    ];

    for (const body of requests) {
      const db = makeDb({ visibleFriendIds: [] });
      const res = await setupApp(db, 'admin').request('/api/account-settings/test-recipients', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body,
      });

      expect(res.status, body).toBe(400);
      expect(db.calls.some((call) => call.method === 'run')).toBe(false);
    }
  });

  test('admin can update global test recipients', async () => {
    const db = makeDb({ visibleFriendIds: [] });

    const res = await setupApp(db, 'admin').request('/api/account-settings/test-recipients', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: ' acc-1 ',
        friendIds: [' friend-visible ', 'friend-visible', ' friend-hidden '],
      }),
    });

    expect(res.status).toBe(200);
    const runCall = db.calls.find((call) => call.method === 'run');
    expect(runCall?.binds).toEqual([
      expect.any(String),
      'acc-1',
      JSON.stringify(['friend-visible', 'friend-hidden']),
      expect.any(String),
      expect.any(String),
      JSON.stringify(['friend-visible', 'friend-hidden']),
      expect.any(String),
    ]);
  });
});

describe('account settings line safety permissions', () => {
  test('owner can update LINE send safety mode', async () => {
    const db = makeDb();

    const res = await setupApp(db, 'owner').request('/api/account-settings/line-safety', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: ' acc-1 ',
        frozen: true,
        reason: '緊急確認',
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({
      frozen: true,
      reason: '緊急確認',
      updatedBy: 'Tajima (staff-1)',
    });
    const runCall = db.calls.find((call) => call.method === 'run');
    expect(runCall?.binds[1]).toBe('acc-1');
    expect(runCall?.binds[2]).toBe('line_safety_freeze');
  });

  test('admin cannot update LINE send safety mode', async () => {
    const db = makeDb();

    const res = await setupApp(db, 'admin').request('/api/account-settings/line-safety', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: 'acc-1',
        frozen: true,
        reason: '緊急確認',
      }),
    });

    expect(res.status).toBe(403);
    expect(db.calls.some((call) => call.method === 'run')).toBe(false);
  });
});

describe('account settings support notifications', () => {
  test('owner can read support notification settings without exposing webhook URL', async () => {
    const db = makeDb({
      settings: {
        'acc-1:support_slack_notifications': JSON.stringify({
          enabled: true,
          webhookUrl: 'https://hooks.slack.test/secret',
          immediateUrgent: true,
          digestEnabled: true,
          digestHours: [12, 17],
          dueSoonHours: 6,
        }),
      },
    });

    const res = await setupApp(db, 'owner').request('/api/account-settings/support-notifications?accountId=acc-1');

    expect(res.status).toBe(200);
    const body = await res.json() as { data: Record<string, unknown> };
    expect(body.data).toEqual({
      enabled: true,
      webhookConfigured: true,
      immediateUrgent: true,
      digestEnabled: true,
      digestHours: [12, 17],
      dueSoonHours: 6,
    });
    expect(JSON.stringify(body)).not.toContain('secret');
  });

  test('staff cannot read or update support notification settings', async () => {
    const db = makeDb();

    const readRes = await setupApp(db, 'staff').request('/api/account-settings/support-notifications?accountId=acc-1');
    const updateRes = await setupApp(db, 'staff').request('/api/account-settings/support-notifications', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: 'acc-1', enabled: true }),
    });

    expect(readRes.status).toBe(403);
    expect(updateRes.status).toBe(403);
    expect(db.calls.some((call) => call.method === 'run')).toBe(false);
  });

  test('admin can update support notification settings', async () => {
    const db = makeDb();

    const res = await setupApp(db, 'admin').request('/api/account-settings/support-notifications', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: ' acc-1 ',
        enabled: true,
        webhookUrl: 'https://hooks.slack.test/new',
        immediateUrgent: true,
        digestEnabled: true,
        digestHours: [14, 12, 14],
        dueSoonHours: 8,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({
      enabled: true,
      webhookConfigured: true,
      digestHours: [12, 14],
      dueSoonHours: 8,
    });
    const runCall = db.calls.find((call) => call.method === 'run');
    expect(runCall?.binds[1]).toBe('acc-1');
    expect(runCall?.binds[2]).toBe('support_slack_notifications');
  });

  test('support notification updates reject unsafe values before DB writes', async () => {
    const requests = [
      '{',
      JSON.stringify({}),
      JSON.stringify({ accountId: 'bad account', enabled: true }),
      JSON.stringify({ accountId: 'acc-1', enabled: 'yes' }),
      JSON.stringify({ accountId: 'acc-1', webhookUrl: 'http://hooks.slack.test/nope' }),
      JSON.stringify({ accountId: 'acc-1', digestHours: [12, 99] }),
      JSON.stringify({ accountId: 'acc-1', dueSoonHours: 0 }),
    ];

    for (const body of requests) {
      const db = makeDb();
      const res = await setupApp(db, 'admin').request('/api/account-settings/support-notifications', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body,
      });

      expect(res.status, body).toBe(400);
      expect(db.calls.some((call) => call.method === 'run')).toBe(false);
    }
  });
});

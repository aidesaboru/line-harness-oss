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
} = {}) {
  const configuredFriendIds = state.configuredFriendIds ?? ['friend-visible', 'friend-hidden'];
  const visibleFriendIds = new Set(state.visibleFriendIds ?? []);
  const friends = state.friends ?? [
    { id: 'friend-visible', display_name: 'Visible Friend', picture_url: 'https://example.com/visible.png' },
    { id: 'friend-hidden', display_name: 'Hidden Friend', picture_url: 'https://example.com/hidden.png' },
  ];
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

  test('admin can update global test recipients', async () => {
    const db = makeDb({ visibleFriendIds: [] });

    const res = await setupApp(db, 'admin').request('/api/account-settings/test-recipients', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: 'acc-1', friendIds: ['friend-visible'] }),
    });

    expect(res.status).toBe(200);
    expect(db.calls.some((call) => call.method === 'run')).toBe(true);
  });
});

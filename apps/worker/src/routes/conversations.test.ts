import { describe, expect, test } from 'vitest';
import { Hono } from 'hono';
import { conversations } from './conversations.js';

type StaffRole = 'owner' | 'admin' | 'staff';

type TestEnv = {
  Bindings: { DB: D1Database };
  Variables: { staff: { id: string; name: string; role: StaffRole } };
};

type DbCall = { sql: string; binds: unknown[] };

function makeDb(options: { visibleFriendIds?: string[] } = {}) {
  const visibleFriendIds = new Set(options.visibleFriendIds ?? []);
  const calls: DbCall[] = [];
  const friends = [
    {
      id: 'friend-visible',
      line_user_id: 'U-visible',
      display_name: '見える顧客',
      is_following: 1,
      line_account_id: 'acc-1',
      line_account_name: '本店LINE',
    },
  ];
  const messages = [
    {
      id: 'message-1',
      direction: 'incoming',
      message_type: 'text',
      content: '相談があります',
      delivery_type: null,
      source: null,
      broadcast_id: null,
      scenario_step_id: null,
      created_at: '2026-06-12T10:00:00.000',
    },
  ];

  const db = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          bound = args;
          return stmt;
        },
        async first<T>() {
          calls.push({ sql, binds: bound });
          if (sql.startsWith('SELECT 1 AS ok WHERE')) {
            const [friendId] = bound as [string];
            return (visibleFriendIds.has(friendId) ? { ok: 1 } : null) as T | null;
          }
          if (sql.includes('SELECT COUNT(*) AS total')) {
            return { total: 0 } as T;
          }
          if (sql.includes('SELECT f.id, f.line_user_id')) {
            const [friendId] = bound as [string];
            return (friends.find((friend) => friend.id === friendId) ?? null) as T | null;
          }
          return null as T | null;
        },
        async all<T>() {
          calls.push({ sql, binds: bound });
          if (sql.includes('SELECT t.name FROM friend_tags')) {
            return { results: [{ name: 'VIP' }] as T[] };
          }
          if (sql.includes('FROM messages_log WHERE friend_id')) {
            return { results: messages as T[] };
          }
          return { results: [] as T[] };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;

  return { db, calls };
}

function setupApp(db: D1Database, role: StaffRole = 'staff') {
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'staff-1', name: '田島', role });
    c.env = { DB: db };
    await next();
  });
  app.route('/', conversations);
  return app;
}

describe('GET /api/conversations support visibility', () => {
  test('staff conversation queue SQL is scoped to support-visible friends', async () => {
    const { db, calls } = makeDb({ visibleFriendIds: ['friend-visible'] });

    const res = await setupApp(db, 'staff').request('/api/conversations?lineAccountId=acc-1&limit=10&offset=5');

    expect(res.status).toBe(200);
    const queueCall = calls.find((call) => call.sql.includes('latest_msg'));
    expect(queueCall?.sql).toContain('sc_friend_scope.friend_id = f.id');
    expect(queueCall?.binds).toEqual([
      0,
      'acc-1',
      'staff-1',
      '%田島%',
      '%田島%',
      '%田島%',
      10,
      5,
    ]);

    const countCall = calls.find((call) => call.sql.includes('SELECT COUNT(*) AS total'));
    expect(countCall?.sql).toContain('sc_friend_scope.friend_id = f.id');
    expect(countCall?.binds).toEqual([
      0,
      'acc-1',
      'staff-1',
      '%田島%',
      '%田島%',
      '%田島%',
    ]);
  });

  test('owner conversation queue is not narrowed by staff support scope', async () => {
    const { db, calls } = makeDb();

    const res = await setupApp(db, 'owner').request('/api/conversations?limit=10');

    expect(res.status).toBe(200);
    const queueCall = calls.find((call) => call.sql.includes('latest_msg'));
    expect(queueCall?.sql).not.toContain('sc_friend_scope');
    expect(queueCall?.binds).toEqual([0, 10, 0]);
  });

  test('staff cannot open a hidden friend conversation', async () => {
    const { db, calls } = makeDb({ visibleFriendIds: ['friend-visible'] });

    const res = await setupApp(db, 'staff').request('/api/conversations/friend-hidden');

    expect(res.status).toBe(404);
    expect(calls.some((call) => call.sql.includes('SELECT f.id, f.line_user_id'))).toBe(false);
  });

  test('staff can open a visible friend conversation', async () => {
    const { db } = makeDb({ visibleFriendIds: ['friend-visible'] });

    const res = await setupApp(db, 'staff').request('/api/conversations/friend-visible');

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { friend: { friendId: string; tags: string[] }; messages: Array<{ id: string; source: string }> };
    };
    expect(body.data.friend).toMatchObject({ friendId: 'friend-visible', tags: ['VIP'] });
    expect(body.data.messages).toMatchObject([{ id: 'message-1', source: 'user' }]);
  });
});

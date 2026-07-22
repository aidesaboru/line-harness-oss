import { describe, expect, test, vi } from 'vitest';
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

function makeThrowingDb(message: string): D1Database {
  return {
    prepare() {
      throw new Error(message);
    },
  } as unknown as D1Database;
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

function loggedText(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.flat().map(String).join(' ');
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
      '田島',
      '田島',
      'staff-1',
      '田島',
      10,
      5,
    ]);

    const countCall = calls.find((call) => call.sql.includes('SELECT COUNT(*) AS total'));
    expect(countCall?.sql).toContain('sc_friend_scope.friend_id = f.id');
    expect(countCall?.binds).toEqual([
      0,
      'acc-1',
      'staff-1',
      '田島',
      '田島',
      'staff-1',
      '田島',
    ]);
  });

  test('conversation queue rejects unsafe filters before SQL bind', async () => {
    const queries = [
      'lineAccountId=bad%20account',
      'minHoursSince=NaN',
      'maxHoursSince=oops',
      'minHoursSince=12&maxHoursSince=1',
    ];

    for (const query of queries) {
      const { db, calls } = makeDb({ visibleFriendIds: ['friend-visible'] });
      const res = await setupApp(db, 'staff').request(`/api/conversations?${query}`);

      expect(res.status, query).toBe(400);
      expect(calls, query).toEqual([]);
    }
  });

  test('conversation queue trims valid filters and normalizes paging before SQL bind', async () => {
    const { db, calls } = makeDb({ visibleFriendIds: ['friend-visible'] });

    const res = await setupApp(db, 'staff')
      .request('/api/conversations?lineAccountId=%20acc-1%20&minHoursSince=1.5&maxHoursSince=12&limit=999&offset=-5');

    expect(res.status).toBe(200);
    const queueCall = calls.find((call) => call.sql.includes('latest_msg'));
    expect(queueCall?.binds).toEqual([
      1.5,
      12,
      'acc-1',
      'staff-1',
      '田島',
      '田島',
      'staff-1',
      '田島',
      200,
      0,
    ]);
    const countCall = calls.find((call) => call.sql.includes('SELECT COUNT(*) AS total'));
    expect(countCall?.binds).toEqual([
      1.5,
      12,
      'acc-1',
      'staff-1',
      '田島',
      '田島',
      'staff-1',
      '田島',
    ]);
  });

  test('conversation queue falls back from invalid paging before SQL bind', async () => {
    const { db, calls } = makeDb({ visibleFriendIds: ['friend-visible'] });

    const res = await setupApp(db, 'staff').request('/api/conversations?limit=abc&offset=Infinity');

    expect(res.status).toBe(200);
    const queueCall = calls.find((call) => call.sql.includes('latest_msg'));
    expect(queueCall?.binds).toEqual([
      0,
      'staff-1',
      '田島',
      '田島',
      'staff-1',
      '田島',
      50,
      0,
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

  test('conversation detail rejects unsafe friend or cursor values before access checks or SQL bind', async () => {
    const cases = [
      '/api/conversations/bad%20friend',
      '/api/conversations/friend-visible?before=not-a-date',
    ];

    for (const path of cases) {
      const { db, calls } = makeDb({ visibleFriendIds: ['friend-visible'] });
      const res = await setupApp(db, 'staff').request(path);

      expect(res.status, path).toBe(400);
      expect(calls, path).toEqual([]);
    }
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

  test('conversation detail trims valid friend and cursor values before SQL bind', async () => {
    const { db, calls } = makeDb({ visibleFriendIds: ['friend-visible'] });

    const res = await setupApp(db, 'staff')
      .request('/api/conversations/%20friend-visible%20?before=%202026-06-13T10:00:00.000%2B09:00%20&limit=999');

    expect(res.status).toBe(200);
    expect(calls[0]).toMatchObject({ binds: ['friend-visible', 'staff-1', '田島', '田島', 'staff-1', '田島'] });
    const messageCall = calls.find((call) => call.sql.includes('FROM messages_log WHERE friend_id'));
    expect(messageCall?.binds).toEqual([
      'friend-visible',
      '2026-06-13T10:00:00.000+09:00',
      200,
    ]);
  });

  test('conversation queue failure logs only the error kind', async () => {
    const db = makeThrowingDb('conversation queue secret account-token U-visible friend-visible 相談 acc-1');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const res = await setupApp(db, 'owner').request('/api/conversations?lineAccountId=acc-1');

      expect(res.status).toBe(500);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body).toEqual({ success: false, error: 'Internal server error' });
      const logged = loggedText(errorSpy);
      expect(logged).toContain('GET /api/conversations error: Error');
      expect(logged).not.toContain('conversation queue secret');
      expect(logged).not.toContain('account-token');
      expect(logged).not.toContain('U-visible');
      expect(logged).not.toContain('friend-visible');
      expect(logged).not.toContain('相談');
      expect(logged).not.toContain('acc-1');
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('conversation detail failure does not leak raw exception into logs or response', async () => {
    const db = makeThrowingDb('conversation detail secret account-token U-visible friend-visible 相談');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const res = await setupApp(db, 'owner').request('/api/conversations/friend-visible');

      expect(res.status).toBe(500);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body).toEqual({ success: false, error: 'Internal server error' });
      const logged = loggedText(errorSpy);
      expect(logged).toContain('GET /api/conversations/:friendId error: Error');
      expect(logged).not.toContain('conversation detail secret');
      expect(logged).not.toContain('account-token');
      expect(logged).not.toContain('U-visible');
      expect(logged).not.toContain('friend-visible');
      expect(logged).not.toContain('相談');
    } finally {
      errorSpy.mockRestore();
    }
  });
});

import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

const dbMocks = {
  getFriends: vi.fn(),
  getFriendById: vi.fn(),
  getFriendCount: vi.fn(),
  addTagToFriend: vi.fn(),
  removeTagFromFriend: vi.fn(),
  getFriendTags: vi.fn(),
  getScenarios: vi.fn(),
  enrollFriendInScenario: vi.fn(),
  jstNow: vi.fn(() => '2026-06-12T10:00:00.000'),
};

vi.mock('@line-crm/db', () => dbMocks);

const { friends } = await import('./friends.js');

type TestEnv = {
  Variables: { staff: { id: string; name: string; role: 'owner' | 'admin' | 'staff' } };
  Bindings: {
    DB: D1Database;
    LINE_CHANNEL_ACCESS_TOKEN: string;
    WORKER_URL: string;
  };
};

type FriendRow = {
  id: string;
  line_user_id: string;
  line_account_id: string;
  display_name: string;
  picture_url: string | null;
  status_message: string | null;
  is_following: number;
  metadata: string;
  ref_code: string | null;
  user_id: string | null;
  created_at: string;
  updated_at: string;
};

type MessageRow = {
  id: string;
  friend_id: string;
  direction: 'incoming' | 'outgoing';
  messageType: string;
  content: string;
  createdAt: string;
  delivery_type?: string | null;
};

const friendRows: FriendRow[] = [
  {
    id: 'friend-visible',
    line_user_id: 'U-visible',
    line_account_id: 'acc-1',
    display_name: '見える友だち',
    picture_url: null,
    status_message: null,
    is_following: 1,
    metadata: '{}',
    ref_code: null,
    user_id: null,
    created_at: '2026-06-12T09:00:00.000',
    updated_at: '2026-06-12T09:00:00.000',
  },
  {
    id: 'friend-hidden',
    line_user_id: 'U-hidden',
    line_account_id: 'acc-1',
    display_name: '隠れる友だち',
    picture_url: null,
    status_message: null,
    is_following: 1,
    metadata: '{}',
    ref_code: null,
    user_id: null,
    created_at: '2026-06-12T10:00:00.000',
    updated_at: '2026-06-12T10:00:00.000',
  },
];

const messageRows: MessageRow[] = [
  {
    id: 'msg-visible',
    friend_id: 'friend-visible',
    direction: 'incoming',
    messageType: 'text',
    content: '確認お願いします',
    createdAt: '2026-06-12T11:00:00.000',
  },
  {
    id: 'msg-hidden',
    friend_id: 'friend-hidden',
    direction: 'incoming',
    messageType: 'text',
    content: '隠れる会話',
    createdAt: '2026-06-12T11:30:00.000',
  },
];

function makeFriendsDb(state: {
  rows?: FriendRow[];
  visibleFriendIds?: string[];
  messages?: MessageRow[];
}) {
  const rows = state.rows ?? friendRows;
  const visible = new Set(state.visibleFriendIds ?? []);
  const messages = state.messages ?? messageRows;
  const calls: Array<{ method: 'first' | 'all' | 'run'; sql: string; binds: unknown[] }> = [];

  function scopedRows(sql: string): FriendRow[] {
    let result = rows;
    if (sql.includes('support_cases sc_friend_scope')) {
      result = result.filter((row) => visible.has(row.id));
    }
    if (sql.includes('line_account_id = ?') || sql.includes('f.line_account_id = ?')) {
      result = result.filter((row) => row.line_account_id === 'acc-1');
    }
    return result;
  }

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
          if (sql.startsWith('SELECT 1 AS ok WHERE')) {
            const [friendId] = bound as [string];
            return (visible.has(friendId) ? { ok: 1 } : null) as T | null;
          }
          if (sql.includes('SELECT COUNT(*) as count FROM friends')) {
            return { count: scopedRows(sql).filter((row) => row.is_following === 1).length } as T;
          }
          return null as T | null;
        },
        async all<T>() {
          calls.push({ method: 'all', sql, binds: bound });
          if (sql.includes('FROM friends f')) {
            return { results: scopedRows(sql) } as { results: T[] };
          }
          if (sql.includes('FROM messages_log WHERE friend_id = ?')) {
            const [friendId] = bound as [string];
            return {
              results: messages
                .filter((message) => message.friend_id === friendId && message.delivery_type !== 'test')
                .map((message) => ({
                  id: message.id,
                  direction: message.direction,
                  messageType: message.messageType,
                  content: message.content,
                  createdAt: message.createdAt,
                })),
            } as { results: T[] };
          }
          return { results: [] } as { results: T[] };
        },
        async run() {
          calls.push({ method: 'run', sql, binds: bound });
          return { success: true, meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;

  return { db, calls };
}

function setupApp(db: D1Database, role: 'owner' | 'admin' | 'staff' = 'staff') {
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'staff-1', name: '田島', role });
    c.env = {
      DB: db,
      LINE_CHANNEL_ACCESS_TOKEN: 'fallback-token',
      WORKER_URL: 'https://worker.example',
    };
    await next();
  });
  app.route('/', friends);
  return app;
}

beforeEach(() => {
  for (const fn of Object.values(dbMocks)) fn.mockReset();
  dbMocks.getFriendTags.mockResolvedValue([]);
  dbMocks.getFriendById.mockImplementation(async (_db: D1Database, id: string) =>
    friendRows.find((friend) => friend.id === id) ?? null,
  );
  dbMocks.getFriendCount.mockResolvedValue(friendRows.length);
});

describe('friends support visibility', () => {
  test('staff friend list only includes friends tied to visible support cases', async () => {
    const { db, calls } = makeFriendsDb({ visibleFriendIds: ['friend-visible'] });

    const res = await setupApp(db, 'staff').request('/api/friends?lineAccountId=acc-1&includeTags=false');

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { items: Array<{ id: string; displayName: string }>; total: number };
    };
    expect(body.success).toBe(true);
    expect(body.data.items.map((item) => item.id)).toEqual(['friend-visible']);
    expect(body.data.total).toBe(1);
    const listCall = calls.find((call) => call.method === 'all' && call.sql.includes('FROM friends f'));
    expect(listCall?.sql).toContain('support_cases sc_friend_scope');
    expect(listCall?.binds).toEqual(expect.arrayContaining(['staff-1', '%田島%', '%田島%', '%田島%']));
  });

  test('friend list clamps invalid limit and fractional offset before SQL bind', async () => {
    const { db, calls } = makeFriendsDb({ visibleFriendIds: ['friend-visible'] });

    const res = await setupApp(db, 'staff')
      .request('/api/friends?lineAccountId=acc-1&includeTags=false&limit=abc&offset=1.9');

    expect(res.status).toBe(200);
    const listCall = calls.find((call) => call.method === 'all' && call.sql.includes('FROM friends f'));
    expect(listCall?.binds.slice(-2)).toEqual([50, 1]);
  });

  test('friend list resets non-finite offset before SQL bind', async () => {
    const { db, calls } = makeFriendsDb({ visibleFriendIds: ['friend-visible'] });

    const res = await setupApp(db, 'staff')
      .request('/api/friends?lineAccountId=acc-1&includeTags=false&offset=Infinity');

    expect(res.status).toBe(200);
    const listCall = calls.find((call) => call.method === 'all' && call.sql.includes('FROM friends f'));
    expect(listCall?.binds.slice(-2)).toEqual([50, 0]);
  });

  test('owner friend list remains unrestricted', async () => {
    const { db, calls } = makeFriendsDb({ visibleFriendIds: ['friend-visible'] });

    const res = await setupApp(db, 'owner').request('/api/friends?lineAccountId=acc-1&includeTags=false');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { items: Array<{ id: string }>; total: number } };
    expect(body.data.items.map((item) => item.id)).toEqual(['friend-visible', 'friend-hidden']);
    expect(body.data.total).toBe(2);
    const listCall = calls.find((call) => call.method === 'all' && call.sql.includes('FROM friends f'));
    expect(listCall?.sql).not.toContain('support_cases sc_friend_scope');
  });

  test('staff friend count uses the same visible support friend scope', async () => {
    const { db, calls } = makeFriendsDb({ visibleFriendIds: ['friend-visible'] });

    const res = await setupApp(db, 'staff').request('/api/friends/count?lineAccountId=acc-1');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { count: number } };
    expect(body.data.count).toBe(1);
    const countCall = calls.find((call) => call.method === 'first' && call.sql.includes('COUNT(*)'));
    expect(countCall?.sql).toContain('support_cases sc_friend_scope');
  });

  test('staff cannot read hidden friend message history', async () => {
    const { db, calls } = makeFriendsDb({ visibleFriendIds: ['friend-visible'] });

    const res = await setupApp(db, 'staff').request('/api/friends/friend-hidden/messages');

    expect(res.status).toBe(404);
    expect(calls.some((call) => call.sql.includes('FROM messages_log'))).toBe(false);
  });

  test('staff can read visible friend message history', async () => {
    const { db } = makeFriendsDb({ visibleFriendIds: ['friend-visible'] });

    const res = await setupApp(db, 'staff').request('/api/friends/friend-visible/messages');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: Array<{ id: string; content: string }> };
    expect(body.success).toBe(true);
    expect(body.data).toEqual([{ id: 'msg-visible', direction: 'incoming', messageType: 'text', content: '確認お願いします', createdAt: '2026-06-12T11:00:00.000' }]);
  });

  test('staff cannot send a direct message to a hidden friend', async () => {
    const { db, calls } = makeFriendsDb({ visibleFriendIds: ['friend-visible'] });

    const res = await setupApp(db, 'staff').request('/api/friends/friend-hidden/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hidden friend send' }),
    });

    expect(res.status).toBe(404);
    expect(dbMocks.getFriendById).not.toHaveBeenCalled();
    expect(calls.some((call) => call.method === 'run')).toBe(false);
  });
});

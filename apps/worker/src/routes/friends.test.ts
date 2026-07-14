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
          if (sql.startsWith('SELECT * FROM friends WHERE id = ?')) {
            const [friendId, lineAccountId] = bound as [string, string | undefined];
            const row = rows.find((friend) =>
              friend.id === friendId &&
              (!lineAccountId || friend.line_account_id === lineAccountId),
            );
            return (row ?? null) as T | null;
          }
          if (sql.startsWith('SELECT * FROM friends WHERE line_user_id = ?')) {
            const [lineUserId, lineAccountId] = bound as [string, string | undefined];
            const row = rows.find((friend) =>
              friend.line_user_id === lineUserId &&
              (!lineAccountId || friend.line_account_id === lineAccountId),
            );
            return (row ?? null) as T | null;
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
          if (sql.startsWith('UPDATE friends SET metadata = ?, display_name = ?')) {
            const [metadata, displayName, updatedAt, friendId] = bound as [string, string, string, string];
            const row = rows.find((friend) => friend.id === friendId);
            if (row) {
              row.metadata = metadata;
              row.display_name = displayName;
              row.updated_at = updatedAt;
            }
          } else if (sql.startsWith('UPDATE friends SET metadata = ?')) {
            const [metadata, updatedAt, friendId] = bound as [string, string, string];
            const row = rows.find((friend) => friend.id === friendId);
            if (row) {
              row.metadata = metadata;
              row.updated_at = updatedAt;
            }
          }
          return { success: true, meta: { changes: 1 } };
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

function loggedText(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.flat().map(String).join(' ');
}

beforeEach(() => {
  for (const fn of Object.values(dbMocks)) fn.mockReset();
  dbMocks.jstNow.mockReturnValue('2026-06-12T10:00:00.000');
  dbMocks.getFriendTags.mockResolvedValue([]);
  dbMocks.getFriendById.mockImplementation(async (_db: D1Database, id: string) =>
    friendRows.find((friend) => friend.id === id) ?? null,
  );
  dbMocks.getFriendCount.mockResolvedValue(friendRows.length);
});

describe('friends support visibility', () => {
  test('staff friend list includes all customers in the selected account', async () => {
    const { db, calls } = makeFriendsDb({ visibleFriendIds: ['friend-visible'] });

    const res = await setupApp(db, 'staff').request('/api/friends?lineAccountId=acc-1&includeTags=false');

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { items: Array<{ id: string; displayName: string }>; total: number };
    };
    expect(body.success).toBe(true);
    expect(body.data.items.map((item) => item.id)).toEqual(['friend-visible', 'friend-hidden']);
    expect(body.data.total).toBe(2);
    const listCall = calls.find((call) => call.method === 'all' && call.sql.includes('FROM friends f'));
    expect(listCall?.sql).not.toContain('support_cases sc_friend_scope');
    expect(listCall?.binds).toEqual(['acc-1', 50, 0]);
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

  test('staff friend count includes all customers in the selected account', async () => {
    const { db, calls } = makeFriendsDb({ visibleFriendIds: ['friend-visible'] });

    const res = await setupApp(db, 'staff').request('/api/friends/count?lineAccountId=acc-1');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { count: number } };
    expect(body.data.count).toBe(2);
    const countCall = calls.find((call) => call.method === 'first' && call.sql.includes('COUNT(*)'));
    expect(countCall?.sql).not.toContain('support_cases sc_friend_scope');
  });

  test('staff cannot read ref attribution stats', async () => {
    const { db, calls } = makeFriendsDb({ visibleFriendIds: ['friend-visible'] });

    const res = await setupApp(db, 'staff').request('/api/friends/ref-stats');

    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  test('staff can read any customer detail', async () => {
    const { db } = makeFriendsDb({ visibleFriendIds: ['friend-visible'] });

    const res = await setupApp(db, 'staff').request('/api/friends/friend-hidden');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { id: string; displayName: string } };
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({ id: 'friend-hidden', displayName: '隠れる友だち' });
  });

  test('staff can read any customer message history', async () => {
    const { db } = makeFriendsDb({ visibleFriendIds: ['friend-visible'] });

    const res = await setupApp(db, 'staff').request('/api/friends/friend-hidden/messages');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: Array<{ id: string; content: string }> };
    expect(body.success).toBe(true);
    expect(body.data).toEqual([{ id: 'msg-hidden', direction: 'incoming', messageType: 'text', content: '隠れる会話', createdAt: '2026-06-12T11:30:00.000' }]);
  });

  test('staff can read visible friend message history', async () => {
    const { db } = makeFriendsDb({ visibleFriendIds: ['friend-visible'] });

    const res = await setupApp(db, 'staff').request('/api/friends/friend-visible/messages');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: Array<{ id: string; content: string }> };
    expect(body.success).toBe(true);
    expect(body.data).toEqual([{ id: 'msg-visible', direction: 'incoming', messageType: 'text', content: '確認お願いします', createdAt: '2026-06-12T11:00:00.000' }]);
  });

  test('metadata update changes display name when customer number and contact name are present', async () => {
    const rows = friendRows.map((row) => ({ ...row }));
    dbMocks.getFriendById.mockImplementation(async (_db: D1Database, id: string) =>
      rows.find((friend) => friend.id === id) ?? null,
    );
    const { db, calls } = makeFriendsDb({ rows, visibleFriendIds: ['friend-visible'] });

    const res = await setupApp(db, 'staff').request('/api/friends/friend-visible/metadata', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerNumber: 'C-001',
        contactName: '林 静香',
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { displayName: string; metadata: Record<string, unknown> } };
    expect(body.success).toBe(true);
    expect(body.data.displayName).toBe('C-001_林 静香');
    expect(body.data.metadata).toMatchObject({ customerNumber: 'C-001', contactName: '林 静香' });
    expect(rows[0].display_name).toBe('C-001_林 静香');
    const updateCall = calls.find((call) => call.sql.startsWith('UPDATE friends SET metadata = ?, display_name = ?'));
    expect(updateCall?.binds).toEqual([
      JSON.stringify({ customerNumber: 'C-001', contactName: '林 静香' }),
      'C-001_林 静香',
      '2026-06-12T10:00:00.000',
      'friend-visible',
    ]);
  });

  test('metadata update accepts operation contract sets for customer cards', async () => {
    const rows = friendRows.map((row) => ({ ...row }));
    dbMocks.getFriendById.mockImplementation(async (_db: D1Database, id: string) =>
      rows.find((friend) => friend.id === id) ?? null,
    );
    const { db } = makeFriendsDb({ rows, visibleFriendIds: ['friend-visible'] });

    const res = await setupApp(db, 'staff').request('/api/friends/friend-visible/metadata', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerNumber: 'C-001',
        contactName: '林 静香',
        operationContracts: [
          {
            shopName: '渋谷店',
            handoverDate: '2026-07-01',
            minimumGuaranteeStartMonth: '2026年7月',
            closedAt: '',
          },
          {
            shopName: '新宿店',
            handoverDate: '2026-08-01',
            minimumGuaranteeStartMonth: '2026年9月',
            closedAt: '2027/03/31 18:00',
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { metadata: Record<string, unknown> } };
    expect(body.success).toBe(true);
    expect(body.data.metadata.operationContracts).toEqual([
      {
        shopName: '渋谷店',
        handoverDate: '2026-07-01',
        minimumGuaranteeStartMonth: '2026年7月',
        closedAt: '',
      },
      {
        shopName: '新宿店',
        handoverDate: '2026-08-01',
        minimumGuaranteeStartMonth: '2026年9月',
        closedAt: '2027/03/31 18:00',
      },
    ]);
  });

  test('owner can bulk update customer metadata by friend id or LINE user id', async () => {
    const rows = friendRows.map((row) => ({ ...row }));
    const { db, calls } = makeFriendsDb({ rows, visibleFriendIds: ['friend-visible'] });

    const res = await setupApp(db, 'owner').request('/api/friends/metadata/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lineAccountId: 'acc-1',
        rows: [
          {
            friendId: 'friend-visible',
            metadata: { customerNumber: 'C-001', contactName: '田中 太郎', companyName: '株式会社テスト' },
          },
          {
            lineUserId: 'U-hidden',
            metadata: { customerNumber: 'C-002', storeName: '新宿店' },
          },
          {
            friendId: 'missing-friend',
            metadata: { customerNumber: 'C-404' },
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { requested: number; updated: number; notFound: Array<{ friendId?: string }> };
    };
    expect(body).toMatchObject({
      success: true,
      data: {
        requested: 3,
        updated: 2,
        notFound: [{ friendId: 'missing-friend' }],
      },
    });
    expect(JSON.parse(rows[0].metadata)).toMatchObject({ customerNumber: 'C-001', contactName: '田中 太郎', companyName: '株式会社テスト' });
    expect(JSON.parse(rows[1].metadata)).toMatchObject({ customerNumber: 'C-002', storeName: '新宿店' });
    expect(rows[0].display_name).toBe('C-001_田中 太郎');
    expect(calls.filter((call) => call.sql.startsWith('UPDATE friends SET metadata = ?'))).toHaveLength(2);
    expect(calls.filter((call) => call.sql.startsWith('UPDATE friends SET metadata = ?, display_name = ?'))).toHaveLength(1);
  });

  test('friend list failure logs only the error kind', async () => {
    const db = makeThrowingDb('friend list secret account-token U-visible friend-visible 検索語');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const res = await setupApp(db, 'owner').request('/api/friends?lineAccountId=acc-1&includeTags=false');

      expect(res.status).toBe(500);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body).toEqual({ success: false, error: 'Internal server error' });
      const logged = loggedText(errorSpy);
      expect(logged).toContain('GET /api/friends error: Error');
      expect(logged).not.toContain('friend list secret');
      expect(logged).not.toContain('account-token');
      expect(logged).not.toContain('U-visible');
      expect(logged).not.toContain('friend-visible');
      expect(logged).not.toContain('検索語');
      expect(logged).not.toContain('acc-1');
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('direct message failure does not leak raw exception into logs or response', async () => {
    const { db } = makeFriendsDb({ visibleFriendIds: ['friend-visible'] });
    dbMocks.getFriendById.mockRejectedValueOnce(
      new Error('direct message secret account-token U-visible friend-visible 送信本文'),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const res = await setupApp(db, 'owner').request('/api/friends/friend-visible/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '送信本文 account-token' }),
      });

      expect(res.status).toBe(500);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body).toEqual({ success: false, error: 'Internal server error' });
      const logged = loggedText(errorSpy);
      expect(logged).toContain('POST /api/friends/:id/messages error: Error');
      expect(logged).not.toContain('direct message secret');
      expect(logged).not.toContain('account-token');
      expect(logged).not.toContain('U-visible');
      expect(logged).not.toContain('friend-visible');
      expect(logged).not.toContain('送信本文');
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('friends input validation', () => {
  test('rejects malformed query, path, metadata, tag, and message payloads before DB side effects', async () => {
    const { db, calls } = makeFriendsDb({ visibleFriendIds: ['friend-visible'] });
    const app = setupApp(db, 'owner');
    const longSearch = 'x'.repeat(121);
    const cases: Array<{ method: string; path: string; body?: string; headers?: Record<string, string> }> = [
      { method: 'GET', path: '/api/friends?lineAccountId=bad%20account&includeTags=false' },
      { method: 'GET', path: '/api/friends?tagId=bad%20tag&includeTags=false' },
      { method: 'GET', path: `/api/friends?search=${longSearch}&includeTags=false` },
      { method: 'GET', path: '/api/friends?metadata.bad%20key=value&includeTags=false' },
      { method: 'GET', path: '/api/friends/count?lineAccountId=bad%20account' },
      { method: 'GET', path: '/api/friends/ref-stats?lineAccountId=bad%20account' },
      { method: 'GET', path: '/api/friends/bad%20id' },
      {
        method: 'POST',
        path: '/api/friends/bad%20id/tags',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tagId: 'tag-1' }),
      },
      {
        method: 'POST',
        path: '/api/friends/friend-visible/tags',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tagId: 'bad tag' }),
      },
      { method: 'DELETE', path: '/api/friends/friend-visible/tags/bad%20tag' },
      {
        method: 'PUT',
        path: '/api/friends/friend-visible/metadata',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(['bad']),
      },
      {
        method: 'PUT',
        path: '/api/friends/friend-visible/metadata',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 'bad key': 'value' }),
      },
      { method: 'GET', path: '/api/friends/bad%20id/messages' },
      {
        method: 'POST',
        path: '/api/friends/bad%20id/messages',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'hello' }),
      },
      {
        method: 'POST',
        path: '/api/friends/friend-visible/messages',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageType: 'sticker', content: 'hello' }),
      },
      {
        method: 'POST',
        path: '/api/friends/friend-visible/messages',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageType: 'image',
          content: JSON.stringify({
            originalContentUrl: 'http://example.com/original.jpg',
            previewImageUrl: 'https://example.com/preview.jpg',
          }),
        }),
      },
    ];

    for (const item of cases) {
      const res = await app.request(item.path, {
        method: item.method,
        headers: item.headers,
        body: item.body,
      });
      expect(res.status, `${item.method} ${item.path}`).toBe(400);
    }

    expect(dbMocks.getFriendById).not.toHaveBeenCalled();
    expect(dbMocks.addTagToFriend).not.toHaveBeenCalled();
    expect(dbMocks.removeTagFromFriend).not.toHaveBeenCalled();
    expect(dbMocks.getScenarios).not.toHaveBeenCalled();
    expect(dbMocks.enrollFriendInScenario).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
});

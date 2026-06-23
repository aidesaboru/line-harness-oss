import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

const lineSdkMocks = vi.hoisted(() => {
  const mocks = {
    LineClient: vi.fn(),
    pushTextMessage: vi.fn(),
    pushFlexMessage: vi.fn(),
    pushImageMessage: vi.fn(),
    markMessagesAsRead: vi.fn(),
  };
  mocks.LineClient.mockImplementation(() => ({
    pushTextMessage: mocks.pushTextMessage,
    pushFlexMessage: mocks.pushFlexMessage,
    pushImageMessage: mocks.pushImageMessage,
    markMessagesAsRead: mocks.markMessagesAsRead,
  }));
  return mocks;
});

const dbMocks = {
  getOperators: vi.fn(),
  getOperatorById: vi.fn(),
  createOperator: vi.fn(),
  updateOperator: vi.fn(),
  deleteOperator: vi.fn(),
  getChats: vi.fn(),
  getChatById: vi.fn(),
  createChat: vi.fn(),
  getFriendById: vi.fn(),
  getLineAccountById: vi.fn(),
  updateChat: vi.fn(),
  jstNow: vi.fn(() => '2026-06-12T10:00:00.000'),
};
vi.mock('@line-crm/db', () => dbMocks);
vi.mock('@line-crm/line-sdk', () => ({ LineClient: lineSdkMocks.LineClient }));

const { chats } = await import('./chats.js');

type TestEnv = {
  Variables: { staff: { id: string; name: string; role: 'owner' | 'admin' | 'staff' } };
  Bindings: {
    DB: D1Database;
    LINE_CHANNEL_ACCESS_TOKEN: string;
    LINE_CAPTURE_ONLY?: string;
    LINE_MANUAL_SEND_ENABLED?: string;
  };
};

type FriendRow = {
  id: string;
  display_name: string | null;
  picture_url: string | null;
  line_user_id: string;
  line_account_id: string;
};

type ChatListRow = {
  id: string;
  friend_id: string;
  display_name: string | null;
  picture_url: string | null;
  line_user_id: string;
  line_account_id: string;
  operator_id: string | null;
  status: string;
  notes: string | null;
  last_message_at: string | null;
  last_message_content: string | null;
  last_message_direction: string | null;
  last_message_type: string | null;
  created_at: string;
  updated_at: string;
};

type MessageRow = {
  id: string;
  friend_id: string;
  direction: 'incoming' | 'outgoing';
  message_type: string;
  content: string;
  created_at: string;
  source?: string | null;
  delivery_type?: string | null;
  mark_as_read_token?: string | null;
};

type SupportCaseRow = {
  id: string;
  line_account_id: string;
  friend_id: string;
  title: string;
  status: string;
  updated_by?: string | null;
  updated_at?: string | null;
  forceCustomerReplyUpdateMiss?: boolean;
};

type SupportEventRow = {
  id: string;
  case_id: string;
  event_type: string;
  actor_id: string | null;
  actor_name: string | null;
  body: string;
  metadata: string;
  created_at: string;
};

function makeChatDb(state: {
  rows: ChatListRow[];
  friends: FriendRow[];
  visibleFriendIds: string[];
  messages?: MessageRow[];
  supportCases?: SupportCaseRow[];
  supportEvents?: SupportEventRow[];
}) {
  const calls: Array<{ method: 'first' | 'all' | 'run'; sql: string; binds: unknown[] }> = [];
  const visible = new Set(state.visibleFriendIds);
  const messages = state.messages ?? [];
  const supportCases = state.supportCases ?? [];
  const supportEvents = state.supportEvents ?? [];

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
          if (sql.startsWith('SELECT * FROM chats WHERE friend_id = ?')) {
            const [friendId] = bound as [string];
            const row = state.rows.find((item) => item.friend_id === friendId);
            if (!row) return null as T | null;
            return {
              id: `chat-${row.friend_id}`,
              friend_id: row.friend_id,
              operator_id: row.operator_id,
              status: row.status,
              notes: row.notes,
              last_message_at: row.last_message_at,
              created_at: row.created_at,
              updated_at: row.updated_at,
            } as T;
          }
          if (sql.startsWith('SELECT display_name, picture_url, line_user_id FROM friends WHERE id = ?')) {
            const [friendId] = bound as [string];
            const friend = state.friends.find((item) => item.id === friendId);
            return (friend
              ? {
                  display_name: friend.display_name,
                  picture_url: friend.picture_url,
                  line_user_id: friend.line_user_id,
                }
              : null) as T | null;
          }
          if (sql.startsWith('SELECT sc.id, sc.title, sc.status FROM support_cases sc WHERE')) {
            const [caseId, lineAccountId, friendId] = bound as [string, string, string];
            const row = supportCases.find((item) => (
              item.id === caseId &&
              item.line_account_id === lineAccountId &&
              item.friend_id === friendId
            ));
            return (row ? { id: row.id, title: row.title, status: row.status } : null) as T | null;
          }
          if (sql.includes('SELECT mark_as_read_token')) {
            const [friendId] = bound as [string];
            const row = messages
              .filter((message) => (
                message.friend_id === friendId &&
                message.direction === 'incoming' &&
                typeof (message as { mark_as_read_token?: unknown }).mark_as_read_token === 'string' &&
                (message as { mark_as_read_token?: string }).mark_as_read_token
              ))
              .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))[0] as
              | (MessageRow & { mark_as_read_token?: string })
              | undefined;
            return (row ? { mark_as_read_token: row.mark_as_read_token } : null) as T | null;
          }
          return null as T | null;
        },
        async all<T>() {
          calls.push({ method: 'all', sql, binds: bound });
          if (sql.includes('FROM deduped d')) {
            const rows = sql.includes('support_cases sc_friend_scope')
              ? state.rows.filter((row) => visible.has(row.friend_id))
              : state.rows;
            return { results: rows } as { results: T[] };
          }
          if (sql.includes('FROM messages_log')) {
            const friendId = bound[0] as string;
            const limit = Number(bound.at(-1) ?? 1000);
            let rows = messages.filter((message) => (
              message.friend_id === friendId &&
              (message.delivery_type === undefined || message.delivery_type === null || message.delivery_type !== 'test')
            ));
            if (sql.includes('(created_at < ? OR (created_at = ? AND id < ?))')) {
              const beforeCreatedAt = bound[1] as string;
              const beforeId = bound[3] as string;
              rows = rows.filter((message) => (
                message.created_at < beforeCreatedAt ||
                (message.created_at === beforeCreatedAt && message.id < beforeId)
              ));
            } else if (sql.includes('created_at < ?')) {
              const beforeCreatedAt = bound[1] as string;
              rows = rows.filter((message) => message.created_at < beforeCreatedAt);
            }
            rows = rows.sort((a, b) => (
              b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id)
            ));
            return { results: rows.slice(0, limit) } as { results: T[] };
          }
          return { results: [] } as { results: T[] };
        },
        async run() {
          calls.push({ method: 'run', sql, binds: bound });
          let changes = 1;
          if (sql.includes('INSERT INTO messages_log')) {
            const [id, friendId] = bound as string[];
            const isExternalOutgoing = sql.includes("'line_official'");
            const messageType = isExternalOutgoing ? 'text' : bound[2] as string;
            const content = isExternalOutgoing ? bound[2] as string : bound[3] as string;
            const createdAt = (isExternalOutgoing ? bound[4] : bound[5]) as string;
            messages.push({
              id,
              friend_id: friendId,
              direction: 'outgoing',
              message_type: messageType,
              content,
              created_at: createdAt,
              source: isExternalOutgoing ? 'line_official' : 'manual',
            });
          } else if (sql.includes('INSERT INTO support_case_events')) {
            const [id, caseId, eventType, actorId, actorName, body, metadata, createdAt] = bound as string[];
            supportEvents.push({
              id,
              case_id: caseId,
              event_type: eventType,
              actor_id: actorId,
              actor_name: actorName,
              body,
              metadata,
              created_at: createdAt,
            });
          } else if (sql.includes('UPDATE support_cases') && sql.includes("status = 'customer_reply'")) {
            const [updatedBy, updatedAt, caseId, lineAccountId] = bound as string[];
            const row = supportCases.find((item) => (
              item.id === caseId &&
              item.line_account_id === lineAccountId &&
              item.status !== 'resolved' &&
              !item.forceCustomerReplyUpdateMiss
            ));
            if (row) {
              row.status = 'customer_reply';
              row.updated_by = updatedBy;
              row.updated_at = updatedAt;
            } else {
              changes = 0;
            }
          }
          return { success: true, meta: { changes } };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;

  return { db, calls, state: { messages, supportCases, supportEvents } };
}

function setupApp(
  db: D1Database,
  role: 'owner' | 'admin' | 'staff' = 'staff',
  envOverrides: Partial<TestEnv['Bindings']> = {},
) {
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'staff-1', name: '田島', role });
    c.env = { DB: db, LINE_CHANNEL_ACCESS_TOKEN: 'fallback-token', ...envOverrides };
    await next();
  });
  app.route('/', chats);
  return app;
}

function loggedText(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.flat().map(String).join(' ');
}

function makeThrowingDb(message: string): D1Database {
  return {
    prepare() {
      throw new Error(message);
    },
  } as unknown as D1Database;
}

const rows: ChatListRow[] = [
  {
    id: 'friend-visible',
    friend_id: 'friend-visible',
    display_name: '見える友だち',
    picture_url: null,
    line_user_id: 'U-visible',
    line_account_id: 'acc-1',
    operator_id: null,
    status: 'in_progress',
    notes: null,
    last_message_at: '2026-06-12T10:00:00.000',
    last_message_content: '確認お願いします',
    last_message_direction: 'incoming',
    last_message_type: 'text',
    created_at: '2026-06-12T09:00:00.000',
    updated_at: '2026-06-12T10:00:00.000',
  },
  {
    id: 'friend-hidden',
    friend_id: 'friend-hidden',
    display_name: '隠れる友だち',
    picture_url: null,
    line_user_id: 'U-hidden',
    line_account_id: 'acc-1',
    operator_id: null,
    status: 'unread',
    notes: null,
    last_message_at: '2026-06-12T11:00:00.000',
    last_message_content: '別件です',
    last_message_direction: 'incoming',
    last_message_type: 'text',
    created_at: '2026-06-12T09:00:00.000',
    updated_at: '2026-06-12T11:00:00.000',
  },
];

const friends: FriendRow[] = rows.map((row) => ({
  id: row.friend_id,
  display_name: row.display_name,
  picture_url: row.picture_url,
  line_user_id: row.line_user_id,
  line_account_id: row.line_account_id,
}));

beforeEach(() => {
  for (const fn of Object.values(dbMocks)) fn.mockReset();
  dbMocks.jstNow.mockReturnValue('2026-06-12T10:00:00.000');
  lineSdkMocks.LineClient.mockClear();
  lineSdkMocks.pushTextMessage.mockReset().mockResolvedValue(undefined);
  lineSdkMocks.pushFlexMessage.mockReset().mockResolvedValue(undefined);
  lineSdkMocks.pushImageMessage.mockReset().mockResolvedValue(undefined);
  lineSdkMocks.markMessagesAsRead.mockReset().mockResolvedValue(undefined);
});

describe('chat support visibility', () => {
  test('staff chat list only includes friends tied to visible support cases', async () => {
    const { db, calls } = makeChatDb({ rows, friends, visibleFriendIds: ['friend-visible'] });

    const res = await setupApp(db, 'staff').request('/api/chats?lineAccountId=acc-1');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: Array<{ id: string; friendName: string }> };
    expect(body.success).toBe(true);
    expect(body.data.map((item) => item.id)).toEqual(['friend-visible']);
    const listCall = calls.find((call) => call.method === 'all' && call.sql.includes('FROM deduped d'));
    expect(listCall?.sql).toContain('support_cases sc_friend_scope');
    expect(listCall?.binds).toContain('staff-1');
    expect(listCall?.binds).toContain('%田島%');
  });

  test('owner chat list remains unrestricted', async () => {
    const { db } = makeChatDb({ rows, friends, visibleFriendIds: ['friend-visible'] });

    const res = await setupApp(db, 'owner').request('/api/chats?lineAccountId=acc-1');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((item) => item.id)).toEqual(['friend-visible', 'friend-hidden']);
  });

  test('staff cannot open a hidden chat by URL', async () => {
    const { db } = makeChatDb({ rows, friends, visibleFriendIds: ['friend-visible'] });
    dbMocks.getChatById.mockResolvedValue(null);
    dbMocks.getFriendById.mockImplementation(async (_db: D1Database, id: string) =>
      friends.find((friend) => friend.id === id) ?? null,
    );

    const denied = await setupApp(db, 'staff').request('/api/chats/friend-hidden');
    expect(denied.status).toBe(404);

    const allowed = await setupApp(db, 'staff').request('/api/chats/friend-visible');
    expect(allowed.status).toBe(200);
  });

  test('chat detail returns message pagination metadata and accepts before cursor', async () => {
    const messages: MessageRow[] = [
      { id: 'msg-1', friend_id: 'friend-visible', direction: 'incoming', message_type: 'text', content: '1件目', created_at: '2026-06-12T09:00:00.000' },
      { id: 'msg-2', friend_id: 'friend-visible', direction: 'outgoing', message_type: 'text', content: '2件目', created_at: '2026-06-12T09:01:00.000' },
      { id: 'msg-3', friend_id: 'friend-visible', direction: 'incoming', message_type: 'text', content: '3件目', created_at: '2026-06-12T09:02:00.000' },
      { id: 'msg-4', friend_id: 'friend-visible', direction: 'outgoing', message_type: 'text', content: '4件目', created_at: '2026-06-12T09:03:00.000' },
      { id: 'msg-test', friend_id: 'friend-visible', direction: 'outgoing', message_type: 'text', content: 'テスト配信', created_at: '2026-06-12T09:04:00.000', delivery_type: 'test' },
    ];
    const { db, calls } = makeChatDb({
      rows,
      friends,
      visibleFriendIds: ['friend-visible'],
      messages,
    });
    dbMocks.getChatById.mockResolvedValue(null);
    dbMocks.getFriendById.mockImplementation(async (_db: D1Database, id: string) =>
      friends.find((friend) => friend.id === id) ?? null,
    );
    const app = setupApp(db, 'owner');

    const first = await app.request('/api/chats/friend-visible?messageLimit=2');
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      success: boolean;
      data: {
        messages: Array<{ id: string; content: string; createdAt: string }>;
        hasMoreMessages: boolean;
        nextMessagesBefore: { createdAt: string; id: string } | null;
      };
    };
    expect(firstBody.success).toBe(true);
    expect(firstBody.data.messages.map((message) => message.id)).toEqual(['msg-3', 'msg-4']);
    expect(firstBody.data.hasMoreMessages).toBe(true);
    expect(firstBody.data.nextMessagesBefore).toEqual({
      createdAt: '2026-06-12T09:02:00.000',
      id: 'msg-3',
    });

    const second = await app.request(
      `/api/chats/friend-visible?messageLimit=2&beforeCreatedAt=${encodeURIComponent(firstBody.data.nextMessagesBefore!.createdAt)}&beforeId=${encodeURIComponent(firstBody.data.nextMessagesBefore!.id)}`,
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as typeof firstBody;
    expect(secondBody.data.messages.map((message) => message.id)).toEqual(['msg-1', 'msg-2']);
    expect(secondBody.data.hasMoreMessages).toBe(false);
    expect(secondBody.data.nextMessagesBefore).toBeNull();

    const messageCalls = calls.filter((call) => call.method === 'all' && call.sql.includes('FROM messages_log'));
    expect(messageCalls[0].binds).toEqual(['friend-visible', 3]);
    expect(messageCalls[1].binds).toEqual([
      'friend-visible',
      '2026-06-12T09:02:00.000',
      '2026-06-12T09:02:00.000',
      'msg-3',
      3,
    ]);
  });

  test('chat list rejects unsafe filters before SQL bind', async () => {
    const cases = [
      '/api/chats?lineAccountId=bad%20account',
      '/api/chats?operatorId=bad%20operator',
      '/api/chats?status=archived',
      '/api/chats?unansweredOnly=maybe',
    ];

    for (const path of cases) {
      const { db, calls } = makeChatDb({ rows, friends, visibleFriendIds: ['friend-visible'] });
      const res = await setupApp(db, 'owner').request(path);

      expect(res.status, path).toBe(400);
      expect(calls, path).toEqual([]);
    }
  });

  test('chat list trims valid filters before SQL bind', async () => {
    const { db, calls } = makeChatDb({ rows, friends, visibleFriendIds: ['friend-visible'] });

    const res = await setupApp(db, 'owner')
      .request('/api/chats?lineAccountId=%20acc-1%20&operatorId=%20operator-1%20&status=%20in_progress%20&unansweredOnly=false');

    expect(res.status).toBe(200);
    const listCall = calls.find((call) => call.method === 'all' && call.sql.includes('FROM deduped d'));
    expect(listCall?.binds).toEqual([
      'acc-1',
      'acc-1',
      'acc-1',
      'acc-1',
      'in_progress',
      'operator-1',
      'acc-1',
    ]);
  });

  test('chat detail rejects unsafe path or cursor values before DB helpers or SQL bind', async () => {
    const cases = [
      '/api/chats/bad%20chat',
      '/api/chats/friend-visible?beforeCreatedAt=not-a-date',
      '/api/chats/friend-visible?beforeId=msg-1',
    ];

    for (const path of cases) {
      dbMocks.getChatById.mockClear();
      dbMocks.getFriendById.mockClear();
      const { db, calls } = makeChatDb({ rows, friends, visibleFriendIds: ['friend-visible'] });
      const res = await setupApp(db, 'owner').request(path);

      expect(res.status, path).toBe(400);
      expect(dbMocks.getChatById, path).not.toHaveBeenCalled();
      expect(dbMocks.getFriendById, path).not.toHaveBeenCalled();
      expect(calls, path).toEqual([]);
    }
  });

  test('chat detail trims valid path and cursor values before SQL bind', async () => {
    const messages: MessageRow[] = [
      { id: 'msg-1', friend_id: 'friend-visible', direction: 'incoming', message_type: 'text', content: '1件目', created_at: '2026-06-12T09:00:00.000' },
      { id: 'msg-2', friend_id: 'friend-visible', direction: 'outgoing', message_type: 'text', content: '2件目', created_at: '2026-06-12T09:01:00.000' },
    ];
    const { db, calls } = makeChatDb({
      rows,
      friends,
      visibleFriendIds: ['friend-visible'],
      messages,
    });
    dbMocks.getChatById.mockResolvedValue(null);
    dbMocks.getFriendById.mockImplementation(async (_db: D1Database, id: string) =>
      friends.find((friend) => friend.id === id) ?? null,
    );

    const res = await setupApp(db, 'owner')
      .request('/api/chats/%20friend-visible%20?messageLimit=999&beforeCreatedAt=%202026-06-12T09:01:00.000%2B09:00%20&beforeId=%20msg-2%20');

    expect(res.status).toBe(200);
    expect(dbMocks.getChatById).toHaveBeenCalledWith(db, 'friend-visible');
    expect(dbMocks.getFriendById).toHaveBeenCalledWith(db, 'friend-visible');
    const messageCall = calls.find((call) => call.method === 'all' && call.sql.includes('FROM messages_log'));
    expect(messageCall?.binds).toEqual([
      'friend-visible',
      '2026-06-12T09:01:00.000+09:00',
      '2026-06-12T09:01:00.000+09:00',
      'msg-2',
      1000,
    ]);
  });

  test('chat mutations reject malformed IDs and payloads before DB helpers or LINE calls', async () => {
    const cases: Array<[string, string, RequestInit?]> = [
      ['POST', '/api/chats', {
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      }],
      ['POST', '/api/chats', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ friendId: 'bad friend' }),
      }],
      ['PUT', '/api/chats/bad%20chat', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'in_progress' }),
      }],
      ['PUT', '/api/chats/friend-visible', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }],
      ['PUT', '/api/chats/friend-visible', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'done' }),
      }],
      ['POST', '/api/chats/bad%20chat/loading', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loadingSeconds: 10 }),
      }],
      ['POST', '/api/chats/bad%20chat/send/validate', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '確認します' }),
      }],
      ['POST', '/api/chats/friend-visible/send/validate', {
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      }],
      ['POST', '/api/chats/bad%20chat/send', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '確認します' }),
      }],
      ['POST', '/api/chats/friend-visible/send', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '確認します', supportCaseId: 'bad case' }),
      }],
    ];

    for (const [method, path, init] of cases) {
      dbMocks.getChatById.mockClear();
      dbMocks.getFriendById.mockClear();
      dbMocks.createChat.mockClear();
      dbMocks.updateChat.mockClear();
      const { db, calls } = makeChatDb({ rows, friends, visibleFriendIds: ['friend-visible'] });
      const res = await setupApp(db, 'owner').request(path, { ...init, method });

      expect(res.status, `${method} ${path}`).toBe(400);
      expect(dbMocks.getChatById, `${method} ${path}`).not.toHaveBeenCalled();
      expect(dbMocks.getFriendById, `${method} ${path}`).not.toHaveBeenCalled();
      expect(dbMocks.createChat, `${method} ${path}`).not.toHaveBeenCalled();
      expect(dbMocks.updateChat, `${method} ${path}`).not.toHaveBeenCalled();
      expect(calls, `${method} ${path}`).toEqual([]);
      expect(lineSdkMocks.LineClient, `${method} ${path}`).not.toHaveBeenCalled();
    }
  });

  test('chat list failure logs only the error kind', async () => {
    const db = makeThrowingDb('chat list secret account-token U-visible friend-visible');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const res = await setupApp(db, 'owner').request('/api/chats?lineAccountId=acc-1');

      expect(res.status).toBe(500);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body).toEqual({ success: false, error: 'Internal server error' });
      const logged = loggedText(errorSpy);
      expect(logged).toContain('GET /api/chats error: Error');
      expect(logged).not.toContain('chat list secret');
      expect(logged).not.toContain('account-token');
      expect(logged).not.toContain('U-visible');
      expect(logged).not.toContain('friend-visible');
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('chat create failure does not log raw chat payload details', async () => {
    const { db } = makeChatDb({ rows, friends, visibleFriendIds: ['friend-visible'] });
    dbMocks.createChat.mockRejectedValue(new Error('chat create secret account-token U-visible friend-visible'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const res = await setupApp(db, 'owner').request('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          friendId: 'friend-visible',
          operatorId: 'operator-1',
          lineAccountId: 'acc-1',
        }),
      });

      expect(res.status).toBe(500);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body).toEqual({ success: false, error: 'Internal server error' });
      const logged = loggedText(errorSpy);
      expect(logged).toContain('POST /api/chats error: Error');
      expect(logged).not.toContain('chat create secret');
      expect(logged).not.toContain('account-token');
      expect(logged).not.toContain('U-visible');
      expect(logged).not.toContain('friend-visible');
      expect(logged).not.toContain('operator-1');
      expect(logged).not.toContain('acc-1');
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('operator creation failure does not log raw operator payload details', async () => {
    const { db } = makeChatDb({ rows, friends, visibleFriendIds: ['friend-visible'] });
    dbMocks.createOperator.mockRejectedValue(new Error('operator create secret owner@example.com account-token'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const res = await setupApp(db, 'owner').request('/api/operators', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'operator create secret',
          email: 'owner@example.com',
          role: 'support',
        }),
      });

      expect(res.status).toBe(500);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body).toEqual({ success: false, error: 'Internal server error' });
      const logged = loggedText(errorSpy);
      expect(logged).toContain('POST /api/operators error: Error');
      expect(logged).not.toContain('operator create secret');
      expect(logged).not.toContain('owner@example.com');
      expect(logged).not.toContain('account-token');
      expect(logged).not.toContain('support');
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('chat create trims valid IDs before DB helpers and line-account update', async () => {
    const { db, calls } = makeChatDb({ rows, friends, visibleFriendIds: ['friend-visible'] });
    dbMocks.createChat.mockResolvedValue({
      id: 'chat-created',
      friend_id: 'friend-visible',
      operator_id: 'operator-1',
      status: 'in_progress',
      notes: null,
      last_message_at: '2026-06-12T10:00:00.000',
      created_at: '2026-06-12T10:00:00.000',
      updated_at: '2026-06-12T10:00:00.000',
    });

    const res = await setupApp(db, 'owner').request('/api/chats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        friendId: ' friend-visible ',
        operatorId: ' operator-1 ',
        lineAccountId: ' acc-1 ',
      }),
    });

    expect(res.status).toBe(201);
    expect(dbMocks.createChat).toHaveBeenCalledWith(db, {
      friendId: 'friend-visible',
      operatorId: 'operator-1',
      lineAccountId: 'acc-1',
    });
    const lineAccountUpdate = calls.find((call) => call.method === 'run' && call.sql.includes('UPDATE chats SET line_account_id'));
    expect(lineAccountUpdate?.binds).toEqual(['acc-1', 'chat-created']);
  });

  test('chat update trims valid IDs and payload before DB helpers', async () => {
    const { db } = makeChatDb({ rows, friends, visibleFriendIds: ['friend-visible'] });
    dbMocks.getChatById.mockImplementation(async (_db: D1Database, id: string) => {
      if (id === 'friend-visible') return null;
      if (id === 'chat-friend-visible') {
        return {
          id: 'chat-friend-visible',
          friend_id: 'friend-visible',
          operator_id: 'operator-1',
          status: 'resolved',
          notes: '次回確認',
          last_message_at: '2026-06-12T10:00:00.000',
          created_at: '2026-06-12T09:00:00.000',
          updated_at: '2026-06-12T10:00:00.000',
        };
      }
      return null;
    });
    dbMocks.getFriendById.mockImplementation(async (_db: D1Database, id: string) =>
      friends.find((friend) => friend.id === id) ?? null,
    );
    dbMocks.updateChat.mockResolvedValue(undefined);

    const res = await setupApp(db, 'owner').request('/api/chats/%20friend-visible%20', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operatorId: ' operator-1 ',
        status: ' resolved ',
        notes: ' 次回確認 ',
      }),
    });

    expect(res.status).toBe(200);
    expect(dbMocks.getChatById).toHaveBeenCalledWith(db, 'friend-visible');
    expect(dbMocks.updateChat).toHaveBeenCalledWith(db, 'chat-friend-visible', {
      operatorId: 'operator-1',
      status: 'resolved',
      notes: '次回確認',
    });
    expect(dbMocks.getChatById).toHaveBeenCalledWith(db, 'chat-friend-visible');
  });

  test('sending a support reply records the chat message and support case event', async () => {
    const { db, state } = makeChatDb({
      rows,
      friends,
      visibleFriendIds: ['friend-visible'],
      supportCases: [
        {
          id: 'case-visible',
          line_account_id: 'acc-1',
          friend_id: 'friend-visible',
          title: '報酬反映の確認',
          status: 'waiting_secondary',
        },
      ],
    });
    dbMocks.getChatById.mockResolvedValue({
      id: 'chat-visible',
      friend_id: 'friend-visible',
      operator_id: null,
      status: 'in_progress',
      notes: null,
      last_message_at: '2026-06-12T10:00:00.000',
      created_at: '2026-06-12T09:00:00.000',
      updated_at: '2026-06-12T10:00:00.000',
    });
    dbMocks.getFriendById.mockImplementation(async (_db: D1Database, id: string) =>
      friends.find((friend) => friend.id === id) ?? null,
    );
    dbMocks.getLineAccountById.mockResolvedValue({ channel_access_token: 'account-token' });
    dbMocks.updateChat.mockResolvedValue(undefined);

    const res = await setupApp(db, 'owner').request('/api/chats/friend-visible/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: '確認して折り返します。',
        supportCaseId: 'case-visible',
        lineAccountId: 'acc-1',
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: {
        sent: boolean;
        messageId: string;
        supportCase: {
          id: string;
          previousStatus: string;
          nextStatus: string | null;
          statusUpdated: boolean;
        } | null;
      };
    };
    expect(body.data.supportCase).toEqual({
      id: 'case-visible',
      previousStatus: 'waiting_secondary',
      nextStatus: 'customer_reply',
      statusUpdated: true,
    });
    expect(lineSdkMocks.LineClient).toHaveBeenCalledWith('account-token', { allowMutationsWhenDisabled: false });
    expect(lineSdkMocks.pushTextMessage).toHaveBeenCalledWith('U-visible', '確認して折り返します。');
    expect(state.messages.at(-1)).toMatchObject({
      friend_id: 'friend-visible',
      direction: 'outgoing',
      message_type: 'text',
      content: '確認して折り返します。',
      created_at: '2026-06-12T10:00:00.000',
    });
    expect(state.supportEvents.at(-1)).toMatchObject({
      case_id: 'case-visible',
      event_type: 'customer_reply_sent',
      actor_id: 'staff-1',
      actor_name: '田島',
      body: 'チャットで顧客返信を送信しました',
      created_at: '2026-06-12T10:00:00.000',
    });
    expect(state.supportCases.at(-1)).toMatchObject({
      id: 'case-visible',
      status: 'customer_reply',
      updated_by: 'staff-1',
      updated_at: '2026-06-12T10:00:00.000',
    });
    const metadata = JSON.parse(state.supportEvents.at(-1)!.metadata) as {
      chatId: string;
      friendId: string;
      lineAccountId: string;
      messageId: string;
      messageType: string;
      contentPreview: string;
      previousStatus: string;
      nextStatus: string;
      statusUpdateApplied: boolean;
    };
    expect(metadata).toMatchObject({
      chatId: 'chat-visible',
      friendId: 'friend-visible',
      lineAccountId: 'acc-1',
      messageType: 'text',
      contentPreview: '確認して折り返します。',
      previousStatus: 'waiting_secondary',
      nextStatus: 'customer_reply',
      statusUpdateApplied: true,
    });
    expect(metadata.messageId).toEqual(body.data.messageId);
    expect(metadata.messageId).toEqual(state.messages.at(-1)!.id);
    expect(dbMocks.updateChat).toHaveBeenCalledWith(db, 'chat-visible', {
      status: 'in_progress',
      lastMessageAt: '2026-06-12T10:00:00.000',
    });
  });

  test('support reply keeps the case link when the URL fallback omits lineAccountId', async () => {
    const { db, state } = makeChatDb({
      rows,
      friends,
      visibleFriendIds: ['friend-visible'],
      supportCases: [
        {
          id: 'case-visible',
          line_account_id: 'acc-1',
          friend_id: 'friend-visible',
          title: 'URL fallback',
          status: 'in_progress',
        },
      ],
    });
    dbMocks.getChatById.mockResolvedValue({
      id: 'chat-visible',
      friend_id: 'friend-visible',
      operator_id: null,
      status: 'in_progress',
      notes: null,
      last_message_at: '2026-06-12T10:00:00.000',
      created_at: '2026-06-12T09:00:00.000',
      updated_at: '2026-06-12T10:00:00.000',
    });
    dbMocks.getFriendById.mockImplementation(async (_db: D1Database, id: string) =>
      friends.find((friend) => friend.id === id) ?? null,
    );
    dbMocks.getLineAccountById.mockResolvedValue({ channel_access_token: 'account-token' });
    dbMocks.updateChat.mockResolvedValue(undefined);

    const res = await setupApp(db, 'owner').request('/api/chats/friend-visible/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'sessionStorageなしでも紐付けます。',
        supportCaseId: 'case-visible',
      }),
    });

    expect(res.status).toBe(200);
    expect(state.supportCases.at(-1)).toMatchObject({
      id: 'case-visible',
      status: 'customer_reply',
    });
    expect(state.supportEvents.at(-1)).toMatchObject({
      case_id: 'case-visible',
      event_type: 'customer_reply_sent',
    });
    const metadata = JSON.parse(state.supportEvents.at(-1)!.metadata) as {
      lineAccountId: string;
      contentPreview: string;
      statusUpdateApplied: boolean;
    };
    expect(metadata).toMatchObject({
      lineAccountId: 'acc-1',
      contentPreview: 'sessionStorageなしでも紐付けます。',
      statusUpdateApplied: true,
    });
  });

  test('manual send can mark the latest incoming message as read while capture-only stays enabled', async () => {
    const { db } = makeChatDb({
      rows,
      friends,
      visibleFriendIds: ['friend-visible'],
      messages: [
        {
          id: 'incoming-1',
          friend_id: 'friend-visible',
          direction: 'incoming',
          message_type: 'text',
          content: '確認お願いします',
          created_at: '2026-06-12T09:30:00.000',
          mark_as_read_token: 'read-token-1',
        },
      ],
    });
    dbMocks.getChatById.mockResolvedValue({
      id: 'chat-visible',
      friend_id: 'friend-visible',
      operator_id: null,
      status: 'unread',
      notes: null,
      last_message_at: '2026-06-12T09:30:00.000',
      created_at: '2026-06-12T09:00:00.000',
      updated_at: '2026-06-12T09:30:00.000',
    });
    dbMocks.getFriendById.mockImplementation(async (_db: D1Database, id: string) =>
      friends.find((friend) => friend.id === id) ?? null,
    );
    dbMocks.getLineAccountById.mockResolvedValue({ channel_access_token: 'account-token' });
    dbMocks.updateChat.mockResolvedValue(undefined);

    const res = await setupApp(db, 'owner', {
      LINE_CAPTURE_ONLY: '1',
      LINE_MANUAL_SEND_ENABLED: '1',
    }).request('/api/chats/friend-visible/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: '確認して折り返します。',
        markAsRead: true,
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        markAsRead: { requested: boolean; marked: boolean; reason: string | null };
      };
    };
    expect(lineSdkMocks.LineClient).toHaveBeenCalledWith('account-token', { allowMutationsWhenDisabled: true });
    expect(lineSdkMocks.pushTextMessage).toHaveBeenCalledWith('U-visible', '確認して折り返します。');
    expect(lineSdkMocks.markMessagesAsRead).toHaveBeenCalledWith('read-token-1');
    expect(body.data.markAsRead).toEqual({ requested: true, marked: true, reason: null });
  });

  test('records a LINE Official Account outgoing message without sending through LINE API', async () => {
    const { db, state } = makeChatDb({
      rows,
      friends,
      visibleFriendIds: ['friend-visible'],
      messages: [],
    });
    dbMocks.getChatById.mockResolvedValue({
      id: 'chat-visible',
      friend_id: 'friend-visible',
      operator_id: null,
      status: 'unread',
      notes: null,
      last_message_at: '2026-06-12T09:30:00.000',
      created_at: '2026-06-12T09:00:00.000',
      updated_at: '2026-06-12T09:30:00.000',
    });
    dbMocks.getFriendById.mockImplementation(async (_db: D1Database, id: string) =>
      friends.find((friend) => friend.id === id) ?? null,
    );
    dbMocks.getLineAccountById.mockResolvedValue({ channel_access_token: 'account-token' });
    dbMocks.updateChat.mockResolvedValue(undefined);

    const res = await setupApp(db, 'owner').request('/api/chats/friend-visible/external-outgoing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'LINE公式側で送信済みです。' }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        recorded: boolean;
        message: { source: string; content: string };
      };
    };
    expect(lineSdkMocks.pushTextMessage).not.toHaveBeenCalled();
    expect(body.data.recorded).toBe(true);
    expect(body.data.message).toMatchObject({
      source: 'line_official',
      content: 'LINE公式側で送信済みです。',
    });
    expect(state.messages.at(-1)).toMatchObject({
      friend_id: 'friend-visible',
      direction: 'outgoing',
      message_type: 'text',
      content: 'LINE公式側で送信済みです。',
      source: 'line_official',
    });
    expect(dbMocks.updateChat).toHaveBeenCalledWith(db, 'chat-visible', {
      status: 'in_progress',
      lastMessageAt: '2026-06-12T10:00:00.000',
    });
  });

  test('sending a support image reply records the chat message and support case event', async () => {
    const { db, state } = makeChatDb({
      rows,
      friends,
      visibleFriendIds: ['friend-visible'],
      supportCases: [
        {
          id: 'case-visible',
          line_account_id: 'acc-1',
          friend_id: 'friend-visible',
          title: '画像確認',
          status: 'in_progress',
        },
      ],
    });
    dbMocks.getChatById.mockResolvedValue({
      id: 'chat-visible',
      friend_id: 'friend-visible',
      operator_id: null,
      status: 'in_progress',
      notes: null,
      last_message_at: '2026-06-12T10:00:00.000',
      created_at: '2026-06-12T09:00:00.000',
      updated_at: '2026-06-12T10:00:00.000',
    });
    dbMocks.getFriendById.mockImplementation(async (_db: D1Database, id: string) =>
      friends.find((friend) => friend.id === id) ?? null,
    );
    dbMocks.getLineAccountById.mockResolvedValue({ channel_access_token: 'account-token' });
    dbMocks.updateChat.mockResolvedValue(undefined);

    const imageContent = JSON.stringify({
      originalContentUrl: 'https://example.com/original.jpg',
      previewImageUrl: 'https://example.com/preview.jpg',
    });
    const res = await setupApp(db, 'owner').request('/api/chats/friend-visible/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messageType: 'image',
        content: imageContent,
        supportCaseId: 'case-visible',
        lineAccountId: 'acc-1',
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: {
        supportCase: {
          id: string;
          previousStatus: string;
          nextStatus: string | null;
          statusUpdated: boolean;
        } | null;
      };
    };
    expect(body.data.supportCase).toEqual({
      id: 'case-visible',
      previousStatus: 'in_progress',
      nextStatus: 'customer_reply',
      statusUpdated: true,
    });
    expect(lineSdkMocks.pushImageMessage).toHaveBeenCalledWith(
      'U-visible',
      'https://example.com/original.jpg',
      'https://example.com/preview.jpg',
    );
    expect(state.messages.at(-1)).toMatchObject({
      friend_id: 'friend-visible',
      direction: 'outgoing',
      message_type: 'image',
      content: imageContent,
      created_at: '2026-06-12T10:00:00.000',
    });
    const metadata = JSON.parse(state.supportEvents.at(-1)!.metadata) as {
      messageType: string;
      contentPreview: string;
      previousStatus: string;
      nextStatus: string;
      statusUpdateApplied: boolean;
    };
    expect(metadata).toMatchObject({
      messageType: 'image',
      contentPreview: imageContent,
      previousStatus: 'in_progress',
      nextStatus: 'customer_reply',
      statusUpdateApplied: true,
    });
  });

  test('unsupported chat message types are rejected before LINE push or DB writes', async () => {
    const { db, state } = makeChatDb({
      rows,
      friends,
      visibleFriendIds: ['friend-visible'],
    });
    dbMocks.getChatById.mockResolvedValue({
      id: 'chat-visible',
      friend_id: 'friend-visible',
      operator_id: null,
      status: 'in_progress',
      notes: null,
      last_message_at: '2026-06-12T10:00:00.000',
      created_at: '2026-06-12T09:00:00.000',
      updated_at: '2026-06-12T10:00:00.000',
    });

    const res = await setupApp(db, 'owner').request('/api/chats/friend-visible/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messageType: 'sticker',
        content: JSON.stringify({ packageId: '1', stickerId: '1' }),
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body).toMatchObject({
      success: false,
      error: 'messageType must be text, flex, or image',
    });
    expect(lineSdkMocks.pushTextMessage).not.toHaveBeenCalled();
    expect(lineSdkMocks.pushFlexMessage).not.toHaveBeenCalled();
    expect(lineSdkMocks.pushImageMessage).not.toHaveBeenCalled();
    expect(dbMocks.updateChat).not.toHaveBeenCalled();
    expect(state.messages).toHaveLength(0);
    expect(state.supportEvents).toHaveLength(0);
  });

  test('image support reply validation rejects malformed payloads before writes', async () => {
    const { db, state } = makeChatDb({
      rows,
      friends,
      visibleFriendIds: ['friend-visible'],
      supportCases: [
        {
          id: 'case-visible',
          line_account_id: 'acc-1',
          friend_id: 'friend-visible',
          title: '画像確認',
          status: 'in_progress',
        },
      ],
    });
    dbMocks.getChatById.mockResolvedValue({
      id: 'chat-visible',
      friend_id: 'friend-visible',
      operator_id: null,
      status: 'in_progress',
      notes: null,
      last_message_at: '2026-06-12T10:00:00.000',
      created_at: '2026-06-12T09:00:00.000',
      updated_at: '2026-06-12T10:00:00.000',
    });

    const res = await setupApp(db, 'owner').request('/api/chats/friend-visible/send/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messageType: 'image',
        content: JSON.stringify({
          originalContentUrl: 'http://example.com/original.jpg',
          previewImageUrl: 'https://example.com/preview.jpg',
        }),
        supportCaseId: 'case-visible',
        lineAccountId: 'acc-1',
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body).toMatchObject({
      success: false,
      error: 'image content must include HTTPS originalContentUrl and previewImageUrl',
    });
    expect(lineSdkMocks.pushImageMessage).not.toHaveBeenCalled();
    expect(dbMocks.updateChat).not.toHaveBeenCalled();
    expect(state.messages).toHaveLength(0);
    expect(state.supportEvents).toHaveLength(0);
    expect(state.supportCases.at(-1)).toMatchObject({ id: 'case-visible', status: 'in_progress' });
  });

  test('loading failure does not leak LINE response body, token, or user ID', async () => {
    const { db } = makeChatDb({ rows, friends, visibleFriendIds: ['friend-visible'] });
    dbMocks.getChatById.mockResolvedValue({
      id: 'chat-visible',
      friend_id: 'friend-visible',
      operator_id: null,
      status: 'in_progress',
      notes: null,
      last_message_at: '2026-06-12T10:00:00.000',
      created_at: '2026-06-12T09:00:00.000',
      updated_at: '2026-06-12T10:00:00.000',
    });
    dbMocks.getFriendById.mockImplementation(async (_db: D1Database, id: string) =>
      friends.find((friend) => friend.id === id) ?? null,
    );
    dbMocks.getLineAccountById.mockResolvedValue({ channel_access_token: 'account-token-secret' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('LINE upstream secret account-token-secret U-visible friend-visible', { status: 503 }),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const res = await setupApp(db, 'owner').request('/api/chats/chat-visible/loading', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loadingSeconds: 10 }),
      });

      expect(res.status).toBe(500);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body).toEqual({ success: false, error: 'Internal server error' });
      expect(fetchSpy).toHaveBeenCalled();
      const logged = loggedText(errorSpy);
      expect(logged).toContain('POST /api/chats/:id/loading error: LineHttpError_503');
      expect(logged).not.toContain('LINE upstream secret');
      expect(logged).not.toContain('account-token-secret');
      expect(logged).not.toContain('U-visible');
      expect(logged).not.toContain('friend-visible');
    } finally {
      fetchSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  test('send validation failure logs only error kind', async () => {
    const { db } = makeChatDb({ rows, friends, visibleFriendIds: ['friend-visible'] });
    dbMocks.getChatById.mockResolvedValue({
      id: 'chat-visible',
      friend_id: 'friend-visible',
      operator_id: null,
      status: 'in_progress',
      notes: null,
      last_message_at: '2026-06-12T10:00:00.000',
      created_at: '2026-06-12T09:00:00.000',
      updated_at: '2026-06-12T10:00:00.000',
    });
    dbMocks.getFriendById.mockRejectedValue(new Error('db secret account-token U-visible friend-visible'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const res = await setupApp(db, 'owner').request('/api/chats/chat-visible/send/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '確認して折り返します。' }),
      });

      expect(res.status).toBe(500);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body).toEqual({ success: false, error: 'Internal server error' });
      const logged = loggedText(errorSpy);
      expect(logged).toContain('POST /api/chats/:id/send/validate error: Error');
      expect(logged).not.toContain('db secret');
      expect(logged).not.toContain('account-token');
      expect(logged).not.toContain('U-visible');
      expect(logged).not.toContain('friend-visible');
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('send failure does not leak LINE exception body, token, or user ID', async () => {
    const { db, state } = makeChatDb({ rows, friends, visibleFriendIds: ['friend-visible'] });
    dbMocks.getChatById.mockResolvedValue({
      id: 'chat-visible',
      friend_id: 'friend-visible',
      operator_id: null,
      status: 'in_progress',
      notes: null,
      last_message_at: '2026-06-12T10:00:00.000',
      created_at: '2026-06-12T09:00:00.000',
      updated_at: '2026-06-12T10:00:00.000',
    });
    dbMocks.getFriendById.mockImplementation(async (_db: D1Database, id: string) =>
      friends.find((friend) => friend.id === id) ?? null,
    );
    dbMocks.getLineAccountById.mockResolvedValue({ channel_access_token: 'account-token-secret' });
    lineSdkMocks.pushTextMessage.mockRejectedValue(
      new Error('LINE push secret account-token-secret U-visible friend-visible'),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const res = await setupApp(db, 'owner').request('/api/chats/chat-visible/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '確認して折り返します。' }),
      });

      expect(res.status).toBe(502);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body).toEqual({ success: false, error: 'LINE送信に失敗しました。もう一度お試しください。' });
      expect(state.messages).toHaveLength(0);
      expect(dbMocks.updateChat).not.toHaveBeenCalled();
      const logged = loggedText(errorSpy);
      expect(logged).toContain('manual LINE send failed: Error');
      expect(logged).not.toContain('LINE push secret');
      expect(logged).not.toContain('account-token-secret');
      expect(logged).not.toContain('U-visible');
      expect(logged).not.toContain('friend-visible');
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('support reply send reports when the support case status update no longer applies', async () => {
    const { db, state } = makeChatDb({
      rows,
      friends,
      visibleFriendIds: ['friend-visible'],
      supportCases: [
        {
          id: 'case-visible',
          line_account_id: 'acc-1',
          friend_id: 'friend-visible',
          title: '報酬反映の確認',
          status: 'waiting_secondary',
          forceCustomerReplyUpdateMiss: true,
        },
      ],
    });
    dbMocks.getChatById.mockResolvedValue({
      id: 'chat-visible',
      friend_id: 'friend-visible',
      operator_id: null,
      status: 'in_progress',
      notes: null,
      last_message_at: '2026-06-12T10:00:00.000',
      created_at: '2026-06-12T09:00:00.000',
      updated_at: '2026-06-12T10:00:00.000',
    });
    dbMocks.getFriendById.mockImplementation(async (_db: D1Database, id: string) =>
      friends.find((friend) => friend.id === id) ?? null,
    );
    dbMocks.getLineAccountById.mockResolvedValue({ channel_access_token: 'account-token' });
    dbMocks.updateChat.mockResolvedValue(undefined);

    const res = await setupApp(db, 'owner').request('/api/chats/friend-visible/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: '確認して折り返します。',
        supportCaseId: 'case-visible',
        lineAccountId: 'acc-1',
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        supportCase: {
          id: string;
          previousStatus: string;
          nextStatus: string | null;
          statusUpdated: boolean;
        } | null;
      };
    };
    expect(body.data.supportCase).toEqual({
      id: 'case-visible',
      previousStatus: 'waiting_secondary',
      nextStatus: null,
      statusUpdated: false,
    });
    expect(lineSdkMocks.pushTextMessage).toHaveBeenCalledWith('U-visible', '確認して折り返します。');
    expect(state.messages).toHaveLength(1);
    expect(state.supportCases.at(-1)).toMatchObject({
      id: 'case-visible',
      status: 'waiting_secondary',
    });
    expect(state.supportEvents.at(-1)).toMatchObject({
      case_id: 'case-visible',
      event_type: 'customer_reply_sent',
    });
    const metadata = JSON.parse(state.supportEvents.at(-1)!.metadata) as {
      previousStatus: string;
      nextStatus: string | null;
      statusUpdateApplied: boolean;
    };
    expect(metadata).toMatchObject({
      previousStatus: 'waiting_secondary',
      nextStatus: null,
      statusUpdateApplied: false,
    });
  });

  test('support reply validation checks the case without sending or writing logs', async () => {
    const { db, state } = makeChatDb({
      rows,
      friends,
      visibleFriendIds: ['friend-visible'],
      supportCases: [
        {
          id: 'case-visible',
          line_account_id: 'acc-1',
          friend_id: 'friend-visible',
          title: '報酬反映の確認',
          status: 'waiting_secondary',
        },
      ],
    });
    dbMocks.getChatById.mockResolvedValue({
      id: 'chat-visible',
      friend_id: 'friend-visible',
      operator_id: null,
      status: 'in_progress',
      notes: null,
      last_message_at: '2026-06-12T10:00:00.000',
      created_at: '2026-06-12T09:00:00.000',
      updated_at: '2026-06-12T10:00:00.000',
    });
    dbMocks.getFriendById.mockImplementation(async (_db: D1Database, id: string) =>
      friends.find((friend) => friend.id === id) ?? null,
    );

    const res = await setupApp(db, 'owner').request('/api/chats/friend-visible/send/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: '確認して折り返します。',
        supportCaseId: 'case-visible',
        lineAccountId: 'acc-1',
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { valid: boolean; supportCaseId: string; supportCaseStatus: string };
    };
    expect(body).toMatchObject({
      success: true,
      data: {
        valid: true,
        supportCaseId: 'case-visible',
        supportCaseStatus: 'waiting_secondary',
      },
    });
    expect(lineSdkMocks.pushTextMessage).not.toHaveBeenCalled();
    expect(dbMocks.updateChat).not.toHaveBeenCalled();
    expect(state.messages).toHaveLength(0);
    expect(state.supportEvents).toHaveLength(0);
    expect(state.supportCases.at(-1)).toMatchObject({ id: 'case-visible', status: 'waiting_secondary' });
  });

  test('support reply validation does not lazy-create chats when only the friend exists', async () => {
    const { db, calls, state } = makeChatDb({
      rows: [],
      friends: [friends[0]],
      visibleFriendIds: ['friend-visible'],
    });
    dbMocks.getChatById.mockResolvedValue(null);
    dbMocks.getFriendById.mockImplementation(async (_db: D1Database, id: string) =>
      friends.find((friend) => friend.id === id) ?? null,
    );

    const res = await setupApp(db, 'owner').request('/api/chats/friend-visible/send/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '送信前確認だけ行う' }),
    });

    expect(res.status).toBe(200);
    expect(calls.some((call) => call.method === 'run' && call.sql.includes('INSERT INTO chats'))).toBe(false);
    expect(lineSdkMocks.pushTextMessage).not.toHaveBeenCalled();
    expect(dbMocks.updateChat).not.toHaveBeenCalled();
    expect(state.messages).toHaveLength(0);
    expect(state.supportEvents).toHaveLength(0);
  });

  test('support reply send is rejected before LINE push when the case is not tied to the chat friend', async () => {
    const { db, state } = makeChatDb({
      rows,
      friends,
      visibleFriendIds: ['friend-visible'],
      supportCases: [
        {
          id: 'case-hidden',
          line_account_id: 'acc-1',
          friend_id: 'friend-hidden',
          title: '別友だちの案件',
          status: 'waiting_secondary',
        },
      ],
    });
    dbMocks.getChatById.mockResolvedValue({
      id: 'chat-visible',
      friend_id: 'friend-visible',
      operator_id: null,
      status: 'in_progress',
      notes: null,
      last_message_at: '2026-06-12T10:00:00.000',
      created_at: '2026-06-12T09:00:00.000',
      updated_at: '2026-06-12T10:00:00.000',
    });
    dbMocks.getFriendById.mockImplementation(async (_db: D1Database, id: string) =>
      friends.find((friend) => friend.id === id) ?? null,
    );
    dbMocks.getLineAccountById.mockResolvedValue({ channel_access_token: 'account-token' });

    const res = await setupApp(db, 'owner').request('/api/chats/friend-visible/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: '別案件へ誤記録したい',
        supportCaseId: 'case-hidden',
        lineAccountId: 'acc-1',
      }),
    });

    expect(res.status).toBe(404);
    expect(lineSdkMocks.pushTextMessage).not.toHaveBeenCalled();
    expect(state.messages).toHaveLength(0);
    expect(state.supportEvents).toHaveLength(0);
  });

  test('resolved support reply send is rejected before LINE push until the case is reopened', async () => {
    const { db, state } = makeChatDb({
      rows,
      friends,
      visibleFriendIds: ['friend-visible'],
      supportCases: [
        {
          id: 'case-resolved',
          line_account_id: 'acc-1',
          friend_id: 'friend-visible',
          title: '完了済み案件',
          status: 'resolved',
        },
      ],
    });
    dbMocks.getChatById.mockResolvedValue({
      id: 'chat-visible',
      friend_id: 'friend-visible',
      operator_id: null,
      status: 'in_progress',
      notes: null,
      last_message_at: '2026-06-12T10:00:00.000',
      created_at: '2026-06-12T09:00:00.000',
      updated_at: '2026-06-12T10:00:00.000',
    });
    dbMocks.getFriendById.mockImplementation(async (_db: D1Database, id: string) =>
      friends.find((friend) => friend.id === id) ?? null,
    );
    dbMocks.getLineAccountById.mockResolvedValue({ channel_access_token: 'account-token' });

    const res = await setupApp(db, 'owner').request('/api/chats/friend-visible/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: '完了済みへ誤送信したい',
        supportCaseId: 'case-resolved',
        lineAccountId: 'acc-1',
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain('再オープン');
    expect(lineSdkMocks.pushTextMessage).not.toHaveBeenCalled();
    expect(dbMocks.updateChat).not.toHaveBeenCalled();
    expect(state.messages).toHaveLength(0);
    expect(state.supportEvents).toHaveLength(0);
    expect(state.supportCases.at(-1)).toMatchObject({ id: 'case-resolved', status: 'resolved' });
  });

  test('resolved support reply validation is rejected without LINE push', async () => {
    const { db, state } = makeChatDb({
      rows,
      friends,
      visibleFriendIds: ['friend-visible'],
      supportCases: [
        {
          id: 'case-resolved',
          line_account_id: 'acc-1',
          friend_id: 'friend-visible',
          title: '完了済み案件',
          status: 'resolved',
        },
      ],
    });
    dbMocks.getChatById.mockResolvedValue({
      id: 'chat-visible',
      friend_id: 'friend-visible',
      operator_id: null,
      status: 'in_progress',
      notes: null,
      last_message_at: '2026-06-12T10:00:00.000',
      created_at: '2026-06-12T09:00:00.000',
      updated_at: '2026-06-12T10:00:00.000',
    });
    dbMocks.getFriendById.mockImplementation(async (_db: D1Database, id: string) =>
      friends.find((friend) => friend.id === id) ?? null,
    );

    const res = await setupApp(db, 'owner').request('/api/chats/friend-visible/send/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: '完了済みへ誤送信したい',
        supportCaseId: 'case-resolved',
        lineAccountId: 'acc-1',
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain('再オープン');
    expect(lineSdkMocks.pushTextMessage).not.toHaveBeenCalled();
    expect(dbMocks.updateChat).not.toHaveBeenCalled();
    expect(state.messages).toHaveLength(0);
    expect(state.supportEvents).toHaveLength(0);
    expect(state.supportCases.at(-1)).toMatchObject({ id: 'case-resolved', status: 'resolved' });
  });
});

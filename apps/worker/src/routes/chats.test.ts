import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

const lineSdkMocks = vi.hoisted(() => {
  const mocks = {
    LineClient: vi.fn(),
    pushTextMessage: vi.fn(),
    pushFlexMessage: vi.fn(),
    pushImageMessage: vi.fn(),
  };
  mocks.LineClient.mockImplementation(() => ({
    pushTextMessage: mocks.pushTextMessage,
    pushFlexMessage: mocks.pushFlexMessage,
    pushImageMessage: mocks.pushImageMessage,
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
  Bindings: { DB: D1Database; LINE_CHANNEL_ACCESS_TOKEN: string };
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
  delivery_type?: string | null;
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
            const [id, friendId, messageType, content] = bound as string[];
            const createdAt = bound[5] as string;
            messages.push({
              id,
              friend_id: friendId,
              direction: 'outgoing',
              message_type: messageType,
              content,
              created_at: createdAt,
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

function setupApp(db: D1Database, role: 'owner' | 'admin' | 'staff' = 'staff') {
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'staff-1', name: '田島', role });
    c.env = { DB: db, LINE_CHANNEL_ACCESS_TOKEN: 'fallback-token' };
    await next();
  });
  app.route('/', chats);
  return app;
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
    expect(lineSdkMocks.LineClient).toHaveBeenCalledWith('account-token');
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

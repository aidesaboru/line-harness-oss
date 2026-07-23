import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import type { ScheduledChatMessageRow } from '../services/scheduled-chat-messages.js';

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

const followerSyncMocks = vi.hoisted(() => ({
  syncFollowerPage: vi.fn(),
}));

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
  getLineConversationById: vi.fn(),
  insertLineConversationMessage: vi.fn(),
  updateChat: vi.fn(),
  jstNow: vi.fn(() => '2026-06-12T10:00:00.000'),
};
vi.mock('@line-crm/db', () => dbMocks);
vi.mock('@line-crm/line-sdk', () => ({ LineClient: lineSdkMocks.LineClient }));
vi.mock('../services/follower-sync.js', () => followerSyncMocks);

const { chats } = await import('./chats.js');

type TestEnv = {
  Variables: { staff: { id: string; name: string; role: 'owner' | 'admin' | 'staff' | 'secondary' } };
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
  marked_as_read_at?: string | null;
  marked_as_read_by?: string | null;
  line_message_id?: string | null;
  quote_token?: string | null;
  quoted_message_id?: string | null;
  deleted_at?: string | null;
  deleted_reason?: string | null;
  sent_by_staff_id?: string | null;
  sent_by_staff_name?: string | null;
};

type LineConversationMessageRow = {
  id: string;
  conversation_id: string;
  direction: 'incoming' | 'outgoing';
  message_type: string;
  content: string;
  source: 'group' | 'room';
  quote_token?: string | null;
  mark_as_read_token?: string | null;
  marked_as_read_at?: string | null;
  marked_as_read_by?: string | null;
  quoted_message_id?: string | null;
  sent_by_staff_id?: string | null;
  sent_by_staff_name?: string | null;
  sender_user_id: string | null;
  sender_name: string | null;
  sender_picture_url: string | null;
  deleted_at: string | null;
  deleted_reason: string | null;
  created_at: string;
};

type OptionalChatTableName =
  | 'chat_confirmation_events'
  | 'chat_reminder_completion_events'
  | 'line_conversations'
  | 'line_conversation_messages';

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

type ChatInternalMessageRow = {
  id: string;
  friend_id: string;
  line_account_id: string | null;
  parent_id: string | null;
  body: string;
  mentions: string;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
};

function makeChatDb(state: {
  rows: ChatListRow[];
  friends: FriendRow[];
  visibleFriendIds: string[];
  messages?: MessageRow[];
  supportCases?: SupportCaseRow[];
  supportEvents?: SupportEventRow[];
  chatInternalMessages?: ChatInternalMessageRow[];
  scheduledMessages?: ScheduledChatMessageRow[];
  lineConversations?: Array<Record<string, unknown>>;
  lineConversationMessages?: LineConversationMessageRow[];
  missingTables?: OptionalChatTableName[];
}) {
  const calls: Array<{ method: 'first' | 'all' | 'run'; sql: string; binds: unknown[] }> = [];
  const visible = new Set(state.visibleFriendIds);
  const messages = state.messages ?? [];
  const supportCases = state.supportCases ?? [];
  const supportEvents = state.supportEvents ?? [];
  const chatInternalMessages = state.chatInternalMessages ?? [];
  const scheduledMessages = state.scheduledMessages ?? [];
  const lineConversations = state.lineConversations ?? [];
  const lineConversationMessages = state.lineConversationMessages ?? [];
  const missingTables = new Set(state.missingTables ?? []);

  const db = {
    prepare(sql: string) {
      if (!sql.includes('FROM sqlite_master')) {
        const missingTable = [...missingTables].find((table) => (
          new RegExp(`\\b${table}\\b`).test(sql)
        ));
        if (missingTable) throw new Error(`no such table: ${missingTable}`);
      }
      let bound: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          bound = args;
          return stmt;
        },
        async first<T>() {
          calls.push({ method: 'first', sql, binds: bound });
          if (sql.includes('FROM messages_log ml') && sql.includes('LEFT JOIN friends f')) {
            const [messageId] = bound as [string];
            const row = messages.find((message) => message.id === messageId);
            if (!row) return null as T | null;
            const friend = state.friends.find((item) => item.id === row.friend_id);
            return {
              id: row.id,
              friend_id: row.friend_id,
              message_type: row.message_type,
              content: row.content,
              line_account_id: (row as MessageRow & { line_account_id?: string | null }).line_account_id ?? null,
              friend_line_account_id: friend?.line_account_id ?? null,
            } as T;
          }
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
          if (sql.includes('FROM chat_internal_messages') && sql.includes('WHERE id = ? AND friend_id = ?')) {
            const [messageId, friendId] = bound as [string, string];
            const row = chatInternalMessages.find((item) => item.id === messageId && item.friend_id === friendId);
            return (row ? { id: row.id } : null) as T | null;
          }
          if (sql.includes('FROM chat_internal_messages') && sql.includes('WHERE id = ?')) {
            const [messageId] = bound as [string];
            return (chatInternalMessages.find((item) => item.id === messageId) ?? null) as T | null;
          }
          if (sql.includes('SELECT id, mark_as_read_token, marked_as_read_at')) {
            const [sourceId] = bound as [string];
            const row = sql.includes('FROM line_conversation_messages')
              ? lineConversationMessages
                .filter((message) => (
                  message.conversation_id === sourceId
                  && message.direction === 'incoming'
                ))
                .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))[0]
              : messages
                .filter((message) => (
                  message.friend_id === sourceId &&
                  message.direction === 'incoming'
                ))
                .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))[0];
            return (row ? {
              id: row.id,
              mark_as_read_token: row.mark_as_read_token ?? null,
              marked_as_read_at: row.marked_as_read_at ?? null,
            } : null) as T | null;
          }
          if (sql.includes('SELECT id, created_at') && sql.includes('direction = \'incoming\'')) {
            const [sourceId] = bound as [string];
            const row = sql.includes('FROM line_conversation_messages')
              ? lineConversationMessages
                .filter((message) => (
                  message.conversation_id === sourceId
                  && message.direction === 'incoming'
                  && !message.deleted_at
                ))
                .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))[0]
              : messages
                .filter((message) => (
                  message.friend_id === sourceId
                  && message.direction === 'incoming'
                  && message.message_type !== 'postback'
                  && !message.deleted_at
                ))
                .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))[0];
            return (row ? { id: row.id, created_at: row.created_at } : null) as T | null;
          }
          if (sql.includes('SELECT id, friend_id, direction, deleted_at')) {
            const [messageId, friendId] = bound as [string, string];
            const row = messages.find((message) => (
              message.id === messageId &&
              message.friend_id === friendId &&
              (message.delivery_type === undefined || message.delivery_type === null || message.delivery_type !== 'test')
            ));
            return (row ? {
              id: row.id,
              friend_id: row.friend_id,
              direction: row.direction,
              deleted_at: row.deleted_at ?? null,
            } : null) as T | null;
          }
          if (sql.includes('SELECT id, direction, quote_token, deleted_at')) {
            const [messageId, sourceId] = bound as [string, string];
            const row = sql.includes('FROM line_conversation_messages')
              ? lineConversationMessages.find((message) => (
                message.id === messageId
                && message.conversation_id === sourceId
              ))
              : messages.find((message) => (
                message.id === messageId &&
                message.friend_id === sourceId &&
                (message.delivery_type === undefined || message.delivery_type === null || message.delivery_type !== 'test')
              ));
            return (row ? {
              id: row.id,
              direction: row.direction,
              quote_token: row.quote_token ?? null,
              deleted_at: row.deleted_at ?? null,
            } : null) as T | null;
          }
          if (sql.startsWith('SELECT * FROM scheduled_chat_messages WHERE id = ?')) {
            const [messageId] = bound as [string];
            return (scheduledMessages.find((message) => message.id === messageId) ?? null) as T | null;
          }
          return null as T | null;
        },
        async all<T>() {
          calls.push({ method: 'all', sql, binds: bound });
          if (sql.includes('FROM sqlite_master')) {
            const results = (bound as OptionalChatTableName[])
              .filter((name) => !missingTables.has(name))
              .map((name) => ({ name }));
            return { results } as { results: T[] };
          }
          if (sql.includes('FROM line_conversations lc')) {
            return { results: lineConversations } as { results: T[] };
          }
          if (sql.includes('FROM line_conversation_messages') && sql.includes('sender_user_id')) {
            const conversationId = bound[0] as string;
            const limit = Number(bound.at(-1) ?? 1000);
            const rows = lineConversationMessages
              .filter((message) => message.conversation_id === conversationId)
              .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
            return { results: rows.slice(0, limit) } as { results: T[] };
          }
          if (sql.includes('FROM deduped d')) {
            let rows = sql.includes('support_cases sc_friend_scope')
              ? state.rows.filter((row) => visible.has(row.friend_id))
              : state.rows;
            if (sql.includes("f.display_name LIKE ? ESCAPE '\\'")) {
              const pattern = String(bound.at(-1) ?? '');
              const needle = pattern
                .replace(/^%/, '')
                .replace(/%$/, '')
                .replace(/\\([\\%_])/g, '$1')
                .toLowerCase();
              rows = rows.filter((row) => [
                row.display_name,
                row.line_user_id,
                row.last_message_content,
                row.notes,
              ].some((value) => String(value ?? '').toLowerCase().includes(needle)));
            }
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
          if (sql.includes('FROM chat_internal_messages')) {
            const [friendId] = bound as [string];
            const rows = chatInternalMessages
              .filter((item) => item.friend_id === friendId)
              .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
            return { results: rows } as { results: T[] };
          }
          if (sql.includes('FROM scheduled_chat_messages')) {
            const [chatId] = bound as [string];
            return {
              results: scheduledMessages.filter((message) => message.chat_id === chatId),
            } as { results: T[] };
          }
          return { results: [] } as { results: T[] };
        },
        async run() {
          calls.push({ method: 'run', sql, binds: bound });
          let changes = 1;
          if (/INSERT(?: OR IGNORE)? INTO messages_log/.test(sql)) {
            const [id, friendId] = bound as string[];
            const isExternalOutgoing = sql.includes("'line_official'");
            const hasLineMessageId = sql.includes('line_message_id');
            const hasQuoteColumns = sql.includes('quote_token') || sql.includes('quoted_message_id');
            const hasSenderColumns = sql.includes('sent_by_staff_id') || sql.includes('sent_by_staff_name');
            const messageType = isExternalOutgoing ? 'text' : bound[2] as string;
            const content = isExternalOutgoing ? bound[2] as string : bound[3] as string;
            const lineMessageId = !isExternalOutgoing && hasLineMessageId ? bound[5] as string | null : null;
            const quoteToken = !isExternalOutgoing && hasQuoteColumns ? bound[6] as string | null : null;
            const quotedMessageId = !isExternalOutgoing && hasQuoteColumns ? bound[7] as string | null : null;
            const sentByStaffId = !isExternalOutgoing && hasSenderColumns
              ? (hasQuoteColumns ? bound[8] : bound[6]) as string | null
              : null;
            const sentByStaffName = !isExternalOutgoing && hasSenderColumns
              ? (hasQuoteColumns ? bound[9] : bound[7]) as string | null
              : null;
            const createdAt = (isExternalOutgoing
              ? bound[4]
              : hasSenderColumns
                ? (hasQuoteColumns ? bound[10] : bound[8])
                : (hasQuoteColumns ? bound[8] : (hasLineMessageId ? bound[6] : bound[5]))) as string;
            messages.push({
              id,
              friend_id: friendId,
              direction: 'outgoing',
              message_type: messageType,
              content,
              created_at: createdAt,
              source: isExternalOutgoing ? 'line_official' : 'manual',
              line_message_id: lineMessageId,
              quote_token: quoteToken,
              quoted_message_id: quotedMessageId,
              sent_by_staff_id: sentByStaffId,
              sent_by_staff_name: sentByStaffName,
            });
          } else if (sql.includes('UPDATE messages_log') && sql.includes('deleted_at')) {
            const [deletedAt, messageId, friendId] = bound as [string, string, string];
            const row = messages.find((message) => message.id === messageId && message.friend_id === friendId);
            if (row && !row.deleted_at) {
              row.deleted_at = deletedAt;
              row.deleted_reason = 'manual_unsend_reflection';
            } else {
              changes = 0;
            }
          } else if (sql.includes('UPDATE messages_log') && sql.includes('marked_as_read_at')) {
            const [markedAt, markedBy, messageId] = bound as [string, string | null, string];
            const row = messages.find((message) => message.id === messageId);
            if (row) {
              row.marked_as_read_at = markedAt;
              row.marked_as_read_by = markedBy;
            } else {
              changes = 0;
            }
          } else if (/INSERT(?: OR IGNORE)? INTO support_case_events/.test(sql)) {
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
          } else if (sql.includes('INSERT INTO chat_internal_messages')) {
            const [id, friendId, lineAccountId, parentId, body, mentions, createdBy, createdByName, createdAt] = bound as string[];
            chatInternalMessages.push({
              id,
              friend_id: friendId,
              line_account_id: lineAccountId ?? null,
              parent_id: parentId ?? null,
              body,
              mentions,
              created_by: createdBy,
              created_by_name: createdByName,
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
          } else if (sql.includes('INSERT INTO scheduled_chat_messages')) {
            const [
              id,
              chatId,
              friendId,
              lineAccountId,
              messagesJson,
              supportCaseId,
              scheduledAt,
              nextAttemptAt,
              createdBy,
              createdByName,
              createdAt,
              updatedAt,
            ] = bound as string[];
            scheduledMessages.push({
              id,
              chat_id: chatId,
              friend_id: friendId,
              line_account_id: lineAccountId ?? null,
              messages_json: messagesJson,
              support_case_id: supportCaseId ?? null,
              scheduled_at: scheduledAt,
              next_attempt_at: nextAttemptAt,
              status: 'pending',
              attempts: 0,
              last_error: null,
              created_by: createdBy ?? null,
              created_by_name: createdByName ?? null,
              sent_at: null,
              cancelled_at: null,
              created_at: createdAt,
              updated_at: updatedAt,
            });
          }
          return { success: true, meta: { changes } };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;

  return { db, calls, state: { messages, supportCases, supportEvents, chatInternalMessages, scheduledMessages } };
}

function setupApp(
  db: D1Database,
  role: 'owner' | 'admin' | 'staff' | 'secondary' = 'staff',
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
  vi.unstubAllGlobals();
  for (const fn of Object.values(dbMocks)) fn.mockReset();
  dbMocks.jstNow.mockReturnValue('2026-06-12T10:00:00.000');
  lineSdkMocks.LineClient.mockClear();
  lineSdkMocks.pushTextMessage.mockReset().mockResolvedValue(undefined);
  lineSdkMocks.pushFlexMessage.mockReset().mockResolvedValue(undefined);
  lineSdkMocks.pushImageMessage.mockReset().mockResolvedValue(undefined);
  lineSdkMocks.markMessagesAsRead.mockReset().mockResolvedValue(undefined);
  followerSyncMocks.syncFollowerPage.mockReset();
  dbMocks.getLineConversationById.mockResolvedValue(null);
  dbMocks.insertLineConversationMessage.mockResolvedValue(true);
  dbMocks.getFriendById.mockImplementation(async (_db: D1Database, id: string) =>
    friends.find((friend) => friend.id === id) ?? null,
  );
});

describe('chat support visibility', () => {
  test('staff chat list includes individual chats in the selected account', async () => {
    const { db, calls } = makeChatDb({ rows, friends, visibleFriendIds: ['friend-visible'] });

    const res = await setupApp(db, 'staff').request('/api/chats?lineAccountId=acc-1');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: Array<{ id: string; friendName: string }> };
    expect(body.success).toBe(true);
    expect(body.data.map((item) => item.id)).toEqual(['friend-visible', 'friend-hidden']);
    const listCall = calls.find((call) => call.method === 'all' && call.sql.includes('FROM deduped d'));
    expect(listCall?.sql).not.toContain('support_cases sc_friend_scope');
    expect(listCall?.sql).toContain("sc.status != 'resolved'");
    expect(listCall?.sql).not.toContain("sc.status != 'resolved' AND (sc.status IN");
    expect(listCall?.sql).toContain('FROM friends');
    expect(listCall?.sql).toContain('WHERE is_following = 1');
    expect(listCall?.sql).toContain('SELECT friend_id, MAX(created_at) AS last_message_at');
    expect(listCall?.sql).toContain('ORDER BY d.last_message_at DESC');
  });

  test('chat list includes LINE group conversations without treating them as customers', async () => {
    const { db } = makeChatDb({
      rows,
      friends,
      visibleFriendIds: friends.map((friend) => friend.id),
      lineConversations: [{
        id: 'conversation-group-1',
        source_type: 'group',
        display_name: 'ECオーナー連絡グループ',
        picture_url: 'https://example.com/group.png',
        last_message_at: '2026-06-12T12:00:00.000',
        status: 'unread',
        last_message_content: '銀行名はりそな銀行です',
        last_message_direction: 'incoming',
        last_message_type: 'text',
        created_at: '2026-06-12T08:00:00.000',
        updated_at: '2026-06-12T12:00:00.000',
      }],
    });

    const res = await setupApp(db, 'staff').request('/api/chats?lineAccountId=account-1');
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<Record<string, unknown>> };
    expect(body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'conversation-group-1',
        conversationType: 'group',
        friendName: 'ECオーナー連絡グループ',
        status: 'unread',
        needsReply: true,
        activeSupportCase: null,
      }),
    ]));
  });

  test('chat list keeps individual chats available when optional chat tables are missing', async () => {
    const { db, calls } = makeChatDb({
      rows,
      friends,
      visibleFriendIds: ['friend-visible'],
      missingTables: [
        'chat_confirmation_events',
        'chat_reminder_completion_events',
        'line_conversations',
        'line_conversation_messages',
      ],
    });

    const res = await setupApp(db, 'staff').request('/api/chats?lineAccountId=acc-1');

    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: Array<{ id: string; conversationType: string; isConfirmed: boolean }>;
    };
    expect(body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'friend-visible',
        conversationType: 'user',
        isConfirmed: false,
      }),
    ]));
    const schemaCall = calls.find((call) => call.sql.includes('FROM sqlite_master'));
    expect(schemaCall?.binds).toEqual([
      'chat_confirmation_events',
      'chat_reminder_completion_events',
      'line_conversations',
      'line_conversation_messages',
    ]);
    const individualListCall = calls.find((call) => call.sql.includes('FROM deduped d'));
    expect(individualListCall?.sql).not.toContain('FROM chat_confirmation_events');
    expect(calls.some((call) => call.sql.includes('FROM line_conversations lc'))).toBe(false);
  });

  test('syncs a page of current LINE followers without removing existing history', async () => {
    const { db, calls } = makeChatDb({ rows, friends, visibleFriendIds: ['friend-visible'] });
    dbMocks.getLineAccountById.mockResolvedValue({
      id: 'acc-1',
      is_active: 1,
      channel_access_token: 'account-token',
    });
    followerSyncMocks.syncFollowerPage.mockResolvedValue({
      fetched: 2,
      created: 1,
      updated: 1,
      profileFailures: 0,
      next: null,
    });

    const res = await setupApp(db, 'admin').request('/api/chats/sync-followers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lineAccountId: 'acc-1' }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      success: true,
      data: { fetched: 2, created: 1, updated: 1, next: null },
    });
    expect(followerSyncMocks.syncFollowerPage).toHaveBeenCalledWith(
      db,
      expect.any(Object),
      'acc-1',
      undefined,
    );
    expect(calls.every((call) => !call.sql.includes('DELETE'))).toBe(true);
  });

  test('limits full follower reconciliation to owners and admins', async () => {
    const { db } = makeChatDb({ rows, friends, visibleFriendIds: ['friend-visible'] });

    const res = await setupApp(db, 'staff').request('/api/chats/sync-followers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lineAccountId: 'acc-1' }),
    });

    expect(res.status).toBe(403);
    expect(followerSyncMocks.syncFollowerPage).not.toHaveBeenCalled();
  });

  test('chat list searches by customer name and latest message', async () => {
    const { db, calls } = makeChatDb({ rows, friends, visibleFriendIds: ['friend-visible'] });

    const res = await setupApp(db, 'owner').request('/api/chats?q=%20%E9%9A%A0%E3%82%8C%E3%82%8B%20');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string; friendName: string }> };
    expect(body.data.map((item) => item.id)).toEqual(['friend-hidden']);

    const listCall = calls.find((call) => call.method === 'all' && call.sql.includes('FROM deduped d'));
    expect(listCall?.sql).toContain("f.display_name LIKE ? ESCAPE '\\'");
    expect(listCall?.sql).toContain("rm.content LIKE ? ESCAPE '\\'");
    expect(listCall?.binds).toEqual(['staff-1', ...Array.from({ length: 13 }, () => '%隠れる%')]);
  });

  test('owner chat list remains unrestricted', async () => {
    const { db } = makeChatDb({ rows, friends, visibleFriendIds: ['friend-visible'] });

    const res = await setupApp(db, 'owner').request('/api/chats?lineAccountId=acc-1');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((item) => item.id)).toEqual(['friend-visible', 'friend-hidden']);
  });

  test('staff can open an existing individual chat by URL', async () => {
    const { db } = makeChatDb({ rows, friends, visibleFriendIds: ['friend-visible'] });
    dbMocks.getChatById.mockResolvedValue(null);

    const hidden = await setupApp(db, 'staff').request('/api/chats/friend-hidden');
    expect(hidden.status).toBe(200);

    const allowed = await setupApp(db, 'staff').request('/api/chats/friend-visible');
    expect(allowed.status).toBe(200);
  });

  test('secondary-only staff cannot access individual LINE chats', async () => {
    const { db, calls } = makeChatDb({ rows, friends, visibleFriendIds: ['friend-visible'] });
    dbMocks.getChatById.mockResolvedValue(null);

    const listRes = await setupApp(db, 'secondary').request('/api/chats?lineAccountId=acc-1');
    expect(listRes.status).toBe(403);
    await expect(listRes.json()).resolves.toMatchObject({
      success: false,
      error: '二次対応専用権限では顧客チャットを閲覧できません',
    });

    const detailRes = await setupApp(db, 'secondary').request('/api/chats/friend-visible');
    expect(detailRes.status).toBe(404);

    const listCall = calls.find((call) => call.method === 'all' && call.sql.includes('FROM deduped d'));
    expect(listCall).toBeUndefined();
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

    const messageCalls = calls.filter((call) => (
      call.method === 'all'
      && call.sql.includes('SELECT id, friend_id, direction, message_type, content')
    ));
    expect(messageCalls[0].binds).toEqual(['friend-visible', 3]);
    expect(messageCalls[1].binds).toEqual([
      'friend-visible',
      '2026-06-12T09:02:00.000',
      '2026-06-12T09:02:00.000',
      'msg-3',
      3,
    ]);
  });

  test('chat detail keeps an individual chat available when optional chat tables are missing', async () => {
    const { db, calls } = makeChatDb({
      rows,
      friends,
      visibleFriendIds: ['friend-visible'],
      messages: [{
        id: 'msg-existing',
        friend_id: 'friend-visible',
        direction: 'incoming',
        message_type: 'text',
        content: '既存の個別チャットです',
        created_at: '2026-06-12T09:00:00.000',
      }],
      missingTables: [
        'chat_confirmation_events',
        'chat_reminder_completion_events',
        'line_conversations',
        'line_conversation_messages',
      ],
    });
    dbMocks.getChatById.mockResolvedValue(null);

    const res = await setupApp(db, 'staff').request('/api/chats/friend-visible');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      success: true,
      data: {
        id: 'friend-visible',
        conversationType: 'user',
        isConfirmed: false,
        confirmedMessageAt: null,
        messages: [expect.objectContaining({ id: 'msg-existing' })],
      },
    });
    expect(dbMocks.getLineConversationById).not.toHaveBeenCalled();
    expect(calls.some((call) => (
      !call.sql.includes('FROM sqlite_master')
      && /\b(chat_confirmation_events|chat_reminder_completion_events|line_conversations|line_conversation_messages)\b/.test(call.sql)
    ))).toBe(false);
  });

  test('records every reminder completion press as a new append-only event', async () => {
    const { db, calls } = makeChatDb({
      rows,
      friends,
      visibleFriendIds: ['friend-visible'],
      messages: [{
        id: 'incoming-reminder-1',
        friend_id: 'friend-visible',
        direction: 'incoming',
        message_type: 'text',
        content: '確認をお願いします',
        created_at: '2026-06-12T09:30:00.000',
      }],
    });
    dbMocks.getChatById.mockResolvedValue(null);

    const first = await setupApp(db, 'staff').request('/api/chats/friend-visible/confirm', {
      method: 'POST',
    });
    const second = await setupApp(db, 'staff').request('/api/chats/friend-visible/confirm', {
      method: 'POST',
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      success: true,
      data: {
        isConfirmed: true,
        confirmedMessageId: 'incoming-reminder-1',
        confirmedMessageAt: '2026-06-12T09:30:00.000',
        confirmedAt: '2026-06-12T10:00:00.000',
      },
    });
    const inserts = calls.filter((call) => (
      call.method === 'run'
      && call.sql.includes('INSERT INTO chat_reminder_completion_events')
    ));
    expect(inserts).toHaveLength(2);
    expect(inserts[0].binds.slice(1)).toEqual([
      'friend-visible',
      null,
      'staff-1',
      '田島',
      'incoming-reminder-1',
      '2026-06-12T09:30:00.000',
      '2026-06-12T10:00:00.000',
    ]);
    expect(inserts[0].binds[0]).not.toBe(inserts[1].binds[0]);
  });

  test('group chat detail returns sender names without customer-only data', async () => {
    dbMocks.getLineConversationById.mockResolvedValue({
      id: 'conversation-group-1',
      line_account_id: 'account-1',
      source_type: 'group',
      source_id: 'Cgroup1',
      display_name: 'ECオーナー連絡グループ',
      picture_url: 'https://example.com/group.png',
      last_message_at: '2026-06-12T12:00:00.000',
      status: 'unread',
      created_at: '2026-06-12T08:00:00.000',
      updated_at: '2026-06-12T12:00:00.000',
    });
    const { db } = makeChatDb({
      rows,
      friends,
      visibleFriendIds: friends.map((friend) => friend.id),
      lineConversationMessages: [{
        id: 'group-message-1',
        conversation_id: 'conversation-group-1',
        direction: 'incoming',
        message_type: 'text',
        content: '銀行名はりそな銀行です',
        source: 'group',
        sender_user_id: 'Ugroupmember',
        sender_name: '中田 匠',
        sender_picture_url: 'https://example.com/member.png',
        deleted_at: null,
        deleted_reason: null,
        created_at: '2026-06-12T12:00:00.000',
      }],
    });

    const res = await setupApp(db, 'staff').request('/api/chats/conversation-group-1');
    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: {
        conversationType: string;
        activeSupportCase: unknown;
        internalMessages: unknown[];
        messages: Array<Record<string, unknown>>;
      };
    };
    expect(body.data).toMatchObject({
      conversationType: 'group',
      status: 'unread',
      needsReply: true,
      activeSupportCase: null,
      internalMessages: [],
    });
    expect(body.data.messages[0]).toMatchObject({
      content: '銀行名はりそな銀行です',
      incomingSenderUserId: 'Ugroupmember',
      incomingSenderName: '中田 匠',
      incomingSenderPictureUrl: 'https://example.com/member.png',
      canQuote: false,
    });
  });

  test('group chat status can be marked as resolved', async () => {
    dbMocks.getLineConversationById.mockResolvedValue({
      id: 'conversation-group-1',
      line_account_id: 'account-1',
      source_type: 'group',
      source_id: 'Cgroup1',
      display_name: 'ECオーナー連絡グループ',
      picture_url: 'https://example.com/group.png',
      last_message_at: '2026-06-12T12:00:00.000',
      status: 'unread',
      created_at: '2026-06-12T08:00:00.000',
      updated_at: '2026-06-12T12:00:00.000',
    });
    const { db, calls } = makeChatDb({
      rows,
      friends,
      visibleFriendIds: friends.map((friend) => friend.id),
    });

    const res = await setupApp(db, 'staff').request('/api/chats/conversation-group-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'resolved' }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      success: true,
      data: {
        id: 'conversation-group-1',
        conversationType: 'group',
        status: 'resolved',
      },
    });
    expect(calls).toContainEqual(expect.objectContaining({
      method: 'run',
      sql: expect.stringContaining('SET workflow_status = ?'),
      binds: [
        'resolved',
        'resolved',
        '2026-06-12T10:00:00.000',
        'conversation-group-1',
      ],
    }));
  });

  test('staff can send a message to a LINE group and records it after LINE accepts it', async () => {
    dbMocks.getLineConversationById.mockResolvedValue({
      id: 'conversation-group-1',
      line_account_id: 'account-1',
      source_type: 'group',
      source_id: 'Cgroup1',
      display_name: 'ECオーナー連絡グループ',
      picture_url: null,
      last_message_at: '2026-06-12T12:00:00.000',
      status: 'unread',
      created_at: '2026-06-12T08:00:00.000',
      updated_at: '2026-06-12T12:00:00.000',
    });
    dbMocks.getLineAccountById.mockResolvedValue({ channel_access_token: 'group-account-token' });
    lineSdkMocks.pushTextMessage.mockResolvedValueOnce({
      sentMessages: [{ id: 'line-group-message-1', quoteToken: 'line-group-quote-1' }],
    });
    const { db } = makeChatDb({
      rows,
      friends,
      visibleFriendIds: friends.map((friend) => friend.id),
    });
    const idempotencyKey = '33333333-3333-4333-8333-333333333333';

    const res = await setupApp(db, 'staff', {
      LINE_CAPTURE_ONLY: '1',
      LINE_MANUAL_SEND_ENABLED: '1',
    }).request('/api/chats/conversation-group-1/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        content: 'グループへ返信します。',
        markAsRead: false,
      }),
    });

    expect(res.status).toBe(200);
    expect(lineSdkMocks.LineClient).toHaveBeenCalledWith('group-account-token', {
      allowMutationsWhenDisabled: true,
    });
    expect(lineSdkMocks.pushTextMessage).toHaveBeenCalledWith(
      'Cgroup1',
      'グループへ返信します。',
      undefined,
      idempotencyKey,
    );
    expect(dbMocks.insertLineConversationMessage).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        id: idempotencyKey,
        conversationId: 'conversation-group-1',
        direction: 'outgoing',
        messageType: 'text',
        content: 'グループへ返信します。',
        source: 'manual',
        lineAccountId: 'account-1',
        lineMessageId: 'line-group-message-1',
        quoteToken: 'line-group-quote-1',
        senderName: '田島',
      }),
    );
    await expect(res.json()).resolves.toMatchObject({
      success: true,
      data: {
        sent: true,
        messageId: idempotencyKey,
        sentByStaffId: 'staff-1',
        sentByStaffName: '田島',
        supportCase: null,
        markAsRead: {
          requested: false,
          marked: false,
          reason: 'not_requested',
        },
      },
    });
  });

  test('staff can mark the latest LINE group message as read', async () => {
    dbMocks.getLineConversationById.mockResolvedValue({
      id: 'conversation-group-1',
      line_account_id: 'account-1',
      source_type: 'group',
      source_id: 'Cgroup1',
      display_name: 'ECオーナー連絡グループ',
      picture_url: null,
      last_message_at: '2026-06-12T12:00:00.000',
      status: 'unread',
      workflow_status: 'unread',
      created_at: '2026-06-12T08:00:00.000',
      updated_at: '2026-06-12T12:00:00.000',
    });
    dbMocks.getLineAccountById.mockResolvedValue({ channel_access_token: 'group-account-token' });
    const { db, calls } = makeChatDb({
      rows,
      friends,
      visibleFriendIds: friends.map((friend) => friend.id),
      lineConversationMessages: [{
        id: 'group-incoming-1',
        conversation_id: 'conversation-group-1',
        direction: 'incoming',
        message_type: 'text',
        content: '確認をお願いします',
        source: 'group',
        quote_token: 'group-quote-1',
        mark_as_read_token: 'group-read-1',
        sender_user_id: 'Ugroupmember',
        sender_name: '中田 匠',
        sender_picture_url: null,
        deleted_at: null,
        deleted_reason: null,
        created_at: '2026-06-12T12:00:00.000',
      }],
    });

    const res = await setupApp(db, 'staff', {
      LINE_CAPTURE_ONLY: '1',
      LINE_MANUAL_SEND_ENABLED: '1',
    }).request('/api/chats/conversation-group-1/read', { method: 'POST' });

    expect(res.status).toBe(200);
    expect(lineSdkMocks.markMessagesAsRead).toHaveBeenCalledWith('group-read-1');
    await expect(res.json()).resolves.toMatchObject({
      success: true,
      data: {
        status: 'in_progress',
        markedMessageId: 'group-incoming-1',
        markAsRead: {
          requested: true,
          marked: true,
          reason: null,
        },
      },
    });
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: 'run',
        sql: expect.stringContaining('UPDATE line_conversation_messages'),
        binds: [
          '2026-06-12T10:00:00.000',
          'staff-1',
          'group-incoming-1',
        ],
      }),
      expect.objectContaining({
        method: 'run',
        sql: expect.stringContaining("SET workflow_status = 'in_progress'"),
      }),
    ]));
  });

  test('staff can quote an incoming LINE group message', async () => {
    dbMocks.getLineConversationById.mockResolvedValue({
      id: 'conversation-group-1',
      line_account_id: 'account-1',
      source_type: 'group',
      source_id: 'Cgroup1',
      display_name: 'ECオーナー連絡グループ',
      picture_url: null,
      last_message_at: '2026-06-12T12:00:00.000',
      status: 'unread',
      workflow_status: 'unread',
      created_at: '2026-06-12T08:00:00.000',
      updated_at: '2026-06-12T12:00:00.000',
    });
    dbMocks.getLineAccountById.mockResolvedValue({ channel_access_token: 'group-account-token' });
    const { db } = makeChatDb({
      rows,
      friends,
      visibleFriendIds: friends.map((friend) => friend.id),
      lineConversationMessages: [{
        id: 'group-incoming-1',
        conversation_id: 'conversation-group-1',
        direction: 'incoming',
        message_type: 'text',
        content: 'この内容を確認してください',
        source: 'group',
        quote_token: 'group-quote-1',
        sender_user_id: 'Ugroupmember',
        sender_name: '中田 匠',
        sender_picture_url: null,
        deleted_at: null,
        deleted_reason: null,
        created_at: '2026-06-12T12:00:00.000',
      }],
    });
    const idempotencyKey = '44444444-4444-4444-8444-444444444444';

    const res = await setupApp(db, 'staff').request('/api/chats/conversation-group-1/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        content: 'こちらの件を確認します。',
        quoteMessageId: 'group-incoming-1',
        markAsRead: false,
      }),
    });

    expect(res.status).toBe(200);
    expect(lineSdkMocks.pushTextMessage).toHaveBeenCalledWith(
      'Cgroup1',
      'こちらの件を確認します。',
      'group-quote-1',
      idempotencyKey,
    );
    expect(dbMocks.insertLineConversationMessage).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        id: idempotencyKey,
        quotedMessageId: 'group-incoming-1',
        sentByStaffId: 'staff-1',
        sentByStaffName: '田島',
      }),
    );
    await expect(res.json()).resolves.toMatchObject({
      success: true,
      data: {
        quotedMessageId: 'group-incoming-1',
      },
    });
  });

  test('failed LINE group delivery is not written to the conversation history', async () => {
    dbMocks.getLineConversationById.mockResolvedValue({
      id: 'conversation-group-1',
      line_account_id: 'account-1',
      source_type: 'group',
      source_id: 'Cgroup1',
      display_name: 'ECオーナー連絡グループ',
      picture_url: null,
      last_message_at: '2026-06-12T12:00:00.000',
      status: 'unread',
      created_at: '2026-06-12T08:00:00.000',
      updated_at: '2026-06-12T12:00:00.000',
    });
    dbMocks.getLineAccountById.mockResolvedValue({ channel_access_token: 'group-account-token' });
    lineSdkMocks.pushTextMessage.mockRejectedValueOnce(new Error('LINE API error: 500 Internal Server Error'));
    const { db } = makeChatDb({
      rows,
      friends,
      visibleFriendIds: friends.map((friend) => friend.id),
    });

    const res = await setupApp(db, 'staff').request('/api/chats/conversation-group-1/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '保存してはいけない送信です。' }),
    });

    expect(res.status).toBe(502);
    expect(dbMocks.insertLineConversationMessage).not.toHaveBeenCalled();
  });

  test('secondary-only staff cannot send to LINE groups', async () => {
    dbMocks.getLineConversationById.mockResolvedValue({
      id: 'conversation-group-1',
      line_account_id: 'account-1',
      source_type: 'group',
      source_id: 'Cgroup1',
      display_name: 'ECオーナー連絡グループ',
      picture_url: null,
      last_message_at: '2026-06-12T12:00:00.000',
      status: 'unread',
      created_at: '2026-06-12T08:00:00.000',
      updated_at: '2026-06-12T12:00:00.000',
    });
    const { db } = makeChatDb({
      rows,
      friends,
      visibleFriendIds: friends.map((friend) => friend.id),
    });

    const res = await setupApp(db, 'secondary').request('/api/chats/conversation-group-1/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '送信できません。' }),
    });

    expect(res.status).toBe(404);
    expect(lineSdkMocks.pushTextMessage).not.toHaveBeenCalled();
    expect(dbMocks.insertLineConversationMessage).not.toHaveBeenCalled();
  });

  test('chat detail includes internal staff chat messages', async () => {
    const { db, state } = makeChatDb({
      rows,
      friends,
      visibleFriendIds: ['friend-visible'],
      chatInternalMessages: [
        {
          id: 'chat-internal-1',
          friend_id: 'friend-visible',
          line_account_id: 'acc-1',
          parent_id: null,
          body: '@田島 返品理由を確認してください',
          mentions: JSON.stringify(['田島']),
          created_by: 'staff-2',
          created_by_name: '佐藤',
          created_at: '2026-06-12T09:10:00.000',
        },
        {
          id: 'chat-internal-2',
          friend_id: 'friend-visible',
          line_account_id: 'acc-1',
          parent_id: 'chat-internal-1',
          body: '確認しました',
          mentions: '[]',
          created_by: 'staff-1',
          created_by_name: '田島',
          created_at: '2026-06-12T09:11:00.000',
        },
      ],
    });
    dbMocks.getChatById.mockResolvedValue(null);
    dbMocks.getFriendById.mockImplementation(async (_db: D1Database, id: string) =>
      friends.find((friend) => friend.id === id) ?? null,
    );

    const res = await setupApp(db, 'staff').request('/api/chats/friend-visible');

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { internalMessages: Array<{ id: string; parentId: string | null; mentions: string[] }> };
    };
    expect(body.data.internalMessages).toEqual([
      expect.objectContaining({ id: 'chat-internal-1', parentId: null, mentions: ['田島'] }),
      expect.objectContaining({ id: 'chat-internal-2', parentId: 'chat-internal-1', mentions: [] }),
    ]);
  });

  test('staff can open LINE media for visible chats', async () => {
    const { db, state } = makeChatDb({
      rows,
      friends,
      visibleFriendIds: ['friend-visible'],
      messages: [
        {
          id: 'msg-file-1',
          friend_id: 'friend-visible',
          direction: 'incoming',
          message_type: 'file',
          content: JSON.stringify({
            lineMessageId: 'line-msg-1',
            fileName: 'invoice.pdf',
            fileSize: 1234,
          }),
          created_at: '2026-06-12T09:00:00.000',
        },
      ],
    });
    dbMocks.getLineAccountById.mockResolvedValue({ channel_access_token: 'account-token' });
    const fetchMock = vi.fn(async () => new Response('pdf-bytes', {
      headers: { 'Content-Type': 'application/pdf', 'Content-Length': '9' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await setupApp(db, 'staff').request('/api/chats/messages/msg-file-1/media');

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api-data.line.me/v2/bot/message/line-msg-1/content',
      { headers: { Authorization: 'Bearer account-token' } },
    );
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    expect(res.headers.get('Content-Disposition')).toContain('invoice.pdf');
    expect(await res.text()).toBe('pdf-bytes');
  });

  test('staff can open LINE media for individual chats', async () => {
    const { db, state } = makeChatDb({
      rows,
      friends,
      visibleFriendIds: ['friend-visible'],
      messages: [
        {
          id: 'msg-hidden-file',
          friend_id: 'friend-hidden',
          direction: 'incoming',
          message_type: 'file',
          content: JSON.stringify({ lineMessageId: 'line-hidden', fileName: 'hidden.pdf' }),
          created_at: '2026-06-12T09:00:00.000',
        },
      ],
    });
    dbMocks.getLineAccountById.mockResolvedValue({ channel_access_token: 'account-token' });
    const fetchMock = vi.fn(async () => new Response('hidden-pdf', {
      headers: { 'Content-Type': 'application/pdf' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await setupApp(db, 'staff').request('/api/chats/messages/msg-hidden-file/media');

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api-data.line.me/v2/bot/message/line-hidden/content',
      { headers: { Authorization: 'Bearer account-token' } },
    );
  });

  test('individual chat media remains available when LINE conversation tables are missing', async () => {
    const { db, calls } = makeChatDb({
      rows,
      friends,
      visibleFriendIds: ['friend-visible'],
      messages: [{
        id: 'msg-existing-file',
        friend_id: 'friend-visible',
        direction: 'incoming',
        message_type: 'file',
        content: JSON.stringify({ lineMessageId: 'line-existing', fileName: 'existing.pdf' }),
        created_at: '2026-06-12T09:00:00.000',
      }],
      missingTables: ['line_conversations', 'line_conversation_messages'],
    });
    dbMocks.getLineAccountById.mockResolvedValue({ channel_access_token: 'account-token' });
    const fetchMock = vi.fn(async () => new Response('existing-pdf', {
      headers: { 'Content-Type': 'application/pdf' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await setupApp(db, 'staff').request('/api/chats/messages/msg-existing-file/media');

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('existing-pdf');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api-data.line.me/v2/bot/message/line-existing/content',
      { headers: { Authorization: 'Bearer account-token' } },
    );
    expect(calls.some((call) => /\bline_conversation_messages\b/.test(call.sql))).toBe(false);
    expect(calls.some((call) => /\bline_conversations\b/.test(call.sql))).toBe(false);
  });

  test('staff can post internal chat messages and thread replies on visible chats', async () => {
    const { db, state } = makeChatDb({
      rows,
      friends,
      visibleFriendIds: ['friend-visible'],
      chatInternalMessages: [
        {
          id: 'chat-internal-root',
          friend_id: 'friend-visible',
          line_account_id: 'acc-1',
          parent_id: null,
          body: '確認お願いします',
          mentions: '[]',
          created_by: 'staff-2',
          created_by_name: '佐藤',
          created_at: '2026-06-12T09:10:00.000',
        },
      ],
    });
    dbMocks.getChatById.mockResolvedValue(null);
    dbMocks.getFriendById.mockImplementation(async (_db: D1Database, id: string) =>
      friends.find((friend) => friend.id === id) ?? null,
    );
    const app = setupApp(db, 'staff');

    const postRes = await app.request('/api/chats/friend-visible/internal-messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: '@佐藤 対応方針を確認してください' }),
    });

    expect(postRes.status).toBe(201);
    expect(state.chatInternalMessages.at(-1)).toMatchObject({
      friend_id: 'friend-visible',
      line_account_id: 'acc-1',
      parent_id: null,
      body: '@佐藤 対応方針を確認してください',
      created_by: 'staff-1',
      created_by_name: '田島',
    });
    expect(JSON.parse(state.chatInternalMessages.at(-1)!.mentions)).toEqual(['佐藤']);

    const replyRes = await app.request('/api/chats/friend-visible/internal-messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'こちらで回答します', parentId: 'chat-internal-root' }),
    });

    expect(replyRes.status).toBe(201);
    expect(state.chatInternalMessages.at(-1)).toMatchObject({
      friend_id: 'friend-visible',
      parent_id: 'chat-internal-root',
      body: 'こちらで回答します',
    });
  });

  test('staff can post internal chat messages on individual chats', async () => {
    const { db, state } = makeChatDb({ rows, friends, visibleFriendIds: ['friend-visible'] });
    dbMocks.getChatById.mockResolvedValue(null);

    const res = await setupApp(db, 'staff').request('/api/chats/friend-hidden/internal-messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: '見えない顧客には投稿できない' }),
    });

    expect(res.status).toBe(201);
    expect(state.chatInternalMessages.at(-1)).toMatchObject({
      friend_id: 'friend-hidden',
      body: '見えない顧客には投稿できない',
    });
  });

  test('chat list rejects unsafe filters before SQL bind', async () => {
    const cases = [
      '/api/chats?lineAccountId=bad%20account',
      '/api/chats?operatorId=bad%20operator',
      '/api/chats?status=archived',
      '/api/chats?unansweredOnly=maybe',
      '/api/chats?q=%00',
      `/api/chats?q=${encodeURIComponent('あ'.repeat(121))}`,
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
      'acc-1',
      'acc-1',
      'staff-1',
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
      isLongTerm: false,
      notes: '次回確認',
    });
    expect(dbMocks.getChatById).toHaveBeenCalledWith(db, 'chat-friend-visible');
  });

  test('stores long-term support without changing the legacy chat status constraint', async () => {
    const { db } = makeChatDb({ rows, friends, visibleFriendIds: ['friend-visible'] });
    let isLongTerm = 0;
    dbMocks.getChatById.mockImplementation(async (_db: D1Database, id: string) => {
      if (id === 'friend-visible') return null;
      if (id !== 'chat-friend-visible') return null;
      return {
        id: 'chat-friend-visible',
        friend_id: 'friend-visible',
        operator_id: null,
        status: 'in_progress',
        is_long_term: isLongTerm,
        notes: null,
        last_message_at: '2026-06-12T10:00:00.000',
        created_at: '2026-06-12T09:00:00.000',
        updated_at: '2026-06-12T10:00:00.000',
      };
    });
    dbMocks.getFriendById.mockImplementation(async (_db: D1Database, id: string) =>
      friends.find((friend) => friend.id === id) ?? null,
    );
    dbMocks.updateChat.mockImplementation(async (_db, _id, update) => {
      isLongTerm = update.isLongTerm ? 1 : 0;
    });

    const res = await setupApp(db, 'owner').request('/api/chats/friend-visible', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'long_term' }),
    });
    const body = await res.json() as { data: { status: string } };

    expect(res.status).toBe(200);
    expect(dbMocks.updateChat).toHaveBeenCalledWith(db, 'chat-friend-visible', {
      status: 'in_progress',
      isLongTerm: true,
    });
    expect(body.data.status).toBe('long_term');
  });

  test.each([
    { active: true, status: 'unread', isLongTerm: 0, expectedStatus: 'unread', expectedSql: 'INSERT INTO chat_typing_status' },
    { active: true, status: 'in_progress', isLongTerm: 1, expectedStatus: 'long_term', expectedSql: 'INSERT INTO chat_typing_status' },
    { active: false, status: 'unread', isLongTerm: 0, expectedStatus: 'unread', expectedSql: 'DELETE FROM chat_typing_status' },
  ])(
    'typing active=$active does not change the $expectedStatus workflow state',
    async ({ active, status, isLongTerm, expectedStatus, expectedSql }) => {
      const { db, calls } = makeChatDb({ rows, friends, visibleFriendIds: ['friend-visible'] });
      dbMocks.getChatById.mockResolvedValue({
        id: 'chat-friend-visible',
        friend_id: 'friend-visible',
        operator_id: null,
        status,
        is_long_term: isLongTerm,
        notes: null,
        last_message_at: '2026-06-12T10:00:00.000',
        created_at: '2026-06-12T09:00:00.000',
        updated_at: '2026-06-12T10:00:00.000',
      });

      const res = await setupApp(db, 'staff').request('/api/chats/friend-visible/typing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active }),
      });
      const body = await res.json() as {
        data: { active: boolean; status: string; typingParticipants: unknown[] };
      };

      expect(res.status).toBe(200);
      expect(body.data).toMatchObject({ active, status: expectedStatus });
      expect(dbMocks.updateChat).not.toHaveBeenCalled();
      expect(calls.some((call) => (
        call.method === 'run' && call.sql.includes(expectedSql)
      ))).toBe(true);
    },
  );

  test('creates a scheduled message for an accessible chat', async () => {
    const { db, state } = makeChatDb({ rows, friends, visibleFriendIds: ['friend-visible'] });
    dbMocks.getChatById.mockResolvedValue(null);
    dbMocks.updateChat.mockResolvedValue(undefined);

    const scheduledAt = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
    const res = await setupApp(db, 'staff').request('/api/chats/friend-visible/scheduled-messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scheduledAt,
        messages: [{ messageType: 'text', content: '翌朝ご連絡します' }],
      }),
    });
    const body = await res.json() as { data: { scheduledAt: string; status: string; messages: unknown[] } };

    expect(res.status).toBe(201);
    expect(body.data).toMatchObject({ scheduledAt, status: 'pending' });
    expect(body.data.messages).toEqual([{ messageType: 'text', content: '翌朝ご連絡します' }]);
    expect(state.scheduledMessages).toHaveLength(1);
    expect(dbMocks.updateChat).toHaveBeenCalledWith(db, 'chat-friend-visible', {
      status: 'in_progress',
      isLongTerm: false,
    });
  });

  test('rejects a scheduled message less than one minute in the future', async () => {
    const { db } = makeChatDb({ rows, friends, visibleFriendIds: ['friend-visible'] });

    const res = await setupApp(db, 'staff').request('/api/chats/friend-visible/scheduled-messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scheduledAt: new Date(Date.now() + 10_000).toISOString(),
        messages: [{ messageType: 'text', content: '近すぎる予約' }],
      }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      success: false,
      error: '予約日時は1分以上先を指定してください',
    });
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
      isLongTerm: false,
      lastMessageAt: '2026-06-12T10:00:00.000',
    });
  });

  test('manual send forwards a stable idempotency key to LINE and uses it for the local message id', async () => {
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
    dbMocks.getLineAccountById.mockResolvedValue({ channel_access_token: 'account-token' });
    dbMocks.updateChat.mockResolvedValue(undefined);
    const key = '11111111-1111-4111-8111-111111111111';

    const res = await setupApp(db, 'owner').request('/api/chats/friend-visible/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify({ content: '重複なく送信します。' }),
    });

    expect(res.status).toBe(200);
    expect(lineSdkMocks.pushTextMessage).toHaveBeenCalledWith(
      'U-visible',
      '重複なく送信します。',
      undefined,
      key,
    );
    expect(state.messages.at(-1)?.id).toBe(key);
  });

  test('manual send reconciles local state when LINE reports an accepted retry key', async () => {
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
    dbMocks.getLineAccountById.mockResolvedValue({ channel_access_token: 'account-token' });
    dbMocks.updateChat.mockResolvedValue(undefined);
    lineSdkMocks.pushTextMessage.mockRejectedValueOnce(new Error('LINE API error: 409 Conflict'));
    const key = '22222222-2222-4222-8222-222222222222';

    const res = await setupApp(db, 'owner').request('/api/chats/friend-visible/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify({ content: '送信済みを復元します。' }),
    });

    expect(res.status).toBe(200);
    expect(state.messages.at(-1)).toMatchObject({ id: key, content: '送信済みを復元します。' });
    expect(dbMocks.updateChat).toHaveBeenCalled();
  });

  test('manual send rejects malformed idempotency keys before LINE delivery', async () => {
    const { db, state } = makeChatDb({ rows, friends, visibleFriendIds: ['friend-visible'] });

    const res = await setupApp(db, 'owner').request('/api/chats/friend-visible/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'not-a-uuid' },
      body: JSON.stringify({ content: '送信しません。' }),
    });

    expect(res.status).toBe(400);
    expect(lineSdkMocks.pushTextMessage).not.toHaveBeenCalled();
    expect(state.messages).toHaveLength(0);
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
    const { db, state } = makeChatDb({
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
        markAsRead: { requested: boolean; marked: boolean; reason: string | null; messageId: string | null; markedAt: string | null };
      };
    };
    expect(lineSdkMocks.LineClient).toHaveBeenCalledWith('account-token', { allowMutationsWhenDisabled: true });
    expect(lineSdkMocks.pushTextMessage).toHaveBeenCalledWith('U-visible', '確認して折り返します。');
    expect(lineSdkMocks.markMessagesAsRead).toHaveBeenCalledWith('read-token-1');
    expect(body.data.markAsRead).toMatchObject({
      requested: true,
      marked: true,
      reason: null,
      messageId: 'incoming-1',
    });
    expect(body.data.markAsRead.markedAt).toEqual(expect.any(String));
    expect(state.messages[0].marked_as_read_at).toEqual(body.data.markAsRead.markedAt);
    expect(state.messages[0].marked_as_read_by).toBe('staff-1');
    expect(state.messages.at(-1)).toMatchObject({
      direction: 'outgoing',
      content: '確認して折り返します。',
    });
  });

  test('manual send stores the LINE sent message id when the API returns one', async () => {
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
      last_message_at: '2026-06-12T09:30:00.000',
      created_at: '2026-06-12T09:00:00.000',
      updated_at: '2026-06-12T09:30:00.000',
    });
    dbMocks.getFriendById.mockImplementation(async (_db: D1Database, id: string) =>
      friends.find((friend) => friend.id === id) ?? null,
    );
    dbMocks.getLineAccountById.mockResolvedValue({ channel_access_token: 'account-token' });
    dbMocks.updateChat.mockResolvedValue(undefined);
    lineSdkMocks.pushTextMessage.mockResolvedValueOnce({ sentMessages: [{ id: 'line-sent-message-1' }] });

    const res = await setupApp(db, 'owner').request('/api/chats/friend-visible/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '送信IDも保存します。' }),
    });

    expect(res.status).toBe(200);
    expect(state.messages.at(-1)).toMatchObject({
      direction: 'outgoing',
      content: '送信IDも保存します。',
      line_message_id: 'line-sent-message-1',
    });
  });

  test('manual send can quote an incoming LINE message', async () => {
    const { db, state } = makeChatDb({
      rows,
      friends,
      visibleFriendIds: ['friend-visible'],
      messages: [
        {
          id: 'incoming-quote-1',
          friend_id: 'friend-visible',
          direction: 'incoming',
          message_type: 'text',
          content: 'この内容に返信してほしいです',
          created_at: '2026-06-12T09:30:00.000',
          quote_token: 'incoming-quote-token-1',
        },
      ],
    });
    dbMocks.getChatById.mockResolvedValue({
      id: 'chat-visible',
      friend_id: 'friend-visible',
      operator_id: null,
      status: 'in_progress',
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
    lineSdkMocks.pushTextMessage.mockResolvedValueOnce({
      sentMessages: [{ id: 'line-sent-message-quote', quoteToken: 'sent-quote-token-1' }],
    });

    const res = await setupApp(db, 'owner').request('/api/chats/friend-visible/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'こちら確認します。',
        quoteMessageId: 'incoming-quote-1',
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { quotedMessageId: string | null; sentByStaffId: string | null; sentByStaffName: string | null } };
    expect(lineSdkMocks.pushTextMessage).toHaveBeenCalledWith(
      'U-visible',
      'こちら確認します。',
      'incoming-quote-token-1',
    );
    expect(body.data.quotedMessageId).toBe('incoming-quote-1');
    expect(body.data.sentByStaffId).toBe('staff-1');
    expect(body.data.sentByStaffName).toBe('田島');
    expect(state.messages.at(-1)).toMatchObject({
      direction: 'outgoing',
      content: 'こちら確認します。',
      line_message_id: 'line-sent-message-quote',
      quote_token: 'sent-quote-token-1',
      quoted_message_id: 'incoming-quote-1',
      sent_by_staff_id: 'staff-1',
      sent_by_staff_name: '田島',
    });
  });

  test('can reflect an official-side outgoing unsend as deleted in Harness', async () => {
    const { db, state } = makeChatDb({
      rows,
      friends,
      visibleFriendIds: ['friend-visible'],
      messages: [
        {
          id: 'outgoing-1',
          friend_id: 'friend-visible',
          direction: 'outgoing',
          message_type: 'text',
          content: '取り消した送信',
          created_at: '2026-06-12T09:30:00.000',
          source: 'manual',
        },
      ],
    });
    dbMocks.getChatById.mockResolvedValue({
      id: 'chat-visible',
      friend_id: 'friend-visible',
      operator_id: null,
      status: 'in_progress',
      notes: null,
      last_message_at: '2026-06-12T09:30:00.000',
      created_at: '2026-06-12T09:00:00.000',
      updated_at: '2026-06-12T09:30:00.000',
    });
    dbMocks.getFriendById.mockImplementation(async (_db: D1Database, id: string) =>
      friends.find((friend) => friend.id === id) ?? null,
    );

    const res = await setupApp(db, 'owner').request('/api/chats/chat-visible/messages/outgoing-1/deleted', {
      method: 'POST',
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; data: { messageId: string; deletedAt: string } };
    expect(body.data.messageId).toBe('outgoing-1');
    expect(state.messages[0]).toMatchObject({
      deleted_at: body.data.deletedAt,
      deleted_reason: 'manual_unsend_reflection',
    });
  });

  test('can mark the latest incoming message as read without sending a LINE message', async () => {
    const { db, state } = makeChatDb({
      rows,
      friends,
      visibleFriendIds: ['friend-visible'],
      messages: [
        {
          id: 'incoming-1',
          friend_id: 'friend-visible',
          direction: 'incoming',
          message_type: 'text',
          content: 'ありがとうございます',
          created_at: '2026-06-12T09:30:00.000',
          mark_as_read_token: 'read-token-thanks',
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
    dbMocks.getLineAccountById.mockResolvedValue({ channel_access_token: 'account-token' });
    dbMocks.updateChat.mockResolvedValue(undefined);

    const res = await setupApp(db, 'owner', {
      LINE_CAPTURE_ONLY: '1',
      LINE_MANUAL_SEND_ENABLED: '1',
    }).request('/api/chats/chat-visible/read', {
      method: 'POST',
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        markAsRead: { requested: boolean; marked: boolean; reason: string | null; messageId: string | null; markedAt: string | null };
        status: string | null;
        markedMessageId: string | null;
        markedAt: string | null;
      };
    };
    expect(lineSdkMocks.LineClient).toHaveBeenCalledWith('account-token', { allowMutationsWhenDisabled: true });
    expect(lineSdkMocks.pushTextMessage).not.toHaveBeenCalled();
    expect(lineSdkMocks.markMessagesAsRead).toHaveBeenCalledWith('read-token-thanks');
    expect(dbMocks.updateChat).toHaveBeenCalledWith(db, 'chat-visible', { status: 'in_progress', isLongTerm: false });
    expect(body.data).toMatchObject({
      markAsRead: { requested: true, marked: true, reason: null, messageId: 'incoming-1' },
      status: 'in_progress',
      markedMessageId: 'incoming-1',
    });
    expect(body.data.markedAt).toEqual(expect.any(String));
    expect(state.messages[0].marked_as_read_at).toEqual(body.data.markedAt);
    expect(state.messages[0].marked_as_read_by).toBe('staff-1');
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
      isLongTerm: false,
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

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getLineConversationById,
  insertLineConversationMessage,
  upsertLineConversation,
  type LineConversationMessageInput,
} from '../src/line-conversations';

function createD1Database(sqlite: Database.Database): D1Database {
  return {
    prepare(query: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...nextValues: unknown[]) {
          values = nextValues;
          return statement;
        },
        async first<T>() {
          return (sqlite.prepare(query).get(...values) ?? null) as T | null;
        },
        async run() {
          const result = sqlite.prepare(query).run(...values);
          return {
            success: true,
            meta: { changes: result.changes },
          };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

describe('LINE conversations', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE line_conversations (
        id              TEXT PRIMARY KEY,
        line_account_id TEXT,
        source_type     TEXT NOT NULL CHECK (source_type IN ('group', 'room')),
        source_id       TEXT NOT NULL,
        display_name    TEXT NOT NULL,
        picture_url     TEXT,
        last_message_at TEXT,
        status          TEXT NOT NULL DEFAULT 'resolved'
                        CHECK (status IN ('unread', 'resolved')),
        workflow_status TEXT
                        CHECK (workflow_status IN ('unread', 'in_progress', 'long_term', 'resolved')),
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_line_conversations_source
      ON line_conversations (COALESCE(line_account_id, ''), source_type, source_id);

      CREATE TABLE line_conversation_messages (
        id                 TEXT PRIMARY KEY,
        conversation_id    TEXT NOT NULL,
        direction          TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
        message_type       TEXT NOT NULL,
        content            TEXT NOT NULL,
        source             TEXT NOT NULL,
        line_account_id    TEXT,
        line_message_id    TEXT,
        webhook_event_id   TEXT UNIQUE,
        quote_token        TEXT,
        mark_as_read_token TEXT,
        marked_as_read_at  TEXT,
        marked_as_read_by  TEXT,
        quoted_message_id  TEXT,
        sent_by_staff_id   TEXT,
        sent_by_staff_name TEXT,
        sender_user_id     TEXT,
        sender_name        TEXT,
        sender_picture_url TEXT,
        created_at         TEXT NOT NULL
      );
    `);
    db = createD1Database(sqlite);
  });

  afterEach(() => {
    sqlite.close();
  });

  function messageInput(
    conversationId: string,
    overrides: Partial<LineConversationMessageInput> = {},
  ): LineConversationMessageInput {
    return {
      id: 'message-1',
      conversationId,
      direction: 'incoming',
      messageType: 'text',
      content: '確認をお願いします',
      source: 'group',
      lineAccountId: 'account-1',
      lineMessageId: 'line-message-1',
      webhookEventId: 'webhook-event-1',
      quoteToken: null,
      senderUserId: 'line-user-1',
      senderName: '担当者',
      senderPictureUrl: null,
      createdAt: '2026-07-23T10:00:00.000+09:00',
      ...overrides,
    };
  }

  it('creates a new conversation as resolved', async () => {
    const conversation = await upsertLineConversation(db, {
      lineAccountId: 'account-1',
      sourceType: 'group',
      sourceId: 'Cgroup1',
      displayName: 'ECオーナー連絡グループ',
      pictureUrl: null,
    });

    expect(conversation.status).toBe('resolved');
    expect(conversation.workflow_status).toBe('resolved');
    expect((await getLineConversationById(db, conversation.id))?.status).toBe('resolved');
    expect((await getLineConversationById(db, conversation.id))?.workflow_status).toBe('resolved');
  });

  it('stores message workflow metadata and marks an incoming conversation unread', async () => {
    const conversation = await upsertLineConversation(db, {
      lineAccountId: 'account-1',
      sourceType: 'group',
      sourceId: 'Cgroup1',
      displayName: 'ECオーナー連絡グループ',
      pictureUrl: null,
    });

    expect(await insertLineConversationMessage(db, messageInput(conversation.id, {
      markAsReadToken: 'read-token-1',
      markedAsReadAt: '2026-07-23T10:01:00.000+09:00',
      markedAsReadBy: 'staff-1',
      quotedMessageId: 'line-message-parent',
      sentByStaffId: 'staff-1',
      sentByStaffName: '担当者',
    }))).toBe(true);
    expect(await getLineConversationById(db, conversation.id)).toMatchObject({
      status: 'unread',
      workflow_status: 'unread',
      last_message_at: '2026-07-23T10:00:00.000+09:00',
    });
    expect(
      sqlite.prepare(
        `SELECT mark_as_read_token, marked_as_read_at, marked_as_read_by,
                quoted_message_id, sent_by_staff_id, sent_by_staff_name
         FROM line_conversation_messages
         WHERE id = ?`,
      ).get('message-1'),
    ).toEqual({
      mark_as_read_token: 'read-token-1',
      marked_as_read_at: '2026-07-23T10:01:00.000+09:00',
      marked_as_read_by: 'staff-1',
      quoted_message_id: 'line-message-parent',
      sent_by_staff_id: 'staff-1',
      sent_by_staff_name: '担当者',
    });
  });

  it('keeps legacy resolved and marks workflow in progress for a newer outgoing message', async () => {
    const conversation = await upsertLineConversation(db, {
      lineAccountId: 'account-1',
      sourceType: 'group',
      sourceId: 'Cgroup1',
      displayName: 'ECオーナー連絡グループ',
      pictureUrl: null,
    });

    expect(await insertLineConversationMessage(db, messageInput(conversation.id))).toBe(true);
    expect(await insertLineConversationMessage(db, messageInput(conversation.id, {
      id: 'message-2',
      direction: 'outgoing',
      content: '確認いたしました',
      lineMessageId: 'line-message-2',
      webhookEventId: 'webhook-event-2',
      createdAt: '2026-07-23T10:05:00.000+09:00',
    }))).toBe(true);

    expect(await getLineConversationById(db, conversation.id)).toMatchObject({
      status: 'resolved',
      workflow_status: 'in_progress',
      last_message_at: '2026-07-23T10:05:00.000+09:00',
    });
  });

  it('does not let a delayed older incoming message overwrite a newer outgoing state', async () => {
    const conversation = await upsertLineConversation(db, {
      lineAccountId: 'account-1',
      sourceType: 'group',
      sourceId: 'Cgroup1',
      displayName: 'ECオーナー連絡グループ',
      pictureUrl: null,
    });

    expect(await insertLineConversationMessage(db, messageInput(conversation.id, {
      id: 'message-newer',
      direction: 'outgoing',
      content: '対応済みです',
      lineMessageId: 'line-message-newer',
      webhookEventId: 'webhook-event-newer',
      createdAt: '2026-07-23T10:10:00.000+09:00',
    }))).toBe(true);
    const beforeDelayedMessage = await getLineConversationById(db, conversation.id);

    expect(await insertLineConversationMessage(db, messageInput(conversation.id, {
      id: 'message-delayed',
      lineMessageId: 'line-message-delayed',
      webhookEventId: 'webhook-event-delayed',
      createdAt: '2026-07-23T10:05:00.000+09:00',
    }))).toBe(true);

    expect(await getLineConversationById(db, conversation.id)).toMatchObject({
      status: 'resolved',
      workflow_status: 'in_progress',
      last_message_at: '2026-07-23T10:10:00.000+09:00',
      updated_at: beforeDelayedMessage?.updated_at,
    });
  });

  it('does not let a delayed older outgoing message overwrite a newer incoming state', async () => {
    const conversation = await upsertLineConversation(db, {
      lineAccountId: 'account-1',
      sourceType: 'group',
      sourceId: 'Cgroup1',
      displayName: 'ECオーナー連絡グループ',
      pictureUrl: null,
    });

    expect(await insertLineConversationMessage(db, messageInput(conversation.id, {
      id: 'message-newer',
      createdAt: '2026-07-23T10:10:00.000+09:00',
    }))).toBe(true);
    const beforeDelayedMessage = await getLineConversationById(db, conversation.id);

    expect(await insertLineConversationMessage(db, messageInput(conversation.id, {
      id: 'message-delayed',
      direction: 'outgoing',
      content: '古い送信メッセージ',
      lineMessageId: 'line-message-delayed',
      webhookEventId: 'webhook-event-delayed',
      createdAt: '2026-07-23T10:05:00.000+09:00',
    }))).toBe(true);

    expect(await getLineConversationById(db, conversation.id)).toMatchObject({
      status: 'unread',
      workflow_status: 'unread',
      last_message_at: '2026-07-23T10:10:00.000+09:00',
      updated_at: beforeDelayedMessage?.updated_at,
    });
  });

  it('does not change a resolved conversation when the message is a duplicate', async () => {
    const conversation = await upsertLineConversation(db, {
      lineAccountId: 'account-1',
      sourceType: 'group',
      sourceId: 'Cgroup1',
      displayName: 'ECオーナー連絡グループ',
      pictureUrl: null,
    });
    const input = messageInput(conversation.id);
    expect(await insertLineConversationMessage(db, input)).toBe(true);
    sqlite.prepare(
      `UPDATE line_conversations
       SET status = 'resolved', workflow_status = 'resolved', updated_at = ?
       WHERE id = ?`,
    ).run('2026-07-23T10:05:00.000+09:00', conversation.id);

    expect(await insertLineConversationMessage(db, input)).toBe(false);
    expect(await getLineConversationById(db, conversation.id)).toMatchObject({
      status: 'resolved',
      workflow_status: 'resolved',
      last_message_at: '2026-07-23T10:00:00.000+09:00',
      updated_at: '2026-07-23T10:05:00.000+09:00',
    });
  });
});

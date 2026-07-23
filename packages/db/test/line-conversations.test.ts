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
    expect((await getLineConversationById(db, conversation.id))?.status).toBe('resolved');
  });

  it('marks the conversation unread only when a message is inserted', async () => {
    const conversation = await upsertLineConversation(db, {
      lineAccountId: 'account-1',
      sourceType: 'group',
      sourceId: 'Cgroup1',
      displayName: 'ECオーナー連絡グループ',
      pictureUrl: null,
    });

    expect(await insertLineConversationMessage(db, messageInput(conversation.id))).toBe(true);
    expect(await getLineConversationById(db, conversation.id)).toMatchObject({
      status: 'unread',
      last_message_at: '2026-07-23T10:00:00.000+09:00',
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
       SET status = 'resolved', updated_at = ?
       WHERE id = ?`,
    ).run('2026-07-23T10:05:00.000+09:00', conversation.id);

    expect(await insertLineConversationMessage(db, input)).toBe(false);
    expect(await getLineConversationById(db, conversation.id)).toMatchObject({
      status: 'resolved',
      last_message_at: '2026-07-23T10:00:00.000+09:00',
      updated_at: '2026-07-23T10:05:00.000+09:00',
    });
  });
});

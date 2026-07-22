import { jstNow } from './utils';

export type LineConversationSourceType = 'group' | 'room';

export interface LineConversation {
  id: string;
  line_account_id: string | null;
  source_type: LineConversationSourceType;
  source_id: string;
  display_name: string;
  picture_url: string | null;
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
}

export type LineConversationMessageInput = {
  id: string;
  conversationId: string;
  direction: 'incoming' | 'outgoing';
  messageType: string;
  content: string;
  source: string;
  lineAccountId: string | null;
  lineMessageId: string | null;
  webhookEventId: string | null;
  quoteToken: string | null;
  senderUserId: string | null;
  senderName: string | null;
  senderPictureUrl: string | null;
  createdAt: string;
};

export async function getLineConversationBySource(
  db: D1Database,
  lineAccountId: string | null,
  sourceType: LineConversationSourceType,
  sourceId: string,
): Promise<LineConversation | null> {
  return db
    .prepare(
      `SELECT * FROM line_conversations
       WHERE line_account_id IS ? AND source_type = ? AND source_id = ?
       LIMIT 1`,
    )
    .bind(lineAccountId, sourceType, sourceId)
    .first<LineConversation>();
}

export async function getLineConversationById(
  db: D1Database,
  id: string,
): Promise<LineConversation | null> {
  return db
    .prepare('SELECT * FROM line_conversations WHERE id = ? LIMIT 1')
    .bind(id)
    .first<LineConversation>();
}

export async function upsertLineConversation(
  db: D1Database,
  input: {
    lineAccountId: string | null;
    sourceType: LineConversationSourceType;
    sourceId: string;
    displayName: string;
    pictureUrl: string | null;
  },
): Promise<LineConversation> {
  const existing = await getLineConversationBySource(
    db,
    input.lineAccountId,
    input.sourceType,
    input.sourceId,
  );
  const now = jstNow();

  if (existing) {
    if (
      existing.display_name !== input.displayName
      || existing.picture_url !== input.pictureUrl
    ) {
      await db
        .prepare(
          `UPDATE line_conversations
           SET display_name = ?, picture_url = ?, updated_at = ?
           WHERE id = ?`,
        )
        .bind(input.displayName, input.pictureUrl, now, existing.id)
        .run();
      return { ...existing, display_name: input.displayName, picture_url: input.pictureUrl, updated_at: now };
    }
    return existing;
  }

  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT OR IGNORE INTO line_conversations
         (id, line_account_id, source_type, source_id, display_name, picture_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.lineAccountId,
      input.sourceType,
      input.sourceId,
      input.displayName,
      input.pictureUrl,
      now,
      now,
    )
    .run();

  const created = await getLineConversationBySource(
    db,
    input.lineAccountId,
    input.sourceType,
    input.sourceId,
  );
  if (!created) throw new Error('Failed to create LINE conversation');
  return created;
}

export async function insertLineConversationMessage(
  db: D1Database,
  input: LineConversationMessageInput,
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO line_conversation_messages
         (id, conversation_id, direction, message_type, content, source, line_account_id,
          line_message_id, webhook_event_id, quote_token, sender_user_id, sender_name,
          sender_picture_url, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.conversationId,
      input.direction,
      input.messageType,
      input.content,
      input.source,
      input.lineAccountId,
      input.lineMessageId,
      input.webhookEventId,
      input.quoteToken,
      input.senderUserId,
      input.senderName,
      input.senderPictureUrl,
      input.createdAt,
    )
    .run();
  const inserted = Number((result as { meta?: { changes?: unknown } }).meta?.changes ?? 0) > 0;
  if (inserted) {
    await db
      .prepare(
        `UPDATE line_conversations
         SET last_message_at = CASE
               WHEN last_message_at IS NULL OR last_message_at < ? THEN ?
               ELSE last_message_at
             END,
             updated_at = ?
         WHERE id = ?`,
      )
      .bind(input.createdAt, input.createdAt, jstNow(), input.conversationId)
      .run();
  }
  return inserted;
}

export async function markLineConversationMessageUnsent(
  db: D1Database,
  lineMessageId: string,
  lineAccountId: string | null,
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE line_conversation_messages
       SET deleted_at = ?, deleted_reason = 'line_unsend'
       WHERE deleted_at IS NULL
         AND line_message_id = ?
         AND (? IS NULL OR line_account_id IS NULL OR line_account_id = ?)`,
    )
    .bind(jstNow(), lineMessageId, lineAccountId, lineAccountId)
    .run();
  return Number((result as { meta?: { changes?: unknown } }).meta?.changes ?? 0);
}

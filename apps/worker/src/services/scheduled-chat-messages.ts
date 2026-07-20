import { jstNow } from '@line-crm/db';
import { LineClient, type Message } from '@line-crm/line-sdk';
import { getLineSendSafetyBlock } from './line-safety.js';

const SCHEDULED_CHAT_MAX_ATTEMPTS = 3;
const SCHEDULED_CHAT_BATCH_LIMIT = 100;
const SCHEDULED_CHAT_PROCESSING_TIMEOUT_MS = 15 * 60 * 1000;

export type ScheduledChatMessagePart = {
  messageType: 'text' | 'image';
  content: string;
};

export type ScheduledChatMessageRow = {
  id: string;
  chat_id: string;
  friend_id: string;
  line_account_id: string | null;
  messages_json: string;
  support_case_id: string | null;
  scheduled_at: string;
  next_attempt_at: string;
  status: 'pending' | 'processing' | 'sent' | 'failed' | 'failed_permanent' | 'cancelled';
  attempts: number;
  last_error: string | null;
  created_by: string | null;
  created_by_name: string | null;
  sent_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
};

type DueScheduledChatMessageRow = ScheduledChatMessageRow & {
  line_user_id: string;
  friend_line_account_id: string | null;
  channel_access_token: string | null;
};

export type ScheduledChatMessageSender = (input: {
  channelAccessToken: string;
  toLineUserId: string;
  messages: Message[];
  retryKey: string;
}) => Promise<unknown>;

function parseLineStatus(err: unknown): number | null {
  if (!(err instanceof Error)) return null;
  const match = err.message.match(/^LINE API error:\s+(\d{3})\b/);
  return match ? Number(match[1]) : null;
}

function scheduledErrorKind(err: unknown): string {
  const status = parseLineStatus(err);
  if (status != null) return `line_http_status_${status}`;
  if (err instanceof TypeError) return 'network_error';
  if (err instanceof Error) return err.name || 'error';
  return typeof err;
}

function isRetryableScheduledError(err: unknown): boolean {
  const status = parseLineStatus(err);
  return status == null || status === 408 || status === 429 || status >= 500;
}

function parseParts(raw: string): ScheduledChatMessagePart[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 5) {
    throw new Error('invalid_scheduled_messages');
  }
  return parsed.map((part) => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) {
      throw new Error('invalid_scheduled_message');
    }
    const value = part as Record<string, unknown>;
    if ((value.messageType !== 'text' && value.messageType !== 'image') || typeof value.content !== 'string') {
      throw new Error('invalid_scheduled_message');
    }
    return { messageType: value.messageType, content: value.content };
  });
}

function toLineMessage(part: ScheduledChatMessagePart): Message {
  if (part.messageType === 'text') {
    return { type: 'text', text: part.content };
  }
  const image = JSON.parse(part.content) as { originalContentUrl?: unknown; previewImageUrl?: unknown };
  if (typeof image.originalContentUrl !== 'string' || typeof image.previewImageUrl !== 'string') {
    throw new Error('invalid_scheduled_image');
  }
  return {
    type: 'image',
    originalContentUrl: image.originalContentUrl,
    previewImageUrl: image.previewImageUrl,
  };
}

function lineMessageIds(result: unknown, count: number): Array<string | null> {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return Array.from({ length: count }, () => null);
  }
  const sentMessages = (result as { sentMessages?: Array<{ id?: string | number }> }).sentMessages;
  return Array.from({ length: count }, (_, index) => {
    const id = sentMessages?.[index]?.id;
    if (typeof id === 'string' && id.trim()) return id.trim();
    if (typeof id === 'number' && Number.isFinite(id)) return String(id);
    return null;
  });
}

async function recordScheduledSupportReply(
  db: D1Database,
  row: DueScheduledChatMessageRow,
  parts: ScheduledChatMessagePart[],
  sentAt: string,
): Promise<void> {
  if (!row.support_case_id) return;
  const supportCase = await db
    .prepare(
      `SELECT id, status, line_account_id, friend_id
       FROM support_cases
       WHERE id = ? AND friend_id = ?
       LIMIT 1`,
    )
    .bind(row.support_case_id, row.friend_id)
    .first<{ id: string; status: string; line_account_id: string; friend_id: string }>();
  if (!supportCase) return;

  const previousStatus = supportCase.status;
  let statusUpdated = false;
  if (previousStatus !== 'resolved') {
    const update = await db
      .prepare(
        `UPDATE support_cases
         SET status = 'customer_reply', updated_by = ?, updated_at = ?
         WHERE id = ? AND status != 'resolved'`,
      )
      .bind(row.created_by, sentAt, supportCase.id)
      .run();
    statusUpdated = Number(update.meta?.changes ?? 0) > 0;
  }

  const preview = parts.map((part) => part.messageType === 'image' ? '[画像]' : part.content).join('\n').slice(0, 200);
  await db
    .prepare(
      `INSERT INTO support_case_events
       (id, case_id, event_type, actor_id, actor_name, body, metadata, created_at)
       VALUES (?, ?, 'customer_reply_sent', ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      supportCase.id,
      row.created_by,
      row.created_by_name,
      '予約した顧客返信を送信しました',
      JSON.stringify({
        chatId: row.chat_id,
        friendId: row.friend_id,
        lineAccountId: supportCase.line_account_id,
        scheduledMessageId: row.id,
        contentPreview: preview,
        previousStatus,
        nextStatus: statusUpdated ? 'customer_reply' : null,
        statusUpdateApplied: statusUpdated,
      }),
      sentAt,
    )
    .run();
}

async function recordSentMessages(
  db: D1Database,
  row: DueScheduledChatMessageRow,
  parts: ScheduledChatMessagePart[],
  result: unknown,
  sentAt: string,
): Promise<void> {
  const ids = lineMessageIds(result, parts.length);
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    await db
      .prepare(
        `INSERT OR IGNORE INTO messages_log
         (id, friend_id, direction, message_type, content, source, line_account_id,
          line_message_id, sent_by_staff_id, sent_by_staff_name, created_at)
         VALUES (?, ?, 'outgoing', ?, ?, 'scheduled_manual', ?, ?, ?, ?, ?)`,
      )
      .bind(
        `${row.id}:${index}`,
        row.friend_id,
        part.messageType,
        part.content,
        row.line_account_id ?? row.friend_line_account_id,
        ids[index],
        row.created_by,
        row.created_by_name,
        sentAt,
      )
      .run();
  }

  await db
    .prepare(
      `UPDATE chats
       SET status = 'in_progress', is_long_term = 0, last_message_at = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(sentAt, sentAt, row.chat_id)
    .run();
}

export function serializeScheduledChatMessage(row: ScheduledChatMessageRow) {
  return {
    id: row.id,
    chatId: row.chat_id,
    friendId: row.friend_id,
    lineAccountId: row.line_account_id,
    messages: parseParts(row.messages_json),
    supportCaseId: row.support_case_id,
    scheduledAt: row.scheduled_at,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    sentAt: row.sent_at,
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getActiveScheduledChatMessages(
  db: D1Database,
  chatId: string,
): Promise<ScheduledChatMessageRow[]> {
  const result = await db
    .prepare(
      `SELECT *
       FROM scheduled_chat_messages
       WHERE chat_id = ?
         AND status IN ('pending', 'processing', 'failed', 'failed_permanent')
       ORDER BY scheduled_at ASC, created_at ASC
       LIMIT 20`,
    )
    .bind(chatId)
    .all<ScheduledChatMessageRow>();
  return result.results ?? [];
}

export async function processDueScheduledChatMessages(
  db: D1Database,
  params: {
    now: Date;
    defaultAccessToken: string;
    allowMutationsWhenDisabled?: boolean;
    sender?: ScheduledChatMessageSender;
  },
): Promise<{ sent: number; failed: number; skipped: number }> {
  const nowIso = params.now.toISOString();
  const processingStaleBefore = new Date(params.now.getTime() - SCHEDULED_CHAT_PROCESSING_TIMEOUT_MS).toISOString();
  await db
    .prepare(
      `UPDATE scheduled_chat_messages
       SET status = CASE WHEN attempts >= ? THEN 'failed_permanent' ELSE 'failed' END,
           next_attempt_at = ?,
           last_error = 'processing_timeout',
           updated_at = ?
       WHERE status = 'processing' AND updated_at <= ?`,
    )
    .bind(SCHEDULED_CHAT_MAX_ATTEMPTS, nowIso, nowIso, processingStaleBefore)
    .run();
  const due = await db
    .prepare(
      `SELECT scm.*, f.line_user_id, f.line_account_id AS friend_line_account_id,
              la.channel_access_token
       FROM scheduled_chat_messages scm
       INNER JOIN friends f ON f.id = scm.friend_id
       LEFT JOIN line_accounts la ON la.id = COALESCE(scm.line_account_id, f.line_account_id)
       WHERE scm.status IN ('pending', 'failed')
         AND scm.next_attempt_at <= ?
         AND scm.attempts < ?
         AND f.is_following = 1
       ORDER BY scm.next_attempt_at ASC
       LIMIT ?`,
    )
    .bind(nowIso, SCHEDULED_CHAT_MAX_ATTEMPTS, SCHEDULED_CHAT_BATCH_LIMIT)
    .all<DueScheduledChatMessageRow>();

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  const sender = params.sender ?? ((input: Parameters<ScheduledChatMessageSender>[0]) => {
    const client = new LineClient(input.channelAccessToken, {
      allowMutationsWhenDisabled: params.allowMutationsWhenDisabled,
    });
    return client.pushMessage(input.toLineUserId, input.messages, input.retryKey);
  });

  for (const row of due.results ?? []) {
    const claim = await db
      .prepare(
        `UPDATE scheduled_chat_messages
         SET status = 'processing', attempts = attempts + 1, updated_at = ?
         WHERE id = ? AND attempts = ? AND status IN ('pending', 'failed')`,
      )
      .bind(nowIso, row.id, row.attempts)
      .run();
    if (Number(claim.meta?.changes ?? 0) === 0) {
      skipped++;
      continue;
    }

    const claimedAttempts = row.attempts + 1;
    try {
      const accountId = row.line_account_id ?? row.friend_line_account_id;
      if (await getLineSendSafetyBlock(db, accountId)) {
        throw new Error('line_safety_blocked');
      }
      const parts = parseParts(row.messages_json);
      const messages = parts.map(toLineMessage);
      let result: unknown = null;
      try {
        result = await sender({
          channelAccessToken: row.channel_access_token || params.defaultAccessToken,
          toLineUserId: row.line_user_id,
          messages,
          retryKey: row.id,
        });
      } catch (err) {
        // 409 means this retry key was already accepted by LINE. Treat it as sent
        // and finish the local bookkeeping without issuing another delivery.
        if (parseLineStatus(err) !== 409) throw err;
      }

      const sentAt = jstNow();
      await recordSentMessages(db, row, parts, result, sentAt);
      try {
        await recordScheduledSupportReply(db, row, parts, sentAt);
      } catch (err) {
        console.error(`scheduled support reply bookkeeping failed: ${scheduledErrorKind(err)}`);
      }
      await db
        .prepare(
          `UPDATE scheduled_chat_messages
           SET status = 'sent', sent_at = ?, last_error = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .bind(sentAt, sentAt, row.id)
        .run();
      sent++;
    } catch (err) {
      const retryable = isRetryableScheduledError(err) && claimedAttempts < SCHEDULED_CHAT_MAX_ATTEMPTS;
      const nextStatus = retryable ? 'failed' : 'failed_permanent';
      const retryAt = new Date(params.now.getTime() + Math.max(5, claimedAttempts * 5) * 60_000).toISOString();
      await db
        .prepare(
          `UPDATE scheduled_chat_messages
           SET status = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
           WHERE id = ?`,
        )
        .bind(nextStatus, retryAt, scheduledErrorKind(err), nowIso, row.id)
        .run();
      failed++;
    }
  }

  return { sent, failed, skipped };
}

export const _internals = {
  SCHEDULED_CHAT_MAX_ATTEMPTS,
  SCHEDULED_CHAT_PROCESSING_TIMEOUT_MS,
  parseParts,
  toLineMessage,
};

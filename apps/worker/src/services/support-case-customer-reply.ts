import { jstNow } from '@line-crm/db';

type SupportCaseCandidate = {
  id: string;
};

export type RestoreSupportCasesFromCustomerMessageParams = {
  friendId: string;
  lineAccountId: string | null;
  messageType: string;
  lineMessageId: string | null;
  webhookEventId: string | null;
  receivedAt?: string;
};

export type RestoreSupportCasesFromCustomerMessageResult = {
  restored: number;
  caseIds: string[];
};

function resultChanges(result: D1Result<unknown> | undefined): number {
  return Number(result?.meta?.changes ?? 0);
}

function eventIdFor(caseId: string, sourceEventId: string): string {
  return `customer-reply-received:${caseId}:${sourceEventId}`;
}

/**
 * Return customer-reply-waiting support cases to the primary queue.
 *
 * The audit insert runs immediately before its matching status update in one
 * D1 batch. Both statements repeat the same status/account guard, so retries
 * and concurrent webhook deliveries cannot change unrelated case states.
 */
export async function restoreSupportCasesFromCustomerMessage(
  db: D1Database,
  params: RestoreSupportCasesFromCustomerMessageParams,
): Promise<RestoreSupportCasesFromCustomerMessageResult> {
  const receivedAt = params.receivedAt ?? jstNow();
  const sourceEventId = params.webhookEventId?.trim() || `fallback:${crypto.randomUUID()}`;
  const accountCondition = params.lineAccountId
    ? 'AND sc.line_account_id = ?'
    : 'AND sc.line_account_id IS NULL';
  const accountBinds = params.lineAccountId ? [params.lineAccountId] : [];

  const candidates = await db
    .prepare(
      `SELECT sc.id
       FROM support_cases sc
       WHERE sc.friend_id = ?
         AND sc.status = 'customer_reply'
         ${accountCondition}
         AND NOT EXISTS (
           SELECT 1
           FROM support_case_events sce
           WHERE sce.id = 'customer-reply-received:' || sc.id || ':' || ?
         )
       ORDER BY sc.updated_at DESC`,
    )
    .bind(params.friendId, ...accountBinds, sourceEventId)
    .all<SupportCaseCandidate>();

  if (candidates.results.length === 0) {
    return { restored: 0, caseIds: [] };
  }

  const statements: D1PreparedStatement[] = [];
  for (const candidate of candidates.results) {
    const eventId = eventIdFor(candidate.id, sourceEventId);
    const metadata = JSON.stringify({
      source: 'line_webhook',
      friendId: params.friendId,
      lineAccountId: params.lineAccountId,
      messageType: params.messageType,
      lineMessageId: params.lineMessageId,
      webhookEventId: params.webhookEventId,
      previousStatus: 'customer_reply',
      nextStatus: 'waiting_primary',
    });

    statements.push(
      db
        .prepare(
          `INSERT INTO support_case_events
           (id, case_id, event_type, actor_id, actor_name, body, metadata, created_at)
           SELECT ?, sc.id, 'customer_reply_received', ?, '顧客', ?, ?, ?
           FROM support_cases sc
           WHERE sc.id = ?
             AND sc.friend_id = ?
             AND sc.status = 'customer_reply'
             ${accountCondition}`,
        )
        .bind(
          eventId,
          params.friendId,
          '顧客から返信を受信したため、一次対応待ちに戻しました',
          metadata,
          receivedAt,
          candidate.id,
          params.friendId,
          ...accountBinds,
        ),
      db
        .prepare(
          `UPDATE support_cases AS sc
           SET status = 'waiting_primary',
               updated_at = ?
           WHERE sc.id = ?
             AND sc.friend_id = ?
             AND sc.status = 'customer_reply'
             ${accountCondition}`,
        )
        .bind(receivedAt, candidate.id, params.friendId, ...accountBinds),
    );
  }

  const results = await db.batch(statements);
  const caseIds = candidates.results
    .filter((_, index) => resultChanges(results[index * 2 + 1]) > 0)
    .map((candidate) => candidate.id);

  return { restored: caseIds.length, caseIds };
}

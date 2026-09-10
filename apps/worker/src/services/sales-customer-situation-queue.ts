import { toJstString } from '@line-crm/db';

export type SalesCustomerSituationQueueSubject = {
  subjectKind: 'friend' | 'conversation';
  subjectId: string;
  lineAccountId: string;
};

type QueueRow = {
  subject_kind: SalesCustomerSituationQueueSubject['subjectKind'];
  subject_id: string;
  line_account_id: string;
  queued_at: string;
  attempts: number;
};

export type SalesCustomerSituationQueueResult = {
  scanned: number;
  claimed: number;
  completed: number;
  retried: number;
  superseded: number;
};

export class SalesCustomerSituationQueueProcessError extends Error {
  constructor(readonly kind: string, options?: { cause?: unknown }) {
    super('sales customer situation queue processing failed', options);
    this.name = 'SalesCustomerSituationQueueProcessError';
  }
}

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
const LEASE_MINUTES = 10;

function errorKind(error: unknown): string {
  const raw = error instanceof SalesCustomerSituationQueueProcessError
    ? error.kind
    : error instanceof TypeError
      ? 'network_error'
      : error instanceof Error
        ? error.name || 'error'
        : typeof error;
  const safe = raw.toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 64);
  return safe || 'error';
}

function retryAt(now: Date, previousAttempts: number): string {
  const nextAttempt = Math.max(1, previousAttempts + 1);
  const delayMinutes = Math.min(60, 5 * (2 ** Math.min(nextAttempt - 1, 4)));
  return toJstString(new Date(now.getTime() + delayMinutes * 60_000));
}

function changed(result: D1Result<unknown>): boolean {
  return Number(result.meta?.changes ?? 0) > 0;
}

export async function processSalesCustomerSituationQueue(
  db: D1Database,
  options: {
    now?: Date;
    limit?: number;
    processSubject: (subject: SalesCustomerSituationQueueSubject) => Promise<void>;
  },
): Promise<SalesCustomerSituationQueueResult> {
  const now = options.now ?? new Date();
  const nowIso = toJstString(now);
  const requestedLimit = options.limit ?? DEFAULT_LIMIT;
  const limit = Number.isInteger(requestedLimit)
    ? Math.min(MAX_LIMIT, Math.max(1, requestedLimit))
    : DEFAULT_LIMIT;
  const rows = await db.prepare(
    `SELECT subject_kind, subject_id, line_account_id, queued_at, attempts
     FROM sales_customer_situation_queue
     WHERE datetime(available_at) <= datetime(?)
       AND (
         claimed_at IS NULL
         OR datetime(claimed_at) <= datetime(?, '-${LEASE_MINUTES} minutes')
       )
     ORDER BY datetime(available_at) ASC, queued_at ASC,
              subject_kind ASC, subject_id ASC
     LIMIT ?`,
  ).bind(nowIso, nowIso, limit).all<QueueRow>();

  const result: SalesCustomerSituationQueueResult = {
    scanned: rows.results.length,
    claimed: 0,
    completed: 0,
    retried: 0,
    superseded: 0,
  };

  for (const row of rows.results) {
    const claimToken = crypto.randomUUID();
    const claim = await db.prepare(
      `UPDATE sales_customer_situation_queue
       SET claim_token = ?, claimed_at = ?
       WHERE subject_kind = ? AND subject_id = ? AND queued_at = ?
         AND datetime(available_at) <= datetime(?)
         AND (
           claimed_at IS NULL
           OR datetime(claimed_at) <= datetime(?, '-${LEASE_MINUTES} minutes')
         )`,
    ).bind(
      claimToken,
      nowIso,
      row.subject_kind,
      row.subject_id,
      row.queued_at,
      nowIso,
      nowIso,
    ).run();
    if (!changed(claim)) continue;
    result.claimed += 1;

    try {
      await options.processSubject({
        subjectKind: row.subject_kind,
        subjectId: row.subject_id,
        lineAccountId: row.line_account_id,
      });
      const removed = await db.prepare(
        `DELETE FROM sales_customer_situation_queue
         WHERE subject_kind = ? AND subject_id = ?
           AND queued_at = ? AND claim_token = ?`,
      ).bind(row.subject_kind, row.subject_id, row.queued_at, claimToken).run();
      if (changed(removed)) result.completed += 1;
      else result.superseded += 1;
    } catch (error) {
      const released = await db.prepare(
        `UPDATE sales_customer_situation_queue
         SET attempts = attempts + 1, last_error_kind = ?, available_at = ?,
             claim_token = NULL, claimed_at = NULL
         WHERE subject_kind = ? AND subject_id = ?
           AND queued_at = ? AND claim_token = ?`,
      ).bind(
        errorKind(error),
        retryAt(now, row.attempts),
        row.subject_kind,
        row.subject_id,
        row.queued_at,
        claimToken,
      ).run();
      if (changed(released)) result.retried += 1;
      else result.superseded += 1;
    }
  }

  return result;
}

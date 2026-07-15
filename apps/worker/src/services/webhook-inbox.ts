const WEBHOOK_INBOX_PERSIST_ATTEMPTS = 2;
const WEBHOOK_INBOX_DEFAULT_LIMIT = 50;
const WEBHOOK_INBOX_MAX_LIMIT = 100;
const WEBHOOK_INBOX_STALE_AFTER_MS = 10 * 60 * 1000;
const WEBHOOK_INBOX_MAX_ATTEMPTS = 8;
const WEBHOOK_INBOX_RETRY_BASE_MS = 5 * 60 * 1000;
const WEBHOOK_INBOX_RETRY_MAX_MS = 60 * 60 * 1000;

export type WebhookInboxInput = {
  eventId: string;
  lineAccountId: string | null;
  payload: string;
  receivedAt: string;
};

export type WebhookInboxRecord<T = unknown> = {
  eventId: string;
  lineAccountId: string | null;
  payload: T;
  attempts: number;
};

type WebhookInboxRow = {
  webhook_event_id: string;
  line_account_id: string | null;
  event_payload: string;
  attempts: number;
};

type DrainWebhookInboxOptions = {
  eventIds?: string[];
  limit?: number;
  now?: () => string;
  errorKind?: (error: unknown) => string;
};

type PersistWebhookInboxOptions = {
  deadlineAtMs?: number;
};

export type DrainWebhookInboxResult = {
  processed: number;
  failed: number;
  skipped: number;
};

function resultChanges(result: D1Result<unknown>): number {
  return Number(result.meta?.changes ?? 0);
}

function defaultErrorKind(error: unknown): string {
  if (error instanceof SyntaxError) return 'invalid_event_payload';
  if (error instanceof TypeError) return 'network_error';
  if (error instanceof Error) return error.name || 'error';
  return typeof error;
}

function deadlineError(): Error {
  const error = new Error('Webhook inbox persistence deadline exceeded');
  error.name = 'WebhookInboxDeadlineError';
  return error;
}

async function runBeforeDeadline<T>(promise: Promise<T>, deadlineAtMs?: number): Promise<T> {
  if (deadlineAtMs === undefined) return promise;
  const remainingMs = deadlineAtMs - Date.now();
  if (remainingMs <= 0) throw deadlineError();

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => reject(deadlineError()), remainingMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

function nextRetryAt(failedAt: string, attempts: number): string {
  const delayMs = Math.min(
    WEBHOOK_INBOX_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1),
    WEBHOOK_INBOX_RETRY_MAX_MS,
  );
  return new Date(new Date(failedAt).getTime() + delayMs).toISOString();
}

export async function persistWebhookInboxEvents(
  db: D1Database,
  events: WebhookInboxInput[],
  options: PersistWebhookInboxOptions = {},
): Promise<void> {
  if (events.length === 0) return;

  let lastError: unknown = null;
  for (let attempt = 0; attempt < WEBHOOK_INBOX_PERSIST_ATTEMPTS; attempt += 1) {
    if (options.deadlineAtMs !== undefined && Date.now() >= options.deadlineAtMs) {
      throw deadlineError();
    }
    try {
      const statements = events.map((event) =>
        db
          .prepare(
            `INSERT INTO line_webhook_inbox
               (webhook_event_id, line_account_id, event_payload, status, attempts, received_at, updated_at)
             VALUES (?, ?, ?, 'pending', 0, ?, ?)
             ON CONFLICT(webhook_event_id) DO NOTHING`,
          )
          .bind(
            event.eventId,
            event.lineAccountId,
            event.payload,
            event.receivedAt,
            event.receivedAt,
          ),
      );
      await runBeforeDeadline(db.batch(statements), options.deadlineAtMs);
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error('Webhook inbox persistence failed');
}

export async function drainWebhookInbox<T = unknown>(
  db: D1Database,
  processEvent: (record: WebhookInboxRecord<T>) => Promise<void>,
  options: DrainWebhookInboxOptions = {},
): Promise<DrainWebhookInboxResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const limit = Math.max(
    1,
    Math.min(Math.trunc(options.limit ?? WEBHOOK_INBOX_DEFAULT_LIMIT), WEBHOOK_INBOX_MAX_LIMIT),
  );
  const eventIds = [...new Set(options.eventIds ?? [])].slice(0, WEBHOOK_INBOX_MAX_LIMIT);
  const scanAt = now();
  const staleBefore = new Date(Date.now() - WEBHOOK_INBOX_STALE_AFTER_MS).toISOString();
  const retryableCondition = `(
    (status = 'pending' AND (next_attempt_at IS NULL OR julianday(next_attempt_at) <= julianday(?)))
    OR (status = 'processing' AND julianday(updated_at) <= julianday(?))
  )`;

  let statement: D1PreparedStatement;
  if (eventIds.length > 0) {
    const placeholders = eventIds.map(() => '?').join(', ');
    statement = db
      .prepare(
        `SELECT webhook_event_id, line_account_id, event_payload, attempts
         FROM line_webhook_inbox
         WHERE webhook_event_id IN (${placeholders})
           AND ${retryableCondition}
         ORDER BY received_at ASC
         LIMIT ?`,
      )
      .bind(...eventIds, scanAt, staleBefore, limit);
  } else {
    statement = db
      .prepare(
        `SELECT webhook_event_id, line_account_id, event_payload, attempts
         FROM line_webhook_inbox
         WHERE ${retryableCondition}
         ORDER BY received_at ASC
         LIMIT ?`,
      )
      .bind(scanAt, staleBefore, limit);
  }

  const rows = await statement.all<WebhookInboxRow>();
  const result: DrainWebhookInboxResult = { processed: 0, failed: 0, skipped: 0 };

  for (const row of rows.results ?? []) {
    const claimedAt = now();
    const claim = await db
      .prepare(
        `UPDATE line_webhook_inbox
         SET status = 'processing', attempts = attempts + 1, next_attempt_at = NULL, updated_at = ?
         WHERE webhook_event_id = ?
           AND (
             (status = 'pending' AND (next_attempt_at IS NULL OR julianday(next_attempt_at) <= julianday(?)))
             OR (status = 'processing' AND julianday(updated_at) <= julianday(?))
           )`,
      )
      .bind(claimedAt, row.webhook_event_id, scanAt, staleBefore)
      .run();

    if (resultChanges(claim) === 0) {
      result.skipped += 1;
      continue;
    }

    try {
      const payload = JSON.parse(row.event_payload) as T;
      await processEvent({
        eventId: row.webhook_event_id,
        lineAccountId: row.line_account_id,
        payload,
        attempts: row.attempts + 1,
      });
      const processedAt = now();
      await db
        .prepare(
          `UPDATE line_webhook_inbox
           SET status = 'processed', event_payload = '{}', processed_at = ?, last_error_kind = NULL,
               next_attempt_at = NULL, updated_at = ?
           WHERE webhook_event_id = ? AND status = 'processing'`,
        )
        .bind(processedAt, processedAt, row.webhook_event_id)
        .run();
      result.processed += 1;
    } catch (error) {
      const errorKind = (options.errorKind ?? defaultErrorKind)(error);
      const attempts = row.attempts + 1;
      const terminal = error instanceof SyntaxError || attempts >= WEBHOOK_INBOX_MAX_ATTEMPTS;
      const failedAt = now();
      await db
        .prepare(
          `UPDATE line_webhook_inbox
           SET status = ?, last_error_kind = ?, next_attempt_at = ?, updated_at = ?
           WHERE webhook_event_id = ? AND status = 'processing'`,
        )
        .bind(
          terminal ? 'failed' : 'pending',
          errorKind,
          terminal ? null : nextRetryAt(failedAt, attempts),
          failedAt,
          row.webhook_event_id,
        )
        .run();
      result.failed += 1;
    }
  }

  return result;
}

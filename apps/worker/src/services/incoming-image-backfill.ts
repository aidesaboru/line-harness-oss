import {
  fetchAndStoreIncomingImageDetailed,
  mergeIncomingImageRefs,
} from './incoming-image.js';

const DEFAULT_BATCH_SIZE = 15;
const MAX_BATCH_SIZE = 25;

type IncomingImageScope = 'personal' | 'group';

type IncomingImageCandidate = {
  scope: IncomingImageScope;
  id: string;
  content: string;
  line_message_id: string;
  line_account_id: string | null;
  created_at: string;
  cursor_key: string;
};

type ActiveLineAccount = {
  id: string;
  channel_access_token: string;
};

export type IncomingImageBackfillResult = {
  examined: number;
  persisted: number;
  unavailable: number;
  failed: number;
  nextCursor: string | null;
  hasMore: boolean;
};

export type IncomingImageBackfillOptions = {
  db: D1Database;
  defaultAccessToken: string;
  workerUrl: string;
  r2?: R2Bucket;
  files?: KVNamespace;
  cursor?: string | null;
  limit?: number;
  fetch?: typeof fetch;
};

function normalizeLimit(value: number | undefined): number {
  if (!Number.isInteger(value) || !value || value < 1) return DEFAULT_BATCH_SIZE;
  return Math.min(value, MAX_BATCH_SIZE);
}

async function loadCandidates(
  db: D1Database,
  cursor: string | null,
  limit: number,
): Promise<IncomingImageCandidate[]> {
  const result = await db
    .prepare(
      `WITH candidates AS (
         SELECT
           'personal' AS scope,
           id,
           content,
           COALESCE(
             NULLIF(line_message_id, ''),
             CASE
               WHEN json_valid(content) THEN CAST(COALESCE(
                 json_extract(content, '$.lineMessageId'),
                 json_extract(content, '$.line_message_id'),
                 json_extract(content, '$.messageId'),
                 json_extract(content, '$.message_id')
               ) AS TEXT)
               ELSE NULL
             END
           ) AS line_message_id,
           line_account_id,
           created_at,
           created_at || '|' || 'personal' || '|' || id AS cursor_key
         FROM messages_log
         WHERE direction = 'incoming'
           AND message_type = 'image'
           AND content NOT LIKE '%/images/incoming-%'
         UNION ALL
         SELECT
           'group' AS scope,
           id,
           content,
           COALESCE(
             NULLIF(line_message_id, ''),
             CASE
               WHEN json_valid(content) THEN CAST(COALESCE(
                 json_extract(content, '$.lineMessageId'),
                 json_extract(content, '$.line_message_id'),
                 json_extract(content, '$.messageId'),
                 json_extract(content, '$.message_id')
               ) AS TEXT)
               ELSE NULL
             END
           ) AS line_message_id,
           line_account_id,
           created_at,
           created_at || '|' || 'group' || '|' || id AS cursor_key
         FROM line_conversation_messages
         WHERE direction = 'incoming'
           AND message_type = 'image'
           AND content NOT LIKE '%/images/incoming-%'
       )
       SELECT *
       FROM candidates
       WHERE line_message_id IS NOT NULL
         AND line_message_id != ''
         AND (? IS NULL OR cursor_key < ?)
       ORDER BY cursor_key DESC
       LIMIT ?`,
    )
    .bind(cursor, cursor, limit + 1)
    .all<IncomingImageCandidate>();
  return result.results;
}

async function updateCandidate(
  db: D1Database,
  candidate: IncomingImageCandidate,
  content: string,
): Promise<boolean> {
  const table = candidate.scope === 'group'
    ? 'line_conversation_messages'
    : 'messages_log';
  const result = await db
    .prepare(
      `UPDATE ${table}
       SET content = ?
       WHERE id = ?
         AND content = ?
         AND direction = 'incoming'
         AND message_type = 'image'`,
    )
    .bind(content, candidate.id, candidate.content)
    .run();
  return Number((result as { meta?: { changes?: unknown } }).meta?.changes ?? 0) > 0;
}

/**
 * Persist a bounded page of historical incoming images.
 *
 * This is intentionally additive: the original message row is only updated
 * after the image bytes have been stored successfully, and no row or object is
 * deleted when LINE no longer has the original content.
 */
export async function backfillIncomingImages(
  options: IncomingImageBackfillOptions,
): Promise<IncomingImageBackfillResult> {
  const limit = normalizeLimit(options.limit);
  const candidates = await loadCandidates(options.db, options.cursor ?? null, limit);
  const page = candidates.slice(0, limit);
  const accounts = await options.db
    .prepare(
      `SELECT id, channel_access_token
       FROM line_accounts
       WHERE is_active = 1`,
    )
    .all<ActiveLineAccount>();
  const tokenByAccountId = new Map(
    accounts.results.map((account) => [account.id, account.channel_access_token]),
  );

  let persisted = 0;
  let unavailable = 0;
  let failed = 0;
  for (const candidate of page) {
    const accessToken = candidate.line_account_id
      ? tokenByAccountId.get(candidate.line_account_id)
      : options.defaultAccessToken;
    if (!accessToken) {
      failed += 1;
      continue;
    }

    const result = await fetchAndStoreIncomingImageDetailed({
      r2: options.r2,
      files: options.files,
      fetch: options.fetch,
      workerUrl: options.workerUrl,
      channelAccessToken: accessToken,
      accountId: candidate.line_account_id ?? 'default',
      messageId: candidate.line_message_id,
    });
    if (!result.ok) {
      if (result.reason === 'line_content_unavailable' && result.status === 404) {
        unavailable += 1;
      } else {
        failed += 1;
      }
      continue;
    }

    const nextContent = mergeIncomingImageRefs(
      candidate.content,
      candidate.line_message_id,
      result.refs,
    );
    if (await updateCandidate(options.db, candidate, nextContent)) {
      persisted += 1;
    } else {
      failed += 1;
    }
  }

  const last = page.at(-1);
  return {
    examined: page.length,
    persisted,
    unavailable,
    failed,
    nextCursor: last?.cursor_key ?? null,
    hasMore: candidates.length > limit,
  };
}

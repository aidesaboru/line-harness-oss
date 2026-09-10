import { describe, expect, test, vi } from 'vitest';
import {
  processSalesCustomerSituationQueue,
  SalesCustomerSituationQueueProcessError,
} from './sales-customer-situation-queue.js';

type QueueState = {
  subjectKind: 'friend' | 'conversation';
  subjectId: string;
  lineAccountId: string;
  queuedAt: string;
  availableAt: string;
  attempts: number;
  lastErrorKind: string | null;
  claimToken: string | null;
  claimedAt: string | null;
};

function d1Result(changes: number): D1Result<unknown> {
  return { success: true, meta: { changes } } as unknown as D1Result<unknown>;
}

function queueDb(initial: QueueState[]) {
  const rows = initial.map((row) => ({ ...row }));
  const calls: Array<{ sql: string; binds: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          binds = values;
          calls.push({ sql, binds });
          return statement;
        },
        async all<T>() {
          const limit = Number(binds[2]);
          return {
            results: rows.slice(0, limit).map((row) => ({
              subject_kind: row.subjectKind,
              subject_id: row.subjectId,
              line_account_id: row.lineAccountId,
              queued_at: row.queuedAt,
              attempts: row.attempts,
            })) as T[],
          };
        },
        async run() {
          if (sql.startsWith('UPDATE sales_customer_situation_queue\n       SET claim_token')) {
            const [claimToken, claimedAt, subjectKind, subjectId, queuedAt] = binds;
            const row = rows.find((candidate) => (
              candidate.subjectKind === subjectKind
              && candidate.subjectId === subjectId
              && candidate.queuedAt === queuedAt
              && candidate.claimToken === null
            ));
            if (!row) return d1Result(0);
            row.claimToken = String(claimToken);
            row.claimedAt = String(claimedAt);
            return d1Result(1);
          }
          if (sql.startsWith('DELETE FROM sales_customer_situation_queue')) {
            const [subjectKind, subjectId, queuedAt, claimToken] = binds;
            const index = rows.findIndex((row) => (
              row.subjectKind === subjectKind
              && row.subjectId === subjectId
              && row.queuedAt === queuedAt
              && row.claimToken === claimToken
            ));
            if (index < 0) return d1Result(0);
            rows.splice(index, 1);
            return d1Result(1);
          }
          if (sql.startsWith('UPDATE sales_customer_situation_queue\n         SET attempts')) {
            const [kind, availableAt, subjectKind, subjectId, queuedAt, claimToken] = binds;
            const row = rows.find((candidate) => (
              candidate.subjectKind === subjectKind
              && candidate.subjectId === subjectId
              && candidate.queuedAt === queuedAt
              && candidate.claimToken === claimToken
            ));
            if (!row) return d1Result(0);
            row.attempts += 1;
            row.lastErrorKind = String(kind);
            row.availableAt = String(availableAt);
            row.claimToken = null;
            row.claimedAt = null;
            return d1Result(1);
          }
          return d1Result(0);
        },
      };
      return statement;
    },
  } as unknown as D1Database;
  return { db, rows, calls };
}

const now = new Date('2026-09-11T00:00:00.000Z');
const dueRow = (overrides: Partial<QueueState> = {}): QueueState => ({
  subjectKind: 'friend',
  subjectId: 'friend-1',
  lineAccountId: 'account-1',
  queuedAt: '2026-09-11T08:50:00.000+09:00',
  availableAt: '2026-09-11T08:51:00.000+09:00',
  attempts: 0,
  lastErrorKind: null,
  claimToken: null,
  claimedAt: null,
  ...overrides,
});

describe('sales customer situation queue', () => {
  test('leases, processes, and removes an unchanged queue item', async () => {
    const harness = queueDb([dueRow()]);
    const processSubject = vi.fn().mockResolvedValue(undefined);

    const result = await processSalesCustomerSituationQueue(harness.db, {
      now,
      processSubject,
    });

    expect(result).toEqual({ scanned: 1, claimed: 1, completed: 1, retried: 0, superseded: 0 });
    expect(processSubject).toHaveBeenCalledWith({
      subjectKind: 'friend',
      subjectId: 'friend-1',
      lineAccountId: 'account-1',
    });
    expect(harness.rows).toHaveLength(0);
    expect(harness.calls[0].sql).toContain("datetime(claimed_at) <= datetime(?, '-10 minutes')");
  });

  test('releases failures with a bounded kind and exponential retry time', async () => {
    const harness = queueDb([dueRow({ attempts: 2 })]);

    const result = await processSalesCustomerSituationQueue(harness.db, {
      now,
      processSubject: async () => {
        throw new SalesCustomerSituationQueueProcessError('ai_unavailable');
      },
    });

    expect(result).toEqual({ scanned: 1, claimed: 1, completed: 0, retried: 1, superseded: 0 });
    expect(harness.rows[0]).toMatchObject({
      attempts: 3,
      lastErrorKind: 'ai_unavailable',
      availableAt: '2026-09-11T09:20:00.000+09:00',
      claimToken: null,
      claimedAt: null,
    });
  });

  test('preserves a newer message that arrives while the leased item is processing', async () => {
    const harness = queueDb([dueRow()]);

    const result = await processSalesCustomerSituationQueue(harness.db, {
      now,
      processSubject: async () => {
        harness.rows[0].queuedAt = '2026-09-11T09:00:01.000+09:00';
        harness.rows[0].availableAt = '2026-09-11T09:01:01.000+09:00';
        harness.rows[0].claimToken = null;
        harness.rows[0].claimedAt = null;
      },
    });

    expect(result).toEqual({ scanned: 1, claimed: 1, completed: 0, retried: 0, superseded: 1 });
    expect(harness.rows).toHaveLength(1);
    expect(harness.rows[0].queuedAt).toBe('2026-09-11T09:00:01.000+09:00');
  });
});

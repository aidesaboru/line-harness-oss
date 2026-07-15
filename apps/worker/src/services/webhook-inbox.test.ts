import { describe, expect, test, vi } from 'vitest';
import { drainWebhookInbox, persistWebhookInboxEvents } from './webhook-inbox.js';

describe('webhook inbox persistence', () => {
  test('stores multiple events in one idempotent D1 batch and retries only that batch', async () => {
    const prepared: Array<{ sql: string; binds: unknown[] }> = [];
    const batch = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary D1 error'))
      .mockResolvedValueOnce([{ success: true }, { success: true }]);
    const db = {
      prepare: vi.fn((sql: string) => ({
        bind: (...binds: unknown[]) => {
          prepared.push({ sql, binds });
          return { sql, binds };
        },
      })),
      batch,
    } as unknown as D1Database;

    await persistWebhookInboxEvents(db, [
      {
        eventId: 'event-1',
        lineAccountId: 'account-1',
        payload: '{"type":"message"}',
        receivedAt: '2026-07-15T13:00:00.000+09:00',
      },
      {
        eventId: 'event-2',
        lineAccountId: 'account-1',
        payload: '{"type":"follow"}',
        receivedAt: '2026-07-15T13:00:00.000+09:00',
      },
    ]);

    expect(batch).toHaveBeenCalledTimes(2);
    expect(batch.mock.calls[1]?.[0]).toHaveLength(2);
    expect(prepared).toHaveLength(4);
    expect(prepared[0]?.sql).toContain('ON CONFLICT(webhook_event_id) DO NOTHING');
    expect(prepared[0]?.binds[0]).toBe('event-1');
    expect(prepared[1]?.binds[0]).toBe('event-2');
  });

  test('does not start a D1 write after the response deadline', async () => {
    const batch = vi.fn();
    const db = {
      prepare: vi.fn(() => ({ bind: vi.fn(() => ({})) })),
      batch,
    } as unknown as D1Database;

    await expect(persistWebhookInboxEvents(db, [{
      eventId: 'event-expired',
      lineAccountId: null,
      payload: '{"type":"message"}',
      receivedAt: '2026-07-15T13:00:00.000+09:00',
    }], { deadlineAtMs: Date.now() - 1 })).rejects.toMatchObject({
      name: 'WebhookInboxDeadlineError',
    });
    expect(batch).not.toHaveBeenCalled();
  });
});

describe('webhook inbox draining', () => {
  test('returns a partially processed event to pending and completes it on the next drain', async () => {
    const row = {
      webhook_event_id: 'event-1',
      line_account_id: 'account-1',
      event_payload: '{"type":"message"}',
      attempts: 0,
      status: 'pending',
      last_error_kind: null as string | null,
      next_attempt_at: null as string | null,
    };

    const db = {
      prepare: vi.fn((sql: string) => ({
        bind: (...binds: unknown[]) => ({
          all: vi.fn(async () => ({
            success: true,
            results: row.status === 'pending' && (
              row.next_attempt_at === null || row.next_attempt_at <= String(binds[0])
            ) ? [{
              webhook_event_id: row.webhook_event_id,
              line_account_id: row.line_account_id,
              event_payload: row.event_payload,
              attempts: row.attempts,
            }] : [],
          })),
          run: vi.fn(async () => {
            if (sql.includes("SET status = 'processing'")) {
              if (row.status !== 'pending') return { success: true, meta: { changes: 0 } };
              row.status = 'processing';
              row.attempts += 1;
              row.next_attempt_at = null;
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.includes("SET status = 'processed'")) {
              row.status = 'processed';
              row.last_error_kind = null;
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.includes('SET status = ?')) {
              row.status = String(binds[0]);
              row.last_error_kind = String(binds[1]);
              row.next_attempt_at = binds[2] === null ? null : String(binds[2]);
              return { success: true, meta: { changes: 1 } };
            }
            throw new Error(`Unexpected SQL: ${sql}`);
          }),
        }),
      })),
    } as unknown as D1Database;
    const processEvent = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('chat update failed'), { name: 'D1Error' }))
      .mockResolvedValueOnce(undefined);
    let currentTime = '2026-07-15T13:00:01.000+09:00';
    const now = vi.fn(() => currentTime);

    const first = await drainWebhookInbox(db, processEvent, {
      now,
      errorKind: (error) => error instanceof Error ? error.name : 'unknown',
    });
    expect(first).toEqual({ processed: 0, failed: 1, skipped: 0 });
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1);
    expect(row.last_error_kind).toBe('D1Error');
    expect(row.next_attempt_at).not.toBeNull();

    currentTime = '2026-07-15T13:06:00.000+09:00';
    const second = await drainWebhookInbox(db, processEvent, { now });
    expect(second).toEqual({ processed: 1, failed: 0, skipped: 0 });
    expect(row.status).toBe('processed');
    expect(row.attempts).toBe(2);
    expect(processEvent).toHaveBeenCalledTimes(2);
  });
});

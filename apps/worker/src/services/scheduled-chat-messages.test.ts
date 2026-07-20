import { describe, expect, test, vi } from 'vitest';
import { setLineMutationsDisabled } from '@line-crm/line-sdk';
import {
  processDueScheduledChatMessages,
  type ScheduledChatMessageRow,
} from './scheduled-chat-messages.js';

type DueRow = ScheduledChatMessageRow & {
  line_user_id: string;
  friend_line_account_id: string | null;
  channel_access_token: string | null;
};

function dueRow(overrides: Partial<DueRow> = {}): DueRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    chat_id: 'chat-1',
    friend_id: 'friend-1',
    line_account_id: 'account-1',
    messages_json: JSON.stringify([
      { messageType: 'image', content: JSON.stringify({ originalContentUrl: 'https://example.com/a.jpg', previewImageUrl: 'https://example.com/a.jpg' }) },
      { messageType: 'text', content: '翌朝のご案内です' },
    ]),
    support_case_id: null,
    scheduled_at: '2026-07-20T23:00:00.000Z',
    next_attempt_at: '2026-07-20T23:00:00.000Z',
    status: 'pending',
    attempts: 0,
    last_error: null,
    created_by: 'staff-1',
    created_by_name: '田島',
    sent_at: null,
    cancelled_at: null,
    created_at: '2026-07-20T12:00:00.000+09:00',
    updated_at: '2026-07-20T12:00:00.000+09:00',
    line_user_id: 'U-friend-1',
    friend_line_account_id: 'account-1',
    channel_access_token: 'account-token',
    ...overrides,
  };
}

function makeDb(row: DueRow) {
  const logs: Array<{ id: string; type: string; content: string }> = [];
  const calls: Array<{ sql: string; binds: unknown[] }> = [];
  let chatLongTerm = 1;

  const db = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...values: unknown[]) {
          binds = values;
          return stmt;
        },
        async all<T>() {
          calls.push({ sql, binds });
          if (sql.includes('FROM scheduled_chat_messages scm')) {
            const due = (row.status === 'pending' || row.status === 'failed') && row.attempts < 3;
            return { results: due ? [row as T] : [] };
          }
          return { results: [] as T[] };
        },
        async first<T>() {
          calls.push({ sql, binds });
          return null as T | null;
        },
        async run() {
          calls.push({ sql, binds });
          let changes = 1;
          if (sql.includes("SET status = 'processing'")) {
            const expectedAttempts = Number(binds[2]);
            if ((row.status !== 'pending' && row.status !== 'failed') || row.attempts !== expectedAttempts) {
              changes = 0;
            } else {
              row.status = 'processing';
              row.attempts += 1;
            }
          } else if (sql.includes('INSERT OR IGNORE INTO messages_log')) {
            logs.push({ id: String(binds[0]), type: String(binds[2]), content: String(binds[3]) });
          } else if (sql.includes('UPDATE chats') && sql.includes('is_long_term = 0')) {
            chatLongTerm = 0;
          } else if (sql.includes("SET status = 'sent'")) {
            row.status = 'sent';
            row.sent_at = String(binds[0]);
            row.last_error = null;
          } else if (sql.includes('SET status = ?, next_attempt_at = ?')) {
            row.status = String(binds[0]) as DueRow['status'];
            row.next_attempt_at = String(binds[1]);
            row.last_error = String(binds[2]);
          }
          return { success: true, meta: { changes } };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;

  return { db, row, logs, calls, getChatLongTerm: () => chatLongTerm };
}

describe('scheduled chat messages', () => {
  test('sends all message parts once and records them with the reservation id', async () => {
    const state = makeDb(dueRow());
    const sender = vi.fn().mockResolvedValue({
      sentMessages: [{ id: 'line-image' }, { id: 'line-text' }],
    });

    const result = await processDueScheduledChatMessages(state.db, {
      now: new Date('2026-07-21T00:00:00.000Z'),
      defaultAccessToken: 'fallback-token',
      sender,
    });

    expect(result).toEqual({ sent: 1, failed: 0, skipped: 0 });
    expect(sender).toHaveBeenCalledWith(expect.objectContaining({
      channelAccessToken: 'account-token',
      toLineUserId: 'U-friend-1',
      retryKey: '11111111-1111-4111-8111-111111111111',
      messages: [
        { type: 'image', originalContentUrl: 'https://example.com/a.jpg', previewImageUrl: 'https://example.com/a.jpg' },
        { type: 'text', text: '翌朝のご案内です' },
      ],
    }));
    expect(state.logs.map((log) => log.id)).toEqual([
      '11111111-1111-4111-8111-111111111111:0',
      '11111111-1111-4111-8111-111111111111:1',
    ]);
    expect(state.row.status).toBe('sent');
    expect(state.getChatLongTerm()).toBe(0);
  });

  test('treats LINE retry-key conflict as an already accepted delivery', async () => {
    const state = makeDb(dueRow());
    const sender = vi.fn().mockRejectedValue(new Error('LINE API error: 409 Conflict'));

    const result = await processDueScheduledChatMessages(state.db, {
      now: new Date('2026-07-21T00:00:00.000Z'),
      defaultAccessToken: 'fallback-token',
      sender,
    });

    expect(result.sent).toBe(1);
    expect(state.row.status).toBe('sent');
    expect(state.logs).toHaveLength(2);
  });

  test('keeps a transient LINE failure retryable', async () => {
    const state = makeDb(dueRow());
    const sender = vi.fn().mockRejectedValue(new Error('LINE API error: 500 Internal Server Error'));

    const result = await processDueScheduledChatMessages(state.db, {
      now: new Date('2026-07-21T00:00:00.000Z'),
      defaultAccessToken: 'fallback-token',
      sender,
    });

    expect(result).toEqual({ sent: 0, failed: 1, skipped: 0 });
    expect(state.row.status).toBe('failed');
    expect(state.row.attempts).toBe(1);
    expect(state.row.last_error).toBe('line_http_status_500');
    expect(state.logs).toHaveLength(0);
  });

  test('allows an operator-scheduled delivery while capture-only mode blocks automatic sends', async () => {
    const state = makeDb(dueRow());
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ sentMessages: [{ id: 'line-image' }, { id: 'line-text' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    setLineMutationsDisabled(true);

    try {
      const result = await processDueScheduledChatMessages(state.db, {
        now: new Date('2026-07-21T00:00:00.000Z'),
        defaultAccessToken: 'fallback-token',
        allowMutationsWhenDisabled: true,
      });

      expect(result.sent).toBe(1);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.line.me/v2/bot/message/push',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'X-Line-Retry-Key': '11111111-1111-4111-8111-111111111111',
          }),
        }),
      );
    } finally {
      setLineMutationsDisabled(false);
      vi.unstubAllGlobals();
    }
  });
});

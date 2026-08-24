import { describe, expect, test, vi } from 'vitest';
import {
  checkInternalChatDataAccess,
  monitorInternalChatHealth,
} from './internal-chat-health.js';

function makeDb(options: { fail?: boolean } = {}) {
  return {
    prepare: vi.fn(() => ({
      first: vi.fn(async () => {
        if (options.fail) throw new Error('D1 unavailable');
        return { support_messages_ready: 1 };
      }),
    })),
  } as unknown as D1Database;
}

function makeStateStore(initial: string | null = null) {
  let value = initial;
  return {
    get: vi.fn(async () => value),
    put: vi.fn(async (_key: string, next: string) => {
      value = next;
    }),
    value: () => value,
  };
}

describe('internal chat health monitor', () => {
  test('checks every table needed by the internal chat feed without changing data', async () => {
    const db = makeDb();

    await expect(checkInternalChatDataAccess(db)).resolves.toBeUndefined();

    const sql = vi.mocked(db.prepare).mock.calls[0]?.[0] ?? '';
    expect(sql).toContain('FROM support_internal_messages');
    expect(sql).toContain('FROM chat_internal_messages');
    expect(sql).toContain('FROM internal_message_events');
    expect(sql).toContain('FROM internal_message_bookmark_events');
    expect(sql).toContain('FROM internal_tasks');
    expect(sql).not.toMatch(/DELETE\s+FROM/i);
    expect(sql).not.toMatch(/UPDATE\s+/i);
  });

  test('sends one Slack alert on failure and suppresses repeats during cooldown', async () => {
    const store = makeStateStore();
    const sender = vi.fn(async () => undefined);
    const runtime = {
      db: makeDb({ fail: true }),
      stateStore: store as unknown as KVNamespace,
      slackBotToken: 'xoxb-test',
      slackChannelId: 'C123',
      adminPublicUrl: 'https://admin.example.com',
      sendSlackMessage: sender,
    };

    await expect(monitorInternalChatHealth({
      ...runtime,
      now: new Date('2026-08-14T09:00:00.000Z'),
    })).resolves.toEqual({ status: 'failed', alertSent: true, recoverySent: false });
    await expect(monitorInternalChatHealth({
      ...runtime,
      now: new Date('2026-08-14T09:05:00.000Z'),
    })).resolves.toEqual({ status: 'failed', alertSent: false, recoverySent: false });

    expect(sender).toHaveBeenCalledTimes(1);
    expect(sender.mock.calls[0]?.[2]).toContain('異常を検知しました');
    expect(JSON.parse(store.value() ?? '{}')).toMatchObject({ status: 'failed' });
  });

  test('sends a recovery notice once after a failed state', async () => {
    const store = makeStateStore(JSON.stringify({
      status: 'failed',
      checkedAt: '2026-08-14T09:00:00.000Z',
      lastAlertAt: '2026-08-14T09:00:00.000Z',
    }));
    const sender = vi.fn(async () => undefined);

    await expect(monitorInternalChatHealth({
      db: makeDb(),
      stateStore: store as unknown as KVNamespace,
      slackBotToken: 'xoxb-test',
      slackChannelId: 'C123',
      sendSlackMessage: sender,
      now: new Date('2026-08-14T09:10:00.000Z'),
    })).resolves.toEqual({ status: 'healthy', alertSent: false, recoverySent: true });

    expect(sender).toHaveBeenCalledTimes(1);
    expect(sender.mock.calls[0]?.[2]).toContain('復旧しました');
    expect(JSON.parse(store.value() ?? '{}')).toMatchObject({ status: 'healthy' });
  });
});

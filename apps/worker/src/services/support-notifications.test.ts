import { describe, expect, test, vi } from 'vitest';
import {
  buildTicketCreatedSlackPayload,
  deliverSupportTicketSlackNotification,
  getSupportNotificationSettings,
  getSupportTicketSlackNotificationHealth,
  notifyUrgentSupportCase,
  parseSupportNotificationSettings,
  parseSupportSlackMentionMap,
  processPendingSupportTicketSlackNotifications,
  processSupportNotificationDigests,
  publicSupportNotificationSettings,
  sendSupportTicketSlackTestNotification,
  setSupportNotificationSettings,
  SUPPORT_NOTIFICATION_SETTING_KEY,
} from './support-notifications.js';

type AccountSetting = { value: string };
type SupportCase = {
  id: string;
  line_account_id: string;
  title: string;
  priority: string;
  status: string;
  primary_assignee: string | null;
  escalation_assignee: string | null;
  due_at: string | null;
  customer_number?: string | null;
  company_name?: string | null;
  contact_name?: string | null;
  customer_summary?: string | null;
  created_at?: string | null;
  updated_at: string;
  friend_name?: string | null;
};
type SupportEvent = {
  id: string;
  case_id: string;
  event_type: string;
  body: string;
  metadata: string;
};
type TicketSlackOutbox = {
  id: string;
  case_id: string;
  line_account_id: string;
  payload: string;
  status: 'pending' | 'sending' | 'failed' | 'dead_letter' | 'sent';
  attempts: number;
  next_attempt_at: string;
  claim_token: string | null;
  last_error_code: string | null;
  slack_message_ts: string | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
};

type DbCall = { method: 'first' | 'all' | 'run'; sql: string; binds: unknown[] };

function makeDb(state: {
  settings?: Record<string, string>;
  cases?: SupportCase[];
  events?: SupportEvent[];
  outbox?: TicketSlackOutbox[];
} = {}) {
  const settings = new Map<string, AccountSetting>(
    Object.entries(state.settings ?? {}).map(([key, value]) => [key, { value }]),
  );
  const cases = state.cases ?? [];
  const events = state.events ?? [];
  const outbox = state.outbox ?? [];
  const calls: DbCall[] = [];

  function settingKey(accountId: string, key: string): string {
    return `${accountId}:${key}`;
  }

  const db = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          bound = args;
          return stmt;
        },
        async first<T>() {
          calls.push({ method: 'first', sql, binds: bound });
          if (sql.includes('FROM account_settings')) {
            const [accountId, key] = bound as [string, string];
            return (settings.get(settingKey(accountId, key)) ?? null) as T | null;
          }
          if (sql.includes('FROM support_case_events')) {
            const [caseId, eventType] = bound as [string, string];
            const row = events.find((event) => event.case_id === caseId && event.event_type === eventType);
            return (row ? { id: row.id } : null) as T | null;
          }
          if (sql.includes('FROM support_slack_notification_outbox')) {
            const [outboxId] = bound as [string];
            return (outbox.find((row) => row.id === outboxId) ?? null) as T | null;
          }
          if (sql.includes('FROM support_cases sc') && sql.includes('WHERE sc.id = ?')) {
            const [caseId, accountId] = bound as [string, string];
            return (cases.find((row) => row.id === caseId && row.line_account_id === accountId) ?? null) as T | null;
          }
          return null as T | null;
        },
        async all<T>() {
          calls.push({ method: 'all', sql, binds: bound });
          if (sql.includes('FROM support_slack_notification_outbox')) {
            if (sql.includes('GROUP BY status')) {
              const counts = new Map<string, { count: number; lastUpdatedAt: string | null }>();
              for (const row of outbox) {
                const current = counts.get(row.status) ?? { count: 0, lastUpdatedAt: null };
                current.count += 1;
                if (!current.lastUpdatedAt || row.updated_at > current.lastUpdatedAt) {
                  current.lastUpdatedAt = row.updated_at;
                }
                counts.set(row.status, current);
              }
              return {
                results: Array.from(counts.entries()).map(([status, value]) => ({
                  status,
                  count: value.count,
                  last_updated_at: value.lastUpdatedAt,
                })) as T[],
              };
            }
            const [nowText, staleBefore, limit] = bound as [string, string, number];
            const rows = outbox
              .filter((row) => (
                (['pending', 'failed'].includes(row.status) && row.next_attempt_at <= nowText)
                || (row.status === 'sending' && row.updated_at <= staleBefore)
              ))
              .slice(0, limit)
              .map((row) => ({ id: row.id }));
            return { results: rows as T[] };
          }
          if (sql.includes('FROM support_cases sc')) {
            const [accountId] = bound as [string];
            return {
              results: cases.filter((row) => row.line_account_id === accountId && row.status !== 'resolved') as T[],
            };
          }
          return { results: [] as T[] };
        },
        async run() {
          calls.push({ method: 'run', sql, binds: bound });
          let changes = 1;
          if (sql.includes('INSERT INTO account_settings')) {
            const [, accountId, key, value] = bound as [string, string, string, string];
            settings.set(settingKey(accountId, key), { value });
          } else if (sql.includes('INSERT INTO support_case_events')) {
            const [id, caseId, eventType, , , body, metadata] = bound as string[];
            events.push({ id, case_id: caseId, event_type: eventType, body, metadata });
          } else if (sql.includes('UPDATE support_slack_notification_outbox')) {
            if (sql.includes("SET status = 'sending'")) {
              const [claimToken, updatedAt, outboxId, nowText, staleBefore] = bound as [string, string, string, string, string];
              const row = outbox.find((item) => item.id === outboxId);
              const claimable = Boolean(row) && (
                (['pending', 'failed'].includes(row!.status) && row!.next_attempt_at <= nowText)
                || (row!.status === 'sending' && row!.updated_at <= staleBefore)
              );
              if (!row || !claimable) {
                changes = 0;
              } else {
                row.status = 'sending';
                row.attempts += 1;
                row.claim_token = claimToken;
                row.last_error_code = null;
                row.updated_at = updatedAt;
              }
            } else if (sql.includes('SET status = ?, last_error_code = ?')) {
              const [status, errorCode, nextAttemptAt, updatedAt, outboxId, claimToken] =
                bound as ['failed' | 'dead_letter', string, string, string, string, string];
              const row = outbox.find(
                (item) => item.id === outboxId && item.status === 'sending' && item.claim_token === claimToken,
              );
              if (!row) changes = 0;
              else {
                row.status = status;
                row.last_error_code = errorCode;
                row.next_attempt_at = nextAttemptAt;
                row.updated_at = updatedAt;
              }
            } else if (sql.includes("SET status = 'sent'")) {
              const [messageTs, sentAt, updatedAt, outboxId, claimToken] =
                bound as [string | null, string, string, string, string];
              const row = outbox.find(
                (item) => item.id === outboxId && item.status === 'sending' && item.claim_token === claimToken,
              );
              if (!row) changes = 0;
              else {
                row.status = 'sent';
                row.slack_message_ts = messageTs;
                row.sent_at = sentAt;
                row.updated_at = updatedAt;
              }
            }
          }
          return { success: true, meta: { changes } };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;

  return { db, calls, state: { settings, cases, events, outbox } };
}

describe('support notification settings', () => {
  test('parse settings uses safe defaults and hides webhook URL in public output', () => {
    const parsed = parseSupportNotificationSettings(JSON.stringify({
      enabled: true,
      webhookUrl: ' https://hooks.slack.test/abc ',
      digestHours: [17, 12, 12, 'bad', 99],
      dueSoonHours: 8,
    }));

    expect(parsed).toEqual({
      enabled: true,
      webhookUrl: 'https://hooks.slack.test/abc',
      immediateUrgent: true,
      digestEnabled: true,
      digestHours: [12, 17],
      dueSoonHours: 8,
    });
    expect(publicSupportNotificationSettings(parsed)).toEqual({
      enabled: true,
      webhookConfigured: true,
      immediateUrgent: true,
      digestEnabled: true,
      digestHours: [12, 17],
      dueSoonHours: 8,
    });
    expect(parseSupportNotificationSettings('{')).toMatchObject({ enabled: false, webhookUrl: null });
  });

  test('setSupportNotificationSettings preserves existing webhook URL when omitted', async () => {
    const { db } = makeDb({
      settings: {
        [`acc-1:${SUPPORT_NOTIFICATION_SETTING_KEY}`]: JSON.stringify({
          enabled: true,
          webhookUrl: 'https://hooks.slack.test/old',
          immediateUrgent: true,
          digestEnabled: true,
          digestHours: [12],
          dueSoonHours: 4,
        }),
      },
    });

    await setSupportNotificationSettings(db, 'acc-1', { enabled: false, digestHours: [14, 17] });
    await expect(getSupportNotificationSettings(db, 'acc-1')).resolves.toMatchObject({
      enabled: false,
      webhookUrl: 'https://hooks.slack.test/old',
      digestHours: [14, 17],
    });
  });
});

describe('support Slack notifications', () => {
  test('urgent case notification sends once and records an event', async () => {
    const { db, state } = makeDb({
      settings: {
        [`acc-1:${SUPPORT_NOTIFICATION_SETTING_KEY}`]: JSON.stringify({
          enabled: true,
          webhookUrl: 'https://hooks.slack.test/support',
          immediateUrgent: true,
          digestEnabled: true,
          digestHours: [12],
          dueSoonHours: 4,
        }),
      },
      cases: [{
        id: 'case-1',
        line_account_id: 'acc-1',
        title: '至急確認',
        priority: 'urgent',
        status: 'waiting_secondary',
        primary_assignee: '一次',
        escalation_assignee: '二次',
        due_at: '2026-06-25T12:00:00.000+09:00',
        customer_number: 'C-001',
        company_name: '株式会社テスト',
        contact_name: '山田 太郎',
        customer_summary: '配送状況を急ぎで確認してほしいです。',
        created_at: '2026-06-25T09:30:00.000+09:00',
        updated_at: '2026-06-25T09:00:00.000+09:00',
        friend_name: '山田',
      }],
    });
    const sent: Array<{ url: string; payload: Record<string, unknown> }> = [];
    const sender = async (url: string, payload: Record<string, unknown>) => {
      sent.push({ url, payload });
    };

    await expect(notifyUrgentSupportCase(db, 'acc-1', 'case-1', {
      adminPublicUrl: 'https://admin.test',
      now: new Date('2026-06-25T01:00:00.000Z'),
      sendWebhook: sender,
    })).resolves.toEqual({ sent: true, reason: 'sent' });
    await expect(notifyUrgentSupportCase(db, 'acc-1', 'case-1', {
      adminPublicUrl: 'https://admin.test',
      now: new Date('2026-06-25T01:00:00.000Z'),
      sendWebhook: sender,
    })).resolves.toEqual({ sent: false, reason: 'already_sent' });

    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('https://hooks.slack.test/support');
    expect(String(sent[0].payload.text)).toContain('大至急');
    expect(String(sent[0].payload.text)).toContain('顧客番号: C-001');
    expect(String(sent[0].payload.text)).toContain('法人名: 株式会社テスト');
    expect(String(sent[0].payload.text)).toContain('顧客名: 山田 太郎');
    expect(String(sent[0].payload.text)).toContain('発生: 本日 09:30 (経過:約30分)');
    expect(String(sent[0].payload.text)).toContain('期限: 本日 12:00 まで');
    expect(String(sent[0].payload.text)).toContain('https://admin.test/support?case=case-1');
    const payloadJson = JSON.stringify(sent[0].payload);
    expect(payloadJson).toContain('"color":"#e01e5a"');
    expect(payloadJson).toContain('問い合わせ概要');
    expect(payloadJson).toContain('チケットを開く');
    expect(state.events.map((event) => event.event_type)).toContain('slack_urgent_sent');
  });

  test('digest notification sends at configured hours and dedupes the same hour', async () => {
    const { db } = makeDb({
      settings: {
        [`acc-1:${SUPPORT_NOTIFICATION_SETTING_KEY}`]: JSON.stringify({
          enabled: true,
          webhookUrl: 'https://hooks.slack.test/support',
          immediateUrgent: true,
          digestEnabled: true,
          digestHours: [12],
          dueSoonHours: 4,
        }),
      },
      cases: [
        {
          id: 'case-1',
          line_account_id: 'acc-1',
          title: '期限超過',
          priority: 'high',
          status: 'waiting_primary',
          primary_assignee: '一次',
          escalation_assignee: null,
          due_at: '2026-06-25T11:00:00.000+09:00',
          updated_at: '2026-06-25T09:00:00.000+09:00',
          friend_name: '山田',
        },
        {
          id: 'case-2',
          line_account_id: 'acc-1',
          title: '回答待ち',
          priority: 'medium',
          status: 'waiting_secondary',
          primary_assignee: '一次',
          escalation_assignee: '二次',
          due_at: '2026-06-25T15:00:00.000+09:00',
          updated_at: '2026-06-25T09:00:00.000+09:00',
          friend_name: '佐藤',
        },
      ],
    });
    const sent: Array<Record<string, unknown>> = [];
    const sender = async (_url: string, payload: Record<string, unknown>) => {
      sent.push(payload);
    };
    const now = new Date('2026-06-25T03:00:00.000Z'); // JST 12:00

    await expect(processSupportNotificationDigests(db, {
      accountIds: ['acc-1'],
      adminPublicUrl: 'https://admin.test',
      now,
      sendWebhook: sender,
    })).resolves.toEqual({ sent: 1, skipped: 0, failed: 0 });
    await expect(processSupportNotificationDigests(db, {
      accountIds: ['acc-1'],
      adminPublicUrl: 'https://admin.test',
      now: new Date('2026-06-25T03:05:00.000Z'),
      sendWebhook: sender,
    })).resolves.toEqual({ sent: 0, skipped: 1, failed: 0 });

    expect(sent).toHaveLength(1);
    expect(String(sent[0].text)).toContain('担当者別');
    expect(String(sent[0].text)).toContain('一次: 1件');
    expect(String(sent[0].text)).toContain('二次: 1件');
    expect(String(sent[0].text)).toContain('https://admin.test/support');
  });

  test('ticket-created payload mentions every secondary assignee and escapes customer text', () => {
    const mentionMap = parseSupportSlackMentionMap(JSON.stringify({
      'staff-yoshida': 'U06SWBHATLY',
      'staff-tajima': 'U09SEGPGT50',
    }));
    const built = buildTicketCreatedSlackPayload({
      caseId: '6a08e4d2-c0c3-4b5f-85b5-370514b3b7c9',
      title: '返金確認 <!channel>',
      priority: 'urgent',
      primaryAssignee: '林 静香',
      secondaryAssignees: [
        { name: '吉田 京平', staffId: 'staff-yoshida' },
        { name: '田島', staffId: 'staff-tajima' },
      ],
      customerSummary: '<@U99999999>へ至急確認してください',
      customerNumber: '4408',
      companyName: '株式会社テスト',
      contactName: '山田 太郎',
      dueAt: '2026-07-24T10:00:00.000+09:00',
    }, {
      channelId: 'C09SPA06P0S',
      url: 'https://admin.test/support?case=case-1',
      mentionMap,
    });

    expect(built.unmappedAssignees).toEqual([]);
    expect(built.payload.channel).toBe('C09SPA06P0S');
    expect(String(built.payload.text)).toContain('<@U06SWBHATLY> <@U09SEGPGT50>');
    expect(String(built.payload.text)).toContain('一次対応: 林 静香');
    expect(String(built.payload.text)).toContain('緊急度: 大至急');
    expect(String(built.payload.text)).toContain('&lt;@U99999999&gt;');
    expect(String(built.payload.text)).toContain('&lt;!channel&gt;');
    expect(String(built.payload.text)).not.toContain('\n対応内容: <@U99999999>');
    const payloadJson = JSON.stringify(built.payload);
    expect(payloadJson).toContain('簡易的な対応内容');
    expect(payloadJson).toContain('チケットを開く');
  });

  test('ticket-created outbox sends once, stores Slack timestamp, and records an audit event', async () => {
    const now = new Date('2026-07-23T13:00:00.000Z');
    const outbox: TicketSlackOutbox = {
      id: 'outbox-1',
      case_id: '6a08e4d2-c0c3-4b5f-85b5-370514b3b7c9',
      line_account_id: 'acc-1',
      payload: JSON.stringify({
        caseId: '6a08e4d2-c0c3-4b5f-85b5-370514b3b7c9',
        title: '返金確認',
        priority: 'high',
        primaryAssignee: '林 静香',
        secondaryAssignees: [{ name: '吉田 京平', staffId: 'staff-yoshida' }],
        customerSummary: '返金状況を確認してください',
        customerNumber: '4408',
        companyName: '株式会社テスト',
        contactName: '山田 太郎',
        dueAt: null,
      }),
      status: 'pending',
      attempts: 0,
      next_attempt_at: '2026-07-23T21:59:00.000+09:00',
      claim_token: null,
      last_error_code: null,
      slack_message_ts: null,
      sent_at: null,
      created_at: '2026-07-23T21:59:00.000+09:00',
      updated_at: '2026-07-23T21:59:00.000+09:00',
    };
    const { db, state } = makeDb({ outbox: [outbox] });
    const sent: Array<Record<string, unknown>> = [];
    const runtime = {
      adminPublicUrl: 'https://admin.test',
      slackBotToken: 'xoxb-test',
      slackChannelId: 'C09SPA06P0S',
      slackMentionMap: JSON.stringify({ 'staff-yoshida': 'U06SWBHATLY' }),
      now,
      sendSlackMessage: async (_token: string, payload: Record<string, unknown>) => {
        sent.push(payload);
        return { messageTs: '1784811600.123456' };
      },
    };

    await expect(deliverSupportTicketSlackNotification(db, outbox.id, runtime))
      .resolves.toEqual({ sent: true, reason: 'sent' });
    await expect(deliverSupportTicketSlackNotification(db, outbox.id, runtime))
      .resolves.toEqual({ sent: false, reason: 'already_sent' });

    expect(sent).toHaveLength(1);
    expect(outbox.status).toBe('sent');
    expect(outbox.attempts).toBe(1);
    expect(outbox.slack_message_ts).toBe('1784811600.123456');
    expect(state.events).toEqual([
      expect.objectContaining({
        case_id: outbox.case_id,
        event_type: 'slack_ticket_created_sent',
      }),
    ]);
  });

  test('temporary Slack failure remains in the outbox and cron retries it', async () => {
    const outbox: TicketSlackOutbox = {
      id: 'outbox-retry',
      case_id: 'da60c3e5-9fc3-47f3-9c08-e370b36c50ab',
      line_account_id: 'acc-1',
      payload: JSON.stringify({
        caseId: 'da60c3e5-9fc3-47f3-9c08-e370b36c50ab',
        title: '配送確認',
        priority: 'medium',
        primaryAssignee: '梶原 麻奈美',
        secondaryAssignees: [{ name: '田島', staffId: 'staff-tajima' }],
        customerSummary: '配送状況を確認してください',
        customerNumber: null,
        companyName: null,
        contactName: null,
        dueAt: null,
      }),
      status: 'pending',
      attempts: 0,
      next_attempt_at: '2026-07-23T21:59:00.000+09:00',
      claim_token: null,
      last_error_code: null,
      slack_message_ts: null,
      sent_at: null,
      created_at: '2026-07-23T21:59:00.000+09:00',
      updated_at: '2026-07-23T21:59:00.000+09:00',
    };
    const { db } = makeDb({ outbox: [outbox] });
    const baseRuntime = {
      adminPublicUrl: 'https://admin.test',
      slackBotToken: 'xoxb-test',
      slackChannelId: 'C09SPA06P0S',
      slackMentionMap: JSON.stringify({ 'staff-tajima': 'U09SEGPGT50' }),
    };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await expect(deliverSupportTicketSlackNotification(db, outbox.id, {
        ...baseRuntime,
        now: new Date('2026-07-23T13:00:00.000Z'),
        sendSlackMessage: async () => {
          throw new Error('temporary network failure');
        },
      })).resolves.toEqual({ sent: false, reason: 'delivery_failed' });
      expect(outbox.status).toBe('failed');
      expect(outbox.attempts).toBe(1);
      expect(outbox.last_error_code).toBe('delivery_error');

      await expect(processPendingSupportTicketSlackNotifications(db, {
        ...baseRuntime,
        now: new Date('2026-07-23T13:02:00.000Z'),
        sendSlackMessage: async () => ({ messageTs: '1784811720.123456' }),
      })).resolves.toEqual({ sent: 1, skipped: 0, failed: 0 });
      expect(outbox.status).toBe('sent');
      expect(outbox.attempts).toBe(2);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('test notification requires a resolved Slack mention', async () => {
    await expect(sendSupportTicketSlackTestNotification({
      slackBotToken: 'xoxb-test',
      slackChannelId: 'C09SPA06P0S',
      slackMentionMap: '{}',
      sendSlackMessage: async () => ({ messageTs: null }),
    }, '宮本 森一')).resolves.toEqual({
      sent: false,
      reason: 'mention_mapping_missing',
    });
  });

  test('notification health exposes pending and dead-letter counts without secrets', async () => {
    const base: Omit<TicketSlackOutbox, 'id' | 'status'> = {
      case_id: 'case-1',
      line_account_id: 'acc-1',
      payload: '{}',
      attempts: 1,
      next_attempt_at: '2026-07-23T22:00:00.000+09:00',
      claim_token: null,
      last_error_code: null,
      slack_message_ts: null,
      sent_at: null,
      created_at: '2026-07-23T22:00:00.000+09:00',
      updated_at: '2026-07-23T22:00:00.000+09:00',
    };
    const { db } = makeDb({
      outbox: [
        { ...base, id: 'outbox-pending', status: 'pending' },
        {
          ...base,
          id: 'outbox-dead',
          status: 'dead_letter',
          last_error_code: 'not_in_channel',
          updated_at: '2026-07-23T22:05:00.000+09:00',
        },
      ],
    });

    await expect(getSupportTicketSlackNotificationHealth(db)).resolves.toEqual({
      pending: 1,
      sending: 0,
      failed: 0,
      deadLetter: 1,
      sent: 0,
      lastUpdatedAt: '2026-07-23T22:05:00.000+09:00',
    });
  });
});

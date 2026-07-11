import { describe, expect, test } from 'vitest';
import {
  getSupportNotificationSettings,
  notifyUrgentSupportCase,
  parseSupportNotificationSettings,
  processSupportNotificationDigests,
  publicSupportNotificationSettings,
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

type DbCall = { method: 'first' | 'all' | 'run'; sql: string; binds: unknown[] };

function makeDb(state: {
  settings?: Record<string, string>;
  cases?: SupportCase[];
  events?: SupportEvent[];
} = {}) {
  const settings = new Map<string, AccountSetting>(
    Object.entries(state.settings ?? {}).map(([key, value]) => [key, { value }]),
  );
  const cases = state.cases ?? [];
  const events = state.events ?? [];
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
          if (sql.includes('FROM support_cases sc') && sql.includes('WHERE sc.id = ?')) {
            const [caseId, accountId] = bound as [string, string];
            return (cases.find((row) => row.id === caseId && row.line_account_id === accountId) ?? null) as T | null;
          }
          return null as T | null;
        },
        async all<T>() {
          calls.push({ method: 'all', sql, binds: bound });
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
          if (sql.includes('INSERT INTO account_settings')) {
            const [, accountId, key, value] = bound as [string, string, string, string];
            settings.set(settingKey(accountId, key), { value });
          } else if (sql.includes('INSERT INTO support_case_events')) {
            const [id, caseId, eventType, , , body, metadata] = bound as string[];
            events.push({ id, case_id: caseId, event_type: eventType, body, metadata });
          }
          return { success: true, meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;

  return { db, calls, state: { settings, cases, events } };
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
});

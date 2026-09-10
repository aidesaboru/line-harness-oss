import { describe, expect, test, vi } from 'vitest';
import {
  buildPrimaryResponseDeadlineSlackPayload,
  customerResponseReminderAt,
  processPrimaryResponseDeadlineSlackNotifications,
} from './support-notifications.js';

type CaseRow = {
  id: string;
  lineAccountId: string;
  title: string;
  status: string;
  dueAt: string | null;
  reminderAt: string | null;
  primaryStaffId: string | null;
};

type StaffRow = {
  id: string;
  name: string;
  active: boolean;
  slackUserId: string | null;
};

type OutboxRow = {
  id: string;
  caseId: string;
  lineAccountId: string;
  responseDueAt: string;
  reminderAt: string;
  recipientStaffId: string;
  status: 'pending' | 'sending' | 'failed' | 'dead_letter' | 'cancelled' | 'sent';
  attempts: number;
  nextAttemptAt: string;
  claimToken: string | null;
  lastErrorCode: string | null;
  slackMessageTs: string | null;
  sentAt: string | null;
  createdAt: string;
  updatedAt: string;
};

function d1Result(changes: number): D1Result<unknown> {
  return { success: true, meta: { changes } } as unknown as D1Result<unknown>;
}

function notificationDb(input: {
  cases: CaseRow[];
  staff: StaffRow[];
  outbox?: OutboxRow[];
}) {
  const cases = input.cases.map((row) => ({ ...row }));
  const staff = input.staff.map((row) => ({ ...row }));
  const outbox = (input.outbox ?? []).map((row) => ({ ...row }));
  const events: Array<{ caseId: string; eventType: string; metadata: string }> = [];
  let generated = 0;

  function currentMatch(row: OutboxRow) {
    const supportCase = cases.find((candidate) => (
      candidate.id === row.caseId && candidate.lineAccountId === row.lineAccountId
    ));
    const recipient = staff.find((candidate) => candidate.id === row.recipientStaffId && candidate.active);
    return supportCase
      && recipient
      && supportCase.status !== 'resolved'
      && supportCase.dueAt === row.responseDueAt
      && supportCase.reminderAt === row.reminderAt
      && supportCase.primaryStaffId === row.recipientStaffId
      ? { supportCase, recipient }
      : null;
  }

  const db = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          binds = values;
          return statement;
        },
        async run() {
          if (
            sql.startsWith('UPDATE support_primary_response_slack_outbox AS outbox')
            && sql.includes("SET status = 'cancelled'")
          ) {
            const [now] = binds as [string];
            let changes = 0;
            for (const row of outbox) {
              if (!['pending', 'sending', 'failed', 'dead_letter'].includes(row.status) || currentMatch(row)) continue;
              row.status = 'cancelled';
              row.claimToken = null;
              row.updatedAt = now;
              changes += 1;
            }
            return d1Result(changes);
          }
          if (
            sql.startsWith('UPDATE support_primary_response_slack_outbox AS outbox')
            && sql.includes("SET status = 'pending'")
          ) {
            const [nextAttemptAt, updatedAt, nowText] = binds as [string, string, string];
            let changes = 0;
            for (const row of outbox) {
              if (row.status !== 'cancelled' || !currentMatch(row) || row.reminderAt > nowText) continue;
              row.status = 'pending';
              row.attempts = 0;
              row.nextAttemptAt = nextAttemptAt;
              row.claimToken = null;
              row.lastErrorCode = null;
              row.updatedAt = updatedAt;
              changes += 1;
            }
            return d1Result(changes);
          }
          if (sql.startsWith('INSERT OR IGNORE INTO support_primary_response_slack_outbox')) {
            const [nextAttemptAt, createdAt, updatedAt, now] = binds as [string, string, string, string];
            let changes = 0;
            for (const supportCase of cases) {
              const recipient = staff.find((row) => row.id === supportCase.primaryStaffId && row.active);
              if (
                !recipient
                || supportCase.status === 'resolved'
                || !supportCase.dueAt
                || !supportCase.reminderAt
                || supportCase.reminderAt > now
                || outbox.some((row) => (
                  row.caseId === supportCase.id
                  && row.responseDueAt === supportCase.dueAt
                  && row.recipientStaffId === supportCase.primaryStaffId
                ))
              ) continue;
              generated += 1;
              outbox.push({
                id: `generated-${generated}`,
                caseId: supportCase.id,
                lineAccountId: supportCase.lineAccountId,
                responseDueAt: supportCase.dueAt,
                reminderAt: supportCase.reminderAt,
                recipientStaffId: recipient.id,
                status: 'pending',
                attempts: 0,
                nextAttemptAt,
                claimToken: null,
                lastErrorCode: null,
                slackMessageTs: null,
                sentAt: null,
                createdAt,
                updatedAt,
              });
              changes += 1;
            }
            return d1Result(changes);
          }
          if (sql.includes("SET status = 'sending', attempts = attempts + 1")) {
            const [claimToken, now, outboxId, dueBefore, staleBefore] = binds as string[];
            const row = outbox.find((candidate) => candidate.id === outboxId);
            if (!row) return d1Result(0);
            const canClaim = (
              (['pending', 'failed'].includes(row.status) && row.nextAttemptAt <= dueBefore)
              || (row.status === 'sending' && row.updatedAt <= staleBefore)
            );
            if (!canClaim) return d1Result(0);
            row.status = 'sending';
            row.attempts += 1;
            row.claimToken = claimToken;
            row.lastErrorCode = null;
            row.updatedAt = now;
            return d1Result(1);
          }
          if (sql.includes("SET status = 'sent', slack_message_ts")) {
            const [messageTs, sentAt, updatedAt, outboxId, claimToken] = binds as string[];
            const row = outbox.find((candidate) => (
              candidate.id === outboxId && candidate.status === 'sending' && candidate.claimToken === claimToken
            ));
            if (!row) return d1Result(0);
            row.status = 'sent';
            row.slackMessageTs = messageTs;
            row.sentAt = sentAt;
            row.claimToken = null;
            row.updatedAt = updatedAt;
            return d1Result(1);
          }
          if (sql.includes("SET status = 'cancelled', claim_token = NULL")) {
            const [updatedAt, outboxId, claimToken] = binds as string[];
            const row = outbox.find((candidate) => candidate.id === outboxId && candidate.claimToken === claimToken);
            if (!row) return d1Result(0);
            row.status = 'cancelled';
            row.claimToken = null;
            row.updatedAt = updatedAt;
            return d1Result(1);
          }
          if (sql.includes('SET status = ?, last_error_code = ?')) {
            const [status, errorCode, nextAttemptAt, updatedAt, outboxId, claimToken] = binds as string[];
            const row = outbox.find((candidate) => candidate.id === outboxId && candidate.claimToken === claimToken);
            if (!row) return d1Result(0);
            row.status = status as OutboxRow['status'];
            row.lastErrorCode = errorCode;
            row.nextAttemptAt = nextAttemptAt;
            row.claimToken = null;
            row.updatedAt = updatedAt;
            return d1Result(1);
          }
          if (sql.startsWith('INSERT INTO support_case_events')) {
            const [, caseId, eventType, , , , metadata] = binds as string[];
            events.push({ caseId, eventType, metadata });
            return d1Result(1);
          }
          return d1Result(0);
        },
        async all<T>() {
          const [now, staleBefore, limit] = binds as [string, string, number];
          const rows = outbox
            .filter((row) => (
              (['pending', 'failed'].includes(row.status) && row.nextAttemptAt <= now)
              || (row.status === 'sending' && row.updatedAt <= staleBefore)
            ))
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
            .slice(0, limit)
            .map((row) => ({ id: row.id })) as T[];
          return { results: rows };
        },
        async first<T>() {
          const [outboxId, claimToken] = binds as string[];
          const outboxRow = outbox.find((row) => (
            row.id === outboxId && row.status === 'sending' && row.claimToken === claimToken
          ));
          if (!outboxRow) return null as T | null;
          const matched = currentMatch(outboxRow);
          if (!matched) return null as T | null;
          return {
            id: outboxRow.id,
            case_id: outboxRow.caseId,
            line_account_id: outboxRow.lineAccountId,
            response_due_at: outboxRow.responseDueAt,
            reminder_at: outboxRow.reminderAt,
            recipient_staff_id: outboxRow.recipientStaffId,
            recipient_name: matched.recipient.name,
            slack_user_id: matched.recipient.slackUserId,
            title: matched.supportCase.title,
            attempts: outboxRow.attempts,
          } as T;
        },
      };
      return statement;
    },
  } as unknown as D1Database;
  return { db, cases, staff, outbox, events };
}

const now = new Date('2026-09-11T01:05:00.000Z');
const baseCase = (overrides: Partial<CaseRow> = {}): CaseRow => ({
  id: 'case-1',
  lineAccountId: 'account-1',
  title: '返品方法の確認',
  status: 'in_progress',
  dueAt: '2026-09-14T18:00:00.000+09:00',
  reminderAt: '2026-09-11T10:00:00.000+09:00',
  primaryStaffId: 'staff-primary',
  ...overrides,
});

const primaryStaff = (overrides: Partial<StaffRow> = {}): StaffRow => ({
  id: 'staff-primary',
  name: '一次担当',
  active: true,
  slackUserId: 'U01234567',
  ...overrides,
});

describe('primary response deadline Slack notifications', () => {
  test('calculates the reminder on the previous weekday', () => {
    expect(customerResponseReminderAt('2026-09-14T18:00:00.000+09:00'))
      .toBe('2026-09-11T10:00:00.000+09:00');
    expect(customerResponseReminderAt('2026-09-16T18:00:00.000+09:00'))
      .toBe('2026-09-15T10:00:00.000+09:00');
    expect(customerResponseReminderAt('invalid')).toBeNull();
  });

  test('builds a minimal primary-only payload without conversation content', () => {
    const payload = buildPrimaryResponseDeadlineSlackPayload({
      id: 'outbox-1',
      case_id: 'case-1',
      title: '返品方法の確認',
      response_due_at: '2026-09-14T18:00:00.000+09:00',
    }, {
      channelId: 'channel-1',
      slackUserId: 'U01234567',
      url: 'https://example.test/support?case=case-1',
      now,
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).toContain('<@U01234567>');
    expect(serialized).toContain('一次対応者本人');
    expect(serialized).not.toContain('問い合わせ本文');
    expect(payload.client_msg_id).toBe('outbox-1');
  });

  test('queues once, mentions the current primary responder, and records delivery', async () => {
    const harness = notificationDb({ cases: [baseCase()], staff: [primaryStaff()] });
    const sendSlackMessage = vi.fn().mockResolvedValue({ messageTs: '1720000000.000001' });

    const first = await processPrimaryResponseDeadlineSlackNotifications(harness.db, {
      slackBotToken: 'test-token',
      slackChannelId: 'channel-1',
      adminPublicUrl: 'https://example.test',
      now,
      sendSlackMessage,
    });
    const second = await processPrimaryResponseDeadlineSlackNotifications(harness.db, {
      slackBotToken: 'test-token',
      slackChannelId: 'channel-1',
      now,
      sendSlackMessage,
    });

    expect(first).toEqual({ queued: 1, cancelled: 0, sent: 1, skipped: 0, failed: 0 });
    expect(second).toEqual({ queued: 0, cancelled: 0, sent: 0, skipped: 0, failed: 0 });
    expect(sendSlackMessage).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(sendSlackMessage.mock.calls[0]?.[1])).toContain('<@U01234567>');
    expect(harness.outbox[0]).toMatchObject({ status: 'sent', attempts: 1 });
    expect(harness.events[0]?.eventType).toBe('slack_primary_response_deadline_sent');
  });

  test('cancels an obsolete recipient and sends only to the newly assigned primary', async () => {
    const old: OutboxRow = {
      id: 'old-outbox',
      caseId: 'case-1',
      lineAccountId: 'account-1',
      responseDueAt: '2026-09-14T18:00:00.000+09:00',
      reminderAt: '2026-09-11T10:00:00.000+09:00',
      recipientStaffId: 'staff-old',
      status: 'pending',
      attempts: 0,
      nextAttemptAt: '2026-09-11T10:00:00.000+09:00',
      claimToken: null,
      lastErrorCode: null,
      slackMessageTs: null,
      sentAt: null,
      createdAt: '2026-09-11T10:00:00.000+09:00',
      updatedAt: '2026-09-11T10:00:00.000+09:00',
    };
    const harness = notificationDb({
      cases: [baseCase()],
      staff: [primaryStaff(), primaryStaff({ id: 'staff-old', name: '旧担当', slackUserId: 'UOLD1234' })],
      outbox: [old],
    });
    const sendSlackMessage = vi.fn().mockResolvedValue({ messageTs: '1720000000.000002' });

    const result = await processPrimaryResponseDeadlineSlackNotifications(harness.db, {
      slackBotToken: 'test-token',
      slackChannelId: 'channel-1',
      now,
      sendSlackMessage,
    });

    expect(result).toEqual({ queued: 1, cancelled: 1, sent: 1, skipped: 0, failed: 0 });
    expect(harness.outbox.find((row) => row.id === 'old-outbox')?.status).toBe('cancelled');
    expect(JSON.stringify(sendSlackMessage.mock.calls[0]?.[1])).toContain('<@U01234567>');
    expect(JSON.stringify(sendSlackMessage.mock.calls[0]?.[1])).not.toContain('<@UOLD1234>');
  });

  test('keeps the delivery retryable when the primary responder has no Slack mapping', async () => {
    const harness = notificationDb({
      cases: [baseCase()],
      staff: [primaryStaff({ slackUserId: null })],
    });

    const result = await processPrimaryResponseDeadlineSlackNotifications(harness.db, {
      slackBotToken: 'test-token',
      slackChannelId: 'channel-1',
      now,
      sendSlackMessage: vi.fn(),
    });

    expect(result).toEqual({ queued: 1, cancelled: 0, sent: 0, skipped: 0, failed: 1 });
    expect(harness.outbox[0]).toMatchObject({
      status: 'failed',
      attempts: 1,
      lastErrorCode: 'mention_mapping_missing',
    });
  });
});

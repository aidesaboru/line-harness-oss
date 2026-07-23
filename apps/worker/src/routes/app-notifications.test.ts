import { describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { appNotifications } from './app-notifications.js';

type Staff = { id: string; name: string; role: 'owner' | 'admin' | 'staff' | 'secondary' };

type TestEnv = {
  Variables: { staff: Staff };
  Bindings: { DB: D1Database };
};

type DbCall = {
  sql: string;
  binds: unknown[];
};

function makeDb() {
  const calls: DbCall[] = [];
  const prepare = vi.fn((sql: string) => ({
    bind: (...binds: unknown[]) => {
      calls.push({ sql, binds });
      return {
        all: vi.fn(async () => {
          if (sql.includes('sc.friend_name')) {
            throw new Error('no such column: sc.friend_name');
          }
          if (sql.includes('sc.priority = ?')) {
            return {
              results: [
                {
                  id: 'case-urgent',
                  title: '至急確認',
                  friend_name: '山田 太郎',
                  updated_at: '2026-07-11T09:00:00.000',
                },
              ],
            };
          }
          return { results: [] };
        }),
        first: vi.fn(async () => null),
        run: vi.fn(async () => ({ success: true })),
      };
    },
  }));
  const batch = vi.fn(async (statements: Array<{ run: () => Promise<unknown> }>) => (
    Promise.all(statements.map((statement) => statement.run()))
  ));
  return { db: { prepare, batch } as unknown as D1Database, calls };
}

function setupApp(
  db: D1Database,
  staff: Staff = { id: 'owner-1', name: 'Owner', role: 'owner' },
) {
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    c.set('staff', staff);
    c.env = { DB: db };
    await next();
  });
  app.route('/', appNotifications);
  return app;
}

function makeInternalChatDb() {
  const calls: DbCall[] = [];
  const prepare = vi.fn((sql: string) => ({
    bind: (...binds: unknown[]) => {
      calls.push({ sql, binds });
      return {
        all: vi.fn(async () => {
          if (sql.includes('FROM support_internal_messages sim') && sql.includes('sim.parent_id')) {
            return {
              results: [
                {
                  id: 'message-new',
                  case_id: 'case-1',
                  case_title: '過去案件を確認',
                  customer_name: '山田 太郎',
                  parent_id: null,
                  body: '過去ログの本文です',
                  mentions: '["Owner"]',
                  reactions: '{}',
                  created_by: 'staff-2',
                  created_by_name: 'Staff Two',
                  created_at: '2026-07-21T10:00:00.000',
                },
                {
                  id: 'message-old',
                  case_id: 'case-1',
                  case_title: '過去案件を確認',
                  customer_name: '山田 太郎',
                  parent_id: null,
                  body: 'さらに古い本文です',
                  mentions: '[]',
                  reactions: '{}',
                  created_by: 'owner-1',
                  created_by_name: 'Owner',
                  created_at: '2026-07-20T10:00:00.000',
                },
              ],
            };
          }
          if (sql.includes('FROM chat_internal_messages cim') && sql.includes('cim.parent_id')) {
            return { results: [] };
          }
          if (sql.includes('FROM internal_message_mentions')) {
            return { results: [{ source_message_id: 'message-new', staff_id: 'owner-1' }] };
          }
          if (sql.includes('FROM internal_conversation_reads')) {
            return {
              results: [{ conversation_id: 'support:case-1', last_read_at: '2026-07-20T12:00:00.000' }],
            };
          }
          return { results: [] };
        }),
        first: vi.fn(async () => (
          sql.includes('FROM internal_conversations') ? { id: 'support:case-1' } : null
        )),
        run: vi.fn(async () => ({ success: true })),
      };
    },
  }));
  const batch = vi.fn(async (statements: Array<{ run: () => Promise<unknown> }>) => (
    Promise.all(statements.map((statement) => statement.run()))
  ));
  return { db: { prepare, batch } as unknown as D1Database, calls };
}

function makeFollowUpReminderDb() {
  const calls: DbCall[] = [];
  const prepare = vi.fn((sql: string) => ({
    bind: (...binds: unknown[]) => {
      calls.push({ sql, binds });
      return {
        all: vi.fn(async () => {
          if (sql.includes('FROM support_case_followup_reminders scr')) {
            return {
              results: [{
                reminder_id: 'reminder-1',
                case_id: 'case-1',
                interval_days: 3,
                next_due_at: '2026-07-20T10:00:00.000+09:00',
                case_status: 'resolved',
                closed_at: '2026-07-22T09:00:00.000+09:00',
                updated_at: '2026-07-22T09:00:00.000+09:00',
                case_title: '請求内容の確認',
                friend_name: '山田 太郎',
              }],
            };
          }
          return { results: [] };
        }),
        first: vi.fn(async () => null),
        run: vi.fn(async () => ({ success: true })),
      };
    },
  }));
  const batch = vi.fn(async (statements: Array<{ run: () => Promise<unknown> }>) => (
    Promise.all(statements.map((statement) => statement.run()))
  ));
  return { db: { prepare, batch } as unknown as D1Database, calls };
}

function makeInternalTaskDb() {
  const calls: DbCall[] = [];
  const task = {
    id: 'task-1',
    line_account_id: 'acc-1',
    source_type: 'chat',
    source_id: 'friend-1',
    source_message_id: 'message-1',
    title: '口座情報を確認する',
    description: '顧客の回答を確認',
    status: 'open',
    due_at: '2026-07-24T10:00:00.000+09:00',
    created_by: 'staff-1',
    created_by_name: '林 静香',
    completed_by: null,
    completed_by_name: null,
    completed_at: null,
    created_at: '2026-07-23T10:00:00.000+09:00',
    updated_at: '2026-07-23T10:00:00.000+09:00',
    comment_count: 1,
  };
  const prepare = vi.fn((sql: string) => ({
    bind: (...binds: unknown[]) => {
      calls.push({ sql, binds });
      return {
        all: vi.fn(async () => {
          if (sql.includes('SELECT it.*')) return { results: [task] };
          if (sql.includes('FROM internal_task_assignees')) {
            return { results: [{ task_id: 'task-1', staff_id: 'staff-1', staff_name: '林 静香' }] };
          }
          if (sql.includes('FROM internal_task_comments')) {
            return {
              results: [{
                id: 'comment-1',
                task_id: 'task-1',
                body: '確認中です',
                created_by: 'staff-1',
                created_by_name: '林 静香',
                created_at: '2026-07-23T10:30:00.000+09:00',
              }],
            };
          }
          if (sql.includes('FROM staff_members')) {
            return { results: [{ id: 'staff-1', name: '林 静香' }] };
          }
          return { results: [] };
        }),
        first: vi.fn(async () => {
          if (sql.includes('SELECT * FROM internal_tasks')) return task;
          if (sql.includes('FROM friends f')) return { ok: 1 };
          if (sql.includes('FROM internal_task_assignees')) return { ok: 1 };
          return null;
        }),
        run: vi.fn(async () => ({ success: true })),
      };
    },
  }));
  const batch = vi.fn(async (statements: Array<{ run: () => Promise<unknown> }>) => (
    Promise.all(statements.map((statement) => statement.run()))
  ));
  return { db: { prepare, batch } as unknown as D1Database, calls };
}

describe('app notifications', () => {
  test('recent urgent notifications read customer names without support_cases.friend_name', async () => {
    const { db, calls } = makeDb();
    const res = await setupApp(db).request('/api/app-notifications/recent?after=2026-07-10T00:00:00.000Z&lineAccountId=acc-1');
    const body = await res.json() as {
      success: boolean;
      data: {
        items: Array<{ kind: string; body: string }>;
      };
    };

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.items).toEqual([
      expect.objectContaining({
        kind: 'urgent_case',
        body: '至急確認 / 山田 太郎',
      }),
    ]);

    const urgentCall = calls.find((call) => call.sql.includes('sc.priority = ?'));
    expect(urgentCall?.sql).toContain('LEFT JOIN friends f ON f.id = sc.friend_id');
    expect(urgentCall?.sql).toContain('f.display_name');
    expect(urgentCall?.sql).not.toContain('sc.friend_name');
    expect(calls.some((call) => call.sql.includes('INSERT INTO app_notification_inbox'))).toBe(true);
    expect(calls.some((call) => /DELETE\s+FROM/i.test(call.sql))).toBe(false);
  });

  test('internal chat feed searches old messages and returns a stable pagination cursor', async () => {
    const { db, calls } = makeInternalChatDb();
    const res = await setupApp(db).request(
      '/api/app-notifications/internal-chat-feed?lineAccountId=acc-1&limit=1&q=%E9%81%8E%E5%8E%BB',
    );
    const body = await res.json() as {
      success: boolean;
      data: {
        items: Array<{ id: string; mentionStaffIds: string[]; isUnread: boolean }>;
        hasMore: boolean;
        nextCursor: string | null;
      };
    };

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.items).toEqual([
      expect.objectContaining({
        id: 'support:message-new',
        mentionStaffIds: ['owner-1'],
        isUnread: true,
      }),
    ]);
    expect(body.data.hasMore).toBe(true);
    expect(body.data.nextCursor).toBe('2026-07-21T10:00:00.000|support:message-new');
    const supportCall = calls.find((call) => call.sql.includes('sim.parent_id'));
    expect(supportCall?.sql).toContain("sim.body LIKE ? ESCAPE '\\'");
    expect(supportCall?.binds).toContain('%過去%');
  });

  test('primary responders can read the full internal chat feed without case assignment filters', async () => {
    const { db, calls } = makeInternalChatDb();
    const res = await setupApp(db, {
      id: 'staff-1',
      name: '林 静香',
      role: 'staff',
    }).request('/api/app-notifications/internal-chat-feed?lineAccountId=acc-1');

    expect(res.status).toBe(200);
    const supportCall = calls.find((call) => call.sql.includes('FROM support_internal_messages sim'));
    const chatCall = calls.find((call) => call.sql.includes('FROM chat_internal_messages cim'));
    expect(supportCall?.sql).not.toContain('sc.created_by = ?');
    expect(supportCall?.sql).not.toContain('sc.primary_assignee = ?');
    expect(chatCall?.sql).not.toContain('sc_friend_scope');
    expect(supportCall?.binds).toEqual(['acc-1', 51]);
    expect(chatCall?.binds).toEqual(['acc-1', 51]);
    expect(calls.some((call) => /DELETE\s+FROM/i.test(call.sql))).toBe(false);
  });

  test('secondary responders keep assignment-scoped internal chat visibility', async () => {
    const { db, calls } = makeInternalChatDb();
    const res = await setupApp(db, {
      id: 'secondary-1',
      name: '吉田 京平',
      role: 'secondary',
    }).request('/api/app-notifications/internal-chat-feed?lineAccountId=acc-1');

    expect(res.status).toBe(200);
    const supportCall = calls.find((call) => call.sql.includes('FROM support_internal_messages sim'));
    const chatCall = calls.find((call) => call.sql.includes('FROM chat_internal_messages cim'));
    expect(supportCall?.sql).toContain('sc.escalation_assignee = ?');
    expect(supportCall?.binds).toContain('吉田 京平');
    expect(chatCall?.sql).toContain('(0 = 1)');
    expect(calls.some((call) => /DELETE\s+FROM/i.test(call.sql))).toBe(false);
  });

  test('marks a conversation as read without deleting any message rows', async () => {
    const { db, calls } = makeInternalChatDb();
    const res = await setupApp(db).request('/api/app-notifications/internal-chat-read', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        lineAccountId: 'acc-1',
        source: 'support',
        sourceId: 'case-1',
      }),
    });

    expect(res.status).toBe(200);
    expect(calls.some((call) => call.sql.includes('INSERT INTO internal_conversation_reads'))).toBe(true);
    expect(calls.some((call) => /DELETE\s+FROM/i.test(call.sql))).toBe(false);
  });

  test('lists my tasks with assignees and a lightweight comment count', async () => {
    const { db, calls } = makeInternalTaskDb();
    const res = await setupApp(db, {
      id: 'staff-1',
      name: '林 静香',
      role: 'staff',
    }).request('/api/app-notifications/internal-chat-tasks?lineAccountId=acc-1&status=open&scope=mine');
    const body = await res.json() as {
      success: boolean;
      data: Array<{ id: string; assignees: unknown[]; comments: unknown[]; commentCount: number }>;
    };

    expect(res.status).toBe(200);
    expect(body.data[0]).toMatchObject({
      id: 'task-1',
      assignees: [{ staffId: 'staff-1', staffName: '林 静香' }],
      comments: [],
      commentCount: 1,
    });
    const taskCall = calls.find((call) => call.sql.includes('SELECT it.*'));
    expect(taskCall?.sql).toContain('ita_mine.staff_id = ?');
    expect(taskCall?.binds).toContain('staff-1');
    expect(calls.some((call) => /DELETE\s+FROM/i.test(call.sql))).toBe(false);
  });

  test('adds a task comment as a new history row', async () => {
    const { db, calls } = makeInternalTaskDb();
    const res = await setupApp(db, {
      id: 'staff-1',
      name: '林 静香',
      role: 'staff',
    }).request('/api/app-notifications/internal-chat-tasks/task-1/comments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: '先方へ確認しました' }),
    });
    const body = await res.json() as { success: boolean; data: { body: string; createdByName: string } };

    expect(res.status).toBe(201);
    expect(body.data).toMatchObject({ body: '先方へ確認しました', createdByName: '林 静香' });
    expect(calls.some((call) => call.sql.includes('INSERT INTO internal_task_comments'))).toBe(true);
    expect(calls.some((call) => call.sql.includes('INSERT INTO internal_task_events'))).toBe(true);
    expect(calls.some((call) => /DELETE\s+FROM/i.test(call.sql))).toBe(false);
  });

  test('loads comments only for the selected task', async () => {
    const { db, calls } = makeInternalTaskDb();
    const res = await setupApp(db, {
      id: 'staff-1',
      name: '林 静香',
      role: 'staff',
    }).request('/api/app-notifications/internal-chat-tasks/task-1/comments');
    const body = await res.json() as { success: boolean; data: Array<{ body: string }> };

    expect(res.status).toBe(200);
    expect(body.data).toEqual([expect.objectContaining({ body: '確認中です' })]);
    expect(calls.filter((call) => call.sql.includes('FROM internal_task_comments'))).toHaveLength(1);
  });

  test('creates a task from a customer chat and defaults the assignee to the creator', async () => {
    const { db, calls } = makeInternalTaskDb();
    const res = await setupApp(db, {
      id: 'staff-1',
      name: '林 静香',
      role: 'staff',
    }).request('/api/app-notifications/internal-chat-tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        lineAccountId: 'acc-1',
        source: 'chat',
        sourceId: 'friend-1',
        sourceMessageId: 'message-1',
        title: '口座情報を確認する',
      }),
    });

    expect(res.status).toBe(201);
    const sourceCall = calls.find((call) => call.sql.includes('FROM friends f'));
    expect(sourceCall?.sql).toContain('FROM messages_log ml_source');
    expect(sourceCall?.binds.filter((value) => value === 'message-1')).toHaveLength(2);
    const staffCall = calls.find((call) => call.sql.includes('FROM staff_members'));
    expect(staffCall?.binds).toEqual(['staff-1']);
    const assigneeInsert = calls.find((call) => call.sql.includes('INSERT INTO internal_task_assignees'));
    expect(assigneeInsert?.binds).toContain('staff-1');
  });

  test('marks notification inbox items as read without removing history', async () => {
    const { db, calls } = makeInternalChatDb();
    const res = await setupApp(db).request('/api/app-notifications/inbox/read', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lineAccountId: 'acc-1', all: true }),
    });

    expect(res.status).toBe(200);
    const updateCall = calls.find((call) => call.sql.includes('UPDATE app_notification_inbox'));
    expect(updateCall?.sql).toContain('read_at = COALESCE(read_at, ?)');
    expect(updateCall?.binds).toContain('owner-1');
    expect(calls.some((call) => /DELETE\s+FROM/i.test(call.sql))).toBe(false);
  });

  test('keeps a resolved case in primary confirmation notifications', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-22T12:00:00.000+09:00'));
    try {
      const { db, calls } = makeFollowUpReminderDb();
      const res = await setupApp(db).request(
        '/api/app-notifications/recent?after=2026-07-22T08:00:00.000%2B09:00&lineAccountId=acc-1',
      );
      const body = await res.json() as {
        success: boolean;
        data: { items: Array<{ kind: string; title: string; body: string }> };
      };

      expect(res.status).toBe(200);
      expect(body.data.items).toContainEqual(expect.objectContaining({
        kind: 'case_followup_reminder',
        title: '対応済み案件の本人確認が必要です',
        body: '請求内容の確認 / 山田 太郎 / 3日おき',
      }));
      const reminderCall = calls.find((call) => call.sql.includes('FROM support_case_followup_reminders scr'));
      expect(reminderCall?.binds).toContain('owner-1');
      expect(calls.some((call) => /DELETE\s+FROM/i.test(call.sql))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

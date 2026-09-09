import { describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { appNotifications } from './app-notifications.js';

type Staff = {
  id: string;
  name: string;
  role: 'owner' | 'admin' | 'staff' | 'secondary';
  secondaryCanRespond?: boolean;
};

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

function makeInternalChatDb(options: {
  denseFeed?: boolean
  failBookmarkLookup?: boolean
  failTaskCountLookup?: boolean
} = {}) {
  const calls: DbCall[] = [];
  const prepare = vi.fn((sql: string) => ({
    bind: (...binds: unknown[]) => {
      if (binds.length > 100) {
        throw new Error(`too many SQL variables: ${binds.length}`);
      }
      calls.push({ sql, binds });
      return {
        all: vi.fn(async () => {
          if (options.failBookmarkLookup && sql.includes('FROM internal_message_bookmark_events')) {
            throw new Error('bookmark lookup unavailable');
          }
          if (
            options.failTaskCountLookup
            && sql.includes('FROM internal_tasks')
            && sql.includes('COUNT(*) AS count')
          ) {
            throw new Error('task count lookup unavailable');
          }
          if (sql.includes('FROM support_internal_messages sim') && sql.includes('sim.parent_id')) {
            if (options.denseFeed) {
              return {
                results: Array.from({ length: 51 }, (_, index) => ({
                  id: `support-message-${index}`,
                  case_id: `case-${index}`,
                  case_title: `案件 ${index}`,
                  customer_name: `顧客 ${index}`,
                  parent_id: null,
                  body: `社内メッセージ ${index}`,
                  mentions: '[]',
                  reactions: '{}',
                  created_by: 'staff-2',
                  created_by_name: 'Staff Two',
                  created_at: `2026-07-21T10:${String(index).padStart(2, '0')}:00.000`,
                })),
              };
            }
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
            if (options.denseFeed) {
              return {
                results: Array.from({ length: 51 }, (_, index) => ({
                  id: `chat-message-${index}`,
                  friend_id: `friend-${index}`,
                  friend_name: `LINE顧客 ${index}`,
                  ticket_title: null,
                  parent_id: null,
                  body: `顧客チャット ${index}`,
                  mentions: '[]',
                  reactions: '{}',
                  created_by: 'staff-2',
                  created_by_name: 'Staff Two',
                  created_at: `2026-07-21T09:${String(index).padStart(2, '0')}:00.000`,
                })),
              };
            }
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

function makeSecondaryNeedsInfoDb() {
  const calls: DbCall[] = [];
  const row = {
    id: 'escalation-returned',
    case_id: 'case-returned',
    case_title: '返金条件の確認',
    assignee: '二次 花子',
    answer: '注文番号と入金日を追記してください',
    updated_by: 'secondary-1',
    updated_at: '2026-07-22T10:00:00.000+09:00',
  };
  const prepare = vi.fn((sql: string) => ({
    bind: (...binds: unknown[]) => {
      calls.push({ sql, binds });
      return {
        all: vi.fn(async () => {
          if (sql.includes('FROM support_escalations se') && binds.includes('needs_info')) {
            const recipientStaffId = binds[2];
            const excludedUpdaterId = binds[5];
            return {
              results: recipientStaffId === 'staff-1' && excludedUpdaterId !== row.updated_by ? [row] : [],
            };
          }
          return { results: [] };
        }),
        first: vi.fn(async () => null),
        run: vi.fn(async () => ({ success: true, meta: { changes: 1 } })),
      };
    },
  }));
  const batch = vi.fn(async (statements: Array<{ run: () => Promise<unknown> }>) => (
    Promise.all(statements.map((statement) => statement.run()))
  ));
  return { db: { prepare, batch } as unknown as D1Database, calls };
}

function makeInternalTaskDb(options: {
  groupSource?: boolean
  createdBy?: string
  currentAssigneeIds?: string[]
  updatedAssigneeIds?: string[]
  actorIsAssignee?: boolean
  taskUpdateChanges?: number
  guardedTaskMutationConflict?: boolean
} = {}) {
  const calls: DbCall[] = [];
  let assigneeLoadCount = 0;
  let taskMutationApplied = true;
  const task = {
    id: 'task-1',
    line_account_id: 'acc-1',
    source_type: 'chat',
    source_id: 'friend-1',
    source_message_id: 'message-1',
    title: '口座情報を確認する',
    description: '顧客の回答を確認',
    status: 'open',
    workflow_status: 'todo',
    priority: 'medium',
    sort_order: 0,
    version: 1,
    labels: '[]',
    source_title: '河原通信',
    customer_name: '2449 河原通信',
    is_group_conversation: 0,
    due_at: '2026-07-24T10:00:00.000+09:00',
    created_by: options.createdBy ?? 'staff-1',
    created_by_name: options.createdBy === 'staff-2' ? '小野里 歩乃佳' : '林 静香',
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
            const currentIds = options.currentAssigneeIds ?? ['staff-1'];
            const ids = assigneeLoadCount > 0 && options.updatedAssigneeIds !== undefined
              ? options.updatedAssigneeIds
              : currentIds;
            assigneeLoadCount += 1;
            return {
              results: ids.map((id) => ({
                task_id: 'task-1',
                staff_id: id,
                staff_name: id === 'staff-2' ? '小野里 歩乃佳' : '林 静香',
              })),
            };
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
            return {
              results: binds.map((id) => ({
                id: String(id),
                name: id === 'staff-2' ? '小野里 歩乃佳' : '林 静香',
              })),
            };
          }
          return { results: [] };
        }),
        first: vi.fn(async () => {
          if (sql.includes('COUNT(*) AS count')) return { count: 1 };
          if (sql.includes('FROM internal_tasks')) return task;
          if (sql.includes('FROM support_cases sc')) return { ok: 1 };
          if (sql.includes('FROM line_conversations lc')) return options.groupSource ? { ok: 1 } : null;
          if (sql.includes('FROM friends f')) return options.groupSource ? null : { ok: 1 };
          if (sql.includes('FROM internal_task_assignees')) {
            return options.actorIsAssignee === false ? null : { ok: 1 };
          }
          return null;
        }),
        run: vi.fn(async () => {
          if (
            options.guardedTaskMutationConflict
            && (sql.includes('task_create_guard') || sql.includes('comment_task_guard'))
          ) {
            return { success: true, meta: { changes: 0 } };
          }
          if (sql.startsWith('UPDATE internal_tasks')) {
            const changes = options.taskUpdateChanges ?? 1;
            taskMutationApplied = changes > 0;
            return { success: true, meta: { changes } };
          }
          if (sql.includes('last_mutation_id = ?') && !taskMutationApplied) {
            return { success: true, meta: { changes: 0 } };
          }
          return { success: true, meta: { changes: 1 } };
        }),
      };
    },
  }));
  const batch = vi.fn(async (statements: Array<{ run: () => Promise<unknown> }>) => (
    Promise.all(statements.map((statement) => statement.run()))
  ));
  return { db: { prepare, batch } as unknown as D1Database, calls };
}

describe('app notifications', () => {
  test.each([
    {
      label: 'task creation',
      method: 'POST',
      path: '/api/app-notifications/internal-chat-tasks',
      body: {
        lineAccountId: 'acc-1',
        source: 'chat',
        sourceId: 'friend-1',
        sourceMessageId: 'message-1',
        title: '閲覧専用からのタスク',
      },
    },
    {
      label: 'task update',
      method: 'PATCH',
      path: '/api/app-notifications/internal-chat-tasks/task-1',
      body: { workflowStatus: 'in_progress', version: 1 },
    },
    {
      label: 'task comment',
      method: 'POST',
      path: '/api/app-notifications/internal-chat-tasks/task-1/comments',
      body: { body: '閲覧専用からのコメント' },
    },
  ])('keeps read-only secondary staff from $label', async ({ method, path, body }) => {
    const { db, calls } = makeInternalTaskDb();
    const res = await setupApp(db, {
      id: 'secondary-1',
      name: '吉田 京平',
      role: 'secondary',
      secondaryCanRespond: false,
    }).request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(403);
    expect(calls.some((call) => (
      call.sql.includes('INSERT INTO internal_tasks')
      || call.sql.includes('INSERT INTO internal_task_comments')
      || call.sql.startsWith('UPDATE internal_tasks')
    ))).toBe(false);
  });

  test('prevents a responding secondary staff from creating a task after source reassignment', async () => {
    const { db, calls } = makeInternalTaskDb({ guardedTaskMutationConflict: true });
    const res = await setupApp(db, {
      id: 'secondary-1',
      name: '吉田 京平',
      role: 'secondary',
      secondaryCanRespond: true,
    }).request('/api/app-notifications/internal-chat-tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lineAccountId: 'acc-1',
        source: 'support',
        sourceId: 'case-1',
        sourceMessageId: 'message-1',
        title: '担当解除と競合するタスク',
      }),
    });

    expect(res.status).toBe(409);
    const createCall = calls.find((call) => call.sql.includes('INSERT INTO internal_tasks'));
    expect(createCall?.sql).toContain('se_task_create_guard');
    const eventCall = calls.find((call) => call.sql.includes('INSERT INTO internal_task_events'));
    expect(eventCall?.sql).toContain('created_task_guard');
  });

  test('prevents a responding secondary assignee from updating a task after reassignment', async () => {
    const { db, calls } = makeInternalTaskDb({ taskUpdateChanges: 0 });
    const res = await setupApp(db, {
      id: 'secondary-1',
      name: '吉田 京平',
      role: 'secondary',
      secondaryCanRespond: true,
    }).request('/api/app-notifications/internal-chat-tasks/task-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowStatus: 'in_progress', version: 1 }),
    });

    expect(res.status).toBe(409);
    const updateCall = calls.find((call) => call.sql.startsWith('UPDATE internal_tasks'));
    expect(updateCall?.sql).toContain('task_write_assignee');
  });

  test('prevents a responding secondary assignee from commenting after reassignment', async () => {
    const { db, calls } = makeInternalTaskDb({ guardedTaskMutationConflict: true });
    const res = await setupApp(db, {
      id: 'secondary-1',
      name: '吉田 京平',
      role: 'secondary',
      secondaryCanRespond: true,
    }).request('/api/app-notifications/internal-chat-tasks/task-1/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: '担当解除と競合するコメント' }),
    });

    expect(res.status).toBe(409);
    const commentCall = calls.find((call) => call.sql.includes('INSERT INTO internal_task_comments'));
    expect(commentCall?.sql).toContain('comment_task_guard');
    const eventCall = calls.find((call) => call.sql.includes('INSERT INTO internal_task_events'));
    expect(eventCall?.sql).toContain('created_comment_guard');
  });

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

  test('notifies the primary operator of a returned escalation with its reason but not the secondary sender', async () => {
    const primaryDb = makeSecondaryNeedsInfoDb();
    const primaryRes = await setupApp(primaryDb.db, {
      id: 'staff-1',
      name: '田島',
      role: 'staff',
    }).request('/api/app-notifications/recent?after=2026-07-22T09:00:00.000%2B09:00&lineAccountId=acc-1');
    const primaryBody = await primaryRes.json() as {
      success: boolean;
      data: { items: Array<{ kind: string; title: string; body: string; href: string }> };
    };

    expect(primaryRes.status).toBe(200);
    expect(primaryBody.data.items).toContainEqual(expect.objectContaining({
      kind: 'secondary_needs_info',
      title: '二次対応から差し戻されました',
      body: '返金条件の確認: 注文番号と入金日を追記してください',
      href: '/support?case=case-returned',
    }));
    const needsInfoCall = primaryDb.calls.find((call) => call.binds.includes('needs_info'));
    expect(needsInfoCall?.sql).toContain('sc.primary_assignee_staff_id = ?');
    expect(needsInfoCall?.sql).toContain('(se.updated_by IS NULL OR se.updated_by != ?)');
    expect(needsInfoCall?.binds).toContain('staff-1');

    const senderDb = makeSecondaryNeedsInfoDb();
    const senderRes = await setupApp(senderDb.db, {
      id: 'secondary-1',
      name: '二次 花子',
      role: 'secondary',
      secondaryCanRespond: true,
    }).request('/api/app-notifications/recent?after=2026-07-22T09:00:00.000%2B09:00&lineAccountId=acc-1');
    const senderBody = await senderRes.json() as { data: { items: Array<{ kind: string }> } };

    expect(senderRes.status).toBe(200);
    expect(senderBody.data.items.some((item) => item.kind === 'secondary_needs_info')).toBe(false);
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

  test('loads a full mixed feed without exceeding the D1 bound-parameter limit', async () => {
    const { db, calls } = makeInternalChatDb({ denseFeed: true });
    const res = await setupApp(db).request(
      '/api/app-notifications/internal-chat-feed?lineAccountId=acc-1',
    );
    const body = await res.json() as {
      success: boolean;
      data: { items: unknown[] };
    };

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.items).toHaveLength(50);
    const bookmarkCalls = calls.filter((call) => call.sql.includes('FROM internal_message_bookmark_events'));
    const taskCountCalls = calls.filter((call) => (
      call.sql.includes('FROM internal_tasks') && call.sql.includes('COUNT(*) AS count')
    ));
    expect(bookmarkCalls).toHaveLength(2);
    expect(taskCountCalls).toHaveLength(2);
    expect([...bookmarkCalls, ...taskCountCalls].every((call) => call.binds.length <= 100)).toBe(true);
    expect(calls.some((call) => /DELETE\s+FROM/i.test(call.sql))).toBe(false);
  });

  test('keeps chat messages readable when bookmark and task metadata are unavailable', async () => {
    const { db, calls } = makeInternalChatDb({
      failBookmarkLookup: true,
      failTaskCountLookup: true,
    });
    const res = await setupApp(db).request(
      '/api/app-notifications/internal-chat-feed?lineAccountId=acc-1',
    );
    const body = await res.json() as {
      success: boolean;
      data: {
        items: Array<{ id: string; body: string; isBookmarked: boolean; taskCount: number }>;
        degradedFeatures: string[];
      };
    };

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.items).toContainEqual(expect.objectContaining({
      id: 'support:message-new',
      body: '過去ログの本文です',
      isBookmarked: false,
      taskCount: 0,
    }));
    expect(body.data.degradedFeatures).toEqual(['bookmarks', 'taskCounts']);
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
    expect(supportCall?.sql).toContain('sc.escalation_assignee_staff_id = ?');
    expect(supportCall?.binds).toContain('secondary-1');
    expect(supportCall?.sql).toContain('assignee_staff_id IS NULL');
    expect(supportCall?.sql).toContain('SELECT COUNT(*) FROM staff_members');
    expect(supportCall?.binds.filter((value) => value === '吉田 京平')).toHaveLength(4);
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
      data: Array<{
        id: string
        assignees: unknown[]
        comments: unknown[]
        commentCount: number
        sourceTitle: string | null
        customerName: string | null
        canUpdate: boolean
      }>;
    };

    expect(res.status).toBe(200);
    expect(body.data[0]).toMatchObject({
      id: 'task-1',
      assignees: [{ staffId: 'staff-1', staffName: '林 静香' }],
      comments: [],
      commentCount: 1,
      sourceTitle: '河原通信',
      customerName: '2449 河原通信',
      canUpdate: true,
    });
    const taskCall = calls.find((call) => call.sql.includes('SELECT it.*'));
    expect(taskCall?.sql).toContain('ita_mine.staff_id = ?');
    expect(taskCall?.sql).toContain('FROM line_conversations lc_task_scope');
    expect(taskCall?.sql).toContain('AS source_title');
    expect(taskCall?.sql).toContain("'$.customerNumber'");
    expect(taskCall?.sql).toContain("|| '_'");
    expect(taskCall?.binds).toContain('staff-1');
    expect(calls.some((call) => /DELETE\s+FROM/i.test(call.sql))).toBe(false);
  });

  test('returns pagination metadata so tasks beyond the first page remain reachable', async () => {
    const { db, calls } = makeInternalTaskDb();
    const res = await setupApp(db).request(
      '/api/app-notifications/internal-chat-tasks?lineAccountId=acc-1&scope=all&status=all&limit=100&offset=0',
    );
    const body = await res.json() as { meta: { total: number; limit: number; offset: number; hasMore: boolean } };

    expect(res.status).toBe(200);
    expect(body.meta).toEqual({ total: 1, limit: 100, offset: 0, hasMore: false });
    const listCall = calls.find((call) => call.sql.includes('SELECT it.*'));
    expect(listCall?.sql).toContain('LIMIT ? OFFSET ?');
    expect(listCall?.binds.slice(-2)).toEqual([100, 0]);
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

  test('creates a task from a LINE group message without requiring a friend row', async () => {
    const { db, calls } = makeInternalTaskDb({ groupSource: true });
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
        sourceId: 'conversation-group-1',
        sourceMessageId: 'group-message-1',
        title: 'グループ内の確認事項を対応する',
      }),
    });

    expect(res.status).toBe(201);
    const sourceCall = calls.find((call) => call.sql.includes('FROM line_conversations lc'));
    expect(sourceCall?.sql).toContain('FROM line_conversation_messages lcm_source');
    expect(sourceCall?.binds).toEqual([
      'conversation-group-1',
      'acc-1',
      'group-message-1',
    ]);
    expect(calls.some((call) => call.sql.includes('INSERT INTO internal_tasks'))).toBe(true);
  });

  test('moves a task to the completed column and records the transition', async () => {
    const { db, calls } = makeInternalTaskDb();
    const res = await setupApp(db, {
      id: 'staff-1',
      name: '林 静香',
      role: 'staff',
    }).request('/api/app-notifications/internal-chat-tasks/task-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    });

    expect(res.status).toBe(200);
    const updateCall = calls.find((call) => call.sql.includes('UPDATE internal_tasks'));
    expect(updateCall?.binds).toContain('done');
    expect(updateCall?.binds).toContain('staff-1');
    const eventCall = calls.find((call) => call.sql.includes('INSERT INTO internal_task_events'));
    expect(eventCall?.binds).toContain('completed');
    expect(calls.some((call) => /DELETE\s+FROM/i.test(call.sql))).toBe(false);
  });

  test('edits task identity and due date without changing its source', async () => {
    const { db, calls } = makeInternalTaskDb();
    const res = await setupApp(db, {
      id: 'staff-1',
      name: '林 静香',
      role: 'staff',
    }).request('/api/app-notifications/internal-chat-tasks/task-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: '契約内容を確認して担当者へ共有する',
        description: '先方の回答が揃ったら完了',
        dueAt: '2026-07-25T12:00:00.000+09:00',
      }),
    });

    expect(res.status).toBe(200);
    const updateCall = calls.find((call) => call.sql.includes('UPDATE internal_tasks'));
    expect(updateCall?.binds).toEqual(expect.arrayContaining([
      '契約内容を確認して担当者へ共有する',
      '先方の回答が揃ったら完了',
      '2026-07-25T12:00:00.000+09:00',
    ]));
    expect(updateCall?.sql).not.toContain('source_id =');
    const eventCall = calls.find((call) => call.sql.includes('INSERT INTO internal_task_events'));
    expect(eventCall?.binds).toContain('updated');
  });

  test('removes the current assignee and returns the updated permission with auditable history', async () => {
    const { db, calls } = makeInternalTaskDb({
      createdBy: 'staff-1',
      currentAssigneeIds: ['staff-2'],
      updatedAssigneeIds: [],
    });
    const res = await setupApp(db, {
      id: 'staff-2',
      name: '小野里 歩乃佳',
      role: 'staff',
    }).request('/api/app-notifications/internal-chat-tasks/task-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assigneeStaffIds: [] }),
    });
    const body = await res.json() as {
      success: boolean
      data: { assignees: unknown[]; canUpdate: boolean }
    };

    expect(res.status).toBe(200);
    expect(body.data.assignees).toEqual([]);
    expect(body.data.canUpdate).toBe(false);
    const removalCall = calls.find((call) => call.sql.includes('SET removed_at = ?'));
    expect(removalCall?.binds).toContain('staff-2');
    const eventCall = calls.find((call) => call.sql.includes('INSERT INTO internal_task_events'));
    const metadata = eventCall?.binds.find((value) => (
      typeof value === 'string' && value.startsWith('{"fields"')
    ));
    expect(metadata && JSON.parse(metadata)).toMatchObject({
      fields: ['assignees'],
      version: { before: 1, after: 2 },
      assigneeStaffIds: { before: ['staff-2'], after: [] },
    });
  });

  test('reactivates an assignee without overwriting the original assignment timestamp', async () => {
    const { db, calls } = makeInternalTaskDb({
      currentAssigneeIds: [],
      updatedAssigneeIds: ['staff-2'],
    });
    const res = await setupApp(db, {
      id: 'staff-1',
      name: '林 静香',
      role: 'staff',
    }).request('/api/app-notifications/internal-chat-tasks/task-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assigneeStaffIds: ['staff-2'] }),
    });

    expect(res.status).toBe(200);
    const assignmentCall = calls.find((call) => call.sql.includes('INSERT INTO internal_task_assignees'));
    expect(assignmentCall?.sql).toContain('removed_at = NULL');
    expect(assignmentCall?.sql).not.toContain('assigned_at = excluded.assigned_at');
    const eventCall = calls.find((call) => call.sql.includes('INSERT INTO internal_task_events'));
    const metadata = eventCall?.binds.find((value) => (
      typeof value === 'string' && value.startsWith('{"fields"')
    ));
    expect(metadata && JSON.parse(metadata)).toMatchObject({
      assigneeStaffIds: { before: [], after: ['staff-2'] },
      assigneeChangedAt: expect.any(String),
    });
  });

  test('rejects a due date that is not a timestamp', async () => {
    const { db, calls } = makeInternalTaskDb();
    const res = await setupApp(db).request('/api/app-notifications/internal-chat-tasks/task-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dueAt: 'not-a-date' }),
    });

    expect(res.status).toBe(400);
    expect(calls.some((call) => call.sql.includes('UPDATE internal_tasks'))).toBe(false);
  });

  test.each(['2026-02-30T12:00:00+09:00', '2026-07-25T12:00:00+14:01'])(
    'rejects invalid task due date %s',
    async (dueAt) => {
      const { db, calls } = makeInternalTaskDb();
      const res = await setupApp(db).request('/api/app-notifications/internal-chat-tasks/task-1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dueAt }),
      });

      expect(res.status).toBe(400);
      expect(calls.some((call) => call.sql.includes('UPDATE internal_tasks'))).toBe(false);
    },
  );

  test.each([
    ['2026-07-25T03:00:00Z', '2026-07-25T12:00:00.000+09:00'],
    ['2026-07-25T12:00', '2026-07-25T12:00:00.000+09:00'],
  ])('normalizes task due date %s to canonical JST', async (dueAt, expected) => {
    const { db, calls } = makeInternalTaskDb();
    const res = await setupApp(db).request('/api/app-notifications/internal-chat-tasks/task-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dueAt }),
    });

    expect(res.status).toBe(200);
    const updateCall = calls.find((call) => call.sql.startsWith('UPDATE internal_tasks'));
    expect(updateCall?.binds).toContain(expected);
  });

  test('rejects a stale task version before any update is written', async () => {
    const { db, calls } = makeInternalTaskDb();
    const res = await setupApp(db).request('/api/app-notifications/internal-chat-tasks/task-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workflowStatus: 'in_progress', version: 2 }),
    });

    expect(res.status).toBe(409);
    expect(calls.some((call) => call.sql.includes('UPDATE internal_tasks'))).toBe(false);
  });

  test('rejects a task update that loses the write-time version race without appending history', async () => {
    const { db, calls } = makeInternalTaskDb({ taskUpdateChanges: 0 });
    const res = await setupApp(db).request('/api/app-notifications/internal-chat-tasks/task-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workflowStatus: 'in_progress', version: 1 }),
    });

    expect(res.status).toBe(409);
    const updateCall = calls.find((call) => call.sql.startsWith('UPDATE internal_tasks'));
    expect(updateCall?.sql).toContain('WHERE id = ? AND version = ?');
    const eventCall = calls.find((call) => call.sql.includes('INSERT INTO internal_task_events'));
    expect(eventCall?.sql).toContain('last_mutation_id = ?');
  });

  test('rejects an empty task name during editing', async () => {
    const { db } = makeInternalTaskDb();
    const res = await setupApp(db).request('/api/app-notifications/internal-chat-tasks/task-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '   ' }),
    });

    expect(res.status).toBe(400);
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

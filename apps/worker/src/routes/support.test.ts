import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { support } from './support.js';

type Staff = { id: string; name: string; role: 'owner' | 'admin' | 'staff' };

type TestEnv = {
  Variables: { staff: Staff };
  Bindings: { DB: D1Database };
};

type SupportCaseRow = {
  id: string;
  line_account_id: string | null;
  friend_id: string | null;
  friend_name?: string | null;
  friend_picture_url?: string | null;
  line_user_id?: string | null;
  title: string;
  category: string;
  priority: string;
  status: string;
  primary_assignee: string | null;
  escalation_assignee: string | null;
  escalation_level: string;
  due_at: string | null;
  next_check_at: string | null;
  customer_number: string | null;
  company_name: string | null;
  contact_name: string | null;
  store_name: string | null;
  contract_type: string | null;
  customer_summary: string;
  internal_note: string;
  customer_reply_draft: string;
  resolution_note: string;
  manual_ids: string;
  created_by: string | null;
  updated_by: string | null;
  closed_at: string | null;
  reopened_at: string | null;
  created_at: string;
  updated_at: string;
};

type SupportEscalationRow = {
  id: string;
  case_id: string;
  case_title?: string | null;
  friend_name?: string | null;
  line_account_id: string | null;
  assignee: string;
  level: string;
  status: string;
  question: string;
  answer: string;
  due_at: string | null;
  answered_at: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

type SupportEventRow = {
  id: string;
  case_id: string;
  event_type: string;
  actor_id: string | null;
  actor_name: string | null;
  body: string;
  metadata: string;
  created_at: string;
};

type SupportManualRow = {
  id: string;
  line_account_id: string | null;
  title: string;
  category: string;
  body: string;
  url: string | null;
  keywords: string;
  owner: string | null;
  approved_by: string | null;
  revised_at: string | null;
  is_active: number;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

type FriendRow = {
  id: string;
  line_account_id: string | null;
  display_name: string | null;
  picture_url?: string | null;
  line_user_id?: string | null;
};

type DbCall = {
  method: 'first' | 'all' | 'run';
  sql: string;
  binds: unknown[];
};

function baseCase(overrides: Partial<SupportCaseRow> = {}): SupportCaseRow {
  return {
    id: 'case-1',
    line_account_id: 'acc-1',
    friend_id: null,
    title: '報酬確認',
    category: 'reward',
    priority: 'medium',
    status: 'open',
    primary_assignee: null,
    escalation_assignee: null,
    escalation_level: 'L1',
    due_at: null,
    next_check_at: null,
    customer_number: null,
    company_name: null,
    contact_name: null,
    store_name: null,
    contract_type: null,
    customer_summary: '',
    internal_note: '',
    customer_reply_draft: '',
    resolution_note: '',
    manual_ids: '[]',
    created_by: 'staff-1',
    updated_by: 'staff-1',
    closed_at: null,
    reopened_at: null,
    created_at: '2026-06-12T09:00:00.000',
    updated_at: '2026-06-12T09:00:00.000',
    ...overrides,
  };
}

function baseManual(overrides: Partial<SupportManualRow> = {}): SupportManualRow {
  return {
    id: 'manual-1',
    line_account_id: 'acc-1',
    title: '報酬確認マニュアル',
    category: 'reward',
    body: '報酬の反映状況を確認します。',
    url: null,
    keywords: '報酬,確認',
    owner: '運用',
    approved_by: null,
    revised_at: '2026-06-12',
    is_active: 1,
    created_by: 'owner-1',
    updated_by: 'owner-1',
    created_at: '2026-06-12T09:00:00.000',
    updated_at: '2026-06-12T09:00:00.000',
    ...overrides,
  };
}

function baseEscalation(overrides: Partial<SupportEscalationRow> = {}): SupportEscalationRow {
  return {
    id: 'esc-1',
    case_id: 'case-1',
    line_account_id: 'acc-1',
    assignee: 'Admin Smoke',
    level: 'L2',
    status: 'pending',
    question: '確認してください',
    answer: '',
    due_at: '2026-06-13T18:00',
    answered_at: null,
    created_by: 'staff-1',
    updated_by: 'staff-1',
    created_at: '2026-06-12T09:00:00.000',
    updated_at: '2026-06-12T09:00:00.000',
    ...overrides,
  };
}

function makeSupportDb(state: {
  cases?: SupportCaseRow[];
  escalations?: SupportEscalationRow[];
  events?: SupportEventRow[];
  friends?: FriendRow[];
  manuals?: SupportManualRow[];
}) {
  const cases = state.cases ?? [];
  const escalations = state.escalations ?? [];
  const events = state.events ?? [];
  const friends = state.friends ?? [];
  const manuals = state.manuals ?? [];
  const calls: DbCall[] = [];

  function hydrateCase(row: SupportCaseRow): SupportCaseRow {
    const friend = friends.find((item) => item.id === row.friend_id);
    return {
      ...row,
      friend_name: friend?.display_name ?? null,
      friend_picture_url: friend?.picture_url ?? null,
      line_user_id: friend?.line_user_id ?? null,
    };
  }

  function findCase(id: string, lineAccountId: string): SupportCaseRow | null {
    const row = cases.find((item) => item.id === id && item.line_account_id === lineAccountId);
    return row ? hydrateCase(row) : null;
  }

  function findEscalation(id: string, lineAccountId?: string): SupportEscalationRow | null {
    const row = escalations.find(
      (item) => item.id === id && (lineAccountId === undefined || item.line_account_id === lineAccountId),
    );
    if (!row) return null;
    const supportCase = cases.find((item) => item.id === row.case_id);
    const friend = friends.find((item) => item.id === supportCase?.friend_id);
    return {
      ...row,
      case_title: supportCase?.title ?? null,
      friend_name: friend?.display_name ?? null,
    };
  }

  function findManual(id: string, lineAccountId?: string): SupportManualRow | null {
    return manuals.find(
      (item) => item.id === id && (lineAccountId === undefined || item.line_account_id === lineAccountId),
    ) ?? null;
  }

  function applyManualUpdate(sql: string, binds: unknown[]) {
    const id = binds.at(-2);
    const lineAccountId = binds.at(-1);
    const row = manuals.find((item) => item.id === id && item.line_account_id === lineAccountId);
    if (!row) return;
    const setMatch = sql.match(/SET (.+) WHERE /);
    if (!setMatch) return;
    let bindIndex = 0;
    setMatch[1].split(',').forEach((part) => {
      const [rawColumn, rawValue] = part.trim().split('=');
      const column = rawColumn.trim();
      const valueToken = rawValue.trim();
      const value = valueToken === '?' ? binds[bindIndex++] : Number(valueToken);
      (row as unknown as Record<string, unknown>)[column] = value;
    });
  }

  function applyCaseUpdate(sql: string, binds: unknown[]) {
    const id = binds.at(-2);
    const lineAccountId = binds.at(-1);
    const row = cases.find((item) => item.id === id && item.line_account_id === lineAccountId);
    if (!row) return;
    const setMatch = sql.match(/SET (.+) WHERE /);
    if (!setMatch) return;
    let bindIndex = 0;
    setMatch[1].split(',').forEach((part) => {
      const [rawColumn, rawValue] = part.trim().split('=');
      const column = rawColumn.trim();
      const valueToken = rawValue.trim();
      const value = valueToken === '?' ? binds[bindIndex++] : valueToken.replace(/^'|'$/g, '');
      (row as unknown as Record<string, unknown>)[column] = value;
    });
  }

  function applyEscalationUpdate(sql: string, binds: unknown[]) {
    const id = binds.at(-2);
    const lineAccountId = binds.at(-1);
    const row = escalations.find((item) => item.id === id && item.line_account_id === lineAccountId);
    if (!row) return;
    const setMatch = sql.match(/SET (.+) WHERE /);
    if (!setMatch) return;
    let bindIndex = 0;
    setMatch[1].split(',').forEach((part) => {
      const [rawColumn, rawValue] = part.trim().split('=');
      const column = rawColumn.trim();
      const valueToken = rawValue.trim();
      const value = valueToken === '?' ? binds[bindIndex++] : valueToken.replace(/^'|'$/g, '');
      (row as unknown as Record<string, unknown>)[column] = value;
    });
  }

  function visibilityParts(sql: string, binds: unknown[]) {
    if (!sql.includes('created_by = ?')) return null;
    const patternIndex = binds.findIndex((item) => typeof item === 'string' && item.startsWith('%') && item.endsWith('%'));
    if (patternIndex < 1) return null;
    return {
      staffId: String(binds[patternIndex - 1]),
      staffName: String(binds[patternIndex]).replaceAll('%', ''),
    };
  }

  function visibleCase(row: SupportCaseRow, sql: string, binds: unknown[]): boolean {
    const scope = visibilityParts(sql, binds);
    if (!scope) return true;
    return (
      row.created_by === scope.staffId ||
      (row.primary_assignee ?? '').includes(scope.staffName) ||
      (row.escalation_assignee ?? '').includes(scope.staffName) ||
      escalations.some(
        (item) =>
          item.case_id === row.id &&
          item.status !== 'closed' &&
          item.assignee.includes(scope.staffName),
      )
    );
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
          if (sql.includes('FROM friends WHERE id = ?')) {
            const [friendId] = bound as [string];
            const friend = friends.find((item) => item.id === friendId);
            return (friend ?? null) as T | null;
          }
          if (sql.includes('FROM support_cases sc') && sql.includes('WHERE sc.id = ? AND sc.line_account_id = ?')) {
            const [caseId, lineAccountId] = bound as [string, string];
            const row = findCase(caseId, lineAccountId);
            return (row && visibleCase(row, sql, bound) ? row : null) as T | null;
          }
          if (sql.startsWith('SELECT status FROM support_cases WHERE id = ? AND line_account_id = ?')) {
            const [caseId, lineAccountId] = bound as [string, string];
            const row = cases.find((item) => item.id === caseId && item.line_account_id === lineAccountId);
            return (row ? { status: row.status } : null) as T | null;
          }
          if (sql.startsWith('SELECT * FROM support_escalations WHERE id = ? AND line_account_id = ?')) {
            const [id, lineAccountId] = bound as [string, string];
            return findEscalation(id, lineAccountId) as T | null;
          }
          if (sql.startsWith('SELECT * FROM support_escalations WHERE id = ?')) {
            const [id] = bound as [string];
            return findEscalation(id) as T | null;
          }
          if (sql.startsWith('SELECT * FROM support_manuals WHERE id = ? AND line_account_id = ?')) {
            const [id, lineAccountId] = bound as [string, string];
            return findManual(id, lineAccountId) as T | null;
          }
          if (sql.startsWith('SELECT * FROM support_manuals WHERE id = ?')) {
            const [id] = bound as [string];
            return findManual(id) as T | null;
          }
          if (sql.includes('FROM support_escalations se') && sql.includes('WHERE se.id = ? AND se.line_account_id = ?')) {
            const [id, lineAccountId] = bound as [string, string];
            return findEscalation(id, lineAccountId) as T | null;
          }
          return null as T | null;
        },
        async all<T>() {
          calls.push({ method: 'all', sql, binds: bound });
          if (sql.includes('FROM support_cases sc')) {
            const lineAccountId = bound[0] as string;
            let rows = cases.filter((item) => item.line_account_id === lineAccountId);
            rows = rows.filter((item) => visibleCase(item, sql, bound));
            if (sql.includes("sc.status = ?")) {
              const status = bound.find((item) => typeof item === 'string' && ['open', 'in_progress', 'waiting_primary', 'escalated', 'waiting_secondary', 'customer_reply', 'on_hold', 'resolved', 'reopened'].includes(item));
              if (status) rows = rows.filter((item) => item.status === status);
            }
            if (sql.includes("sc.status != 'resolved'")) {
              rows = rows.filter((item) => item.status !== 'resolved');
            }
            if (sql.includes("sc.status IN ('escalated', 'waiting_secondary')")) {
              rows = rows.filter((item) => ['escalated', 'waiting_secondary'].includes(item.status));
            }
            if (sql.includes("sc.status = 'customer_reply'")) {
              rows = rows.filter((item) => item.status === 'customer_reply');
            }
            if (sql.includes("(sc.primary_assignee IS NULL OR sc.primary_assignee = '')")) {
              rows = rows.filter((item) => !item.primary_assignee);
            }
            if (sql.includes('sc.due_at IS NOT NULL AND sc.due_at < ?')) {
              const dueCutoff = String(bound.find((item, index) => (
                index > 0 &&
                typeof item === 'string' &&
                /^\d{4}-\d{2}-\d{2}T/.test(item)
              )) ?? '9999-12-31T23:59:59.999');
              rows = rows.filter((item) => item.due_at !== null && item.due_at < dueCutoff);
            }
            if (sql.includes("sc.status != 'resolved' AND (")) {
              const pattern = String(bound.find((item) => typeof item === 'string' && item.startsWith('%')) ?? '');
              const staffName = pattern.replaceAll('%', '');
              rows = rows.filter(
                (item) =>
                  item.status !== 'resolved' &&
                  ((item.escalation_assignee ?? '').includes(staffName) ||
                    escalations.some(
                      (escalation) =>
                        escalation.case_id === item.id &&
                        escalation.status !== 'closed' &&
                        escalation.assignee.includes(staffName),
                    )),
              );
            }
            return { results: rows.map(hydrateCase) } as { results: T[] };
          }
          if (sql.includes('FROM support_case_events')) {
            const [caseId] = bound as [string];
            return { results: events.filter((item) => item.case_id === caseId) } as { results: T[] };
          }
          if (sql.includes('FROM support_escalations se') && sql.includes('WHERE se.case_id = ?')) {
            const [caseId] = bound as [string];
            return { results: escalations.filter((item) => item.case_id === caseId).map((item) => findEscalation(item.id)!) } as { results: T[] };
          }
          if (sql.includes('FROM support_escalations se')) {
            const lineAccountId = bound[0] as string;
            return { results: escalations.filter((item) => item.line_account_id === lineAccountId).map((item) => findEscalation(item.id)!) } as { results: T[] };
          }
          if (sql.includes('FROM messages_log')) {
            return { results: [] } as { results: T[] };
          }
          if (sql.includes('FROM support_manuals')) {
            const lineAccountId = bound.find((item) => typeof item === 'string' && item.startsWith('acc-')) as string | undefined;
            const rows = lineAccountId
              ? manuals.filter((item) => item.line_account_id === lineAccountId || item.line_account_id === null)
              : manuals;
            return { results: rows } as { results: T[] };
          }
          return { results: [] } as { results: T[] };
        },
        async run() {
          calls.push({ method: 'run', sql, binds: bound });
          if (sql.includes('INSERT INTO support_cases')) {
            const [
              id,
              lineAccountId,
              friendId,
              title,
              category,
              priority,
              status,
              primaryAssignee,
              escalationAssignee,
              escalationLevel,
              dueAt,
              nextCheckAt,
              customerNumber,
              companyName,
              contactName,
              storeName,
              contractType,
              customerSummary,
              internalNote,
              customerReplyDraft,
              resolutionNote,
              manualIds,
              createdBy,
              updatedBy,
              closedAt,
              reopenedAt,
              createdAt,
              updatedAt,
            ] = bound as string[];
            cases.push({
              id,
              line_account_id: lineAccountId,
              friend_id: friendId,
              title,
              category,
              priority,
              status,
              primary_assignee: primaryAssignee,
              escalation_assignee: escalationAssignee,
              escalation_level: escalationLevel,
              due_at: dueAt,
              next_check_at: nextCheckAt,
              customer_number: customerNumber,
              company_name: companyName,
              contact_name: contactName,
              store_name: storeName,
              contract_type: contractType,
              customer_summary: customerSummary,
              internal_note: internalNote,
              customer_reply_draft: customerReplyDraft,
              resolution_note: resolutionNote,
              manual_ids: manualIds,
              created_by: createdBy,
              updated_by: updatedBy,
              closed_at: closedAt,
              reopened_at: reopenedAt,
              created_at: createdAt,
              updated_at: updatedAt,
            });
          } else if (sql.includes('INSERT INTO support_case_events')) {
            const [id, caseId, eventType, actorId, actorName, body, metadata, createdAt] = bound as string[];
            events.push({
              id,
              case_id: caseId,
              event_type: eventType,
              actor_id: actorId,
              actor_name: actorName,
              body,
              metadata,
              created_at: createdAt,
            });
          } else if (sql.includes('INSERT INTO support_escalations')) {
            const [id, caseId, lineAccountId, assignee, level, question, dueAt, createdBy, updatedBy, createdAt, updatedAt] = bound as string[];
            escalations.push({
              id,
              case_id: caseId,
              line_account_id: lineAccountId,
              assignee,
              level,
              status: 'pending',
              question,
              answer: '',
              due_at: dueAt,
              answered_at: null,
              created_by: createdBy,
              updated_by: updatedBy,
              created_at: createdAt,
              updated_at: updatedAt,
            });
          } else if (sql.includes("SET status = 'waiting_secondary'")) {
            const caseId = bound.at(-2) as string;
            const lineAccountId = bound.at(-1) as string;
            const row = cases.find((item) => item.id === caseId && item.line_account_id === lineAccountId);
            if (row) {
              const hasRoutingFields = sql.includes('escalation_assignee = ?');
              const updatedBy = hasRoutingFields ? bound[3] as string : bound[0] as string;
              const updatedAt = hasRoutingFields ? bound[4] as string : bound[1] as string;
              row.status = 'waiting_secondary';
              if (hasRoutingFields) {
                const [assignee, level, dueAt] = bound as string[];
                row.escalation_assignee = assignee;
                row.escalation_level = level;
                row.due_at = dueAt ?? row.due_at;
              }
              row.updated_by = updatedBy;
              row.updated_at = updatedAt;
            }
          } else if (sql.startsWith('UPDATE support_cases SET')) {
            applyCaseUpdate(sql, bound);
          } else if (sql.startsWith('UPDATE support_escalations SET')) {
            applyEscalationUpdate(sql, bound);
          } else if (sql.includes('INSERT INTO support_manuals')) {
            const [
              id,
              lineAccountId,
              title,
              category,
              body,
              url,
              keywords,
              owner,
              approvedBy,
              revisedAt,
              isActive,
              createdBy,
              updatedBy,
              createdAt,
              updatedAt,
            ] = bound as Array<string | number | null>;
            manuals.push({
              id: String(id),
              line_account_id: lineAccountId === null ? null : String(lineAccountId),
              title: String(title),
              category: String(category),
              body: String(body),
              url: url === null ? null : String(url),
              keywords: String(keywords),
              owner: owner === null ? null : String(owner),
              approved_by: approvedBy === null ? null : String(approvedBy),
              revised_at: revisedAt === null ? null : String(revisedAt),
              is_active: Number(isActive),
              created_by: createdBy === null ? null : String(createdBy),
              updated_by: updatedBy === null ? null : String(updatedBy),
              created_at: String(createdAt),
              updated_at: String(updatedAt),
            });
          } else if (sql.startsWith('UPDATE support_manuals SET')) {
            applyManualUpdate(sql, bound);
          }
          return { success: true, meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;

  return { db, calls, state: { cases, escalations, events, friends, manuals } };
}

function setupApp(db: D1Database, staff: Staff = { id: 'staff-1', name: '田島', role: 'staff' }) {
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    c.set('staff', staff);
    c.env = { DB: db };
    await next();
  });
  app.route('/', support);
  return app;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('support CRM routes', () => {
  test('creates a case from a friend and records an audit event', async () => {
    const { db, state } = makeSupportDb({
      friends: [{
        id: 'friend-1',
        line_account_id: 'acc-1',
        display_name: '山田さん',
        picture_url: null,
        line_user_id: 'U123',
      }],
    });

    const res = await setupApp(db, { id: 'owner-1', name: 'Owner', role: 'owner' }).request('/api/support/cases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lineAccountId: 'acc-1',
        friendId: 'friend-1',
        title: '',
        category: 'reward',
        priority: 'high',
        customerSummary: '報酬が反映されていない',
        primaryAssignee: '松山',
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { success: boolean; data: { title: string; friendName: string | null; priority: string } };
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      title: '報酬が反映されていない',
      friendName: '山田さん',
      priority: 'high',
    });
    expect(state.cases).toHaveLength(1);
    expect(state.events).toEqual([
      expect.objectContaining({
        case_id: state.cases[0].id,
        event_type: 'created',
        actor_name: 'Owner',
      }),
    ]);
  });

  test('staff cannot create support cases', async () => {
    const { db, state } = makeSupportDb({
      friends: [{
        id: 'friend-visible',
        line_account_id: 'acc-1',
        display_name: '担当中の友だち',
        picture_url: null,
        line_user_id: 'U-visible',
      }],
      cases: [baseCase({ id: 'case-visible', friend_id: 'friend-visible', primary_assignee: '田島' })],
    });

    const res = await setupApp(db, { id: 'staff-1', name: '田島', role: 'staff' }).request('/api/support/cases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lineAccountId: 'acc-1',
        friendId: 'friend-visible',
        customerSummary: '担当中の友だちから追加案件化',
      }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain('owner/admin');
    expect(state.cases).toHaveLength(1);
  });

  test('case creation requires either a linked friend or a customer summary', async () => {
    const { db, state } = makeSupportDb({});

    const res = await setupApp(db, { id: 'owner-1', name: 'Owner', role: 'owner' }).request('/api/support/cases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lineAccountId: 'acc-1',
        title: '',
        customerSummary: ' ',
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe('LINE会話を選ぶか、問い合わせ要約を入力してください。');
    expect(state.cases).toHaveLength(0);
  });

  test('staff can update work fields and manual links on visible cases', async () => {
    const { db, state } = makeSupportDb({
      cases: [baseCase({ id: 'case-visible', primary_assignee: '田島' })],
      manuals: [baseManual({ id: 'manual-1', line_account_id: 'acc-1' })],
    });

    const res = await setupApp(db, { id: 'staff-1', name: '田島', role: 'staff' }).request('/api/support/cases/case-visible', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lineAccountId: 'acc-1',
        status: 'in_progress',
        nextCheckAt: '2026-06-13T18:00',
        customerSummary: '状況を確認中です',
        internalNote: '注文IDを確認',
        customerReplyDraft: '確認して折り返します。',
        manualIds: ['manual-1'],
        eventBody: 'staffが対応内容を更新しました',
      }),
    });

    expect(res.status).toBe(200);
    expect(state.cases[0]).toMatchObject({
      status: 'in_progress',
      primary_assignee: '田島',
      next_check_at: '2026-06-13T18:00',
      customer_summary: '状況を確認中です',
      internal_note: '注文IDを確認',
      customer_reply_draft: '確認して折り返します。',
      manual_ids: '["manual-1"]',
      updated_by: 'staff-1',
    });
    expect(state.events.at(-1)).toMatchObject({
      case_id: 'case-visible',
      event_type: 'updated',
      actor_name: '田島',
      body: 'staffが対応内容を更新しました',
    });
  });

  test('staff cannot change routing or customer identity fields on visible cases', async () => {
    const { db, calls, state } = makeSupportDb({
      cases: [baseCase({ id: 'case-visible', primary_assignee: '田島', due_at: '2026-06-14T18:00' })],
    });

    const res = await setupApp(db, { id: 'staff-1', name: '田島', role: 'staff' }).request('/api/support/cases/case-visible', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lineAccountId: 'acc-1',
        primaryAssignee: '松山',
        dueAt: '2026-06-15T18:00',
        customerNumber: 'C-001',
      }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain('primaryAssignee');
    expect(body.error).toContain('dueAt');
    expect(body.error).toContain('customerNumber');
    expect(state.cases[0]).toMatchObject({
      primary_assignee: '田島',
      due_at: '2026-06-14T18:00',
      customer_number: null,
    });
    expect(calls.some((call) => call.method === 'run' && call.sql.startsWith('UPDATE support_cases'))).toBe(false);
  });

  test('owner can change routing fields on a case', async () => {
    const { db, state } = makeSupportDb({ cases: [baseCase({ id: 'case-owner' })] });

    const res = await setupApp(db, { id: 'owner-1', name: 'Owner', role: 'owner' }).request('/api/support/cases/case-owner', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lineAccountId: 'acc-1',
        priority: 'high',
        primaryAssignee: '松山',
        escalationAssignee: 'Admin Smoke',
        dueAt: '2026-06-15T18:00',
        eventBody: 'ownerが担当と期限を更新しました',
      }),
    });

    expect(res.status).toBe(200);
    expect(state.cases[0]).toMatchObject({
      priority: 'high',
      primary_assignee: '松山',
      escalation_assignee: 'Admin Smoke',
      due_at: '2026-06-15T18:00',
      updated_by: 'owner-1',
    });
  });

  test('rejects resolving a case without a resolution note', async () => {
    const { db, calls } = makeSupportDb({ cases: [baseCase()] });

    const res = await setupApp(db).request('/api/support/cases/case-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lineAccountId: 'acc-1',
        status: 'resolved',
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain('対応結果メモ');
    expect(calls.some((call) => call.method === 'run' && call.sql.startsWith('UPDATE support_cases'))).toBe(false);
  });

  test('rejects reopening a case that is not resolved', async () => {
    const { db, calls } = makeSupportDb({ cases: [baseCase({ id: 'case-open', status: 'in_progress' })] });

    const res = await setupApp(db).request('/api/support/cases/case-open', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lineAccountId: 'acc-1',
        status: 'reopened',
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain('完了済み案件だけ');
    expect(calls.some((call) => call.method === 'run' && call.sql.startsWith('UPDATE support_cases'))).toBe(false);
  });

  test('allows reopening a resolved case and clears the closed timestamp', async () => {
    const { db, state } = makeSupportDb({
      cases: [
        baseCase({
          id: 'case-resolved',
          status: 'resolved',
          resolution_note: '返信済み',
          closed_at: '2026-06-12T12:00:00.000',
        }),
      ],
    });

    const res = await setupApp(db).request('/api/support/cases/case-resolved', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lineAccountId: 'acc-1',
        status: 'reopened',
        eventBody: '案件を再オープンしました',
      }),
    });

    expect(res.status).toBe(200);
    expect(state.cases[0]).toMatchObject({
      status: 'reopened',
      closed_at: null,
      updated_by: 'staff-1',
    });
    expect(state.cases[0].reopened_at).toEqual(expect.any(String));
  });

  test('does not refresh reopened_at when saving an already reopened case', async () => {
    const { db, state } = makeSupportDb({
      cases: [
        baseCase({
          id: 'case-reopened',
          status: 'reopened',
          reopened_at: '2026-06-12T13:00:00.000',
        }),
      ],
    });

    const res = await setupApp(db).request('/api/support/cases/case-reopened', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lineAccountId: 'acc-1',
        status: 'reopened',
        internalNote: '再オープン後の通常保存',
      }),
    });

    expect(res.status).toBe(200);
    expect(state.cases[0]).toMatchObject({
      status: 'reopened',
      internal_note: '再オープン後の通常保存',
      reopened_at: '2026-06-12T13:00:00.000',
    });
  });

  test('owner escalates an open case and moves it to waiting_secondary', async () => {
    const { db, state } = makeSupportDb({ cases: [baseCase({ id: 'case-esc' })] });

    const res = await setupApp(db, { id: 'owner-1', name: 'Owner', role: 'owner' }).request('/api/support/cases/case-esc/escalations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lineAccountId: 'acc-1',
        assignee: '田島',
        level: 'L2',
        question: '入金履歴を確認してください',
        dueAt: '2026-06-12T18:00',
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { success: boolean; data: { assignee: string; status: string; question: string } };
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      assignee: '田島',
      status: 'pending',
      question: '入金履歴を確認してください',
    });
    expect(state.cases[0]).toMatchObject({
      status: 'waiting_secondary',
      escalation_assignee: '田島',
      escalation_level: 'L2',
    });
    expect(state.events.at(-1)).toMatchObject({
      case_id: 'case-esc',
      event_type: 'escalated',
      actor_name: 'Owner',
    });
  });

  test('staff creates an escalation question only using the case routing', async () => {
    const { db, state } = makeSupportDb({
      cases: [baseCase({
        id: 'case-esc',
        primary_assignee: '田島',
        escalation_assignee: 'Admin Smoke',
        escalation_level: 'L3',
        due_at: '2026-06-14T18:00',
      })],
    });

    const res = await setupApp(db, { id: 'staff-1', name: '田島', role: 'staff' }).request('/api/support/cases/case-esc/escalations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lineAccountId: 'acc-1',
        question: '報酬の承認日を確認してください',
      }),
    });

    expect(res.status).toBe(201);
    expect(state.escalations[0]).toMatchObject({
      case_id: 'case-esc',
      assignee: 'Admin Smoke',
      level: 'L3',
      question: '報酬の承認日を確認してください',
      due_at: null,
      created_by: 'staff-1',
    });
    expect(state.cases[0]).toMatchObject({
      status: 'waiting_secondary',
      escalation_assignee: 'Admin Smoke',
      escalation_level: 'L3',
      due_at: '2026-06-14T18:00',
      updated_by: 'staff-1',
    });
  });

  test('staff cannot choose escalation routing on create', async () => {
    const { db, calls, state } = makeSupportDb({
      cases: [baseCase({
        id: 'case-esc',
        primary_assignee: '田島',
        escalation_assignee: 'Admin Smoke',
        escalation_level: 'L2',
      })],
    });

    const res = await setupApp(db, { id: 'staff-1', name: '田島', role: 'staff' }).request('/api/support/cases/case-esc/escalations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lineAccountId: 'acc-1',
        assignee: 'Other Admin',
        level: 'L3',
        dueAt: '2026-06-14T18:00',
        question: '勝手に割り当てたい',
      }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain('assignee');
    expect(body.error).toContain('level');
    expect(body.error).toContain('dueAt');
    expect(state.escalations).toHaveLength(0);
    expect(calls.some((call) => call.method === 'run' && call.sql.includes('support_escalations'))).toBe(false);
  });

  test('staff cannot create escalation when the case has no secondary assignee', async () => {
    const { db, state } = makeSupportDb({
      cases: [baseCase({ id: 'case-esc', primary_assignee: '田島', escalation_assignee: null })],
    });

    const res = await setupApp(db, { id: 'staff-1', name: '田島', role: 'staff' }).request('/api/support/cases/case-esc/escalations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lineAccountId: 'acc-1',
        question: '確認先が未設定です',
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain('二次対応先');
    expect(state.escalations).toHaveLength(0);
  });

  test('staff can answer or return visible escalations', async () => {
    const { db, state } = makeSupportDb({
      cases: [baseCase({ id: 'case-esc', primary_assignee: '田島', status: 'waiting_secondary' })],
      escalations: [baseEscalation({ id: 'esc-visible', case_id: 'case-esc', assignee: 'Admin Smoke' })],
    });

    const res = await setupApp(db, { id: 'staff-1', name: '田島', role: 'staff' }).request('/api/support/escalations/esc-visible', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lineAccountId: 'acc-1',
        status: 'answered',
        answer: '確認できました',
        eventBody: '二次回答の要点を登録しました',
      }),
    });

    expect(res.status).toBe(200);
    expect(state.escalations[0]).toMatchObject({
      status: 'answered',
      answer: '確認できました',
      updated_by: 'staff-1',
    });
    expect(state.cases[0]).toMatchObject({
      status: 'customer_reply',
      updated_by: 'staff-1',
    });
    expect(state.events.at(-1)).toMatchObject({
      case_id: 'case-esc',
      event_type: 'escalation_updated',
      actor_name: '田島',
    });
  });

  test('updating an escalation answer without a status change does not move the case status', async () => {
    const { db, calls, state } = makeSupportDb({
      cases: [baseCase({ id: 'case-esc', primary_assignee: '田島', status: 'resolved' })],
      escalations: [
        baseEscalation({
          id: 'esc-visible',
          case_id: 'case-esc',
          assignee: 'Admin Smoke',
          status: 'answered',
          answer: '旧回答',
          answered_at: '2026-06-12T10:00:00.000',
        }),
      ],
    });

    const res = await setupApp(db, { id: 'staff-1', name: '田島', role: 'staff' }).request('/api/support/escalations/esc-visible', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lineAccountId: 'acc-1',
        answer: '回答文だけを補足しました',
      }),
    });

    expect(res.status).toBe(200);
    expect(state.escalations[0]).toMatchObject({
      status: 'answered',
      answer: '回答文だけを補足しました',
    });
    expect(state.cases[0]).toMatchObject({ status: 'resolved' });
    expect(calls.some((call) => call.method === 'run' && call.sql.startsWith('UPDATE support_cases'))).toBe(false);
  });

  test('rejects escalation status updates on resolved cases until the case is reopened', async () => {
    const { db, calls, state } = makeSupportDb({
      cases: [baseCase({ id: 'case-esc', primary_assignee: '田島', status: 'resolved' })],
      escalations: [baseEscalation({ id: 'esc-visible', case_id: 'case-esc', assignee: 'Admin Smoke' })],
    });

    const res = await setupApp(db, { id: 'staff-1', name: '田島', role: 'staff' }).request('/api/support/escalations/esc-visible', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lineAccountId: 'acc-1',
        status: 'answered',
        answer: '完了済み案件を戻したい',
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain('再オープン');
    expect(state.escalations[0]).toMatchObject({ status: 'pending', answer: '' });
    expect(state.cases[0]).toMatchObject({ status: 'resolved' });
    expect(calls.some((call) => call.method === 'run' && call.sql.startsWith('UPDATE support_escalations'))).toBe(false);
    expect(calls.some((call) => call.method === 'run' && call.sql.startsWith('UPDATE support_cases'))).toBe(false);
  });

  test('staff cannot change escalation routing fields', async () => {
    const { db, calls, state } = makeSupportDb({
      cases: [baseCase({ id: 'case-esc', primary_assignee: '田島', status: 'waiting_secondary' })],
      escalations: [baseEscalation({ id: 'esc-visible', case_id: 'case-esc', assignee: 'Admin Smoke', due_at: '2026-06-13T18:00' })],
    });

    const res = await setupApp(db, { id: 'staff-1', name: '田島', role: 'staff' }).request('/api/support/escalations/esc-visible', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lineAccountId: 'acc-1',
        assignee: 'Other Admin',
        level: 'L3',
        dueAt: '2026-06-14T18:00',
      }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain('assignee');
    expect(body.error).toContain('level');
    expect(body.error).toContain('dueAt');
    expect(state.escalations[0]).toMatchObject({
      assignee: 'Admin Smoke',
      level: 'L2',
      due_at: '2026-06-13T18:00',
    });
    expect(calls.some((call) => call.method === 'run' && call.sql.startsWith('UPDATE support_escalations'))).toBe(false);
  });

  test('owner can change escalation routing fields', async () => {
    const { db, state } = makeSupportDb({
      cases: [baseCase({ id: 'case-esc', status: 'waiting_secondary' })],
      escalations: [baseEscalation({ id: 'esc-visible', case_id: 'case-esc' })],
    });

    const res = await setupApp(db, { id: 'owner-1', name: 'Owner', role: 'owner' }).request('/api/support/escalations/esc-visible', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lineAccountId: 'acc-1',
        assignee: 'Other Admin',
        level: 'L3',
        dueAt: '2026-06-14T18:00',
        question: '追加確認をお願いします',
      }),
    });

    expect(res.status).toBe(200);
    expect(state.escalations[0]).toMatchObject({
      assignee: 'Other Admin',
      level: 'L3',
      due_at: '2026-06-14T18:00',
      question: '追加確認をお願いします',
      updated_by: 'owner-1',
    });
  });

  test('filters my escalations by the logged-in staff name', async () => {
    const { db, calls } = makeSupportDb({
      cases: [
        baseCase({ id: 'case-mine', title: '自分宛', status: 'waiting_secondary', escalation_assignee: '田島' }),
        baseCase({ id: 'case-other', title: '他人宛', status: 'waiting_secondary', escalation_assignee: '松山' }),
        baseCase({ id: 'case-done', title: '完了済み', status: 'resolved', escalation_assignee: '田島' }),
      ],
    });

    const res = await setupApp(db).request('/api/support/cases?lineAccountId=acc-1&scope=my_escalations');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: Array<{ id: string; title: string }> };
    expect(body.success).toBe(true);
    expect(body.data.map((item) => item.id)).toEqual(['case-mine']);
    const listCall = calls.find((call) => call.method === 'all' && call.sql.includes('FROM support_cases sc'));
    expect(listCall?.binds).toContain('%田島%');
  });

  test('filters operational queues without mixing resolved cases', async () => {
    const { db } = makeSupportDb({
      cases: [
        baseCase({ id: 'case-open', status: 'open', primary_assignee: '田島', due_at: '2099-01-01T10:00:00.000' }),
        baseCase({ id: 'case-overdue', status: 'in_progress', primary_assignee: '田島', due_at: '2020-01-01T10:00:00.000' }),
        baseCase({ id: 'case-unassigned', status: 'waiting_primary', primary_assignee: null, due_at: null }),
        baseCase({ id: 'case-resolved', status: 'resolved', primary_assignee: null, due_at: '2020-01-01T10:00:00.000' }),
      ],
    });
    const app = setupApp(db, { id: 'owner-1', name: 'Owner', role: 'owner' });

    const unresolved = await app.request('/api/support/cases?lineAccountId=acc-1&queue=unresolved');
    expect(unresolved.status).toBe(200);
    const unresolvedBody = (await unresolved.json()) as { data: Array<{ id: string }> };
    expect(unresolvedBody.data.map((item) => item.id)).toEqual([
      'case-open',
      'case-overdue',
      'case-unassigned',
    ]);

    const overdue = await app.request('/api/support/cases?lineAccountId=acc-1&queue=overdue');
    expect(overdue.status).toBe(200);
    const overdueBody = (await overdue.json()) as { data: Array<{ id: string }> };
    expect(overdueBody.data.map((item) => item.id)).toEqual(['case-overdue']);

    const unassigned = await app.request('/api/support/cases?lineAccountId=acc-1&queue=unassigned');
    expect(unassigned.status).toBe(200);
    const unassignedBody = (await unassigned.json()) as { data: Array<{ id: string }> };
    expect(unassignedBody.data.map((item) => item.id)).toEqual(['case-unassigned']);
  });

  test('clamps invalid limit and fractional offset before listing support cases', async () => {
    const { db, calls } = makeSupportDb({
      cases: [
        baseCase({ id: 'case-1', title: '1件目' }),
        baseCase({ id: 'case-2', title: '2件目' }),
      ],
    });

    const res = await setupApp(db, { id: 'owner-1', name: 'Owner', role: 'owner' })
      .request('/api/support/cases?lineAccountId=acc-1&limit=abc&offset=1.9');

    expect(res.status).toBe(200);
    const listCall = calls.find((call) => call.method === 'all' && call.sql.includes('FROM support_cases sc'));
    expect(listCall?.binds.slice(-2)).toEqual([50, 1]);
  });

  test('resets non-finite offset before listing support cases', async () => {
    const { db, calls } = makeSupportDb({
      cases: [baseCase({ id: 'case-1' })],
    });

    const res = await setupApp(db, { id: 'owner-1', name: 'Owner', role: 'owner' })
      .request('/api/support/cases?lineAccountId=acc-1&offset=Infinity');

    expect(res.status).toBe(200);
    const listCall = calls.find((call) => call.method === 'all' && call.sql.includes('FROM support_cases sc'));
    expect(listCall?.binds.slice(-2)).toEqual([50, 0]);
  });

  test('staff can only list and open cases in their support scope', async () => {
    const { db } = makeSupportDb({
      cases: [
        baseCase({ id: 'case-created', title: '自分が作成', created_by: 'staff-1', primary_assignee: null }),
        baseCase({ id: 'case-primary', title: '一次担当', created_by: 'owner-1', primary_assignee: '田島' }),
        baseCase({ id: 'case-other', title: '範囲外', created_by: 'owner-1', primary_assignee: '松山' }),
      ],
    });
    const app = setupApp(db, { id: 'staff-1', name: '田島', role: 'staff' });

    const listRes = await app.request('/api/support/cases?lineAccountId=acc-1');
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { data: Array<{ id: string }> };
    expect(listBody.data.map((item) => item.id)).toEqual(['case-created', 'case-primary']);

    const denied = await app.request('/api/support/cases/case-other?lineAccountId=acc-1');
    expect(denied.status).toBe(404);

    const ownerRes = await setupApp(db, { id: 'owner-1', name: 'Owner', role: 'owner' })
      .request('/api/support/cases?lineAccountId=acc-1');
    const ownerBody = (await ownerRes.json()) as { data: Array<{ id: string }> };
    expect(ownerBody.data.map((item) => item.id)).toEqual(['case-created', 'case-primary', 'case-other']);
  });

  test('allows staff to search manuals but blocks manual mutation', async () => {
    const { db, calls } = makeSupportDb({});
    const app = setupApp(db, { id: 'staff-2', name: '一次担当', role: 'staff' });

    const listRes = await app.request('/api/support/manuals?lineAccountId=acc-1&q=報酬');
    expect(listRes.status).toBe(200);

    for (const [path, init] of [
      ['/api/support/manuals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lineAccountId: 'acc-1', title: '新しいマニュアル' }),
      }],
      ['/api/support/manuals/manual-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '更新' }),
      }],
      ['/api/support/manuals/manual-1', { method: 'DELETE' }],
    ] as const) {
      const res = await app.request(path, init);
      expect(res.status).toBe(403);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toContain('owner/admin');
    }

    expect(calls.some((call) => call.method === 'run' && call.sql.includes('support_manuals'))).toBe(false);
  });

  test('owner manual creation requires a LINE account scope', async () => {
    const { db, state } = makeSupportDb({});
    const app = setupApp(db, { id: 'owner-1', name: 'Owner', role: 'owner' });

    const missingScope = await app.request('/api/support/manuals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'スコープなし手順', body: '確認手順です。' }),
    });
    expect(missingScope.status).toBe(400);

    const ok = await app.request('/api/support/manuals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lineAccountId: 'acc-1',
        title: '新しい確認手順',
        category: 'reward',
        body: '報酬の確認手順です。',
        url: 'https://example.com/reward-manual',
      }),
    });
    expect(ok.status).toBe(201);
    const body = (await ok.json()) as { success: boolean; data: { lineAccountId: string; title: string } };
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      lineAccountId: 'acc-1',
      title: '新しい確認手順',
    });
    expect(state.manuals.at(-1)).toMatchObject({
      line_account_id: 'acc-1',
      title: '新しい確認手順',
      body: '報酬の確認手順です。',
      url: 'https://example.com/reward-manual',
      created_by: 'owner-1',
      updated_by: 'owner-1',
    });
  });

  test('owner manual creation rejects empty body and non-http links', async () => {
    const { db, calls, state } = makeSupportDb({});
    const app = setupApp(db, { id: 'owner-1', name: 'Owner', role: 'owner' });

    const emptyBody = await app.request('/api/support/manuals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lineAccountId: 'acc-1', title: '本文なし手順', body: ' ' }),
    });
    expect(emptyBody.status).toBe(400);
    expect((await emptyBody.json()) as { error: string }).toMatchObject({ error: 'body is required' });

    const invalidUrl = await app.request('/api/support/manuals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lineAccountId: 'acc-1',
        title: '不正リンク手順',
        body: '確認手順です。',
        url: 'ftp://example.com/manual',
      }),
    });
    expect(invalidUrl.status).toBe(400);
    expect((await invalidUrl.json()) as { error: string }).toMatchObject({
      error: 'url must start with http:// or https://',
    });

    expect(state.manuals).toHaveLength(0);
    expect(calls.some((call) => call.method === 'run' && call.sql.includes('support_manuals'))).toBe(false);
  });

  test('owner manual updates are scoped to the requested LINE account', async () => {
    const { db, state } = makeSupportDb({
      manuals: [
        baseManual({ id: 'manual-acc1', line_account_id: 'acc-1', title: 'acc1の手順' }),
        baseManual({ id: 'manual-acc2', line_account_id: 'acc-2', title: 'acc2の手順' }),
      ],
    });
    const app = setupApp(db, { id: 'owner-1', name: 'Owner', role: 'owner' });

    const missingScope = await app.request('/api/support/manuals/manual-acc1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'スコープなし更新' }),
    });
    expect(missingScope.status).toBe(400);

    const denied = await app.request('/api/support/manuals/manual-acc2', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lineAccountId: 'acc-1', title: '越境更新' }),
    });
    expect(denied.status).toBe(404);
    expect(state.manuals.find((item) => item.id === 'manual-acc2')?.title).toBe('acc2の手順');

    const ok = await app.request('/api/support/manuals/manual-acc1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lineAccountId: 'acc-1', title: '更新済み手順', body: '更新済みの本文' }),
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { success: boolean; data: { id: string; title: string; body: string; lineAccountId: string } };
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      id: 'manual-acc1',
      lineAccountId: 'acc-1',
      title: '更新済み手順',
      body: '更新済みの本文',
    });
    expect(state.manuals.find((item) => item.id === 'manual-acc1')).toMatchObject({
      line_account_id: 'acc-1',
      title: '更新済み手順',
      body: '更新済みの本文',
      updated_by: 'owner-1',
    });
  });

  test('owner manual updates reject empty title/body and non-http links', async () => {
    const { db, calls, state } = makeSupportDb({
      manuals: [baseManual({ id: 'manual-acc1', line_account_id: 'acc-1', title: '元の手順' })],
    });
    const app = setupApp(db, { id: 'owner-1', name: 'Owner', role: 'owner' });

    for (const [payload, expectedError] of [
      [{ lineAccountId: 'acc-1', title: ' ' }, 'title is required'],
      [{ lineAccountId: 'acc-1', body: '' }, 'body is required'],
      [{ lineAccountId: 'acc-1', url: 'mailto:support@example.com' }, 'url must start with http:// or https://'],
    ] as const) {
      const res = await app.request('/api/support/manuals/manual-acc1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      expect(res.status).toBe(400);
      expect((await res.json()) as { error: string }).toMatchObject({ error: expectedError });
    }

    expect(state.manuals.find((item) => item.id === 'manual-acc1')).toMatchObject({
      title: '元の手順',
      body: '報酬の反映状況を確認します。',
      url: null,
    });
    expect(calls.some((call) => call.method === 'run' && call.sql.startsWith('UPDATE support_manuals SET'))).toBe(false);
  });

  test('owner manual archive is scoped to the requested LINE account', async () => {
    const { db, state } = makeSupportDb({
      manuals: [
        baseManual({ id: 'manual-acc1', line_account_id: 'acc-1', is_active: 1 }),
        baseManual({ id: 'manual-acc2', line_account_id: 'acc-2', is_active: 1 }),
      ],
    });
    const app = setupApp(db, { id: 'owner-1', name: 'Owner', role: 'owner' });

    const missingScope = await app.request('/api/support/manuals/manual-acc1', { method: 'DELETE' });
    expect(missingScope.status).toBe(400);

    const denied = await app.request('/api/support/manuals/manual-acc2?lineAccountId=acc-1', { method: 'DELETE' });
    expect(denied.status).toBe(404);
    expect(state.manuals.find((item) => item.id === 'manual-acc2')?.is_active).toBe(1);

    const ok = await app.request('/api/support/manuals/manual-acc1?lineAccountId=acc-1', { method: 'DELETE' });
    expect(ok.status).toBe(200);
    expect(state.manuals.find((item) => item.id === 'manual-acc1')).toMatchObject({
      is_active: 0,
      updated_by: 'owner-1',
    });
  });
});

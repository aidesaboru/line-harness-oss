import { describe, expect, test, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

// We assert on the SQL/binds the route forwards to D1. The DB-helper path
// (no lineAccountId query) is mocked separately on @line-crm/db.
const dbMocks = {
  getAutomations: vi.fn(),
  getAutomationById: vi.fn(),
  createAutomation: vi.fn(),
  updateAutomation: vi.fn(),
  deleteAutomation: vi.fn(),
  getAutomationLogs: vi.fn(),
};
vi.mock('@line-crm/db', () => dbMocks);

const { automations } = await import('./automations.js');

interface AutomationRow {
  id: string;
  name: string;
  description: string | null;
  event_type: string;
  conditions: string;
  actions: string;
  is_active: number;
  priority: number;
  created_at: string;
  updated_at: string;
  line_account_id: string | null;
}

function makeAutomationDb(rows: AutomationRow[]) {
  const calls: { sql: string; binds: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          bound = args;
          return stmt;
        },
        async all() {
          calls.push({ sql, binds: bound });
          // NULL-aware filter: row matches when its line_account_id is NULL
          // (global) OR equals the bound lineAccountId.
          if (/FROM automations\b/i.test(sql) && /line_account_id IS NULL/i.test(sql)) {
            const [lineAccountId] = bound as [string];
            const filtered = rows.filter(
              (r) => r.line_account_id == null || r.line_account_id === lineAccountId,
            );
            return { results: filtered };
          }
          return { results: [] };
        },
        async run() {
          calls.push({ sql, binds: bound });
          return { success: true, meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
  return { db, calls };
}

function setupApp(db: D1Database) {
  const app = new Hono<{
    Bindings: { DB: D1Database };
    Variables: { staff: { id: string; name: string; role: 'owner' } };
  }>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'owner-1', name: 'Owner', role: 'owner' });
    c.env = { DB: db };
    await next();
  });
  app.route('/', automations);
  return app;
}

const rowBase = {
  description: null,
  event_type: 'message_received',
  conditions: '{}',
  actions: '[]',
  is_active: 1,
  priority: 0,
  created_at: '2026-05-20T00:00:00.000',
  updated_at: '2026-05-20T00:00:00.000',
};

beforeEach(() => {
  for (const fn of Object.values(dbMocks)) fn.mockReset();
  dbMocks.getAutomationLogs.mockResolvedValue([]);
});

describe('GET /api/automations?lineAccountId=X', () => {
  test('includes both account-bound and global (NULL) automations', async () => {
    const rows: AutomationRow[] = [
      { id: 'a-global', name: 'global', line_account_id: null, ...rowBase },
      { id: 'a-acc1', name: 'acc1', line_account_id: 'acc-1', ...rowBase },
      { id: 'a-acc2', name: 'acc2', line_account_id: 'acc-2', ...rowBase },
    ];
    const { db, calls } = makeAutomationDb(rows);

    const res = await setupApp(db).request('/api/automations?lineAccountId=acc-1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { id: string; lineAccountId: string | null }[];
    };
    expect(body.success).toBe(true);
    const ids = body.data.map((d) => d.id).sort();
    // The engine (event-bus.ts:149) fires automations whose line_account_id
    // is NULL OR equal to the active account. The list endpoint must mirror
    // that scope, otherwise globals + freshly-created records disappear in
    // the UI even though they will still execute.
    expect(ids).toEqual(['a-acc1', 'a-global']);
    // Scope must be surfaced so callers can tell globals from account-bound
    // rows — otherwise the UI cannot safely offer per-account edit/disable.
    const byId = new Map(body.data.map((d) => [d.id, d.lineAccountId] as const));
    expect(byId.get('a-global')).toBeNull();
    expect(byId.get('a-acc1')).toBe('acc-1');
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toMatch(/line_account_id IS NULL/);
    expect(calls[0].sql).toMatch(/line_account_id = \?/);
    expect(calls[0].binds).toEqual(['acc-1']);
  });

  test('falls back to getAutomations helper when no lineAccountId is provided', async () => {
    dbMocks.getAutomations.mockResolvedValue([
      { id: 'a-x', name: 'x', line_account_id: null, ...rowBase },
    ]);
    const { db } = makeAutomationDb([]);

    const res = await setupApp(db).request('/api/automations');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { id: string }[] };
    expect(body.data.map((d) => d.id)).toEqual(['a-x']);
    expect(dbMocks.getAutomations).toHaveBeenCalledTimes(1);
  });

  test('returns empty array when filter matches nothing and no globals exist', async () => {
    const rows: AutomationRow[] = [
      { id: 'a-other', name: 'other', line_account_id: 'acc-other', ...rowBase },
    ];
    const { db } = makeAutomationDb(rows);

    const res = await setupApp(db).request('/api/automations?lineAccountId=acc-1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: unknown[] };
    expect(body.data).toEqual([]);
  });
});

describe('GET /api/automations/:id/logs', () => {
  test('clamps invalid, fractional, and oversized limit query values', async () => {
    const { db } = makeAutomationDb([]);
    const app = setupApp(db);

    expect((await app.request('/api/automations/auto-1/logs?limit=abc')).status).toBe(200);
    expect((await app.request('/api/automations/auto-1/logs?limit=2.9')).status).toBe(200);
    expect((await app.request('/api/automations/auto-1/logs?limit=9999')).status).toBe(200);

    expect(dbMocks.getAutomationLogs).toHaveBeenNthCalledWith(1, db, 'auto-1', 100);
    expect(dbMocks.getAutomationLogs).toHaveBeenNthCalledWith(2, db, 'auto-1', 2);
    expect(dbMocks.getAutomationLogs).toHaveBeenNthCalledWith(3, db, 'auto-1', 500);
  });
});

describe('automation payload validation', () => {
  test('rejects malformed query, path, and payload values before DB helpers or SQL', async () => {
    const { db, calls } = makeAutomationDb([]);
    const app = setupApp(db);
    const cases: Array<{ method: string; path: string; body?: string }> = [
      { method: 'GET', path: '/api/automations?lineAccountId=bad account' },
      { method: 'GET', path: '/api/automations/bad id' },
      { method: 'GET', path: '/api/automations/bad id/logs' },
      { method: 'POST', path: '/api/automations', body: '{not-json' },
      {
        method: 'POST',
        path: '/api/automations',
        body: JSON.stringify({ name: 'Welcome', eventType: 'bad event', actions: [] }),
      },
      {
        method: 'POST',
        path: '/api/automations',
        body: JSON.stringify({ name: 'Welcome', eventType: 'friend_add', actions: [{ type: 'bad action', params: {} }] }),
      },
      {
        method: 'PUT',
        path: '/api/automations/auto-1',
        body: JSON.stringify({}),
      },
      {
        method: 'PUT',
        path: '/api/automations/auto-1',
        body: JSON.stringify({ isActive: 1 }),
      },
      { method: 'DELETE', path: '/api/automations/bad id' },
    ];

    for (const item of cases) {
      const res = await app.request(item.path, {
        method: item.method,
        headers: item.body ? { 'Content-Type': 'application/json' } : undefined,
        body: item.body,
      });
      expect(res.status, `${item.method} ${item.path}`).toBe(400);
    }

    expect(dbMocks.getAutomations).not.toHaveBeenCalled();
    expect(dbMocks.getAutomationById).not.toHaveBeenCalled();
    expect(dbMocks.createAutomation).not.toHaveBeenCalled();
    expect(dbMocks.updateAutomation).not.toHaveBeenCalled();
    expect(dbMocks.deleteAutomation).not.toHaveBeenCalled();
    expect(dbMocks.getAutomationLogs).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  test('trims and normalizes valid create and update payloads before DB helpers', async () => {
    const { db, calls } = makeAutomationDb([]);
    const created = {
      id: 'auto-1',
      name: 'Welcome',
      description: 'Desc',
      event_type: 'message_received',
      conditions: '{"keyword":"hi"}',
      actions: '[{"type":"send_message","params":{"content":"hello"}}]',
      is_active: 1,
      priority: 2,
      created_at: '2026-06-14T00:00:00.000',
      updated_at: '2026-06-14T00:00:00.000',
      line_account_id: 'acc-1',
    };
    dbMocks.createAutomation.mockResolvedValue(created);
    dbMocks.getAutomationById.mockResolvedValue({
      ...created,
      name: 'Updated',
      description: '',
      event_type: 'friend_add',
      conditions: '{}',
      actions: '[{"type":"add_tag","params":{"tagId":"tag-1"}}]',
      is_active: 0,
      priority: 3,
      line_account_id: null,
    });

    const app = setupApp(db);
    const createRes = await app.request('/api/automations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: ' Welcome ',
        description: ' Desc ',
        eventType: ' message_received ',
        conditions: { keyword: 'hi' },
        actions: [{ type: ' send_message ', params: { content: 'hello' } }],
        priority: 2,
        lineAccountId: ' acc-1 ',
      }),
    });
    const updateRes = await app.request('/api/automations/auto-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: ' Updated ',
        description: null,
        eventType: ' friend_add ',
        conditions: {},
        actions: [{ type: ' add_tag ', params: { tagId: 'tag-1' } }],
        priority: 3,
        isActive: false,
        lineAccountId: '',
      }),
    });

    expect(createRes.status).toBe(201);
    expect(updateRes.status).toBe(200);
    expect(dbMocks.createAutomation).toHaveBeenCalledWith(db, {
      name: 'Welcome',
      description: 'Desc',
      eventType: 'message_received',
      conditions: { keyword: 'hi' },
      actions: [{ type: 'send_message', params: { content: 'hello' } }],
      priority: 2,
      lineAccountId: 'acc-1',
    });
    expect(dbMocks.updateAutomation).toHaveBeenCalledWith(db, 'auto-1', {
      name: 'Updated',
      description: '',
      eventType: 'friend_add',
      conditions: {},
      actions: [{ type: 'add_tag', params: { tagId: 'tag-1' } }],
      priority: 3,
      isActive: false,
    });
    const lineAccountUpdates = calls.filter((call) => call.sql.includes('UPDATE automations SET line_account_id = ?'));
    expect(lineAccountUpdates.map((call) => call.binds)).toEqual([
      ['acc-1', 'auto-1'],
      [null, 'auto-1'],
    ]);
  });
});

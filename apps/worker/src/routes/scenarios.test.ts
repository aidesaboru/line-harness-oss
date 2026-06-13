import { describe, expect, test, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

const dbMocks = {
  getScenarios: vi.fn(),
  getScenarioById: vi.fn(),
  createScenario: vi.fn(),
  updateScenario: vi.fn(),
  deleteScenario: vi.fn(),
  createScenarioStep: vi.fn(),
  updateScenarioStep: vi.fn(),
  deleteScenarioStep: vi.fn(),
  enrollFriendInScenario: vi.fn(),
  getFriendById: vi.fn(),
  computeNextDeliveryAt: vi.fn(),
  resolveStepContent: vi.fn(),
};
vi.mock('@line-crm/db', () => dbMocks);

vi.mock('../services/scenario-stats.js', () => ({
  computeScenarioStats: vi.fn(),
}));

const { scenarios: scenariosModule } = await import('./scenarios.js');

type StaffRole = 'owner' | 'admin' | 'staff';

type TestEnv = {
  Bindings: { DB: D1Database };
  Variables: { staff: { id: string; name: string; role: StaffRole } };
};

interface ScenarioRow {
  id: string;
  name: string;
  description: string | null;
  trigger_type: string;
  trigger_tag_id: string | null;
  is_active: number;
  delivery_mode: string;
  created_at: string;
  updated_at: string;
  line_account_id: string | null;
  step_count: number;
}

function makeScenarioDb(rows: ScenarioRow[], options: { visibleFriendIds?: string[] } = {}) {
  const calls: { sql: string; binds: unknown[] }[] = [];
  const visibleFriendIds = new Set(options.visibleFriendIds ?? []);
  const db = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          bound = args;
          return stmt;
        },
        async all<_T>() {
          calls.push({ sql, binds: bound });
          if (/FROM scenarios s\b/i.test(sql) && /line_account_id IS NULL/i.test(sql)) {
            const [lineAccountId] = bound as [string];
            const filtered = rows.filter(
              (r) => r.line_account_id == null || r.line_account_id === lineAccountId,
            );
            return { results: filtered };
          }
          return { results: [] };
        },
        async first<T>() {
          calls.push({ sql, binds: bound });
          if (sql.startsWith('SELECT 1 AS ok WHERE')) {
            const [friendId] = bound as [string];
            return (visibleFriendIds.has(friendId) ? { ok: 1 } : null) as T | null;
          }
          return null as T | null;
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
  return { db, calls };
}

function setupApp(db: D1Database, role: StaffRole = 'staff') {
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'staff-1', name: '田島', role });
    c.env = { DB: db };
    await next();
  });
  app.route('/', scenariosModule);
  return app;
}

const rowBase = {
  description: null,
  trigger_type: 'friend_add',
  trigger_tag_id: null,
  is_active: 1,
  delivery_mode: 'relative',
  created_at: '2026-05-20T00:00:00.000',
  updated_at: '2026-05-20T00:00:00.000',
  step_count: 0,
};

beforeEach(() => {
  for (const fn of Object.values(dbMocks)) fn.mockReset();
});

describe('GET /api/scenarios?lineAccountId=X', () => {
  test('includes both account-bound and global (NULL) scenarios', async () => {
    const rows: ScenarioRow[] = [
      { id: 's-global', name: 'global', line_account_id: null, ...rowBase },
      { id: 's-acc1', name: 'acc1', line_account_id: 'acc-1', ...rowBase },
      { id: 's-acc2', name: 'acc2', line_account_id: 'acc-2', ...rowBase },
    ];
    const { db, calls } = makeScenarioDb(rows);

    const res = await setupApp(db).request('/api/scenarios?lineAccountId=acc-1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { id: string; lineAccountId: string | null }[] };
    expect(body.success).toBe(true);
    // webhook.ts:211 / liff.ts:878 trigger scenarios where line_account_id is
    // NULL (global) OR matches the active account. The list endpoint must
    // mirror that so the UI does not hide records the engine will fire.
    const ids = body.data.map((d) => d.id).sort();
    expect(ids).toEqual(['s-acc1', 's-global']);
    // Serializer surfaces the binding so the UI can distinguish 全アカ共通 from
    // an account-specific scenario.
    const globalRow = body.data.find((d) => d.id === 's-global');
    expect(globalRow?.lineAccountId).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toMatch(/line_account_id IS NULL/);
    expect(calls[0].sql).toMatch(/s\.line_account_id = \?/);
    expect(calls[0].binds).toEqual(['acc-1']);
  });

  test('falls back to getScenarios helper when no lineAccountId is provided', async () => {
    dbMocks.getScenarios.mockResolvedValue([
      { id: 's-x', name: 'x', line_account_id: null, ...rowBase },
    ]);
    const { db } = makeScenarioDb([]);

    const res = await setupApp(db).request('/api/scenarios');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { id: string }[] };
    expect(body.data.map((d) => d.id)).toEqual(['s-x']);
    expect(dbMocks.getScenarios).toHaveBeenCalledTimes(1);
  });

  test('returns empty array when filter matches nothing and no globals exist', async () => {
    const rows: ScenarioRow[] = [
      { id: 's-other', name: 'other', line_account_id: 'acc-other', ...rowBase },
    ];
    const { db } = makeScenarioDb(rows);

    const res = await setupApp(db).request('/api/scenarios?lineAccountId=acc-1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: unknown[] };
    expect(body.data).toEqual([]);
  });
});

describe('scenario definition role guards', () => {
  test('staff cannot mutate scenario definitions or steps', async () => {
    const { db } = makeScenarioDb([]);
    const app = setupApp(db, 'staff');
    const requests: Array<[string, string, RequestInit?]> = [
      ['POST', '/api/scenarios', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Campaign', triggerType: 'friend_add' }),
      }],
      ['PUT', '/api/scenarios/scenario-1', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed' }),
      }],
      ['DELETE', '/api/scenarios/scenario-1'],
      ['POST', '/api/scenarios/scenario-1/steps', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stepOrder: 1,
          delayMinutes: 0,
          messageType: 'text',
          messageContent: 'hello',
        }),
      }],
      ['PUT', '/api/scenarios/scenario-1/steps/step-1', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageContent: 'updated' }),
      }],
      ['DELETE', '/api/scenarios/scenario-1/steps/step-1'],
      ['POST', '/api/scenarios/scenario-1/steps/reorder', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orders: [{ stepId: 'step-1', stepOrder: 1 }] }),
      }],
    ];

    for (const [method, path, init] of requests) {
      const res = await app.request(path, { ...init, method });
      expect(res.status, `${method} ${path}`).toBe(403);
    }

    expect(dbMocks.createScenario).not.toHaveBeenCalled();
    expect(dbMocks.updateScenario).not.toHaveBeenCalled();
    expect(dbMocks.deleteScenario).not.toHaveBeenCalled();
    expect(dbMocks.createScenarioStep).not.toHaveBeenCalled();
    expect(dbMocks.updateScenarioStep).not.toHaveBeenCalled();
    expect(dbMocks.deleteScenarioStep).not.toHaveBeenCalled();
  });
});

describe('POST /api/scenarios/:id/enroll/:friendId support visibility', () => {
  const scenario = { id: 'scenario-1', name: 'manual', line_account_id: null, ...rowBase };
  const enrollment = {
    id: 'friend-scenario-1',
    friend_id: 'friend-visible',
    scenario_id: 'scenario-1',
    current_step_order: 1,
    status: 'active',
    started_at: '2026-06-12T10:00:00.000',
    next_delivery_at: null,
    updated_at: '2026-06-12T10:00:00.000',
  };

  test('staff cannot manually enroll a hidden friend', async () => {
    dbMocks.getScenarioById.mockResolvedValue(scenario);
    const { db } = makeScenarioDb([], { visibleFriendIds: ['friend-visible'] });

    const res = await setupApp(db, 'staff').request('/api/scenarios/scenario-1/enroll/friend-hidden', {
      method: 'POST',
    });

    expect(res.status).toBe(404);
    expect(dbMocks.getFriendById).not.toHaveBeenCalled();
    expect(dbMocks.enrollFriendInScenario).not.toHaveBeenCalled();
  });

  test('staff can manually enroll a visible friend', async () => {
    dbMocks.getScenarioById.mockResolvedValue(scenario);
    dbMocks.getFriendById.mockResolvedValue({ id: 'friend-visible', line_user_id: 'U-visible' });
    dbMocks.enrollFriendInScenario.mockResolvedValue(enrollment);
    const { db } = makeScenarioDb([], { visibleFriendIds: ['friend-visible'] });

    const res = await setupApp(db, 'staff').request('/api/scenarios/scenario-1/enroll/friend-visible', {
      method: 'POST',
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { friendId: string; scenarioId: string; status: string } };
    expect(body.data).toMatchObject({
      friendId: 'friend-visible',
      scenarioId: 'scenario-1',
      status: 'active',
    });
    expect(dbMocks.enrollFriendInScenario).toHaveBeenCalledWith(db, 'friend-visible', 'scenario-1');
  });
});

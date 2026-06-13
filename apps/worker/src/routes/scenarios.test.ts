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

interface ScenarioStepRow {
  id: string;
  scenario_id: string;
  step_order: number;
  delay_minutes: number;
  offset_days: number | null;
  offset_minutes: number | null;
  delivery_time: string | null;
  message_type: 'text' | 'image' | 'flex';
  message_content: string;
}

interface TemplateRow {
  id: string;
  message_type: string;
  message_content: string;
}

function makeScenarioDb(
  rows: ScenarioRow[],
  options: {
    visibleFriendIds?: string[];
    deliveryModeByScenarioId?: Record<string, string>;
    steps?: ScenarioStepRow[];
    templates?: TemplateRow[];
    tagIds?: string[];
  } = {},
) {
  const calls: { sql: string; binds: unknown[] }[] = [];
  const visibleFriendIds = new Set(options.visibleFriendIds ?? []);
  const deliveryModeByScenarioId = options.deliveryModeByScenarioId ?? {};
  const templates = new Map((options.templates ?? []).map((t) => [t.id, t]));
  const tagIds = new Set(options.tagIds ?? []);
  const steps = options.steps ?? [];
  const batchCalls: unknown[][] = [];
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
          if (/SELECT id, step_order FROM scenario_steps WHERE scenario_id = \?/i.test(sql)) {
            const [scenarioId] = bound as [string];
            return {
              results: steps
                .filter((s) => s.scenario_id === scenarioId)
                .map((s) => ({ id: s.id, step_order: s.step_order })),
            };
          }
          return { results: [] };
        },
        async first<T>() {
          calls.push({ sql, binds: bound });
          if (sql.startsWith('SELECT 1 AS ok WHERE')) {
            const [friendId] = bound as [string];
            return (visibleFriendIds.has(friendId) ? { ok: 1 } : null) as T | null;
          }
          if (/SELECT delivery_mode FROM scenarios WHERE id = \?/i.test(sql)) {
            const [scenarioId] = bound as [string];
            const mode = deliveryModeByScenarioId[scenarioId] ?? rows.find((r) => r.id === scenarioId)?.delivery_mode;
            return (mode ? { delivery_mode: mode } : null) as T | null;
          }
          if (/SELECT id, message_type, message_content FROM templates WHERE id = \?/i.test(sql)) {
            const [templateId] = bound as [string];
            const tpl = templates.get(templateId);
            return (tpl ? { id: tpl.id, message_type: tpl.message_type, message_content: tpl.message_content } : null) as T | null;
          }
          if (/SELECT id FROM templates WHERE id = \?/i.test(sql)) {
            const [templateId] = bound as [string];
            return (templates.has(templateId) ? { id: templateId } : null) as T | null;
          }
          if (/SELECT id FROM tags WHERE id = \?/i.test(sql)) {
            const [tagId] = bound as [string];
            return (tagIds.has(tagId) ? { id: tagId } : null) as T | null;
          }
          if (/FROM scenario_steps WHERE id = \? AND scenario_id = \?/i.test(sql)) {
            const [stepId, scenarioId] = bound as [string, string];
            const step = steps.find((s) => s.id === stepId && s.scenario_id === scenarioId);
            if (!step) return null as T | null;
            return {
              delay_minutes: step.delay_minutes,
              offset_days: step.offset_days,
              offset_minutes: step.offset_minutes,
              delivery_time: step.delivery_time,
              message_type: step.message_type,
              message_content: step.message_content,
            } as T;
          }
          return null as T | null;
        },
      };
      return stmt;
    },
    async batch(statements: unknown[]) {
      batchCalls.push(statements);
      return [];
    },
  } as unknown as D1Database;
  return { db, calls, batchCalls };
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

function loggedText(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.flat().map(String).join(' ');
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

    const res = await setupApp(db, 'owner').request('/api/scenarios?lineAccountId=acc-1');
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

    const res = await setupApp(db, 'owner').request('/api/scenarios');
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

    const res = await setupApp(db, 'owner').request('/api/scenarios?lineAccountId=acc-1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: unknown[] };
    expect(body.data).toEqual([]);
  });

  test('rejects unsafe lineAccountId before SQL or DB helper calls', async () => {
    const { db, calls } = makeScenarioDb([]);

    const res = await setupApp(db, 'owner').request('/api/scenarios?lineAccountId=bad%20account');

    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
    expect(dbMocks.getScenarios).not.toHaveBeenCalled();
  });

  test('trims valid lineAccountId before SQL bind', async () => {
    const rows: ScenarioRow[] = [
      { id: 's-global', name: 'global', line_account_id: null, ...rowBase },
      { id: 's-acc1', name: 'acc1', line_account_id: 'acc-1', ...rowBase },
    ];
    const { db, calls } = makeScenarioDb(rows);

    const res = await setupApp(db, 'owner').request('/api/scenarios?lineAccountId=%20acc-1%20');

    expect(res.status).toBe(200);
    expect(calls[0].binds).toEqual(['acc-1']);
  });
});

describe('scenario definition role guards', () => {
  test('staff cannot read or mutate scenario definitions or steps', async () => {
    const { db } = makeScenarioDb([]);
    const app = setupApp(db, 'staff');
    const requests: Array<[string, string, RequestInit?]> = [
      ['GET', '/api/scenarios'],
      ['GET', '/api/scenarios/scenario-1'],
      ['GET', '/api/scenarios/scenario-1/preview'],
      ['GET', '/api/scenarios/scenario-1/stats'],
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

    expect(dbMocks.getScenarios).not.toHaveBeenCalled();
    expect(dbMocks.getScenarioById).not.toHaveBeenCalled();
    expect(dbMocks.createScenario).not.toHaveBeenCalled();
    expect(dbMocks.updateScenario).not.toHaveBeenCalled();
    expect(dbMocks.deleteScenario).not.toHaveBeenCalled();
    expect(dbMocks.createScenarioStep).not.toHaveBeenCalled();
    expect(dbMocks.updateScenarioStep).not.toHaveBeenCalled();
    expect(dbMocks.deleteScenarioStep).not.toHaveBeenCalled();
  });
});

describe('scenario payload validation', () => {
  test('scenario path IDs and preview cursors reject malformed values before DB lookup or writes', async () => {
    const validStepBody = JSON.stringify({
      stepOrder: 1,
      delayMinutes: 0,
      messageType: 'text',
      messageContent: 'hello',
    });
    const cases: Array<[string, string, RequestInit?]> = [
      ['GET', '/api/scenarios/bad%20scenario'],
      ['PUT', '/api/scenarios/bad%20scenario', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed' }),
      }],
      ['DELETE', '/api/scenarios/bad%20scenario'],
      ['POST', '/api/scenarios/bad%20scenario/steps', {
        headers: { 'Content-Type': 'application/json' },
        body: validStepBody,
      }],
      ['PUT', '/api/scenarios/scenario-1/steps/bad%20step', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageContent: 'updated' }),
      }],
      ['DELETE', '/api/scenarios/bad%20scenario/steps/step-1'],
      ['POST', '/api/scenarios/bad%20scenario/steps/reorder', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orders: [{ stepId: 'step-1', stepOrder: 1 }] }),
      }],
      ['GET', '/api/scenarios/bad%20scenario/preview'],
      ['GET', '/api/scenarios/scenario-1/preview?startAt=not-a-date'],
      ['GET', '/api/scenarios/bad%20scenario/stats'],
      ['POST', '/api/scenarios/bad%20scenario/enroll/friend-visible'],
      ['POST', '/api/scenarios/scenario-1/enroll/bad%20friend'],
    ];

    for (const [method, path, init] of cases) {
      const { db, calls, batchCalls } = makeScenarioDb([]);
      const res = await setupApp(db, 'owner').request(path, { ...init, method });

      expect(res.status, `${method} ${path}`).toBe(400);
      expect(calls, `${method} ${path}`).toEqual([]);
      expect(batchCalls, `${method} ${path}`).toEqual([]);
    }

    expect(dbMocks.getScenarioById).not.toHaveBeenCalled();
    expect(dbMocks.updateScenario).not.toHaveBeenCalled();
    expect(dbMocks.deleteScenario).not.toHaveBeenCalled();
    expect(dbMocks.createScenarioStep).not.toHaveBeenCalled();
    expect(dbMocks.updateScenarioStep).not.toHaveBeenCalled();
    expect(dbMocks.deleteScenarioStep).not.toHaveBeenCalled();
    expect(dbMocks.enrollFriendInScenario).not.toHaveBeenCalled();
  });

  test('scenario create/update rejects malformed or invalid payloads before DB writes', async () => {
    const { db, calls } = makeScenarioDb([]);
    const app = setupApp(db, 'owner');

    const requests: Array<[string, string, BodyInit]> = [
      ['POST', '/api/scenarios', '{'],
      ['POST', '/api/scenarios', JSON.stringify({ name: 'x', triggerType: 'friend_add', deliveryMode: 'weekly' })],
      ['POST', '/api/scenarios', JSON.stringify({ name: 'x', triggerType: 'unknown' })],
      ['PUT', '/api/scenarios/scenario-1', '{'],
      ['PUT', '/api/scenarios/scenario-1', JSON.stringify({})],
      ['PUT', '/api/scenarios/scenario-1', JSON.stringify({ deliveryMode: 'relative' })],
      ['PUT', '/api/scenarios/scenario-1', JSON.stringify({ isActive: 'yes' })],
    ];

    for (const [method, path, body] of requests) {
      const res = await app.request(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      expect(res.status, `${method} ${path}`).toBe(400);
    }

    expect(calls).toHaveLength(0);
    expect(dbMocks.createScenario).not.toHaveBeenCalled();
    expect(dbMocks.updateScenario).not.toHaveBeenCalled();
  });

  test('scenario create/update trims valid payloads before DB writes', async () => {
    const { db } = makeScenarioDb([]);
    dbMocks.createScenario.mockResolvedValue({
      id: 'scenario-1',
      name: 'Welcome',
      description: 'Intro',
      trigger_type: 'manual',
      trigger_tag_id: null,
      is_active: 1,
      delivery_mode: 'elapsed',
      line_account_id: null,
      created_at: '2026-06-12T10:00:00.000',
      updated_at: '2026-06-12T10:00:00.000',
    });
    dbMocks.updateScenario.mockResolvedValue({
      id: 'scenario-1',
      name: 'Welcome 2',
      description: null,
      trigger_type: 'manual',
      trigger_tag_id: 'tag-1',
      is_active: 0,
      delivery_mode: 'elapsed',
      line_account_id: null,
      created_at: '2026-06-12T10:00:00.000',
      updated_at: '2026-06-12T10:05:00.000',
    });
    const app = setupApp(db, 'owner');

    const createRes = await app.request('/api/scenarios', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: ' Welcome ',
        description: ' Intro ',
        triggerType: 'manual',
        deliveryMode: 'elapsed',
      }),
    });
    expect(createRes.status).toBe(201);
    expect(dbMocks.createScenario).toHaveBeenCalledWith(db, {
      name: 'Welcome',
      description: 'Intro',
      triggerType: 'manual',
      triggerTagId: null,
      deliveryMode: 'elapsed',
    });

    const updateRes = await app.request('/api/scenarios/%20scenario-1%20', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: ' Welcome 2 ',
        description: ' ',
        triggerTagId: ' tag-1 ',
        isActive: false,
      }),
    });
    expect(updateRes.status).toBe(200);
    expect(dbMocks.updateScenario).toHaveBeenLastCalledWith(db, 'scenario-1', {
      name: 'Welcome 2',
      description: null,
      trigger_type: undefined,
      trigger_tag_id: 'tag-1',
      is_active: 0,
    });
  });

  test('scenario create failure logs only the error kind', async () => {
    const { db } = makeScenarioDb([]);
    dbMocks.createScenario.mockRejectedValueOnce(
      new Error('scenario secret account-token scenario-1 Welcome message body raw-body'),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const res = await setupApp(db, 'owner').request('/api/scenarios', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Welcome',
          description: 'message body',
          triggerType: 'manual',
          deliveryMode: 'elapsed',
        }),
      });

      expect(res.status).toBe(500);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body).toEqual({ success: false, error: 'Internal server error' });
      const logged = loggedText(errorSpy);
      expect(logged).toContain('POST /api/scenarios error: Error');
      expect(logged).not.toContain('scenario secret');
      expect(logged).not.toContain('account-token');
      expect(logged).not.toContain('scenario-1');
      expect(logged).not.toContain('Welcome');
      expect(logged).not.toContain('message body');
      expect(logged).not.toContain('raw-body');
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('scenario step create/update/reorder rejects malformed payloads before DB lookup', async () => {
    const { db, calls } = makeScenarioDb([]);
    const app = setupApp(db, 'owner');

    const requests: Array<[string, string, BodyInit]> = [
      ['POST', '/api/scenarios/scenario-1/steps', '{'],
      ['POST', '/api/scenarios/scenario-1/steps', JSON.stringify({
        stepOrder: 1,
        delayMinutes: 0,
        messageType: 'video',
        messageContent: 'hello',
      })],
      ['POST', '/api/scenarios/scenario-1/steps', JSON.stringify({
        stepOrder: 1,
        delayMinutes: 0,
        messageType: 'flex',
        messageContent: '{bad',
      })],
      ['POST', '/api/scenarios/scenario-1/steps', JSON.stringify({
        stepOrder: 1,
        delayMinutes: 0,
        messageType: 'text',
        messageContent: 'hello',
        conditionType: 'tag_exists',
      })],
      ['PUT', '/api/scenarios/scenario-1/steps/step-1', '{'],
      ['PUT', '/api/scenarios/scenario-1/steps/step-1', JSON.stringify({})],
      ['PUT', '/api/scenarios/scenario-1/steps/step-1', JSON.stringify({
        messageType: 'image',
        messageContent: '{}',
      })],
      ['POST', '/api/scenarios/scenario-1/steps/reorder', '{'],
      ['POST', '/api/scenarios/scenario-1/steps/reorder', JSON.stringify({
        orders: [
          { stepId: 'step-1', stepOrder: 1 },
          { stepId: 'step-2', stepOrder: 1 },
        ],
      })],
    ];

    for (const [method, path, body] of requests) {
      const res = await app.request(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      expect(res.status, `${method} ${path}`).toBe(400);
    }

    expect(calls).toHaveLength(0);
    expect(dbMocks.createScenarioStep).not.toHaveBeenCalled();
    expect(dbMocks.updateScenarioStep).not.toHaveBeenCalled();
  });

  test('scenario step create trims valid payloads before DB writes', async () => {
    const stepRow = {
      id: 'step-1',
      scenario_id: 'scenario-1',
      step_order: 1,
      delay_minutes: 0,
      offset_days: null,
      offset_minutes: null,
      delivery_time: null,
      message_type: 'text',
      message_content: 'Hello',
      condition_type: 'tag_exists',
      condition_value: 'tag-1',
      next_step_on_false: 2,
      template_id: null,
      on_reach_tag_id: null,
      created_at: '2026-06-12T10:00:00.000',
    };
    const { db } = makeScenarioDb([{ id: 'scenario-1', name: 's', line_account_id: null, ...rowBase }]);
    dbMocks.createScenarioStep.mockResolvedValue(stepRow);
    const app = setupApp(db, 'owner');

    const res = await app.request('/api/scenarios/%20scenario-1%20/steps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stepOrder: 1,
        delayMinutes: 0,
        messageType: 'text',
        messageContent: ' Hello ',
        conditionType: 'tag_exists',
        conditionValue: ' tag-1 ',
        nextStepOnFalse: 2,
        templateId: ' ',
        onReachTagId: null,
      }),
    });

    expect(res.status).toBe(201);
    expect(dbMocks.createScenarioStep).toHaveBeenCalledWith(db, {
      scenarioId: 'scenario-1',
      stepOrder: 1,
      delayMinutes: 0,
      messageType: 'text',
      messageContent: 'Hello',
      conditionType: 'tag_exists',
      conditionValue: 'tag-1',
      nextStepOnFalse: 2,
      offsetDays: null,
      offsetMinutes: null,
      deliveryTime: null,
      templateId: null,
      onReachTagId: null,
    });
  });

  test('scenario step update validates scenario ownership and trims valid payloads', async () => {
    const existingStep: ScenarioStepRow = {
      id: 'step-1',
      scenario_id: 'scenario-1',
      step_order: 1,
      delay_minutes: 0,
      offset_days: null,
      offset_minutes: null,
      delivery_time: null,
      message_type: 'text',
      message_content: 'Old',
    };
    const updatedStep = {
      ...existingStep,
      message_content: 'Updated',
      condition_type: null,
      condition_value: null,
      next_step_on_false: null,
      template_id: null,
      on_reach_tag_id: null,
      created_at: '2026-06-12T10:00:00.000',
    };
    const { db } = makeScenarioDb([], { steps: [existingStep] });
    dbMocks.updateScenarioStep.mockResolvedValue(updatedStep);
    const app = setupApp(db, 'owner');

    const missingRes = await app.request('/api/scenarios/other-scenario/steps/step-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageContent: 'Nope' }),
    });
    expect(missingRes.status).toBe(404);
    expect(dbMocks.updateScenarioStep).not.toHaveBeenCalled();

    const res = await app.request('/api/scenarios/%20scenario-1%20/steps/%20step-1%20', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messageType: 'text',
        messageContent: ' Updated ',
        conditionType: null,
        conditionValue: null,
        templateId: null,
      }),
    });

    expect(res.status).toBe(200);
    expect(dbMocks.updateScenarioStep).toHaveBeenCalledWith(db, 'step-1', {
      step_order: undefined,
      delay_minutes: undefined,
      message_type: 'text',
      message_content: 'Updated',
      condition_type: null,
      condition_value: null,
      next_step_on_false: undefined,
      offset_days: undefined,
      offset_minutes: undefined,
      delivery_time: undefined,
      template_id: null,
      on_reach_tag_id: undefined,
    });
  });

  test('scenario step reorder rejects unknown steps before batch update', async () => {
    const { db, batchCalls } = makeScenarioDb([], {
      steps: [{
        id: 'step-1',
        scenario_id: 'scenario-1',
        step_order: 1,
        delay_minutes: 0,
        offset_days: null,
        offset_minutes: null,
        delivery_time: null,
        message_type: 'text',
        message_content: 'Hello',
      }],
    });
    const app = setupApp(db, 'owner');

    const res = await app.request('/api/scenarios/scenario-1/steps/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orders: [{ stepId: 'step-missing', stepOrder: 1 }] }),
    });

    expect(res.status).toBe(404);
    expect(batchCalls).toHaveLength(0);
  });

  test('scenario step delete validates scenario ownership before deleting', async () => {
    const { db } = makeScenarioDb([], {
      steps: [{
        id: 'step-1',
        scenario_id: 'scenario-1',
        step_order: 1,
        delay_minutes: 0,
        offset_days: null,
        offset_minutes: null,
        delivery_time: null,
        message_type: 'text',
        message_content: 'Hello',
      }],
    });
    const app = setupApp(db, 'owner');

    const missingRes = await app.request('/api/scenarios/other-scenario/steps/step-1', { method: 'DELETE' });
    expect(missingRes.status).toBe(404);
    expect(dbMocks.deleteScenarioStep).not.toHaveBeenCalled();

    const res = await app.request('/api/scenarios/%20scenario-1%20/steps/%20step-1%20', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(dbMocks.deleteScenarioStep).toHaveBeenCalledWith(db, 'step-1');
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

    const res = await setupApp(db, 'staff').request('/api/scenarios/%20scenario-1%20/enroll/%20friend-visible%20', {
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

  test('manual scenario enrollment failure does not leak raw exception into logs or response', async () => {
    const { db } = makeScenarioDb(
      [{ id: 'scenario-1', name: 's', line_account_id: null, ...rowBase }],
      { visibleFriendIds: ['friend-visible'] },
    );
    dbMocks.getScenarioById.mockResolvedValue({
      id: 'scenario-1',
      name: 'Welcome',
      description: null,
      trigger_type: 'manual',
      trigger_tag_id: null,
      is_active: 1,
      delivery_mode: 'relative',
      line_account_id: null,
      created_at: '2026-06-12T10:00:00.000',
      updated_at: '2026-06-12T10:00:00.000',
      steps: [],
    });
    dbMocks.getFriendById.mockResolvedValue({ id: 'friend-visible', line_user_id: 'U-visible' });
    dbMocks.enrollFriendInScenario.mockRejectedValueOnce(
      new Error('scenario enroll secret account-token scenario-1 friend-visible U-visible raw-body'),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const res = await setupApp(db, 'staff').request('/api/scenarios/scenario-1/enroll/friend-visible', {
        method: 'POST',
      });

      expect(res.status).toBe(500);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body).toEqual({ success: false, error: 'Internal server error' });
      const logged = loggedText(errorSpy);
      expect(logged).toContain('POST /api/scenarios/:id/enroll/:friendId error: Error');
      expect(logged).not.toContain('scenario enroll secret');
      expect(logged).not.toContain('account-token');
      expect(logged).not.toContain('scenario-1');
      expect(logged).not.toContain('friend-visible');
      expect(logged).not.toContain('U-visible');
      expect(logged).not.toContain('raw-body');
    } finally {
      errorSpy.mockRestore();
    }
  });
});

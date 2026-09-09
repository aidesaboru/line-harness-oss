import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

const dbMocks = {
  getStaffMembers: vi.fn(),
  getStaffById: vi.fn(),
  createStaffMember: vi.fn(),
  updateStaffMember: vi.fn(),
  deleteStaffMember: vi.fn(),
  regenerateStaffApiKey: vi.fn(),
  countActiveStaffByRole: vi.fn(),
  jstNow: vi.fn(() => '2026-08-24T22:30:00.000+09:00'),
};

vi.mock('@line-crm/db', () => dbMocks);

const { staff } = await import('./staff.js');

type StaffRole = 'owner' | 'admin' | 'staff' | 'secondary';

type TestEnv = {
  Variables: { staff: { id: string; name: string; role: StaffRole } };
  Bindings: { DB: D1Database };
};

const staffRow = {
  id: 'staff-new',
  name: '田島',
  email: 'tajima@example.com',
  role: 'staff' as const,
  secondary_can_respond: 0,
  sales_only: 0,
  api_key: 'lh_testapikey',
  is_active: 1,
  created_at: '2026-06-13T10:00:00.000',
  updated_at: '2026-06-13T10:00:00.000',
};

function setupApp(role: StaffRole = 'owner', dbOverride?: D1Database) {
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'owner-1', name: 'Owner', role });
    c.env = dbOverride ? { DB: dbOverride } : {
      DB: {
        prepare: vi.fn(() => ({
          all: vi.fn().mockResolvedValue({ results: [] }),
        })),
      } as unknown as D1Database,
    };
    await next();
  });
  app.route('/', staff);
  return app;
}

function loggedText(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.flat().map(String).join(' ');
}

function expectNoLogLeak(logged: string, values: string[]): void {
  for (const value of values) {
    expect(logged).not.toContain(value);
  }
}

beforeEach(() => {
  for (const fn of Object.values(dbMocks)) fn.mockReset();
});

describe('staff routes', () => {
  test('hides the reference-only environment owner from staff lists', async () => {
    dbMocks.getStaffMembers.mockResolvedValue([
      staffRow,
      {
        ...staffRow,
        id: 'env-owner',
        name: '環境オーナー（参照専用）',
        role: 'owner',
        api_key: 'disabled_env_owner_test',
        is_active: 0,
      },
    ]);

    const listRes = await setupApp().request('/api/staff');
    expect(listRes.status).toBe(200);
    expect(await listRes.json()).toMatchObject({
      success: true,
      data: [{ id: 'staff-new' }],
    });

    const optionsRes = await setupApp().request('/api/staff/assignee-options');
    expect(optionsRes.status).toBe(200);
    expect(await optionsRes.json()).toEqual({
      success: true,
      data: [{
        id: 'staff-new',
        name: '田島',
        role: 'staff',
        secondaryCanRespond: false,
        isActive: true,
      }],
    });
  });

  test('owner can configure a mutual ticket share between active primary staff', async () => {
    dbMocks.getStaffMembers.mockResolvedValue([
      { ...staffRow, id: 'staff-a', name: '林' },
      { ...staffRow, id: 'staff-b', name: '小野里' },
    ]);
    const calls: Array<{ sql: string; binds: unknown[] }> = [];
    const batch = vi.fn().mockResolvedValue([]);
    const db = {
      prepare(sql: string) {
        let binds: unknown[] = [];
        const statement = {
          bind(...values: unknown[]) {
            binds = values;
            calls.push({ sql, binds });
            return statement;
          },
          all: vi.fn().mockResolvedValue({ results: [] }),
        };
        return statement;
      },
      batch,
    } as unknown as D1Database;

    const res = await setupApp('owner', db).request('/api/staff/staff-b/ticket-shares', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ peerStaffIds: ['staff-a'] }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      data: { staffId: 'staff-b', peerStaffIds: ['staff-a'] },
    });
    expect(calls).toEqual([
      expect.objectContaining({
        sql: expect.stringContaining('SELECT staff_a_id, staff_b_id'),
        binds: ['staff-b', 'staff-b'],
      }),
      expect.objectContaining({
        sql: expect.stringContaining('INSERT INTO staff_ticket_shares'),
        binds: ['staff-a', 'staff-b', 'owner-1'],
      }),
      expect.objectContaining({
        sql: expect.stringContaining('INSERT INTO staff_ticket_share_events'),
      }),
    ]);
    expect(batch).toHaveBeenCalledOnce();
  });

  test('ticket share rejects self assignment and non-primary peers', async () => {
    dbMocks.getStaffMembers.mockResolvedValue([
      { ...staffRow, id: 'staff-a', name: '林' },
      { ...staffRow, id: 'admin-1', name: '管理者', role: 'admin' },
    ]);

    const selfRes = await setupApp().request('/api/staff/staff-a/ticket-shares', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ peerStaffIds: ['staff-a'] }),
    });
    expect(selfRes.status).toBe(400);

    const peerRes = await setupApp().request('/api/staff/staff-a/ticket-shares', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ peerStaffIds: ['admin-1'] }),
    });
    expect(peerRes.status).toBe(400);
  });

  test('prevents management operations on the reference-only environment owner', async () => {
    const requests: Array<[string, string, string | undefined]> = [
      ['GET', '/api/staff/env-owner', undefined],
      ['PATCH', '/api/staff/env-owner', JSON.stringify({ isActive: true })],
      ['DELETE', '/api/staff/env-owner', undefined],
      ['POST', '/api/staff/env-owner/regenerate-key', undefined],
    ];

    for (const [method, path, body] of requests) {
      const res = await setupApp().request(path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body,
      });

      expect(res.status, `${method} ${path}`).toBe(404);
    }

    expect(dbMocks.getStaffById).not.toHaveBeenCalled();
    expect(dbMocks.updateStaffMember).not.toHaveBeenCalled();
    expect(dbMocks.deleteStaffMember).not.toHaveBeenCalled();
    expect(dbMocks.regenerateStaffApiKey).not.toHaveBeenCalled();
  });

  test('list failure logs only the error kind', async () => {
    dbMocks.getStaffMembers.mockRejectedValueOnce(
      new Error('staff list secret staff-new tajima@example.com lh_testapikey raw-body'),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const res = await setupApp().request('/api/staff');

      expect(res.status).toBe(500);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body).toEqual({ success: false, error: 'Internal server error' });
      const logged = loggedText(errorSpy);
      expect(logged).toContain('GET /api/staff error: Error');
      expectNoLogLeak(logged, [
        'staff list secret',
        'staff-new',
        'tajima@example.com',
        'lh_testapikey',
        'raw-body',
      ]);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('create failure logs only the error kind', async () => {
    dbMocks.createStaffMember.mockRejectedValueOnce(
      new Error('staff create secret staff-new tajima@example.com lh_testapikey raw-body'),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const res = await setupApp().request('/api/staff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '田島', email: 'tajima@example.com', role: 'staff' }),
      });

      expect(res.status).toBe(500);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body).toEqual({ success: false, error: 'Internal server error' });
      const logged = loggedText(errorSpy);
      expect(logged).toContain('POST /api/staff error: Error');
      expectNoLogLeak(logged, [
        'staff create secret',
        'staff-new',
        'tajima@example.com',
        'lh_testapikey',
        'raw-body',
      ]);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('rejects blank staff names when creating members', async () => {
    const res = await setupApp().request('/api/staff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '   ', email: 'staff@example.com', role: 'staff' }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ success: false, error: 'name is required' });
    expect(dbMocks.createStaffMember).not.toHaveBeenCalled();
  });

  test('rejects invalid staff create payloads before DB helpers', async () => {
    const requests = [
      '{',
      JSON.stringify({}),
      JSON.stringify({ name: '田島', email: 'bad email', role: 'staff' }),
      JSON.stringify({ name: '田島', email: 'staff@example.com', role: 'operator' }),
      JSON.stringify({ name: 'x'.repeat(129), email: 'staff@example.com', role: 'staff' }),
    ];

    for (const body of requests) {
      vi.clearAllMocks();
      const res = await setupApp().request('/api/staff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });

      expect(res.status, body).toBe(400);
      expect(dbMocks.createStaffMember).not.toHaveBeenCalled();
    }
  });

  test('trims staff name and email when creating members', async () => {
    dbMocks.createStaffMember.mockResolvedValue(staffRow);

    const res = await setupApp().request('/api/staff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '  田島  ', email: '  tajima@example.com  ', role: 'staff' }),
    });

    expect(res.status).toBe(201);
    expect(dbMocks.createStaffMember).toHaveBeenCalledWith(
      expect.anything(),
      {
        name: '田島',
        email: 'tajima@example.com',
        role: 'staff',
        secondary_can_respond: 0,
        sales_only: 0,
      },
      {
        action: 'created',
        metadata: { role: 'staff', secondaryCanRespond: false, salesOnly: false },
        actorId: 'owner-1',
        actorName: 'Owner',
      },
    );
  });

  test('accepts the secondary role when creating and updating members', async () => {
    dbMocks.createStaffMember.mockResolvedValue({ ...staffRow, role: 'secondary' });

    const createRes = await setupApp().request('/api/staff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '松山',
        email: '',
        role: 'secondary',
        secondaryCanRespond: true,
      }),
    });

    expect(createRes.status).toBe(201);
    expect(dbMocks.createStaffMember).toHaveBeenCalledWith(
      expect.anything(),
      {
        name: '松山',
        email: null,
        role: 'secondary',
        secondary_can_respond: 1,
        sales_only: 0,
      },
      {
        action: 'created',
        metadata: { role: 'secondary', secondaryCanRespond: true, salesOnly: false },
        actorId: 'owner-1',
        actorName: 'Owner',
      },
    );

    dbMocks.getStaffById.mockResolvedValue({ ...staffRow, id: 'staff-1' });
    dbMocks.updateStaffMember.mockResolvedValue({ ...staffRow, id: 'staff-1', role: 'secondary' });

    const updateRes = await setupApp().request('/api/staff/staff-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'secondary', secondaryCanRespond: true }),
    });

    expect(updateRes.status).toBe(200);
    expect(dbMocks.updateStaffMember).toHaveBeenCalledWith(
      expect.anything(),
      'staff-1',
      {
        name: undefined,
        email: undefined,
        role: 'secondary',
        secondary_can_respond: 1,
        sales_only: 0,
        is_active: undefined,
      },
      {
        action: 'updated',
        metadata: {
          before: { role: 'staff', isActive: true, secondaryCanRespond: false, salesOnly: false },
          after: { role: 'secondary', isActive: true, secondaryCanRespond: true, salesOnly: false },
        },
        actorId: 'owner-1',
        actorName: 'Owner',
      },
    );
  });

  test('creates and updates sales viewers as restricted staff accounts', async () => {
    dbMocks.createStaffMember.mockResolvedValue({ ...staffRow, sales_only: 1 });

    const createRes = await setupApp().request('/api/staff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '営業担当',
        role: 'staff',
        salesOnly: true,
      }),
    });

    expect(createRes.status).toBe(201);
    expect(dbMocks.createStaffMember).toHaveBeenCalledWith(
      expect.anything(),
      {
        name: '営業担当',
        email: null,
        role: 'staff',
        secondary_can_respond: 0,
        sales_only: 1,
      },
      {
        action: 'created',
        metadata: { role: 'staff', secondaryCanRespond: false, salesOnly: true },
        actorId: 'owner-1',
        actorName: 'Owner',
      },
    );

    dbMocks.getStaffById.mockResolvedValue({ ...staffRow, id: 'staff-1' });
    dbMocks.updateStaffMember.mockResolvedValue({ ...staffRow, id: 'staff-1', sales_only: 1 });
    const updateRes = await setupApp().request('/api/staff/staff-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'staff', salesOnly: true }),
    });

    expect(updateRes.status).toBe(200);
    expect(dbMocks.updateStaffMember).toHaveBeenCalledWith(
      expect.anything(),
      'staff-1',
      expect.objectContaining({
        role: 'staff',
        secondary_can_respond: 0,
        sales_only: 1,
      }),
      expect.objectContaining({
        metadata: {
          before: { role: 'staff', isActive: true, secondaryCanRespond: false, salesOnly: false },
          after: { role: 'staff', isActive: true, secondaryCanRespond: false, salesOnly: true },
        },
      }),
    );
  });

  test('rejects sales-only permission on non-primary roles', async () => {
    const createRes = await setupApp().request('/api/staff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '営業管理者', role: 'admin', salesOnly: true }),
    });
    expect(createRes.status).toBe(400);
    expect(dbMocks.createStaffMember).not.toHaveBeenCalled();

    dbMocks.getStaffById.mockResolvedValue({ ...staffRow, id: 'staff-1' });
    const updateRes = await setupApp().request('/api/staff/staff-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'admin', salesOnly: true }),
    });
    expect(updateRes.status).toBe(400);
    expect(dbMocks.updateStaffMember).not.toHaveBeenCalled();
  });

  test('excludes sales viewers from support assignee and ticket-share candidates', async () => {
    dbMocks.getStaffMembers.mockResolvedValue([
      { ...staffRow, id: 'staff-a', name: '一次担当' },
      { ...staffRow, id: 'sales-a', name: '営業担当', sales_only: 1 },
    ]);

    const optionsRes = await setupApp().request('/api/staff/assignee-options');
    expect(optionsRes.status).toBe(200);
    expect(await optionsRes.json()).toMatchObject({
      data: [{ id: 'staff-a' }],
    });

    const shareRes = await setupApp().request('/api/staff/staff-a/ticket-shares', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ peerStaffIds: ['sales-a'] }),
    });
    expect(shareRes.status).toBe(400);
  });

  test('rejects blank staff names when updating members', async () => {
    dbMocks.getStaffById.mockResolvedValue({ ...staffRow, id: 'staff-1' });

    const res = await setupApp().request('/api/staff/staff-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '   ' }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ success: false, error: 'name is required' });
    expect(dbMocks.getStaffById).not.toHaveBeenCalled();
    expect(dbMocks.updateStaffMember).not.toHaveBeenCalled();
  });

  test('rejects invalid staff update payloads before DB helpers', async () => {
    const requests = [
      '{',
      JSON.stringify({}),
      JSON.stringify({ email: 'bad email' }),
      JSON.stringify({ role: 'operator' }),
      JSON.stringify({ isActive: 'true' }),
      JSON.stringify({ name: 'x'.repeat(129) }),
    ];

    for (const body of requests) {
      vi.clearAllMocks();
      const res = await setupApp().request('/api/staff/staff-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body,
      });

      expect(res.status, body).toBe(400);
      expect(dbMocks.getStaffById).not.toHaveBeenCalled();
      expect(dbMocks.countActiveStaffByRole).not.toHaveBeenCalled();
      expect(dbMocks.updateStaffMember).not.toHaveBeenCalled();
    }
  });

  test('trims staff name and clears blank email when updating members', async () => {
    dbMocks.getStaffById.mockResolvedValue({ ...staffRow, id: 'staff-1' });
    dbMocks.updateStaffMember.mockResolvedValue({ ...staffRow, id: 'staff-1', email: null });

    const res = await setupApp().request('/api/staff/%20staff-1%20', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '  一次担当  ', email: '   ' }),
    });

    expect(res.status).toBe(200);
    expect(dbMocks.updateStaffMember).toHaveBeenCalledWith(
      expect.anything(),
      'staff-1',
      {
        name: '一次担当',
        email: null,
        role: undefined,
        secondary_can_respond: undefined,
        sales_only: undefined,
        is_active: undefined,
      },
      {
        action: 'updated',
        metadata: {
          before: { role: 'staff', isActive: true, secondaryCanRespond: false, salesOnly: false },
          after: { role: 'staff', isActive: true, secondaryCanRespond: false, salesOnly: false },
        },
        actorId: 'owner-1',
        actorName: 'Owner',
      },
    );
  });

  test('marks PATCH deactivation as a disabled audit event', async () => {
    dbMocks.getStaffById.mockResolvedValue({ ...staffRow, id: 'staff-1' });
    dbMocks.updateStaffMember.mockResolvedValue({ ...staffRow, id: 'staff-1', is_active: 0 });

    const res = await setupApp().request('/api/staff/staff-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: false }),
    });

    expect(res.status).toBe(200);
    expect(dbMocks.updateStaffMember).toHaveBeenCalledWith(
      expect.anything(),
      'staff-1',
      expect.objectContaining({ is_active: 0 }),
      {
        action: 'disabled',
        metadata: {
          before: { role: 'staff', isActive: true, secondaryCanRespond: false, salesOnly: false },
          after: { role: 'staff', isActive: false, secondaryCanRespond: false, salesOnly: false },
        },
        actorId: 'owner-1',
        actorName: 'Owner',
      },
    );
  });

  test('update failure logs only the error kind', async () => {
    dbMocks.getStaffById.mockResolvedValue({ ...staffRow, id: 'staff-1' });
    dbMocks.updateStaffMember.mockRejectedValueOnce(
      new Error('staff update secret staff-1 tajima@example.com lh_testapikey raw-body'),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const res = await setupApp().request('/api/staff/staff-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '田島', email: 'tajima@example.com' }),
      });

      expect(res.status).toBe(500);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body).toEqual({ success: false, error: 'Internal server error' });
      const logged = loggedText(errorSpy);
      expect(logged).toContain('PATCH /api/staff/:id error: Error');
      expectNoLogLeak(logged, [
        'staff update secret',
        'staff-1',
        'tajima@example.com',
        'lh_testapikey',
        'raw-body',
      ]);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('rejects unsafe staff path ids before DB helpers', async () => {
    const requests: Array<[string, string, string | undefined]> = [
      ['GET', '/api/staff/bad%20staff', undefined],
      ['PATCH', '/api/staff/bad%20staff', JSON.stringify({ name: '田島' })],
      ['DELETE', '/api/staff/bad%20staff', undefined],
      ['POST', '/api/staff/bad%20staff/regenerate-key', undefined],
    ];

    for (const [method, path, body] of requests) {
      vi.clearAllMocks();
      const res = await setupApp().request(path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body,
      });

      expect(res.status, `${method} ${path}`).toBe(400);
      expect(dbMocks.getStaffById).not.toHaveBeenCalled();
      expect(dbMocks.updateStaffMember).not.toHaveBeenCalled();
      expect(dbMocks.deleteStaffMember).not.toHaveBeenCalled();
      expect(dbMocks.regenerateStaffApiKey).not.toHaveBeenCalled();
    }
  });

  test('trims staff path ids before DB helpers', async () => {
    dbMocks.getStaffById.mockResolvedValue({ ...staffRow, id: 'staff-1', role: 'admin' });
    dbMocks.regenerateStaffApiKey.mockResolvedValue('lh_newapikey');

    const getRes = await setupApp().request('/api/staff/%20staff-1%20');
    expect(getRes.status).toBe(200);
    expect(dbMocks.getStaffById).toHaveBeenLastCalledWith(expect.anything(), 'staff-1');

    const deleteRes = await setupApp().request('/api/staff/%20staff-1%20', { method: 'DELETE' });
    expect(deleteRes.status).toBe(200);
    expect(dbMocks.deleteStaffMember).toHaveBeenCalledWith(
      expect.anything(),
      'staff-1',
      {
        action: 'disabled',
        metadata: { reason: 'legacy_delete_endpoint' },
        actorId: 'owner-1',
        actorName: 'Owner',
      },
    );

    const regenerateRes = await setupApp().request('/api/staff/%20staff-1%20/regenerate-key', { method: 'POST' });
    expect(regenerateRes.status).toBe(200);
    expect(dbMocks.regenerateStaffApiKey).toHaveBeenCalledWith(
      expect.anything(),
      'staff-1',
      {
        action: 'api_key_regenerated',
        actorId: 'owner-1',
        actorName: 'Owner',
      },
    );
  });

  test('regenerate-key failure logs only the error kind', async () => {
    dbMocks.getStaffById.mockResolvedValue({ ...staffRow, id: 'staff-1' });
    dbMocks.regenerateStaffApiKey.mockRejectedValueOnce(
      new Error('staff key secret staff-1 tajima@example.com lh_newapikey raw-body'),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const res = await setupApp().request('/api/staff/staff-1/regenerate-key', { method: 'POST' });

      expect(res.status).toBe(500);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body).toEqual({ success: false, error: 'Internal server error' });
      const logged = loggedText(errorSpy);
      expect(logged).toContain('POST /api/staff/:id/regenerate-key error: Error');
      expectNoLogLeak(logged, [
        'staff key secret',
        'staff-1',
        'tajima@example.com',
        'lh_newapikey',
        'raw-body',
      ]);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

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
  api_key: 'lh_testapikey',
  is_active: 1,
  created_at: '2026-06-13T10:00:00.000',
  updated_at: '2026-06-13T10:00:00.000',
};

function setupApp(role: StaffRole = 'owner') {
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'owner-1', name: 'Owner', role });
    c.env = { DB: {} as D1Database };
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
      data: [{ id: 'staff-new', name: '田島', role: 'staff', isActive: true }],
    });
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
    expect(dbMocks.createStaffMember).toHaveBeenCalledWith(expect.anything(), {
      name: '田島',
      email: 'tajima@example.com',
      role: 'staff',
    });
  });

  test('accepts the secondary role when creating and updating members', async () => {
    dbMocks.createStaffMember.mockResolvedValue({ ...staffRow, role: 'secondary' });

    const createRes = await setupApp().request('/api/staff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '松山', email: '', role: 'secondary' }),
    });

    expect(createRes.status).toBe(201);
    expect(dbMocks.createStaffMember).toHaveBeenCalledWith(expect.anything(), {
      name: '松山',
      email: null,
      role: 'secondary',
    });

    dbMocks.getStaffById.mockResolvedValue({ ...staffRow, id: 'staff-1' });
    dbMocks.updateStaffMember.mockResolvedValue({ ...staffRow, id: 'staff-1', role: 'secondary' });

    const updateRes = await setupApp().request('/api/staff/staff-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'secondary' }),
    });

    expect(updateRes.status).toBe(200);
    expect(dbMocks.updateStaffMember).toHaveBeenCalledWith(expect.anything(), 'staff-1', {
      name: undefined,
      email: undefined,
      role: 'secondary',
      is_active: undefined,
    });
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
    expect(dbMocks.updateStaffMember).toHaveBeenCalledWith(expect.anything(), 'staff-1', {
      name: '一次担当',
      email: null,
      role: undefined,
      is_active: undefined,
    });
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
    expect(dbMocks.deleteStaffMember).toHaveBeenCalledWith(expect.anything(), 'staff-1');

    const regenerateRes = await setupApp().request('/api/staff/%20staff-1%20/regenerate-key', { method: 'POST' });
    expect(regenerateRes.status).toBe(200);
    expect(dbMocks.regenerateStaffApiKey).toHaveBeenCalledWith(expect.anything(), 'staff-1');
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

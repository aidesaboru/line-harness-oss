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

type StaffRole = 'owner' | 'admin' | 'staff';

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

beforeEach(() => {
  for (const fn of Object.values(dbMocks)) fn.mockReset();
});

describe('staff routes', () => {
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
});

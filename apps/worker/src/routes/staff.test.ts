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

  test('trims staff name and clears blank email when updating members', async () => {
    dbMocks.getStaffById.mockResolvedValue({ ...staffRow, id: 'staff-1' });
    dbMocks.updateStaffMember.mockResolvedValue({ ...staffRow, id: 'staff-1', email: null });

    const res = await setupApp().request('/api/staff/staff-1', {
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
});

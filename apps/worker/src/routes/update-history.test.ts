import { describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { updateHistory } from './update-history.js';

type StaffRole = 'owner' | 'admin' | 'staff' | 'secondary';

type TestEnv = {
  Bindings: { DB: D1Database };
  Variables: { staff: { id: string; name: string; role: StaffRole } };
};

function setupApp(role: StaffRole, rows: unknown[] = []) {
  const db = {
    prepare: vi.fn(() => ({
      all: vi.fn().mockResolvedValue({ results: rows }),
    })),
  } as unknown as D1Database & { prepare: ReturnType<typeof vi.fn> };
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: `${role}-1`, name: role, role });
    c.env = { DB: db };
    await next();
  });
  app.route('/', updateHistory);
  return { app, db };
}

describe('update history route', () => {
  test('admin can read update history through the logged-in API', async () => {
    const { app, db } = setupApp('admin', [
      {
        id: 'manual_1',
        started_at: 1,
        completed_at: 1,
        from_version: '0.15.0',
        to_version: '0.15.0',
        status: 'success',
        events_jsonl: '{"step":"manual_change"}\n',
        error: null,
        rollback_expires_at: null,
        rollback_of: null,
      },
    ]);

    const res = await app.request('/api/update-history');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: Array<{ id: string }> };
    expect(body.success).toBe(true);
    expect(body.data.map((item) => item.id)).toEqual(['manual_1']);
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('FROM update_history'));
  });

  test('primary and secondary staff cannot read update history', async () => {
    for (const role of ['staff', 'secondary'] as const) {
      const { app, db } = setupApp(role);
      const res = await app.request('/api/update-history');

      expect(res.status, role).toBe(403);
      expect(db.prepare).not.toHaveBeenCalled();
    }
  });
});

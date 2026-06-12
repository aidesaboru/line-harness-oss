import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

const lineClientConstructor = vi.fn();

vi.mock('@line-crm/line-sdk', () => ({
  LineClient: lineClientConstructor,
}));

const { profileRefresh } = await import('./profile-refresh.js');

type StaffRole = 'owner' | 'admin' | 'staff';

type TestEnv = {
  Bindings: { DB: D1Database; LINE_CHANNEL_ACCESS_TOKEN: string };
  Variables: { staff: { id: string; name: string; role: StaffRole } };
};

function makeDb() {
  const db = {
    prepare: vi.fn(() => ({
      bind: vi.fn(function bind() {
        return this;
      }),
      all: vi.fn().mockResolvedValue({ results: [] }),
      first: vi.fn().mockResolvedValue(null),
      run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 0 } }),
    })),
  };
  return db as unknown as D1Database & { prepare: ReturnType<typeof vi.fn> };
}

function setupApp(role: StaffRole = 'staff', db = makeDb()) {
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'staff-1', name: 'Tajima', role });
    c.env = {
      DB: db,
      LINE_CHANNEL_ACCESS_TOKEN: 'test-token',
    };
    await next();
  });
  app.route('/', profileRefresh);
  return { app, db };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('admin diagnostics role guards', () => {
  test('staff cannot access admin diagnostics or repair APIs', async () => {
    const { app, db } = setupApp('staff');

    const requests: Array<[string, string, RequestInit?]> = [
      ['POST', '/api/admin/refresh-profiles'],
      ['POST', '/api/admin/broadcasts/broadcast-1/reset-to-draft'],
      ['POST', '/api/admin/tag-leak-check', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tagsA: ['A'], tagsB: ['B'] }),
      }],
      ['POST', '/api/admin/content-leak-check', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tagName: 'A', contentSubstring: 'hello' }),
      }],
      ['POST', '/api/admin/broadcast-coverage', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tagName: 'A', contentSubstring: 'hello' }),
      }],
      ['POST', '/api/admin/tag-remove-content-dups', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tagName: 'A', contentSubstring: 'hello' }),
      }],
      ['GET', '/api/admin/auto-reply-stats'],
      ['GET', '/api/admin/recent-messages'],
      ['GET', '/api/admin/automations-summary'],
      ['GET', '/api/admin/friend-debug/friend-1'],
    ];

    for (const [method, path, init] of requests) {
      const res = await app.request(path, { ...init, method });
      expect(res.status, `${method} ${path}`).toBe(403);
    }

    expect(db.prepare).not.toHaveBeenCalled();
    expect(lineClientConstructor).not.toHaveBeenCalled();
  });

  test('owner can read diagnostic stats', async () => {
    const { app, db } = setupApp('owner');

    const res = await app.request('/api/admin/auto-reply-stats');

    expect(res.status).toBe(200);
    expect(db.prepare).toHaveBeenCalled();
  });
});

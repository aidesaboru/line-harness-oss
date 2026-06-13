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

type DbCall = { sql: string; binds: unknown[] };

function makeDb() {
  const calls: DbCall[] = [];
  const db = {
    calls,
    prepare: vi.fn((sql: string) => ({
      bind: vi.fn(function bind(...args: unknown[]) {
        calls.push({ sql, binds: args });
        return this;
      }),
      all: vi.fn().mockResolvedValue({ results: [] }),
      first: vi.fn().mockResolvedValue(null),
      run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 0 } }),
    })),
  };
  return db as unknown as D1Database & { prepare: ReturnType<typeof vi.fn>; calls: DbCall[] };
}

function makeDbWithProfileRows(
  rows: Array<{
    id: string;
    line_user_id: string;
    line_account_id: string | null;
    channel_access_token: string | null;
  }>,
) {
  const db = makeDb();
  db.prepare.mockImplementation((sql: string) => ({
    bind: vi.fn(function bind(...args: unknown[]) {
      db.calls.push({ sql, binds: args });
      return this;
    }),
    all: vi.fn().mockResolvedValue({ results: sql.includes('FROM friends f') ? rows : [] }),
    first: vi.fn().mockResolvedValue(null),
    run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 0 } }),
  }));
  return db;
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

  test('refresh profiles clamps limit and floors offset before SQL bind', async () => {
    const { app, db } = setupApp('owner');

    const res = await app.request('/api/admin/refresh-profiles?limit=abc&offset=1.9', { method: 'POST' });

    expect(res.status).toBe(200);
    const batchCall = db.calls.find((call) => call.sql.includes('FROM friends f'));
    expect(batchCall?.binds.slice(-2)).toEqual([100, 1]);
  });

  test('refresh profiles rejects invalid offset before DB access', async () => {
    const { app, db } = setupApp('owner');

    const res = await app.request('/api/admin/refresh-profiles?offset=Infinity', { method: 'POST' });

    expect(res.status).toBe(400);
    expect(db.prepare).not.toHaveBeenCalled();
  });

  test('refresh profiles rejects unsafe account filter before DB access', async () => {
    const { app, db } = setupApp('owner');

    const res = await app.request('/api/admin/refresh-profiles?accountId=bad%20account', { method: 'POST' });

    expect(res.status).toBe(400);
    expect(db.prepare).not.toHaveBeenCalled();
    expect(lineClientConstructor).not.toHaveBeenCalled();
  });

  test('refresh profiles trims valid account filter before SQL bind', async () => {
    const { app, db } = setupApp('owner');

    const res = await app.request('/api/admin/refresh-profiles?accountId=%20acc-1%20&limit=10&offset=0', {
      method: 'POST',
    });

    expect(res.status).toBe(200);
    const batchCall = db.calls.find((call) => call.sql.includes('FROM friends f'));
    expect(batchCall?.binds).toEqual(['acc-1', 10, 0]);
  });

  test('refresh profiles logs only LINE status/kind for profile fetch failures', async () => {
    const db = makeDbWithProfileRows([
      { id: 'friend-403', line_user_id: 'U403', line_account_id: 'acc-1', channel_access_token: 'line-token-1' },
      { id: 'friend-500', line_user_id: 'U500', line_account_id: 'acc-1', channel_access_token: 'line-token-2' },
    ]);
    const getProfile = vi.fn()
      .mockRejectedValueOnce(new Error('LINE API error: 403 Forbidden — blocked-user SECRET_403'))
      .mockRejectedValueOnce(new Error('LINE API error: 500 Internal Server Error — upstream SECRET_500'));
    lineClientConstructor.mockImplementation(() => ({ getProfile }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { app } = setupApp('owner', db);

    try {
      const res = await app.request('/api/admin/refresh-profiles?limit=2&offset=0', { method: 'POST' });
      expect(res.status).toBe(200);
      const body = await res.json() as {
        data: { processed: number; updated: number; notFound: number; otherErrors: number };
      };
      expect(body.data).toMatchObject({
        processed: 2,
        updated: 0,
        notFound: 1,
        otherErrors: 1,
      });

      const logged = errorSpy.mock.calls.flat().map(String).join('\n');
      expect(logged).toContain('refresh-profile failed: line_http_status_500');
      expect(logged).not.toContain('SECRET_403');
      expect(logged).not.toContain('SECRET_500');
      expect(logged).not.toContain('blocked-user');
      expect(logged).not.toContain('upstream');
      expect(logged).not.toContain('line-token-1');
      expect(logged).not.toContain('line-token-2');
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('admin repair and debug routes reject unsafe path ids before DB access', async () => {
    const { app, db } = setupApp('owner');

    const reset = await app.request('/api/admin/broadcasts/bad%20broadcast/reset-to-draft', { method: 'POST' });
    const debug = await app.request('/api/admin/friend-debug/bad%20friend');

    expect(reset.status).toBe(400);
    expect(debug.status).toBe(400);
    expect(db.prepare).not.toHaveBeenCalled();
  });

  test('diagnostic body routes reject malformed or invalid payloads before DB access', async () => {
    const { app, db } = setupApp('owner');
    const requests: Array<[string, RequestInit]> = [
      ['/api/admin/tag-leak-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      }],
      ['/api/admin/tag-leak-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tagsA: [], tagsB: ['B'] }),
      }],
      ['/api/admin/content-leak-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tagName: 'A', contentSubstring: ' ' }),
      }],
      ['/api/admin/broadcast-coverage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tagName: 'x'.repeat(129), contentSubstring: 'hello' }),
      }],
      ['/api/admin/tag-remove-content-dups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tagName: 'A', contentSubstring: 'x'.repeat(1025) }),
      }],
    ];

    for (const [path, init] of requests) {
      const res = await app.request(path, init);
      expect(res.status, path).toBe(400);
    }

    expect(db.prepare).not.toHaveBeenCalled();
  });

  test('diagnostic body routes trim valid payloads before SQL bind', async () => {
    const { app, db } = setupApp('owner');

    const tagLeak = await app.request('/api/admin/tag-leak-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tagsA: [' A ', 'B'], tagsB: [' C '] }),
    });
    const contentLeak = await app.request('/api/admin/content-leak-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tagName: ' A ', contentSubstring: ' hello ' }),
    });
    const removeDups = await app.request('/api/admin/tag-remove-content-dups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tagName: ' Rest ', contentSubstring: ' watched ' }),
    });

    expect(tagLeak.status).toBe(200);
    expect(contentLeak.status).toBe(200);
    expect(removeDups.status).toBe(200);
    expect(db.calls[0].binds).toEqual(['A', 'B', 'C']);
    expect(db.calls.some((call) => call.binds.includes('A') && call.binds.includes('%hello%'))).toBe(true);
    expect(db.calls.some((call) => call.binds.includes('Rest') && call.binds.includes('%watched%'))).toBe(true);
  });

  test('auto reply stats falls back from invalid days query', async () => {
    const { app, db } = setupApp('owner');

    const res = await app.request('/api/admin/auto-reply-stats?days=abc');

    expect(res.status).toBe(200);
    const dateBinds = db.calls
      .flatMap((call) => call.binds)
      .filter((bind): bind is string => typeof bind === 'string' && bind.includes('+09:00'));
    expect(dateBinds).toHaveLength(2);
    expect(dateBinds.every((value) => !value.includes('Invalid'))).toBe(true);
  });

  test('recent messages clamps invalid limit before SQL bind', async () => {
    const { app, db } = setupApp('owner');

    expect((await app.request('/api/admin/recent-messages?limit=Infinity')).status).toBe(200);
    expect((await app.request('/api/admin/recent-messages?limit=2.9')).status).toBe(200);
    expect((await app.request('/api/admin/recent-messages?limit=9999')).status).toBe(200);

    const limitBinds = db.calls
      .filter((call) => call.sql.includes('FROM messages_log ml'))
      .map((call) => call.binds[0]);
    expect(limitBinds).toEqual([20, 2, 100]);
  });
});

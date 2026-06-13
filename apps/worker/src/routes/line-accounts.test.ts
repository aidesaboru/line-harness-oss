import { describe, expect, test, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

// Mock @line-crm/db so we can assert on the values the route forwards to the
// DB layer without needing a real D1Database. The route's responsibility is
// "normalize body → call DB function with correct args", so capturing those
// args is the meaningful assertion.
const dbMocks = {
  getLineAccounts: vi.fn(),
  getLineAccountById: vi.fn(),
  createLineAccount: vi.fn(),
  updateLineAccount: vi.fn(),
  updateLineAccountFields: vi.fn(),
  updateLineAccountOrder: vi.fn(),
  deleteLineAccount: vi.fn(),
  getTrafficPoolBySlug: vi.fn(),
  createTrafficPool: vi.fn(),
  addPoolAccount: vi.fn(),
};
vi.mock('@line-crm/db', () => dbMocks);

// Re-import after mock so the module picks up mocked deps.
const { lineAccounts } = await import('./line-accounts.js');

type TestEnv = {
  Variables: { staff: { id: string; role: 'owner' | 'admin' | 'staff' } };
  Bindings: { DB: D1Database };
};

// Minimal D1 stub: every prepare/bind/first chain resolves to `null` (no row).
// Used for the uniqueness check in checkUniqueLoginAndLiff — tests that need
// to assert duplicate-rejection override `firstResult` per request.
function makeDbStub(firstResult: unknown = null): D1Database {
  return {
    prepare: vi.fn(() => ({
      bind: vi.fn(() => ({
        first: vi.fn().mockResolvedValue(firstResult),
      })),
    })),
  } as unknown as D1Database;
}

function setupApp(
  role: 'owner' | 'admin' | 'staff' = 'owner',
  dbStub: D1Database = makeDbStub(),
) {
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'test-staff', role });
    c.env = { DB: dbStub };
    await next();
  });
  app.route('/', lineAccounts);
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

const fakeAccount = {
  id: 'acc-1',
  channel_id: '123456789',
  name: 'メイン',
  channel_access_token: 'token',
  channel_secret: 'secret',
  login_channel_id: null,
  login_channel_secret: null,
  liff_id: null,
  is_active: 1,
  country: null,
  role: null,
  display_order: 0,
  token_expires_at: null,
  created_at: '2026-05-08T00:00:00.000',
  updated_at: '2026-05-08T00:00:00.000',
};

beforeEach(() => {
  for (const fn of Object.values(dbMocks)) fn.mockReset();
});

describe('POST /api/line-accounts', () => {
  test('create failure logs only the error kind', async () => {
    dbMocks.createLineAccount.mockRejectedValueOnce(
      new Error('line secret channel-token channel-secret login-secret acc-1 2009624792-XXXX raw-body'),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const app = setupApp('owner');
      const res = await app.request('/api/line-accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channelId: '123456789',
          name: 'メイン',
          channelAccessToken: 'channel-token',
          channelSecret: 'channel-secret',
          loginChannelId: '2009624792',
          loginChannelSecret: 'login-secret',
          liffId: '2009624792-XXXX',
        }),
      });

      expect(res.status).toBe(500);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body).toEqual({ success: false, error: 'Internal server error' });
      const logged = loggedText(errorSpy);
      expect(logged).toContain('POST /api/line-accounts error: Error');
      expectNoLogLeak(logged, [
        'line secret',
        'channel-token',
        'channel-secret',
        'login-secret',
        'acc-1',
        '123456789',
        '2009624792',
        '2009624792-XXXX',
        'raw-body',
      ]);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('auto-enroll failure logs only the error kind and still creates account', async () => {
    dbMocks.createLineAccount.mockResolvedValue({
      ...fakeAccount,
      channel_access_token: 'channel-token',
      channel_secret: 'channel-secret',
      login_channel_id: '2009624792',
      login_channel_secret: 'login-secret',
      liff_id: '2009624792-XXXX',
    });
    dbMocks.getTrafficPoolBySlug.mockResolvedValue({ id: 'pool-secret' });
    dbMocks.addPoolAccount.mockRejectedValueOnce(
      new Error('enroll secret pool-secret acc-1 channel-token login-secret raw-body'),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const app = setupApp('owner');
      const res = await app.request('/api/line-accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channelId: '123456789',
          name: 'メイン',
          channelAccessToken: 'channel-token',
          channelSecret: 'channel-secret',
          loginChannelId: '2009624792',
          loginChannelSecret: 'login-secret',
          liffId: '2009624792-XXXX',
        }),
      });

      expect(res.status).toBe(201);
      const logged = loggedText(errorSpy);
      expect(logged).toContain('[line-accounts] failed to auto-enroll into main pool: Error');
      expectNoLogLeak(logged, [
        'enroll secret',
        'pool-secret',
        'acc-1',
        'channel-token',
        'channel-secret',
        'login-secret',
        '123456789',
        '2009624792',
        '2009624792-XXXX',
        'raw-body',
      ]);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('rejects malformed JSON before create', async () => {
    const app = setupApp('owner');
    const res = await app.request('/api/line-accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not-json',
    });

    expect(res.status).toBe(400);
    expect(dbMocks.createLineAccount).not.toHaveBeenCalled();
  });

  test('rejects unsafe credential payload before create', async () => {
    const app = setupApp('owner');
    const res = await app.request('/api/line-accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId: '123456789',
        name: 'メイン',
        channelAccessToken: 'token with space',
        channelSecret: 'secret',
      }),
    });

    expect(res.status).toBe(400);
    expect(dbMocks.createLineAccount).not.toHaveBeenCalled();
  });

  test('passes loginChannelId / loginChannelSecret / liffId through to createLineAccount', async () => {
    dbMocks.createLineAccount.mockResolvedValue({
      ...fakeAccount,
      login_channel_id: '2009624792',
      login_channel_secret: 'login-secret',
      liff_id: '2009624792-XXXX',
    });

    const app = setupApp('owner');
    const res = await app.request('/api/line-accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId: ' 123456789 ',
        name: ' メイン ',
        channelAccessToken: ' token ',
        channelSecret: ' secret ',
        loginChannelId: '2009624792',
        loginChannelSecret: 'login-secret',
        liffId: '2009624792-XXXX',
      }),
    });

    expect(res.status).toBe(201);
    expect(dbMocks.createLineAccount).toHaveBeenCalledTimes(1);
    expect(dbMocks.createLineAccount.mock.calls[0][1]).toMatchObject({
      channelId: '123456789',
      name: 'メイン',
      channelAccessToken: 'token',
      channelSecret: 'secret',
      loginChannelId: '2009624792',
      loginChannelSecret: 'login-secret',
      liffId: '2009624792-XXXX',
    });

    const body = (await res.json()) as { success: boolean; data: { loginChannelId: string | null; liffId: string | null; loginChannelSecret: string | null } };
    expect(body.success).toBe(true);
    expect(body.data.loginChannelId).toBe('2009624792');
    expect(body.data.liffId).toBe('2009624792-XXXX');
    // serializeLineAccountFull exposes loginChannelSecret to owner-only POST response
    expect(body.data.loginChannelSecret).toBe('login-secret');
  });

  test('omits loginChannelId/etc when not provided (stores null)', async () => {
    dbMocks.createLineAccount.mockResolvedValue(fakeAccount);

    const app = setupApp('owner');
    const res = await app.request('/api/line-accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId: '123456789',
        name: 'メイン',
        channelAccessToken: 'token',
        channelSecret: 'secret',
      }),
    });

    expect(res.status).toBe(201);
    expect(dbMocks.createLineAccount.mock.calls[0][1]).toMatchObject({
      loginChannelId: null,
      loginChannelSecret: null,
      liffId: null,
    });
  });

  test('trims whitespace and treats empty string as null for optional fields', async () => {
    dbMocks.createLineAccount.mockResolvedValue(fakeAccount);

    // Use a complete login pair (both id+secret present) to focus on the
    // trim/empty-string normalization behavior. liffId is independent.
    const app = setupApp('owner');
    await app.request('/api/line-accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId: '123456789',
        name: 'メイン',
        channelAccessToken: 'token',
        channelSecret: 'secret',
        loginChannelId: '  2009624792  ',
        loginChannelSecret: '  login-secret  ',
        liffId: '   ',
      }),
    });

    expect(dbMocks.createLineAccount.mock.calls[0][1]).toMatchObject({
      loginChannelId: '2009624792',
      loginChannelSecret: 'login-secret',
      liffId: null,
    });
  });
});

describe('PATCH /api/line-accounts/order', () => {
  test('trims ids and updates display order', async () => {
    const app = setupApp('admin');
    const res = await app.request('/api/line-accounts/order', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ordered: [{ id: ' acc-2 ', displayOrder: 1 }] }),
    });

    expect(res.status).toBe(200);
    expect(dbMocks.updateLineAccountOrder.mock.calls[0][1]).toEqual([
      { id: 'acc-2', displayOrder: 1 },
    ]);
  });

  test('rejects malformed JSON before order update', async () => {
    const app = setupApp('admin');
    const res = await app.request('/api/line-accounts/order', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: '{not-json',
    });

    expect(res.status).toBe(400);
    expect(dbMocks.updateLineAccountOrder).not.toHaveBeenCalled();
  });

  test('rejects malformed order payload before order update', async () => {
    const app = setupApp('admin');
    const fractional = await app.request('/api/line-accounts/order', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ordered: [{ id: 'acc-1', displayOrder: 1.5 }] }),
    });
    const duplicate = await app.request('/api/line-accounts/order', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ordered: [
          { id: 'acc-1', displayOrder: 0 },
          { id: ' acc-1 ', displayOrder: 1 },
        ],
      }),
    });

    expect(fractional.status).toBe(400);
    expect(duplicate.status).toBe(400);
    expect(dbMocks.updateLineAccountOrder).not.toHaveBeenCalled();
  });
});

describe('line account path ID validation', () => {
  test('rejects malformed account path IDs before DB lookup or mutation helpers', async () => {
    const app = setupApp('owner');
    const requests: Array<[string, string, RequestInit?]> = [
      ['GET', '/api/line-accounts/bad%20account'],
      ['PATCH', '/api/line-accounts/bad%20account', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ country: '日本' }),
      }],
      ['PUT', '/api/line-accounts/bad%20account', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'メイン' }),
      }],
      ['DELETE', '/api/line-accounts/bad%20account'],
    ];

    for (const [method, path, init] of requests) {
      const res = await app.request(path, { ...init, method });
      expect(res.status, `${method} ${path}`).toBe(400);
    }

    expect(dbMocks.getLineAccountById).not.toHaveBeenCalled();
    expect(dbMocks.updateLineAccount).not.toHaveBeenCalled();
    expect(dbMocks.updateLineAccountFields).not.toHaveBeenCalled();
    expect(dbMocks.deleteLineAccount).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/line-accounts/:id', () => {
  test('metadata update failure logs only the error kind', async () => {
    dbMocks.getLineAccountById.mockResolvedValue(fakeAccount);
    dbMocks.updateLineAccountFields.mockRejectedValueOnce(
      new Error('metadata secret acc-1 login-secret 2009624792 2009624792-XXXX raw-body'),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const app = setupApp('admin');
      const res = await app.request('/api/line-accounts/acc-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          loginChannelId: '2009624792',
          loginChannelSecret: 'login-secret',
          liffId: '2009624792-XXXX',
        }),
      });

      expect(res.status).toBe(500);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body).toEqual({ success: false, error: 'Internal server error' });
      const logged = loggedText(errorSpy);
      expect(logged).toContain('PATCH /api/line-accounts/:id error: Error');
      expectNoLogLeak(logged, [
        'metadata secret',
        'acc-1',
        'login-secret',
        '2009624792',
        '2009624792-XXXX',
        'raw-body',
      ]);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('rejects malformed JSON before lookup or update', async () => {
    const app = setupApp('admin');
    const res = await app.request('/api/line-accounts/acc-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: '{not-json',
    });

    expect(res.status).toBe(400);
    expect(dbMocks.getLineAccountById).not.toHaveBeenCalled();
    expect(dbMocks.updateLineAccount).not.toHaveBeenCalled();
    expect(dbMocks.updateLineAccountFields).not.toHaveBeenCalled();
  });

  test('rejects malformed metadata before lookup or update', async () => {
    const app = setupApp('admin');
    const badBoolean = await app.request('/api/line-accounts/acc-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: 'true' }),
    });
    const credentialOnPatch = await app.request('/api/line-accounts/acc-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelAccessToken: 'token' }),
    });
    const emptyPayload = await app.request('/api/line-accounts/acc-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(badBoolean.status).toBe(400);
    expect(credentialOnPatch.status).toBe(400);
    expect(emptyPayload.status).toBe(400);
    expect(dbMocks.getLineAccountById).not.toHaveBeenCalled();
    expect(dbMocks.updateLineAccount).not.toHaveBeenCalled();
    expect(dbMocks.updateLineAccountFields).not.toHaveBeenCalled();
  });

  test('updates loginChannelId / loginChannelSecret / liffId via metadata path', async () => {
    dbMocks.getLineAccountById.mockResolvedValue(fakeAccount);
    dbMocks.updateLineAccountFields.mockResolvedValue({
      ...fakeAccount,
      login_channel_id: '2009999999',
      liff_id: '2009999999-YYYY',
    });

    const app = setupApp('admin');
    const res = await app.request('/api/line-accounts/acc-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        loginChannelId: '2009999999',
        loginChannelSecret: 'rotated',
        liffId: '2009999999-YYYY',
      }),
    });

    expect(res.status).toBe(200);
    expect(dbMocks.updateLineAccountFields).toHaveBeenCalledTimes(1);
    expect(dbMocks.updateLineAccountFields.mock.calls[0][2]).toMatchObject({
      loginChannelId: '2009999999',
      loginChannelSecret: 'rotated',
      liffId: '2009999999-YYYY',
    });
  });

  test('clears LIFF when explicitly set to empty string', async () => {
    dbMocks.getLineAccountById.mockResolvedValue(fakeAccount);
    dbMocks.updateLineAccountFields.mockResolvedValue({
      ...fakeAccount,
      liff_id: null,
    });

    const app = setupApp('admin');
    await app.request('/api/line-accounts/acc-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ liffId: '' }),
    });

    expect(dbMocks.updateLineAccountFields.mock.calls[0][2]).toMatchObject({
      liffId: null,
    });
  });

  test('does not touch login/liff fields when not provided', async () => {
    dbMocks.updateLineAccountFields.mockResolvedValue(fakeAccount);
    dbMocks.getLineAccountById.mockResolvedValue(fakeAccount);

    const app = setupApp('admin');
    await app.request('/api/line-accounts/acc-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ country: '日本' }),
    });

    const arg = dbMocks.updateLineAccountFields.mock.calls[0][2];
    expect(arg.country).toBe('日本');
    expect(arg.loginChannelId).toBeUndefined();
    expect(arg.loginChannelSecret).toBeUndefined();
    expect(arg.liffId).toBeUndefined();
  });
});

describe('Login pair / uniqueness validation', () => {
  test('POST: rejects loginChannelId without secret', async () => {
    const app = setupApp('owner');
    const res = await app.request('/api/line-accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId: '123456789',
        name: 'メイン',
        channelAccessToken: 'token',
        channelSecret: 'secret',
        loginChannelId: '2009624792',
        // loginChannelSecret missing
      }),
    });

    expect(res.status).toBe(400);
    expect(dbMocks.createLineAccount).not.toHaveBeenCalled();
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.error).toMatch(/loginChannelSecret/);
  });

  test('POST: rejects loginChannelSecret without ID', async () => {
    const app = setupApp('owner');
    const res = await app.request('/api/line-accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId: '123456789',
        name: 'メイン',
        channelAccessToken: 'token',
        channelSecret: 'secret',
        loginChannelSecret: 'orphan',
      }),
    });

    expect(res.status).toBe(400);
    expect(dbMocks.createLineAccount).not.toHaveBeenCalled();
  });

  test('POST: rejects duplicate liffId', async () => {
    // makeDbStub returns "another row already has this liff_id"
    const app = setupApp('owner', makeDbStub({ id: 'other-acc' }));

    const res = await app.request('/api/line-accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId: '123456789',
        name: 'メイン',
        channelAccessToken: 'token',
        channelSecret: 'secret',
        liffId: '2009624792-DUPLICATE',
      }),
    });

    expect(res.status).toBe(409);
    expect(dbMocks.createLineAccount).not.toHaveBeenCalled();
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.error).toMatch(/already assigned/);
  });

  test('PATCH: LIFF-only edit succeeds against half-configured Login (id-only) account', async () => {
    // Setup CLI persists login_channel_id without secret as a best-effort.
    // Adding a LIFF ID later via the dashboard must NOT trip the pair check
    // because the request doesn't touch the Login fields at all.
    dbMocks.getLineAccountById.mockResolvedValue({
      ...fakeAccount,
      login_channel_id: 'setup-cli-id',
      login_channel_secret: null,
    });
    dbMocks.updateLineAccountFields.mockResolvedValue({
      ...fakeAccount,
      login_channel_id: 'setup-cli-id',
      login_channel_secret: null,
      liff_id: '2009624792-NEW',
    });

    const app = setupApp('admin');
    const res = await app.request('/api/line-accounts/acc-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ liffId: '2009624792-NEW' }),
    });

    expect(res.status).toBe(200);
    expect(dbMocks.updateLineAccountFields.mock.calls[0][2]).toMatchObject({
      liffId: '2009624792-NEW',
    });
  });

  test('PATCH: clearing both Login fields together succeeds', async () => {
    dbMocks.getLineAccountById.mockResolvedValue({
      ...fakeAccount,
      login_channel_id: 'old-id',
      login_channel_secret: 'old-secret',
    });
    dbMocks.updateLineAccountFields.mockResolvedValue({
      ...fakeAccount,
      login_channel_id: null,
      login_channel_secret: null,
    });

    const app = setupApp('admin');
    const res = await app.request('/api/line-accounts/acc-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loginChannelId: null, loginChannelSecret: null }),
    });

    expect(res.status).toBe(200);
    expect(dbMocks.updateLineAccountFields.mock.calls[0][2]).toMatchObject({
      loginChannelId: null,
      loginChannelSecret: null,
    });
  });

  test('PATCH: clearing only loginChannelId is rejected (would orphan the secret)', async () => {
    dbMocks.getLineAccountById.mockResolvedValue({
      ...fakeAccount,
      login_channel_id: 'old-id',
      login_channel_secret: 'old-secret',
    });

    const app = setupApp('admin');
    const res = await app.request('/api/line-accounts/acc-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loginChannelId: null }),
    });

    expect(res.status).toBe(400);
    expect(dbMocks.updateLineAccountFields).not.toHaveBeenCalled();
  });

  test('PATCH: keeps existing secret when only changing the loginChannelId', async () => {
    // Current row already has both id+secret. Caller changes only the id —
    // pair check should pass because the unchanged secret keeps the pair complete.
    dbMocks.getLineAccountById.mockResolvedValue({
      ...fakeAccount,
      login_channel_id: 'old-id',
      login_channel_secret: 'kept-secret',
    });
    dbMocks.updateLineAccountFields.mockResolvedValue({
      ...fakeAccount,
      login_channel_id: 'new-id',
      login_channel_secret: 'kept-secret',
    });

    const app = setupApp('admin');

    const res = await app.request('/api/line-accounts/acc-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loginChannelId: 'new-id' }),
    });

    expect(res.status).toBe(200);
    expect(dbMocks.updateLineAccountFields).toHaveBeenCalled();
  });
});

describe('PUT /api/line-accounts/:id', () => {
  test('credential update failure logs only the error kind', async () => {
    dbMocks.updateLineAccount.mockRejectedValueOnce(
      new Error('credential secret acc-1 channel-token channel-secret raw-body'),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const app = setupApp('owner');
      const res = await app.request('/api/line-accounts/acc-1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channelAccessToken: 'channel-token',
          channelSecret: 'channel-secret',
        }),
      });

      expect(res.status).toBe(500);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body).toEqual({ success: false, error: 'Internal server error' });
      const logged = loggedText(errorSpy);
      expect(logged).toContain('PUT /api/line-accounts/:id error: Error');
      expectNoLogLeak(logged, [
        'credential secret',
        'acc-1',
        'channel-token',
        'channel-secret',
        'raw-body',
      ]);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('rejects malformed JSON before lookup or update', async () => {
    const app = setupApp('owner');
    const res = await app.request('/api/line-accounts/acc-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{not-json',
    });

    expect(res.status).toBe(400);
    expect(dbMocks.getLineAccountById).not.toHaveBeenCalled();
    expect(dbMocks.updateLineAccount).not.toHaveBeenCalled();
    expect(dbMocks.updateLineAccountFields).not.toHaveBeenCalled();
  });

  test('rejects malformed credential update before lookup or update', async () => {
    const app = setupApp('owner');
    const badSecret = await app.request('/api/line-accounts/acc-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelSecret: '' }),
    });
    const badBoolean = await app.request('/api/line-accounts/acc-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: 1 }),
    });

    expect(badSecret.status).toBe(400);
    expect(badBoolean.status).toBe(400);
    expect(dbMocks.getLineAccountById).not.toHaveBeenCalled();
    expect(dbMocks.updateLineAccount).not.toHaveBeenCalled();
    expect(dbMocks.updateLineAccountFields).not.toHaveBeenCalled();
  });

  test('owner can update Login/LIFF + country/role in one request', async () => {
    dbMocks.getLineAccountById.mockResolvedValue({
      ...fakeAccount,
      login_channel_secret: 'existing-secret',
    });
    dbMocks.updateLineAccount.mockResolvedValue({
      ...fakeAccount,
      login_channel_id: '2009624792',
      login_channel_secret: 'existing-secret',
      liff_id: '2009624792-XXXX',
    });
    dbMocks.updateLineAccountFields.mockResolvedValue({
      ...fakeAccount,
      login_channel_id: '2009624792',
      login_channel_secret: 'existing-secret',
      liff_id: '2009624792-XXXX',
      country: '日本',
      role: '本店',
    });

    const app = setupApp('owner');
    const res = await app.request('/api/line-accounts/acc-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        loginChannelId: '2009624792',
        liffId: '2009624792-XXXX',
        country: '日本',
        role: '本店',
      }),
    });

    expect(res.status).toBe(200);
    expect(dbMocks.updateLineAccount.mock.calls[0][2]).toMatchObject({
      login_channel_id: '2009624792',
      liff_id: '2009624792-XXXX',
    });
    // country/role uses the fields helper (separate code path)
    expect(dbMocks.updateLineAccountFields.mock.calls[0][2]).toMatchObject({
      country: '日本',
      role: '本店',
    });
  });
});

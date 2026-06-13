import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

const dbMocks = {
  getFriendByLineUserId: vi.fn(),
  createUser: vi.fn(),
  getUserByEmail: vi.fn(),
  linkFriendToUser: vi.fn(),
  upsertFriend: vi.fn(),
  getEntryRouteByRefCode: vi.fn(),
  recordRefTracking: vi.fn(),
  addTagToFriend: vi.fn(),
  getLineAccountByChannelId: vi.fn(),
  getLineAccountById: vi.fn(),
  getLineAccounts: vi.fn(),
  getTrafficPoolBySlug: vi.fn(),
  getTrafficPoolById: vi.fn(),
  getRandomPoolAccount: vi.fn(),
  getPoolAccounts: vi.fn(),
  getTrackedLinkById: vi.fn(),
  recordLinkClick: vi.fn(),
  getMessageTemplateById: vi.fn(),
  enrollFriendInScenario: vi.fn(),
  jstNow: vi.fn(() => '2026-06-13T10:00:00.000+09:00'),
};

const liffAuthMocks = {
  verifyCallerLineUserId: vi.fn(),
};

vi.mock('@line-crm/db', () => dbMocks);
vi.mock('../services/liff-auth.js', () => liffAuthMocks);
vi.mock('../services/intro-message.js', () => ({
  buildIntroMessage: vi.fn(),
}));

const { liffRoutes } = await import('./liff.js');

type TestEnv = {
  Bindings: {
    DB: D1Database;
    LINE_LOGIN_CHANNEL_ID?: string;
    LINE_CHANNEL_ACCESS_TOKEN: string;
    LIFF_URL: string;
  };
  Variables: { staff: { id: string; name: string; role: StaffRole } };
};

type StaffRole = 'owner' | 'admin' | 'staff';

function setupApp(db: D1Database = {} as D1Database, role?: StaffRole) {
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    if (role) {
      c.set('staff', { id: 'staff-1', name: 'Tajima', role });
    }
    c.env = {
      DB: db,
      LINE_LOGIN_CHANNEL_ID: 'login-channel',
      LINE_CHANNEL_ACCESS_TOKEN: 'line-token',
      LIFF_URL: 'https://liff.example.com',
    };
    await next();
  });
  app.route('/', liffRoutes);
  return app;
}

function createPreparedDb() {
  const bound = {
    run: vi.fn().mockResolvedValue({}),
    first: vi.fn().mockResolvedValue(null),
    all: vi.fn().mockResolvedValue({ results: [] }),
  };
  const statement = {
    ...bound,
    bind: vi.fn(() => bound),
  };
  return {
    prepare: vi.fn(() => statement),
  } as unknown as D1Database;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  liffAuthMocks.verifyCallerLineUserId.mockResolvedValue(null);
  dbMocks.getFriendByLineUserId.mockResolvedValue(null);
  dbMocks.getLineAccounts.mockResolvedValue([]);
  dbMocks.getEntryRouteByRefCode.mockResolvedValue(null);
  dbMocks.getTrackedLinkById.mockResolvedValue(null);
  dbMocks.recordRefTracking.mockResolvedValue(undefined);
  dbMocks.recordLinkClick.mockResolvedValue(undefined);
});

describe('public LIFF profile endpoint', () => {
  test('rejects caller-supplied lineUserId without a valid LINE idToken', async () => {
    const res = await setupApp().request('/api/liff/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lineUserId: 'U-victim' }),
    });

    expect(res.status).toBe(401);
    expect(liffAuthMocks.verifyCallerLineUserId).toHaveBeenCalledWith(undefined, expect.anything());
    expect(dbMocks.getFriendByLineUserId).not.toHaveBeenCalled();
  });

  test('returns only the friend matched by the verified LINE idToken subject', async () => {
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue('U-verified');
    dbMocks.getFriendByLineUserId.mockResolvedValue({
      id: 'friend-verified',
      display_name: 'Verified User',
      is_following: 1,
      user_id: 'user-verified',
    });

    const res = await setupApp().request('/api/liff/profile', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer id-token',
      },
      body: JSON.stringify({ lineUserId: 'U-victim' }),
    });

    expect(res.status).toBe(200);
    expect(liffAuthMocks.verifyCallerLineUserId).toHaveBeenCalledWith('Bearer id-token', expect.anything());
    expect(dbMocks.getFriendByLineUserId).toHaveBeenCalledWith({} as D1Database, 'U-verified');
    const json = await res.json() as {
      success: boolean;
      data: { id: string; displayName: string; isFollowing: boolean; userId: string | null };
    };
    expect(json).toEqual({
      success: true,
      data: {
        id: 'friend-verified',
        displayName: 'Verified User',
        isFollowing: true,
        userId: 'user-verified',
      },
    });
  });

  test('accepts body idToken for legacy clients but still ignores lineUserId', async () => {
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue('U-body-token');
    dbMocks.getFriendByLineUserId.mockResolvedValue({
      id: 'friend-body-token',
      display_name: 'Body Token User',
      is_following: 0,
      user_id: null,
    });

    const res = await setupApp().request('/api/liff/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: 'body-id-token', lineUserId: 'U-victim' }),
    });

    expect(res.status).toBe(200);
    expect(liffAuthMocks.verifyCallerLineUserId).toHaveBeenCalledWith('Bearer body-id-token', expect.anything());
    expect(dbMocks.getFriendByLineUserId).toHaveBeenCalledWith({} as D1Database, 'U-body-token');
  });
});

describe('public LIFF link endpoint', () => {
  test('rejects malformed or oversized link payloads before LINE verification', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const app = setupApp();

    const malformed = await app.request('/api/liff/link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not-json',
    });
    const oversized = await app.request('/api/liff/link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idToken: 'token',
        ref: 'r'.repeat(600),
      }),
    });

    expect(malformed.status).toBe(400);
    expect(oversized.status).toBe(400);
    expect(dbMocks.getLineAccounts).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dbMocks.getFriendByLineUserId).not.toHaveBeenCalled();
  });

  test('records tracked-link clicks only after LINE idToken verification resolves the friend', async () => {
    const db = createPreparedDb();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ sub: 'U-verified', name: 'Verified User' }),
    }));
    dbMocks.getFriendByLineUserId.mockResolvedValue({
      id: 'friend-verified',
      line_account_id: null,
      user_id: 'user-existing',
    });
    dbMocks.getTrackedLinkById.mockResolvedValue({
      id: 'link-1',
      name: 'LP',
      original_url: 'https://example.com/lp',
      tag_id: null,
      scenario_id: null,
      intro_template_id: null,
      reward_template_id: null,
      is_active: 1,
      click_count: 0,
      created_at: '2026-06-13T10:00:00.000',
      updated_at: '2026-06-13T10:00:00.000',
    });

    const res = await setupApp(db).request('/api/liff/link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: 'verified-token', ref: 'link-1' }),
    });

    expect(res.status).toBe(200);
    expect(dbMocks.getFriendByLineUserId).toHaveBeenCalledWith(db, 'U-verified');
    expect(dbMocks.recordRefTracking).toHaveBeenCalledWith(db, {
      refCode: 'link-1',
      friendId: 'friend-verified',
      entryRouteId: null,
      sourceUrl: null,
    });
    expect(dbMocks.recordLinkClick).toHaveBeenCalledWith(db, 'link-1', 'friend-verified');
  });
});

describe('public LIFF config endpoint', () => {
  test('rejects unsafe liffId before DB lookup or LINE bot info fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const db = { prepare: vi.fn() } as unknown as D1Database;
    const paths = [
      '/api/liff/config',
      '/api/liff/config?liffId=bad%20liff',
      `/api/liff/config?liffId=${'a'.repeat(129)}`,
    ];

    for (const path of paths) {
      const res = await setupApp(db).request(path);
      expect(res.status, path).toBe(400);
      expect(db.prepare, path).not.toHaveBeenCalled();
      expect(fetchMock, path).not.toHaveBeenCalled();
    }
  });

  test('trims valid liffId before account lookup', async () => {
    const first = vi.fn().mockResolvedValue({
      id: 'acc-1',
      name: 'Main',
      channel_access_token: 'line-token',
    });
    const bind = vi.fn(() => ({ first }));
    const prepare = vi.fn(() => ({ bind }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ basicId: '@main' }),
    }));

    const res = await setupApp({ prepare } as unknown as D1Database)
      .request('/api/liff/config?liffId=%20LIFF-1%20');

    expect(res.status).toBe(200);
    expect(bind).toHaveBeenCalledWith('LIFF-1');
  });
});

describe('management LIFF analytics endpoints', () => {
  test('staff cannot read ref analytics or wrap management links', async () => {
    const db = { prepare: vi.fn() } as unknown as D1Database;
    const app = setupApp(db, 'staff');
    const requests: Array<[string, string, RequestInit?]> = [
      ['GET', '/api/analytics/ref-summary'],
      ['GET', '/api/analytics/ref/launch'],
      ['POST', '/api/links/wrap', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/lp', ref: 'launch' }),
      }],
    ];

    for (const [method, path, init] of requests) {
      const res = await app.request(path, { ...init, method });
      expect(res.status, `${method} ${path}`).toBe(403);
    }

    expect(db.prepare).not.toHaveBeenCalled();
  });

  test('owner can wrap a management link through LIFF', async () => {
    const res = await setupApp({} as D1Database, 'owner').request('/api/links/wrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/lp', ref: 'launch' }),
    });

    expect(res.status).toBe(200);
    const json = await res.json() as { success: boolean; data: { url: string } };
    expect(json).toEqual({
      success: true,
      data: { url: 'https://liff.example.com?redirect=https%3A%2F%2Fexample.com%2Flp&ref=launch' },
    });
  });

  test('owner analytics rejects unsafe filters before DB access', async () => {
    const db = { prepare: vi.fn() } as unknown as D1Database;
    const app = setupApp(db, 'owner');
    const paths = [
      '/api/analytics/ref-summary?lineAccountId=bad%20account',
      `/api/analytics/ref-summary?lineAccountId=${'a'.repeat(129)}`,
      '/api/analytics/ref/bad%20ref',
      '/api/analytics/ref/launch?lineAccountId=bad%20account',
    ];

    for (const path of paths) {
      const res = await app.request(path);
      expect(res.status, path).toBe(400);
      expect(db.prepare, path).not.toHaveBeenCalled();
    }
  });

  test('owner analytics trims valid account and ref filters before SQL binds', async () => {
    const first = vi.fn().mockResolvedValue({ count: 0 });
    const all = vi.fn().mockResolvedValue({ results: [] });
    const bind = vi.fn(() => ({ first, all }));
    const prepare = vi.fn(() => ({ bind, first, all }));
    const app = setupApp({ prepare } as unknown as D1Database, 'owner');

    const summary = await app.request('/api/analytics/ref-summary?lineAccountId=%20acc-1%20');
    expect(summary.status).toBe(200);
    expect(bind.mock.calls.slice(0, 3)).toEqual([['acc-1'], ['acc-1'], ['acc-1']]);

    bind.mockClear();
    const detail = await app.request('/api/analytics/ref/%20launch%20?lineAccountId=%20acc-1%20');
    expect(detail.status).toBe(200);
    expect(bind.mock.calls).toEqual([['launch'], ['launch', 'launch', 'acc-1']]);
  });
});

describe('public LIFF send-form-link endpoint', () => {
  test('rejects missing idToken before trusting the caller-supplied lineUserId', async () => {
    const res = await setupApp().request('/api/liff/send-form-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lineUserId: 'U-victim', formId: 'form-1' }),
    });

    expect(res.status).toBe(401);
    expect(dbMocks.getLineAccounts).not.toHaveBeenCalled();
    expect(dbMocks.getFriendByLineUserId).not.toHaveBeenCalled();
  });

  test('rejects oversized send-form-link payloads before LINE verification', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await setupApp().request('/api/liff/send-form-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lineUserId: 'U-victim',
        formId: 'form-1',
        idToken: 'id-token',
        ig: 'i'.repeat(600),
      }),
    });

    expect(res.status).toBe(400);
    expect(dbMocks.getLineAccounts).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dbMocks.getFriendByLineUserId).not.toHaveBeenCalled();
  });

  test('rejects an idToken whose subject does not match the supplied lineUserId', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ sub: 'U-verified' }),
    }));

    const res = await setupApp().request('/api/liff/send-form-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lineUserId: 'U-victim', formId: 'form-1', idToken: 'verified-token' }),
    });

    expect(res.status).toBe(403);
    expect(dbMocks.getLineAccounts).toHaveBeenCalledWith({} as D1Database);
    expect(dbMocks.getFriendByLineUserId).not.toHaveBeenCalled();
  });
});

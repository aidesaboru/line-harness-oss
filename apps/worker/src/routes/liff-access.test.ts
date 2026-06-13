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
  };
};

function setupApp() {
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    c.env = {
      DB: {} as D1Database,
      LINE_LOGIN_CHANNEL_ID: 'login-channel',
      LINE_CHANNEL_ACCESS_TOKEN: 'line-token',
    };
    await next();
  });
  app.route('/', liffRoutes);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  liffAuthMocks.verifyCallerLineUserId.mockResolvedValue(null);
  dbMocks.getFriendByLineUserId.mockResolvedValue(null);
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

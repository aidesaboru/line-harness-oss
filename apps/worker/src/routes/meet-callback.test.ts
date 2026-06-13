import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

const dbMocks = {
  getFriendByLineUserId: vi.fn(),
  getLineAccountById: vi.fn(),
};

const lineClientMethods = {
  pushMessage: vi.fn(),
};

const lineClientConstructor = vi.fn(() => lineClientMethods);

vi.mock('@line-crm/db', () => dbMocks);
vi.mock('@line-crm/line-sdk', () => ({
  LineClient: lineClientConstructor,
}));

const { meetCallback } = await import('./meet-callback.js');

const SECRET = 'm'.repeat(32);

type TestEnv = {
  Bindings: {
    DB: D1Database;
    LINE_CHANNEL_ACCESS_TOKEN: string;
    MEET_CALLBACK_SECRET?: string;
  };
};

function createDb() {
  const stmt = {
    bind: vi.fn(),
    run: vi.fn().mockResolvedValue({ success: true }),
  };
  stmt.bind.mockReturnValue(stmt);
  const db = {
    prepare: vi.fn(() => stmt),
  } as unknown as D1Database;
  return { db, stmt };
}

function setupApp(db: D1Database, secret: string | null = SECRET) {
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    c.env = {
      DB: db,
      LINE_CHANNEL_ACCESS_TOKEN: 'fallback-token',
      MEET_CALLBACK_SECRET: secret ?? undefined,
    };
    await next();
  });
  app.route('/', meetCallback);
  return app;
}

async function hmac(body: string, secret = SECRET): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function validBody() {
  return JSON.stringify({
    session_id: 'session-1',
    scenario_id: 'scenario-1',
    line_user_id: 'U-friend',
    status: 'completed',
    transcripts: [
      { question_text: '悩みは？', transcript: '在庫管理を楽にしたい' },
    ],
    requirements_doc: '要件定義の本文',
    completed_at: '2026-06-13T10:00:00.000+09:00',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getFriendByLineUserId.mockResolvedValue({
    id: 'friend-1',
    line_user_id: 'U-friend',
    line_account_id: 'acc-1',
    display_name: '友だち',
    metadata: '{"existing":true}',
  });
  dbMocks.getLineAccountById.mockResolvedValue({
    id: 'acc-1',
    channel_access_token: 'account-token',
  });
  lineClientMethods.pushMessage.mockResolvedValue(undefined);
  lineClientConstructor.mockImplementation(() => lineClientMethods);
});

describe('Meet callback signature guard', () => {
  test('fails closed when MEET_CALLBACK_SECRET is not configured', async () => {
    const { db } = createDb();
    const res = await setupApp(db, null).request('/api/meet-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: validBody(),
    });

    expect(res.status).toBe(503);
    expect(dbMocks.getFriendByLineUserId).not.toHaveBeenCalled();
    expect(lineClientConstructor).not.toHaveBeenCalled();
  });

  test('rejects missing or malformed signatures before DB lookup', async () => {
    const { db } = createDb();
    const app = setupApp(db);

    const missing = await app.request('/api/meet-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: validBody(),
    });
    const malformed = await app.request('/api/meet-callback', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Meet-Callback-Signature': 'bad',
      },
      body: validBody(),
    });

    expect(missing.status).toBe(401);
    expect(malformed.status).toBe(401);
    expect(dbMocks.getFriendByLineUserId).not.toHaveBeenCalled();
    expect(lineClientConstructor).not.toHaveBeenCalled();
  });

  test('rejects invalid signatures before parsing JSON', async () => {
    const { db } = createDb();
    const res = await setupApp(db).request('/api/meet-callback', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Meet-Callback-Signature': '0'.repeat(64),
      },
      body: '{not-json',
    });

    expect(res.status).toBe(401);
    expect(dbMocks.getFriendByLineUserId).not.toHaveBeenCalled();
    expect(lineClientConstructor).not.toHaveBeenCalled();
  });

  test('rejects invalid callback bodies after signature verification and before DB lookup', async () => {
    const { db } = createDb();
    const body = JSON.stringify({ line_user_id: 'U-friend', transcripts: [] });

    const res = await setupApp(db).request('/api/meet-callback', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Meet-Callback-Signature': await hmac(body),
      },
      body,
    });

    expect(res.status).toBe(400);
    expect(dbMocks.getFriendByLineUserId).not.toHaveBeenCalled();
    expect(lineClientConstructor).not.toHaveBeenCalled();
  });

  test('accepts a valid signed callback and stores hearing metadata', async () => {
    const { db, stmt } = createDb();
    const body = validBody();

    const res = await setupApp(db).request('/api/meet-callback', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Meet-Callback-Signature': await hmac(body),
      },
      body,
    });

    expect(res.status).toBe(200);
    expect(dbMocks.getFriendByLineUserId).toHaveBeenCalledWith(db, 'U-friend');
    expect(dbMocks.getLineAccountById).toHaveBeenCalledWith(db, 'acc-1');
    expect(lineClientConstructor).toHaveBeenCalledWith('account-token');
    expect(lineClientMethods.pushMessage).toHaveBeenCalledWith('U-friend', [
      expect.objectContaining({ type: 'flex', altText: 'ヒアリング結果' }),
    ]);
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('UPDATE friends SET metadata'));
    expect(stmt.bind).toHaveBeenCalledWith(expect.any(String), 'friend-1');
    const [metadata] = stmt.bind.mock.calls[0] as [string, string];
    expect(JSON.parse(metadata)).toMatchObject({
      existing: true,
      meet_hearing: {
        session_id: 'session-1',
        status: 'completed',
        requirements_doc: '要件定義の本文',
      },
    });
  });
});

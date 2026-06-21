import { describe, expect, test, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const lineClientMethods = vi.hoisted(() => ({
  getProfile: vi.fn(),
  pushMessage: vi.fn(),
  replyMessage: vi.fn(),
}));

// Stub the DB graph — these tests only exercise the size guard and
// signature-verify-before-parse path; webhook event handling is out of scope.
vi.mock('@line-crm/db', () => ({
  upsertFriend: vi.fn(),
  updateFriendFollowStatus: vi.fn(),
  getFriendByLineUserId: vi.fn(),
  getScenarios: vi.fn(),
  enrollFriendInScenario: vi.fn(),
  getScenarioSteps: vi.fn(),
  advanceFriendScenario: vi.fn(),
  completeFriendScenario: vi.fn(),
  upsertChatOnMessage: vi.fn(),
  getLineAccounts: vi.fn().mockResolvedValue([]),
  jstNow: vi.fn(),
  computeNextDeliveryAt: vi.fn(),
  resolveStepContent: vi.fn(),
  addTagToFriend: vi.fn(),
  getEntryRouteByRefCode: vi.fn(),
  getMessageTemplateById: vi.fn(),
}));

vi.mock('@line-crm/line-sdk', async () => {
  const actual = await vi.importActual<typeof import('@line-crm/line-sdk')>('@line-crm/line-sdk');
  return {
    ...actual,
    verifySignature: vi.fn(),
    LineClient: vi.fn().mockImplementation(() => lineClientMethods),
  };
});

vi.mock('../services/event-bus.js', () => ({
  fireEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/step-delivery.js', () => ({
  buildMessage: vi.fn(),
  expandVariables: vi.fn(),
}));

import {
  getScenarios,
  getFriendByLineUserId,
  getLineAccounts,
  jstNow,
  upsertChatOnMessage,
  upsertFriend,
} from '@line-crm/db';
import { verifySignature } from '@line-crm/line-sdk';
import { fireEvent } from '../services/event-bus.js';
import { webhook } from './webhook.js';

function setupApp() {
  const app = new Hono();
  app.route('/', webhook);
  return app;
}

const baseEnv = {
  DB: {} as D1Database,
  LINE_CHANNEL_SECRET: 'env-default-secret',
  LINE_CHANNEL_ACCESS_TOKEN: 'env-default-token',
} as Record<string, unknown>;

const baseExecutionCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
  props: {},
} as unknown as ExecutionContext;

beforeEach(() => {
  vi.clearAllMocks();
  lineClientMethods.getProfile.mockResolvedValue({
    displayName: 'Test User',
    pictureUrl: 'https://example.com/profile.png',
    statusMessage: 'hello',
  });
  lineClientMethods.pushMessage.mockResolvedValue(undefined);
  lineClientMethods.replyMessage.mockResolvedValue(undefined);
  vi.mocked(getLineAccounts).mockResolvedValue([]);
  vi.mocked(jstNow).mockReturnValue('2026-06-11T17:45:17.000+09:00');
});

function createDbMock() {
  const statements: Array<{ sql: string; binds: unknown[] }> = [];

  const db = {
    prepare: vi.fn((sql: string) => ({
      bind: (...binds: unknown[]) => {
        statements.push({ sql, binds });
        return {
          run: vi.fn().mockResolvedValue({ success: true }),
          first: vi.fn().mockResolvedValue(null),
          all: vi.fn().mockResolvedValue({ results: [] }),
        };
      },
      run: vi.fn().mockResolvedValue({ success: true }),
      first: vi.fn().mockResolvedValue(null),
      all: vi.fn().mockResolvedValue({ results: [] }),
    })),
  } as unknown as D1Database;

  return { db, statements };
}

describe('POST /webhook — DoS defenses (#104)', () => {
  test('rejects with 413 when Content-Length declares an oversized body', async () => {
    const app = setupApp();
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(2 * 1024 * 1024), // 2 MiB > 1 MiB cap
          'X-Line-Signature': 'whatever',
        },
        body: JSON.stringify({ events: [] }),
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(413);
    // Signature verification must not even be attempted on an oversized body.
    expect(verifySignature).not.toHaveBeenCalled();
  });

  test('rejects with 413 when actual body exceeds the cap even if Content-Length is absent', async () => {
    const app = setupApp();
    const oversizedBody = 'x'.repeat(1024 * 1024 + 1);
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Line-Signature': 'whatever',
        },
        body: oversizedBody,
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(413);
    expect(verifySignature).not.toHaveBeenCalled();
  });

  test('verifies signature before parsing JSON — malformed body with invalid signature never reaches the parser', async () => {
    vi.mocked(verifySignature).mockResolvedValue(false);

    const app = setupApp();
    // 44-char signature (valid HMAC-SHA256 base64 length) so it clears the
    // length pre-check and reaches verifySignature. Malformed JSON body: if
    // signature were verified *after* parse (old behavior), we'd hit the
    // parser-failure branch first. With signature-first, we get the invalid-
    // signature branch and never attempt to parse.
    const validShapedSignature = 'A'.repeat(43) + '=';
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Line-Signature': validShapedSignature,
        },
        body: '{not valid json',
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(200);
    // verifySignature must run; rejection happens before any parse attempt.
    expect(verifySignature).toHaveBeenCalled();
    expect(verifySignature).toHaveBeenCalledWith('env-default-secret', '{not valid json', validShapedSignature);
  });

  test('rejects unsigned or malformed-signature requests without hitting verifySignature or D1', async () => {
    const app = setupApp();
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Missing X-Line-Signature header entirely.
        },
        body: JSON.stringify({ events: [] }),
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(200);
    // Fast-rejected before any crypto / DB work.
    expect(verifySignature).not.toHaveBeenCalled();
  });
});

describe('POST /webhook — message intake', () => {
  test('creates and logs a first text message from an unregistered friend', async () => {
    vi.mocked(verifySignature).mockResolvedValue(true);
    vi.mocked(getLineAccounts).mockResolvedValue([
      {
        id: 'acc-1',
        name: 'Account 1',
        channel_id: 'channel-1',
        channel_secret: 'env-default-secret',
        channel_access_token: 'account-token',
        login_channel_id: null,
        login_channel_secret: null,
        liff_id: null,
        is_active: 1,
        country: null,
        role: null,
        display_order: 0,
        token_expires_at: null,
        created_at: '2026-06-11T00:00:00.000+09:00',
        updated_at: '2026-06-11T00:00:00.000+09:00',
      },
    ]);
    vi.mocked(getFriendByLineUserId).mockResolvedValue(null);
    vi.mocked(upsertFriend).mockResolvedValue({
      id: 'friend-1',
      line_user_id: 'Urealuser',
      display_name: 'Test User',
      picture_url: 'https://example.com/profile.png',
      status_message: 'hello',
      is_following: 1,
      user_id: null,
      line_account_id: null,
      metadata: '{}',
      first_tracked_link_id: null,
      created_at: '2026-06-11T17:45:17.000+09:00',
      updated_at: '2026-06-11T17:45:17.000+09:00',
    });
    vi.mocked(upsertChatOnMessage).mockResolvedValue(undefined);

    const { db, statements } = createDbMock();
    const app = setupApp();
    const ctx = {
      ...baseExecutionCtx,
      waitUntil: vi.fn(),
    } as unknown as ExecutionContext;
    const body = JSON.stringify({
      destination: 'Ubot',
      events: [
        {
          type: 'message',
          mode: 'active',
          timestamp: 1781167517000,
          source: { type: 'user', userId: 'Urealuser' },
          webhookEventId: '01JXHARNESSTEST',
          deliveryContext: { isRedelivery: false },
          replyToken: 'reply-token',
          message: {
            id: 'msg-1',
            type: 'text',
            quoteToken: 'quote-token',
            text: 'テスト4',
          },
        },
      ],
    });

    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Line-Signature': 'A'.repeat(43) + '=',
        },
        body,
      },
      {
        ...baseEnv,
        DB: db,
      },
      ctx,
    );

    expect(res.status).toBe(200);
    const processingPromise = vi.mocked(ctx.waitUntil).mock.calls[0]?.[0] as Promise<void>;
    await processingPromise;

    expect(upsertFriend).toHaveBeenCalledWith(db, {
      lineUserId: 'Urealuser',
      displayName: 'Test User',
      pictureUrl: 'https://example.com/profile.png',
      statusMessage: 'hello',
    });
    expect(upsertChatOnMessage).toHaveBeenCalledWith(db, 'friend-1');

    expect(statements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sql: expect.stringContaining('UPDATE friends SET line_account_id'),
          binds: ['acc-1', '2026-06-11T17:45:17.000+09:00', 'friend-1'],
        }),
        expect.objectContaining({
          sql: expect.stringContaining('INSERT INTO messages_log'),
          binds: [
            expect.any(String),
            'friend-1',
            'テスト4',
            'acc-1',
            null,
            '2026-06-11T17:45:17.000+09:00',
          ],
        }),
      ]),
    );
  });

  test('capture-only mode logs text messages without replies, scenarios, or automations', async () => {
    vi.mocked(verifySignature).mockResolvedValue(true);
    vi.mocked(getLineAccounts).mockResolvedValue([
      {
        id: 'acc-1',
        name: 'Account 1',
        channel_id: 'channel-1',
        channel_secret: 'env-default-secret',
        channel_access_token: 'account-token',
        login_channel_id: null,
        login_channel_secret: null,
        liff_id: null,
        is_active: 1,
        country: null,
        role: null,
        display_order: 0,
        token_expires_at: null,
        created_at: '2026-06-11T00:00:00.000+09:00',
        updated_at: '2026-06-11T00:00:00.000+09:00',
      },
    ]);
    vi.mocked(getFriendByLineUserId).mockResolvedValue(null);
    vi.mocked(upsertFriend).mockResolvedValue({
      id: 'friend-1',
      line_user_id: 'Urealuser',
      display_name: 'Test User',
      picture_url: 'https://example.com/profile.png',
      status_message: 'hello',
      is_following: 1,
      user_id: null,
      line_account_id: null,
      metadata: '{}',
      first_tracked_link_id: null,
      created_at: '2026-06-11T17:45:17.000+09:00',
      updated_at: '2026-06-11T17:45:17.000+09:00',
    });
    vi.mocked(upsertChatOnMessage).mockResolvedValue(undefined);

    const { db, statements } = createDbMock();
    const app = setupApp();
    const ctx = {
      ...baseExecutionCtx,
      waitUntil: vi.fn(),
    } as unknown as ExecutionContext;
    const body = JSON.stringify({
      destination: 'Ubot',
      events: [
        {
          type: 'message',
          mode: 'active',
          timestamp: 1781167517000,
          source: { type: 'user', userId: 'Urealuser' },
          webhookEventId: '01JXCAPTUREONLY',
          deliveryContext: { isRedelivery: false },
          replyToken: 'reply-token',
          message: {
            id: 'msg-1',
            type: 'text',
            quoteToken: 'quote-token',
            markAsReadToken: 'read-token-1',
            text: '体験を完了する',
          },
        },
      ],
    });

    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Line-Signature': 'A'.repeat(43) + '=',
        },
        body,
      },
      {
        ...baseEnv,
        DB: db,
        LINE_CAPTURE_ONLY: '1',
      },
      ctx,
    );

    expect(res.status).toBe(200);
    const processingPromise = vi.mocked(ctx.waitUntil).mock.calls[0]?.[0] as Promise<void>;
    await processingPromise;

    expect(lineClientMethods.replyMessage).not.toHaveBeenCalled();
    expect(lineClientMethods.pushMessage).not.toHaveBeenCalled();
    expect(getScenarios).not.toHaveBeenCalled();
    expect(fireEvent).not.toHaveBeenCalled();
    expect(upsertChatOnMessage).toHaveBeenCalledWith(db, 'friend-1');

    expect(statements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sql: expect.stringContaining('INSERT INTO messages_log'),
          binds: [
            expect.any(String),
            'friend-1',
            '体験を完了する',
            'acc-1',
            'read-token-1',
            '2026-06-11T17:45:17.000+09:00',
          ],
        }),
      ]),
    );
  });
});

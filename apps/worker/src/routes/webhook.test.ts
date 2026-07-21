import { describe, expect, test, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const lineClientMethods = vi.hoisted(() => ({
  getProfile: vi.fn(),
  pushMessage: vi.fn(),
  replyMessage: vi.fn(),
}));

const supportCaseReplyMethods = vi.hoisted(() => ({
  restoreSupportCasesFromCustomerMessage: vi.fn(),
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

vi.mock('../services/support-case-customer-reply.js', () => supportCaseReplyMethods);

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
  supportCaseReplyMethods.restoreSupportCasesFromCustomerMessage.mockResolvedValue({
    restored: 0,
    caseIds: [],
  });
  vi.mocked(getLineAccounts).mockResolvedValue([]);
  vi.mocked(jstNow).mockReturnValue('2026-06-11T17:45:17.000+09:00');
});

function createDbMock(inboxRows: Array<Record<string, unknown>> = []) {
  const statements: Array<{ sql: string; binds: unknown[] }> = [];

  const db = {
    batch: vi.fn(async (batchStatements: D1PreparedStatement[]) =>
      batchStatements.map(() => ({ success: true, meta: { changes: 1 } })),
    ),
    prepare: vi.fn((sql: string) => ({
      bind: (...binds: unknown[]) => {
        statements.push({ sql, binds });
        return {
          run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
          first: vi.fn().mockResolvedValue(null),
          all: vi.fn().mockResolvedValue({
            results: sql.includes('FROM line_webhook_inbox') ? inboxRows : [],
          }),
        };
      },
      run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
      first: vi.fn().mockResolvedValue(null),
      all: vi.fn().mockResolvedValue({
        results: sql.includes('FROM line_webhook_inbox') ? inboxRows : [],
      }),
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
    expect(supportCaseReplyMethods.restoreSupportCasesFromCustomerMessage).toHaveBeenCalledWith(db, {
      friendId: 'friend-1',
      lineAccountId: 'acc-1',
      messageType: 'text',
      lineMessageId: 'msg-1',
      webhookEventId: '01JXHARNESSTEST',
      receivedAt: '2026-06-11T17:45:17.000+09:00',
    });

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
            'msg-1',
            'quote-token',
            null,
            '2026-06-11T17:45:17.000+09:00',
          ],
        }),
      ]),
    );
  });

  test('fills missing line account id for an existing friend when a message arrives', async () => {
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
    vi.mocked(getFriendByLineUserId).mockResolvedValue({
      id: 'friend-existing',
      line_user_id: 'Urealuser',
      display_name: 'Existing User',
      picture_url: null,
      status_message: null,
      is_following: 1,
      user_id: null,
      line_account_id: null,
      metadata: '{}',
      first_tracked_link_id: null,
      created_at: '2026-06-10T17:45:17.000+09:00',
      updated_at: '2026-06-10T17:45:17.000+09:00',
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
          webhookEventId: '01JXEXISTING',
          deliveryContext: { isRedelivery: false },
          replyToken: 'reply-token',
          message: {
            id: 'msg-existing',
            type: 'text',
            quoteToken: 'quote-token',
            text: '既存顧客からの連絡です',
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

    expect(upsertFriend).not.toHaveBeenCalled();
    expect(upsertChatOnMessage).toHaveBeenCalledWith(db, 'friend-existing');
    expect(statements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sql: expect.stringContaining('UPDATE friends SET line_account_id'),
          binds: ['acc-1', '2026-06-11T17:45:17.000+09:00', 'friend-existing'],
        }),
        expect.objectContaining({
          sql: expect.stringContaining('INSERT INTO messages_log'),
          binds: [
            expect.any(String),
            'friend-existing',
            '既存顧客からの連絡です',
            'acc-1',
            'msg-existing',
            'quote-token',
            null,
            '2026-06-11T17:45:17.000+09:00',
          ],
        }),
      ]),
    );
  });

  test('restores customer-reply cases when a non-text message arrives', async () => {
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
    vi.mocked(getFriendByLineUserId).mockResolvedValue({
      id: 'friend-existing',
      line_user_id: 'Urealuser',
      display_name: 'Existing User',
      picture_url: null,
      status_message: null,
      is_following: 1,
      user_id: null,
      line_account_id: 'acc-1',
      metadata: '{}',
      first_tracked_link_id: null,
      created_at: '2026-06-10T17:45:17.000+09:00',
      updated_at: '2026-06-10T17:45:17.000+09:00',
    });

    const { db } = createDbMock();
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
          webhookEventId: '01JXIMAGETEST',
          deliveryContext: { isRedelivery: false },
          replyToken: 'reply-token',
          message: {
            id: 'msg-image',
            type: 'image',
            contentProvider: {
              type: 'external',
              originalContentUrl: 'https://example.com/image.jpg',
              previewImageUrl: 'https://example.com/image-preview.jpg',
            },
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
      { ...baseEnv, DB: db },
      ctx,
    );

    expect(res.status).toBe(200);
    await (vi.mocked(ctx.waitUntil).mock.calls[0]?.[0] as Promise<void>);
    expect(supportCaseReplyMethods.restoreSupportCasesFromCustomerMessage).toHaveBeenCalledWith(db, {
      friendId: 'friend-existing',
      lineAccountId: 'acc-1',
      messageType: 'image',
      lineMessageId: 'msg-image',
      webhookEventId: '01JXIMAGETEST',
      receivedAt: '2026-06-11T17:45:17.000+09:00',
    });
  });

  test('does not restore support cases for postback events', async () => {
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
    vi.mocked(getFriendByLineUserId).mockResolvedValue({
      id: 'friend-existing',
      line_user_id: 'Urealuser',
      display_name: 'Existing User',
      picture_url: null,
      status_message: null,
      is_following: 1,
      user_id: null,
      line_account_id: 'acc-1',
      metadata: '{}',
      first_tracked_link_id: null,
      created_at: '2026-06-10T17:45:17.000+09:00',
      updated_at: '2026-06-10T17:45:17.000+09:00',
    });

    const { db } = createDbMock();
    const app = setupApp();
    const ctx = {
      ...baseExecutionCtx,
      waitUntil: vi.fn(),
    } as unknown as ExecutionContext;
    const body = JSON.stringify({
      destination: 'Ubot',
      events: [
        {
          type: 'postback',
          mode: 'active',
          timestamp: 1781167517000,
          source: { type: 'user', userId: 'Urealuser' },
          webhookEventId: '01JXPOSTBACKTEST',
          deliveryContext: { isRedelivery: false },
          replyToken: 'reply-token',
          postback: { data: 'action=confirm' },
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
      { ...baseEnv, DB: db },
      ctx,
    );

    expect(res.status).toBe(200);
    await (vi.mocked(ctx.waitUntil).mock.calls[0]?.[0] as Promise<void>);
    expect(supportCaseReplyMethods.restoreSupportCasesFromCustomerMessage).not.toHaveBeenCalled();
  });

  test('capture-only mode durably queues text messages before deferred projection', async () => {
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

    const event = {
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
    };
    const { db, statements } = createDbMock([
      {
        webhook_event_id: '01JXCAPTUREONLY',
        line_account_id: 'acc-1',
        event_payload: JSON.stringify(event),
        attempts: 0,
      },
    ]);
    const app = setupApp();
    const waitUntil = vi.fn();
    const ctx = {
      ...baseExecutionCtx,
      waitUntil,
    } as unknown as ExecutionContext;
    const body = JSON.stringify({
      destination: 'Ubot',
      events: [event],
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
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await waitUntil.mock.calls[0]?.[0];

    expect(lineClientMethods.replyMessage).not.toHaveBeenCalled();
    expect(lineClientMethods.pushMessage).not.toHaveBeenCalled();
    expect(getScenarios).not.toHaveBeenCalled();
    expect(fireEvent).not.toHaveBeenCalled();
    expect(upsertChatOnMessage).toHaveBeenCalledWith(db, 'friend-1');
    expect(supportCaseReplyMethods.restoreSupportCasesFromCustomerMessage).toHaveBeenCalledWith(db, {
      friendId: 'friend-1',
      lineAccountId: 'acc-1',
      messageType: 'text',
      lineMessageId: 'msg-1',
      webhookEventId: '01JXCAPTUREONLY',
      receivedAt: '2026-06-11T17:45:17.000+09:00',
    });

    expect(statements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sql: expect.stringContaining('INSERT INTO line_webhook_inbox'),
          binds: [
            '01JXCAPTUREONLY',
            'acc-1',
            expect.stringContaining('体験を完了する'),
            '2026-06-11T17:45:17.000+09:00',
            '2026-06-11T17:45:17.000+09:00',
          ],
        }),
        expect.objectContaining({
          sql: expect.stringContaining('ON CONFLICT(webhook_event_id)'),
          binds: [
            expect.any(String),
            'friend-1',
            '体験を完了する',
            'acc-1',
            'msg-1',
            '01JXCAPTUREONLY',
            'quote-token',
            'read-token-1',
            '2026-06-11T17:45:17.000+09:00',
          ],
        }),
      ]),
    );
  });

  test('returns 503 when capture-only persistence still fails after a retry', async () => {
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
    vi.mocked(getFriendByLineUserId).mockResolvedValue({
      id: 'friend-existing',
      line_user_id: 'Urealuser',
      display_name: 'Existing User',
      picture_url: null,
      status_message: null,
      is_following: 1,
      user_id: null,
      line_account_id: 'acc-1',
      metadata: '{}',
      first_tracked_link_id: null,
      created_at: '2026-06-10T17:45:17.000+09:00',
      updated_at: '2026-06-10T17:45:17.000+09:00',
    });

    const batch = vi.fn().mockRejectedValue(new Error('D1 unavailable'));
    const db = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({})),
      })),
      batch,
    } as unknown as D1Database;
    const app = setupApp();
    const ctx = {
      ...baseExecutionCtx,
      waitUntil: vi.fn(),
    } as unknown as ExecutionContext;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Line-Signature': 'A'.repeat(43) + '=',
        },
        body: JSON.stringify({
          destination: 'Ubot',
          events: [
            {
              type: 'message',
              mode: 'active',
              timestamp: 1781167517000,
              source: { type: 'user', userId: 'Urealuser' },
              webhookEventId: '01JXCAPTUREFAIL',
              deliveryContext: { isRedelivery: false },
              replyToken: 'reply-token',
              message: { id: 'msg-fail', type: 'text', text: '保存失敗テスト' },
            },
          ],
        }),
      },
      {
        ...baseEnv,
        DB: db,
        LINE_CAPTURE_ONLY: '1',
      },
      ctx,
    );

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ status: 'retry' });
    expect(batch).toHaveBeenCalledTimes(2);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(upsertChatOnMessage).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('Capture-only webhook inbox persistence failed'));
    consoleError.mockRestore();
  });

  test('marks unsent LINE messages as deleted in Harness', async () => {
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
          type: 'unsend',
          mode: 'active',
          timestamp: 1781167517000,
          source: { type: 'user', userId: 'Urealuser' },
          webhookEventId: '01JXUNSENDTEST',
          deliveryContext: { isRedelivery: false },
          unsend: { messageId: 'msg-1' },
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

    expect(statements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sql: expect.stringContaining('UPDATE messages_log'),
          binds: [
            '2026-06-11T17:45:17.000+09:00',
            'acc-1',
            'acc-1',
            'msg-1',
            'msg-1',
            'msg-1',
          ],
        }),
      ]),
    );
  });
});

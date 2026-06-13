import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

const dbMocks = {
  getBroadcasts: vi.fn(),
  getBroadcastById: vi.fn(),
  createBroadcast: vi.fn(),
  updateBroadcast: vi.fn(),
  deleteBroadcast: vi.fn(),
  getLineAccountById: vi.fn(),
  jstNow: vi.fn(),
};

const lineClientMethods = {
  pushMessage: vi.fn(),
  getUnitInsight: vi.fn(),
  getMessageEventInsight: vi.fn(),
};

const lineClientConstructor = vi.fn(() => lineClientMethods);

vi.mock('@line-crm/db', () => dbMocks);
vi.mock('@line-crm/line-sdk', () => ({
  LineClient: lineClientConstructor,
}));
vi.mock('../services/broadcast.js', () => ({
  buildMessage: vi.fn((messageType: string, content: string) => ({ type: messageType, text: content })),
  processBroadcastSend: vi.fn(),
  processQueuedBroadcasts: vi.fn(),
}));
vi.mock('../services/auto-track.js', () => ({
  autoTrackContent: vi.fn(async (_db: D1Database, messageType: string, content: string) => ({
    messageType,
    content,
  })),
}));
vi.mock('../services/dedup-broadcast.js', () => ({
  computeDedupBroadcastPreview: vi.fn(),
}));
vi.mock('../services/segment-send.js', () => ({
  processSegmentSend: vi.fn(),
}));

const { computeDedupBroadcastPreview } = await import('../services/dedup-broadcast.js');
const { broadcasts } = await import('./broadcasts.js');
const { default: dedupPreview } = await import('./dedup-preview.js');

type StaffRole = 'owner' | 'admin' | 'staff';

type TestEnv = {
  Bindings: { DB: D1Database; WORKER_URL: string };
  Variables: { staff: { id: string; name: string; role: StaffRole } };
};

type FriendRow = {
  id: string;
  line_user_id: string;
};

type DbCall = { method: 'all' | 'first' | 'run'; sql: string; binds: unknown[] };

function makeDb(state: {
  configuredFriendIds?: string[];
  visibleFriendIds?: string[];
  friends?: FriendRow[];
  broadcastRow?: Record<string, string | null>;
} = {}) {
  const configuredFriendIds = state.configuredFriendIds ?? ['friend-visible', 'friend-hidden'];
  const visibleFriendIds = new Set(state.visibleFriendIds ?? []);
  const friends = state.friends ?? [
    { id: 'friend-visible', line_user_id: 'U-visible' },
    { id: 'friend-hidden', line_user_id: 'U-hidden' },
  ];
  const calls: DbCall[] = [];

  const db = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          bound = args;
          return stmt;
        },
        async first<T>() {
          calls.push({ method: 'first', sql, binds: bound });
          if (sql.includes("key = 'test_recipients'")) {
            return { value: JSON.stringify(configuredFriendIds) } as T;
          }
          if (sql.includes('FROM broadcasts')) {
            return (state.broadcastRow ?? null) as T | null;
          }
          return null as T | null;
        },
        async all<T>() {
          calls.push({ method: 'all', sql, binds: bound });
          if (sql.includes('FROM friends f')) {
            const scoped = sql.includes('sc_friend_scope.friend_id = f.id');
            const ids = new Set(configuredFriendIds);
            return {
              results: friends.filter((friend) => {
                if (!ids.has(friend.id)) return false;
                if (!scoped) return true;
                return visibleFriendIds.has(friend.id);
              }) as T[],
            };
          }
          return { results: [] as T[] };
        },
        async run() {
          calls.push({ method: 'run', sql, binds: bound });
          return { success: true, meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  } as unknown as D1Database & { calls: DbCall[] };
  db.calls = calls;
  return db;
}

function setupApp(db: D1Database, role: StaffRole = 'staff') {
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'staff-1', name: 'Tajima', role });
    c.env = { DB: db, WORKER_URL: 'https://worker.example.com' };
    await next();
  });
  app.route('/', broadcasts);
  app.route('/', dedupPreview);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getBroadcasts.mockResolvedValue([]);
  dbMocks.getBroadcastById.mockResolvedValue({
    id: 'broadcast-1',
    title: 'Draft',
    message_type: 'text',
    message_content: 'hello',
    target_type: 'all',
    target_tag_id: null,
    status: 'draft',
    scheduled_at: null,
    sent_at: null,
    total_count: 0,
    success_count: 0,
    created_at: '2026-06-13T10:00:00.000',
    line_account_id: 'acc-1',
  });
  dbMocks.getLineAccountById.mockResolvedValue({
    id: 'acc-1',
    channel_access_token: 'account-token',
  });
  dbMocks.jstNow.mockReturnValue('2026-06-13T10:00:00.000+09:00');
  lineClientConstructor.mockImplementation(() => lineClientMethods);
  lineClientMethods.pushMessage.mockResolvedValue({ success: true });
  lineClientMethods.getUnitInsight.mockResolvedValue({ messages: [] });
  lineClientMethods.getMessageEventInsight.mockResolvedValue({ overview: {} });
});

describe('broadcast support role guards', () => {
  test('staff cannot access global broadcast management APIs', async () => {
    const db = makeDb({ visibleFriendIds: ['friend-visible'] });
    const app = setupApp(db, 'staff');

    const requests: Array<[string, string, RequestInit?]> = [
      ['GET', '/api/broadcasts'],
      ['GET', '/api/broadcasts/broadcast-1'],
      ['GET', '/api/broadcasts/broadcast-1/preview-count'],
      ['GET', '/api/broadcasts/broadcast-1/per-account-stats'],
      ['GET', '/api/broadcasts/broadcast-1/insight'],
      ['GET', '/api/broadcasts/broadcast-1/progress'],
      ['POST', '/api/broadcasts', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Draft',
          messageType: 'text',
          messageContent: 'hello',
          targetType: 'all',
        }),
      }],
      ['PUT', '/api/broadcasts/broadcast-1', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Updated' }),
      }],
      ['DELETE', '/api/broadcasts/broadcast-1'],
      ['POST', '/api/broadcasts/broadcast-1/send'],
      ['POST', '/api/broadcasts/broadcast-1/send-segment', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conditions: { operator: 'AND', rules: [] } }),
      }],
      ['POST', '/api/broadcasts/broadcast-1/fetch-insight'],
      ['POST', '/api/broadcasts/broadcast-1/test-send'],
      ['POST', '/api/segments/count', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conditions: { operator: 'AND', rules: [] } }),
      }],
      ['POST', '/api/broadcasts/dedup-preview', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountIds: ['acc-1'], dedupPriority: ['acc-1'] }),
      }],
    ];

    for (const [method, path, init] of requests) {
      const res = await app.request(path, { ...init, method });
      expect(res.status, `${method} ${path}`).toBe(403);
    }

    expect(dbMocks.getBroadcasts).not.toHaveBeenCalled();
    expect(dbMocks.getBroadcastById).not.toHaveBeenCalled();
    expect(dbMocks.createBroadcast).not.toHaveBeenCalled();
    expect(dbMocks.updateBroadcast).not.toHaveBeenCalled();
    expect(dbMocks.deleteBroadcast).not.toHaveBeenCalled();
    expect(lineClientMethods.pushMessage).not.toHaveBeenCalled();
    expect(computeDedupBroadcastPreview).not.toHaveBeenCalled();
    expect(db.calls).toEqual([]);
  });

  test('owner test-send keeps global configured recipient scope', async () => {
    const db = makeDb({ visibleFriendIds: [] });

    const res = await setupApp(db, 'owner').request('/api/broadcasts/broadcast-1/test-send', { method: 'POST' });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { sent: number; failed: number };
    expect(body).toMatchObject({ sent: 2, failed: 0 });
    expect(lineClientMethods.pushMessage).toHaveBeenCalledTimes(2);
    expect(lineClientMethods.pushMessage).toHaveBeenNthCalledWith(1, 'U-visible', [{ type: 'text', text: '【テスト配信】\nhello' }]);
    expect(lineClientMethods.pushMessage).toHaveBeenNthCalledWith(2, 'U-hidden', [{ type: 'text', text: '【テスト配信】\nhello' }]);
    const recipientsCall = db.calls.find((call) => call.sql.includes('FROM friends f'));
    expect(recipientsCall?.sql).not.toContain('sc_friend_scope');
  });
});

describe('dedup preview payload validation', () => {
  test('rejects malformed or unsafe payloads before computing preview', async () => {
    const app = setupApp(makeDb(), 'owner');
    const cases: Array<{ name: string; body: string; error: string }> = [
      { name: 'malformed json', body: '{', error: 'invalid_json' },
      { name: 'non-object payload', body: JSON.stringify(['acc-1']), error: 'invalid_payload' },
      {
        name: 'empty accountIds',
        body: JSON.stringify({ accountIds: [], dedupPriority: [] }),
        error: 'invalid_account_ids',
      },
      {
        name: 'unsafe accountId',
        body: JSON.stringify({ accountIds: ['acc 1'], dedupPriority: [] }),
        error: 'invalid_account_ids',
      },
      {
        name: 'unsafe dedupPriority',
        body: JSON.stringify({ accountIds: ['acc-1'], dedupPriority: ['acc 1'] }),
        error: 'invalid_dedup_priority',
      },
      {
        name: 'unsafe targetTagId',
        body: JSON.stringify({ accountIds: ['acc-1'], dedupPriority: [], targetTagId: 'tag 1' }),
        error: 'invalid_target_tag_id',
      },
    ];

    for (const item of cases) {
      const res = await app.request('/api/broadcasts/dedup-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: item.body,
      });

      expect(res.status, item.name).toBe(400);
      await expect(res.json(), item.name).resolves.toMatchObject({
        success: false,
        error: item.error,
      });
    }

    expect(computeDedupBroadcastPreview).not.toHaveBeenCalled();
  });

  test('trims and dedupes ids before computing preview', async () => {
    const db = makeDb();
    vi.mocked(computeDedupBroadcastPreview).mockResolvedValue({
      totalSelected: 3,
      uniqueRecipients: 2,
      reduction: 1,
      reductionRate: 1 / 3,
      perAccount: [
        {
          accountId: 'acc-1',
          accountName: 'Account 1',
          accountCountry: null,
          selectedCount: 2,
          sendCount: 1,
          excludedToHigherPriority: 1,
          recipients: [{ friendId: 'friend-1', lineUserId: 'U1', identKey: 'uid:user-1' }],
        },
      ],
    });

    const res = await setupApp(db, 'owner').request('/api/broadcasts/dedup-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountIds: [' acc-1 ', 'acc-1', 'acc-2'],
        dedupPriority: ['acc-3', ' acc-2 ', 'acc-2', 'acc-1'],
        targetTagId: ' tag-1 ',
      }),
    });

    expect(res.status).toBe(200);
    expect(computeDedupBroadcastPreview).toHaveBeenCalledWith(
      db,
      ['acc-1', 'acc-2'],
      ['acc-2', 'acc-1'],
      'tag-1',
    );
    await expect(res.json()).resolves.toMatchObject({
      success: true,
      data: {
        totalSelected: 3,
        uniqueRecipients: 2,
        reduction: 1,
        perAccount: [
          {
            accountId: 'acc-1',
            accountName: 'Account 1',
            selectedCount: 2,
            sendCount: 1,
            excludedToHigherPriority: 1,
          },
        ],
      },
    });
  });
});

describe('broadcast management payload validation', () => {
  test('rejects malformed query, path, and payload values before DB helpers, SQL, or LINE side effects', async () => {
    const db = makeDb();
    const app = setupApp(db, 'owner');
    const cases: Array<{ method: string; path: string; body?: string; headers?: Record<string, string> }> = [
      { method: 'GET', path: '/api/broadcasts?lineAccountId=bad%20account' },
      { method: 'GET', path: '/api/broadcasts/bad%20id' },
      { method: 'GET', path: '/api/broadcasts/bad%20id/preview-count' },
      { method: 'GET', path: '/api/broadcasts/bad%20id/per-account-stats' },
      { method: 'POST', path: '/api/broadcasts', headers: { 'Content-Type': 'application/json' }, body: '{' },
      {
        method: 'POST',
        path: '/api/broadcasts',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Sale', messageType: 'video', messageContent: 'hello', targetType: 'all' }),
      },
      {
        method: 'POST',
        path: '/api/broadcasts',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Sale',
          messageType: 'image',
          messageContent: JSON.stringify({
            originalContentUrl: 'http://example.com/image.jpg',
            previewImageUrl: 'https://example.com/preview.jpg',
          }),
          targetType: 'all',
        }),
      },
      {
        method: 'POST',
        path: '/api/broadcasts',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Sale',
          messageType: 'text',
          messageContent: 'hello',
          targetType: 'multi-account-dedup',
          accountIds: ['acc 1'],
          dedupPriority: [],
        }),
      },
      {
        method: 'PUT',
        path: '/api/broadcasts/bad%20id',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Updated' }),
      },
      {
        method: 'PUT',
        path: '/api/broadcasts/broadcast-1',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(['bad']),
      },
      { method: 'DELETE', path: '/api/broadcasts/bad%20id' },
      { method: 'POST', path: '/api/broadcasts/bad%20id/send' },
      {
        method: 'POST',
        path: '/api/broadcasts/bad%20id/send-segment',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conditions: { operator: 'AND', rules: [] } }),
      },
      {
        method: 'POST',
        path: '/api/broadcasts/broadcast-1/send-segment',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conditions: { operator: 'AND', rules: [{ type: 'tag_exists', value: 'bad tag' }] } }),
      },
      { method: 'GET', path: '/api/broadcasts/bad%20id/insight' },
      { method: 'POST', path: '/api/broadcasts/bad%20id/fetch-insight' },
      { method: 'POST', path: '/api/broadcasts/bad%20id/test-send' },
      { method: 'GET', path: '/api/broadcasts/bad%20id/progress' },
      {
        method: 'POST',
        path: '/api/segments/count',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conditions: { operator: 'X', rules: [] } }),
      },
      {
        method: 'POST',
        path: '/api/segments/count',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conditions: { operator: 'AND', rules: [] }, accountId: 'bad account' }),
      },
    ];

    for (const item of cases) {
      const res = await app.request(item.path, {
        method: item.method,
        headers: item.headers,
        body: item.body,
      });
      expect(res.status, `${item.method} ${item.path}`).toBe(400);
    }

    expect(dbMocks.getBroadcasts).not.toHaveBeenCalled();
    expect(dbMocks.getBroadcastById).not.toHaveBeenCalled();
    expect(dbMocks.createBroadcast).not.toHaveBeenCalled();
    expect(dbMocks.updateBroadcast).not.toHaveBeenCalled();
    expect(dbMocks.deleteBroadcast).not.toHaveBeenCalled();
    expect(lineClientConstructor).not.toHaveBeenCalled();
    expect(computeDedupBroadcastPreview).not.toHaveBeenCalled();
    expect(db.calls).toEqual([]);
  });

  test('trims and normalizes valid create, update, and segment count payloads', async () => {
    const db = makeDb();
    dbMocks.createBroadcast.mockResolvedValue({
      id: 'broadcast-created',
      title: 'Sale',
      message_type: 'text',
      message_content: 'hello',
      target_type: 'multi-account-dedup',
      target_tag_id: 'tag-1',
      status: 'scheduled',
      scheduled_at: '2026-06-14T10:00:00.000Z',
      sent_at: null,
      total_count: 0,
      success_count: 0,
      created_at: '2026-06-14T00:00:00.000',
      account_ids: JSON.stringify(['acc-1', 'acc-2']),
      dedup_priority: JSON.stringify(['acc-2', 'acc-1']),
      failed_account_ids: null,
      dedup_progress: null,
      batch_lock_at: null,
      line_account_id: 'acc-1',
      alt_text: 'Alt',
    });
    dbMocks.updateBroadcast.mockResolvedValue({
      id: 'broadcast-1',
      title: 'Updated',
      message_type: 'text',
      message_content: 'hi',
      target_type: 'tag',
      target_tag_id: 'tag-1',
      status: 'draft',
      scheduled_at: null,
      sent_at: null,
      total_count: 0,
      success_count: 0,
      created_at: '2026-06-14T00:00:00.000',
      account_ids: null,
      dedup_priority: null,
      failed_account_ids: null,
      dedup_progress: null,
      batch_lock_at: null,
    });

    const app = setupApp(db, 'owner');
    const createRes = await app.request('/api/broadcasts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: ' Sale ',
        messageType: ' text ',
        messageContent: ' hello ',
        targetType: ' multi-account-dedup ',
        targetTagId: ' tag-1 ',
        scheduledAt: ' 2026-06-14T10:00:00.000Z ',
        lineAccountId: ' acc-1 ',
        altText: ' Alt ',
        accountIds: [' acc-1 ', 'acc-1', 'acc-2'],
        dedupPriority: ['acc-3', ' acc-2 ', 'acc-2', 'acc-1'],
      }),
    });
    const updateRes = await app.request('/api/broadcasts/broadcast-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: ' Updated ',
        messageContent: ' hi ',
        targetType: ' tag ',
        targetTagId: ' tag-1 ',
        scheduledAt: '',
      }),
    });
    const countRes = await app.request('/api/segments/count', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: ' acc-1 ',
        conditions: {
          operator: 'AND',
          rules: [
            { type: 'tag_exists', value: ' tag-1 ' },
            { type: 'metadata_equals', value: { key: ' plan ', value: ' vip ' } },
          ],
        },
      }),
    });

    expect(createRes.status).toBe(201);
    expect(updateRes.status).toBe(200);
    expect(countRes.status).toBe(200);
    expect(dbMocks.createBroadcast).toHaveBeenCalledWith(db, {
      title: 'Sale',
      messageType: 'text',
      messageContent: 'hello',
      targetType: 'multi-account-dedup',
      targetTagId: 'tag-1',
      scheduledAt: '2026-06-14T10:00:00.000Z',
      accountIds: ['acc-1', 'acc-2'],
      dedupPriority: ['acc-2', 'acc-1'],
    });
    expect(dbMocks.updateBroadcast).toHaveBeenCalledWith(db, 'broadcast-1', {
      title: 'Updated',
      message_content: 'hi',
      target_type: 'tag',
      target_tag_id: 'tag-1',
      scheduled_at: null,
      status: 'draft',
    });
    const createSqlUpdate = db.calls.find((call) => call.sql.includes('UPDATE broadcasts SET line_account_id = ?'));
    expect(createSqlUpdate?.binds).toEqual(['acc-1', 'Alt', 'broadcast-created']);
    const countCall = db.calls.find((call) => call.sql.includes('SELECT COUNT(*) as count FROM'));
    expect(countCall?.binds).toEqual(['acc-1', 'tag-1', '$.plan', 'vip']);
  });

  test('fetch insight stores only error kind for per-account LINE failures', async () => {
    const db = makeDb({
      broadcastRow: {
        line_request_id: null,
        aggregation_unit: 'agg-secret',
        line_account_id: null,
        target_type: 'multi-account-dedup',
        account_ids: JSON.stringify(['acc-1', 'acc-2']),
        failed_account_ids: null,
      },
    });
    dbMocks.getBroadcastById.mockResolvedValue({
      id: 'broadcast-1',
      title: 'Dedup',
      message_type: 'text',
      message_content: 'hello',
      target_type: 'multi-account-dedup',
      target_tag_id: null,
      status: 'sent',
      scheduled_at: null,
      sent_at: '2026-06-13T10:00:00.000+09:00',
      total_count: 2,
      success_count: 2,
      created_at: '2026-06-13T09:00:00.000+09:00',
      line_request_id: null,
      aggregation_unit: 'agg-secret',
      account_ids: JSON.stringify(['acc-1', 'acc-2']),
      dedup_priority: JSON.stringify(['acc-1', 'acc-2']),
      failed_account_ids: null,
    });
    dbMocks.getLineAccountById.mockResolvedValue({ id: 'acc-1', channel_access_token: 'line-token-secret' });
    lineClientMethods.getUnitInsight
      .mockRejectedValueOnce(new Error('LINE API error: 500 Internal Server Error — SECRET_INSIGHT U-secret'))
      .mockResolvedValueOnce({ messages: [{ uniqueImpression: 2, uniqueClick: 1, uniqueMediaPlayed: 0 }] });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const res = await setupApp(db, 'owner').request('/api/broadcasts/broadcast-1/fetch-insight', {
        method: 'POST',
      });

      const responseText = await res.text();
      const logged = errorSpy.mock.calls.flat().map(String).join('\n');
      expect(res.status, responseText).toBe(200);
      expect(logged).toContain('[fetch-insight] dedup account insight failed: line_http_status_500');
      expect(logged).not.toContain('SECRET_INSIGHT');
      expect(logged).not.toContain('U-secret');
      expect(logged).not.toContain('acc-1');
      expect(logged).not.toContain('line-token-secret');

      const insightWrite = db.calls.find((call) => call.sql.includes('INSERT INTO broadcast_insights'));
      const boundText = insightWrite?.binds.map(String).join('\n') ?? '';
      expect(boundText).toContain('"error":"line_http_status_500"');
      expect(boundText).not.toContain('SECRET_INSIGHT');
      expect(boundText).not.toContain('U-secret');
      expect(boundText).not.toContain('line-token-secret');
    } finally {
      errorSpy.mockRestore();
    }
  });
});

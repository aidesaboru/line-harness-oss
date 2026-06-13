import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

const dbMocks = {
  getBroadcasts: vi.fn(),
  getBroadcastById: vi.fn(),
  createBroadcast: vi.fn(),
  updateBroadcast: vi.fn(),
  deleteBroadcast: vi.fn(),
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
  lineClientConstructor.mockImplementation(() => lineClientMethods);
  lineClientMethods.pushMessage.mockResolvedValue({ success: true });
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

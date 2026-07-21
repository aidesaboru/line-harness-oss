import { beforeEach, describe, expect, test, vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({
  getFriendByLineUserId: vi.fn(),
  upsertFriend: vi.fn(),
  jstNow: vi.fn(() => '2026-07-22T10:00:00.000'),
}));

vi.mock('@line-crm/db', () => dbMocks);

const { syncFollowerPage } = await import('./follower-sync.js');

function makeDb() {
  const calls: Array<{ sql: string; binds: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...values: unknown[]) {
          binds = values;
          return stmt;
        },
        async run() {
          calls.push({ sql, binds });
          return { success: true };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
  return { db, calls };
}

beforeEach(() => {
  dbMocks.getFriendByLineUserId.mockReset();
  dbMocks.upsertFriend.mockReset();
  dbMocks.jstNow.mockClear();
});

describe('syncFollowerPage', () => {
  test('adds new followers and preserves existing friend rows', async () => {
    const { db, calls } = makeDb();
    const client = {
      getFollowers: vi.fn().mockResolvedValue({ userIds: ['U-new', 'U-existing'], next: 'cursor-2' }),
      getProfile: vi.fn()
        .mockResolvedValueOnce({ displayName: '新規友だち', pictureUrl: 'https://example.com/new.jpg' })
        .mockResolvedValueOnce({ displayName: '既存友だち' }),
    };
    dbMocks.getFriendByLineUserId
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'friend-existing' });
    dbMocks.upsertFriend
      .mockResolvedValueOnce({ id: 'friend-new' })
      .mockResolvedValueOnce({ id: 'friend-existing' });

    const result = await syncFollowerPage(db, client, 'acc-1');

    expect(result).toEqual({
      fetched: 2,
      created: 1,
      updated: 1,
      profileFailures: 0,
      next: 'cursor-2',
    });
    expect(client.getFollowers).toHaveBeenCalledWith({ limit: 200 });
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.sql.includes('UPDATE friends'))).toBe(true);
    expect(calls.every((call) => !call.sql.includes('DELETE'))).toBe(true);
    expect(calls.map((call) => call.binds[0])).toEqual(['acc-1', 'acc-1']);
  });

  test('keeps a follower available even when profile retrieval fails', async () => {
    const { db } = makeDb();
    const client = {
      getFollowers: vi.fn().mockResolvedValue({ userIds: ['U-profile-error'] }),
      getProfile: vi.fn().mockRejectedValue(new Error('profile unavailable')),
    };
    dbMocks.getFriendByLineUserId.mockResolvedValue(null);
    dbMocks.upsertFriend.mockResolvedValue({ id: 'friend-profile-error' });

    const result = await syncFollowerPage(db, client, 'acc-1', 'cursor-1');

    expect(result.profileFailures).toBe(1);
    expect(result.created).toBe(1);
    expect(result.next).toBeNull();
    expect(client.getFollowers).toHaveBeenCalledWith({ limit: 200, start: 'cursor-1' });
    expect(dbMocks.upsertFriend).toHaveBeenCalledWith(db, { lineUserId: 'U-profile-error' });
  });
});

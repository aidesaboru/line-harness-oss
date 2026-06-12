import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

const dbMocks = {
  getUsers: vi.fn(),
  getUserById: vi.fn(),
  createUser: vi.fn(),
  updateUser: vi.fn(),
  deleteUser: vi.fn(),
  linkFriendToUser: vi.fn(),
  getUserFriends: vi.fn(),
  getUserByEmail: vi.fn(),
  getUserByPhone: vi.fn(),
};

vi.mock('@line-crm/db', () => dbMocks);

const { users } = await import('./users.js');

type StaffRole = 'owner' | 'admin' | 'staff';

type TestEnv = {
  Bindings: { DB: D1Database };
  Variables: { staff: { id: string; name: string; role: StaffRole } };
};

type UserRow = {
  id: string;
  email: string | null;
  phone: string | null;
  external_id: string | null;
  display_name: string | null;
  created_at: string;
  updated_at: string;
};

type FriendRow = {
  id: string;
  user_id: string | null;
  line_user_id: string;
  display_name: string | null;
  is_following: number;
  created_at: string;
  updated_at: string;
};

type DbCall = { method: 'all' | 'first' | 'run'; sql: string; binds: unknown[] };

const userVisible: UserRow = {
  id: 'user-visible',
  email: 'visible@example.com',
  phone: '09011112222',
  external_id: null,
  display_name: 'Visible Customer',
  created_at: '2026-06-13T10:00:00.000',
  updated_at: '2026-06-13T10:00:00.000',
};

const userHidden: UserRow = {
  id: 'user-hidden',
  email: 'hidden@example.com',
  phone: '09033334444',
  external_id: null,
  display_name: 'Hidden Customer',
  created_at: '2026-06-13T09:00:00.000',
  updated_at: '2026-06-13T09:00:00.000',
};

const userShared: UserRow = {
  id: 'user-shared',
  email: 'shared@example.com',
  phone: '09055556666',
  external_id: null,
  display_name: 'Shared Customer',
  created_at: '2026-06-13T08:00:00.000',
  updated_at: '2026-06-13T08:00:00.000',
};

const friends: FriendRow[] = [
  {
    id: 'friend-visible',
    user_id: 'user-visible',
    line_user_id: 'U-visible',
    display_name: 'Visible Friend',
    is_following: 1,
    created_at: '2026-06-13T10:00:00.000',
    updated_at: '2026-06-13T10:00:00.000',
  },
  {
    id: 'friend-hidden',
    user_id: 'user-hidden',
    line_user_id: 'U-hidden',
    display_name: 'Hidden Friend',
    is_following: 1,
    created_at: '2026-06-13T09:00:00.000',
    updated_at: '2026-06-13T09:00:00.000',
  },
  {
    id: 'friend-shared-visible',
    user_id: 'user-shared',
    line_user_id: 'U-shared-visible',
    display_name: 'Shared Visible',
    is_following: 1,
    created_at: '2026-06-13T08:00:00.000',
    updated_at: '2026-06-13T08:00:00.000',
  },
  {
    id: 'friend-shared-hidden',
    user_id: 'user-shared',
    line_user_id: 'U-shared-hidden',
    display_name: 'Shared Hidden',
    is_following: 1,
    created_at: '2026-06-13T07:00:00.000',
    updated_at: '2026-06-13T07:00:00.000',
  },
];

function makeDb(state: {
  visibleFriendIds?: string[];
  users?: UserRow[];
  friends?: FriendRow[];
} = {}) {
  const visibleFriendIds = new Set(state.visibleFriendIds ?? []);
  const userRows = state.users ?? [userVisible, userHidden, userShared];
  const friendRows = state.friends ?? friends;
  const calls: DbCall[] = [];

  function isScoped(sql: string): boolean {
    return sql.includes('sc_friend_scope.friend_id = f.id');
  }

  function isUserVisible(userId: string): boolean {
    return friendRows.some((friend) => friend.user_id === userId && visibleFriendIds.has(friend.id));
  }

  function selectUsers(sql: string, bound: unknown[]): UserRow[] {
    let rows = [...userRows];
    if (sql.includes('WHERE u.id = ?')) {
      rows = rows.filter((user) => user.id === bound[0]);
    } else if (sql.includes('WHERE u.email = ?')) {
      rows = rows.filter((user) => user.email === bound[0]);
    } else if (sql.includes('WHERE u.phone = ?')) {
      rows = rows.filter((user) => user.phone === bound[0]);
    }

    if (isScoped(sql)) {
      rows = rows.filter((user) => isUserVisible(user.id));
    }

    return rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

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
          if (sql.startsWith('SELECT 1 AS ok WHERE')) {
            const [friendId] = bound as [string];
            return (visibleFriendIds.has(friendId) ? { ok: 1 } : null) as T | null;
          }
          if (sql.includes('SELECT DISTINCT u.*')) {
            return (selectUsers(sql, bound)[0] ?? null) as T | null;
          }
          return null as T | null;
        },
        async all<T>() {
          calls.push({ method: 'all', sql, binds: bound });
          if (sql.includes('SELECT DISTINCT u.*')) {
            return { results: selectUsers(sql, bound) as T[] };
          }
          if (sql.includes('FROM friends f') && sql.includes('WHERE f.user_id = ?')) {
            const [userId] = bound as [string];
            let rows = friendRows.filter((friend) => friend.user_id === userId);
            if (isScoped(sql)) {
              rows = rows.filter((friend) => visibleFriendIds.has(friend.id));
            }
            return {
              results: rows.map((friend) => ({
                id: friend.id,
                line_user_id: friend.line_user_id,
                display_name: friend.display_name,
                is_following: friend.is_following,
              })) as T[],
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
    c.env = { DB: db };
    await next();
  });
  app.route('/', users);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getUsers.mockResolvedValue([userVisible, userHidden, userShared]);
  dbMocks.getUserById.mockImplementation(async (_db: D1Database, id: string) =>
    [userVisible, userHidden, userShared].find((user) => user.id === id) ?? null,
  );
  dbMocks.getUserFriends.mockImplementation(async (_db: D1Database, userId: string) =>
    friends
      .filter((friend) => friend.user_id === userId)
      .map((friend) => ({
        id: friend.id,
        line_user_id: friend.line_user_id,
        display_name: friend.display_name,
        is_following: friend.is_following,
      })),
  );
  dbMocks.getUserByEmail.mockImplementation(async (_db: D1Database, email: string) =>
    [userVisible, userHidden, userShared].find((user) => user.email === email) ?? null,
  );
  dbMocks.getUserByPhone.mockImplementation(async (_db: D1Database, phone: string) =>
    [userVisible, userHidden, userShared].find((user) => user.phone === phone) ?? null,
  );
  dbMocks.createUser.mockResolvedValue(userVisible);
  dbMocks.updateUser.mockResolvedValue(userVisible);
  dbMocks.deleteUser.mockResolvedValue(undefined);
  dbMocks.linkFriendToUser.mockResolvedValue(undefined);
});

describe('users support visibility guards', () => {
  test('staff user list is scoped to support-visible friends', async () => {
    const db = makeDb({ visibleFriendIds: ['friend-visible', 'friend-shared-visible'] });

    const res = await setupApp(db, 'staff').request('/api/users');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((user) => user.id)).toEqual(['user-visible', 'user-shared']);
    const listCall = db.calls.find((call) => call.sql.includes('SELECT DISTINCT u.*'));
    expect(listCall?.sql).toContain('sc_friend_scope.friend_id = f.id');
  });

  test('staff cannot read a hidden user by id', async () => {
    const db = makeDb({ visibleFriendIds: ['friend-visible'] });

    const res = await setupApp(db, 'staff').request('/api/users/user-hidden');

    expect(res.status).toBe(404);
  });

  test('staff linked accounts are scoped to visible friends only', async () => {
    const db = makeDb({ visibleFriendIds: ['friend-shared-visible'] });

    const res = await setupApp(db, 'staff').request('/api/users/user-shared/accounts');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string; lineUserId: string }> };
    expect(body.data).toEqual([
      {
        id: 'friend-shared-visible',
        lineUserId: 'U-shared-visible',
        displayName: 'Shared Visible',
        isFollowing: true,
      },
    ]);
    const accountsCall = db.calls.find((call) => call.sql.includes('FROM friends f'));
    expect(accountsCall?.sql).toContain('sc_friend_scope.friend_id = f.id');
  });

  test('staff cannot link a hidden friend to a visible user', async () => {
    const db = makeDb({ visibleFriendIds: ['friend-visible'] });

    const res = await setupApp(db, 'staff').request('/api/users/user-visible/link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ friendId: 'friend-hidden' }),
    });

    expect(res.status).toBe(404);
    expect(dbMocks.linkFriendToUser).not.toHaveBeenCalled();
  });

  test('staff cannot link a visible friend to a hidden target user', async () => {
    const db = makeDb({ visibleFriendIds: ['friend-visible'] });

    const res = await setupApp(db, 'staff').request('/api/users/user-hidden/link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ friendId: 'friend-visible' }),
    });

    expect(res.status).toBe(404);
    expect(dbMocks.linkFriendToUser).not.toHaveBeenCalled();
  });

  test('owner can link any friend using the existing global scope', async () => {
    const db = makeDb({ visibleFriendIds: [] });

    const res = await setupApp(db, 'owner').request('/api/users/user-hidden/link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ friendId: 'friend-hidden' }),
    });

    expect(res.status).toBe(200);
    expect(dbMocks.getUserById).toHaveBeenCalledWith(db, 'user-hidden');
    expect(dbMocks.linkFriendToUser).toHaveBeenCalledWith(db, 'friend-hidden', 'user-hidden');
  });

  test('staff match cannot find a hidden user by email', async () => {
    const db = makeDb({ visibleFriendIds: ['friend-visible'] });

    const res = await setupApp(db, 'staff').request('/api/users/match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'hidden@example.com' }),
    });

    expect(res.status).toBe(404);
  });

  test('staff cannot create, update, or delete global user records', async () => {
    const db = makeDb({ visibleFriendIds: ['friend-visible'] });
    const app = setupApp(db, 'staff');

    const createRes = await app.request('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'new@example.com' }),
    });
    const updateRes = await app.request('/api/users/user-visible', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Updated' }),
    });
    const deleteRes = await app.request('/api/users/user-visible', { method: 'DELETE' });

    expect(createRes.status).toBe(403);
    expect(updateRes.status).toBe(403);
    expect(deleteRes.status).toBe(403);
    expect(dbMocks.createUser).not.toHaveBeenCalled();
    expect(dbMocks.updateUser).not.toHaveBeenCalled();
    expect(dbMocks.deleteUser).not.toHaveBeenCalled();
  });
});

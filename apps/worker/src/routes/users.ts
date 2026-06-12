import { Hono } from 'hono';
import {
  getUsers,
  getUserById,
  createUser,
  updateUser,
  deleteUser,
  linkFriendToUser,
  getUserFriends,
  getUserByEmail,
  getUserByPhone,
} from '@line-crm/db';
import type { User as DbUser } from '@line-crm/db';
import type { Env } from '../index.js';
import { requireRole } from '../middleware/role-guard.js';
import {
  supportFriendVisibilitySql,
  type SupportAccessStaff,
} from '../services/support-access.js';
import { currentSupportStaff, ensureSupportFriendAccess } from './support-friend-access.js';

const users = new Hono<Env>();

type LinkedFriend = {
  id: string;
  line_user_id: string;
  display_name: string | null;
  is_following: number;
};

function serializeUser(row: DbUser) {
  return {
    id: row.id,
    email: row.email,
    phone: row.phone,
    externalId: row.external_id,
    displayName: row.display_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getScopedUsers(db: D1Database, staff: SupportAccessStaff): Promise<DbUser[]> {
  const visibility = supportFriendVisibilitySql(staff, 'f.id');
  if (!visibility.sql) return getUsers(db);

  const result = await db
    .prepare(
      `SELECT DISTINCT u.*
       FROM users u
       JOIN friends f ON f.user_id = u.id
       WHERE ${visibility.sql}
       ORDER BY u.created_at DESC`,
    )
    .bind(...visibility.binds)
    .all<DbUser>();
  return result.results ?? [];
}

async function getScopedUserById(
  db: D1Database,
  id: string,
  staff: SupportAccessStaff,
): Promise<DbUser | null> {
  const visibility = supportFriendVisibilitySql(staff, 'f.id');
  if (!visibility.sql) return getUserById(db, id);

  return db
    .prepare(
      `SELECT DISTINCT u.*
       FROM users u
       JOIN friends f ON f.user_id = u.id
       WHERE u.id = ? AND ${visibility.sql}
       LIMIT 1`,
    )
    .bind(id, ...visibility.binds)
    .first<DbUser>();
}

async function getScopedUserByEmail(
  db: D1Database,
  email: string,
  staff: SupportAccessStaff,
): Promise<DbUser | null> {
  const visibility = supportFriendVisibilitySql(staff, 'f.id');
  if (!visibility.sql) return getUserByEmail(db, email);

  return db
    .prepare(
      `SELECT DISTINCT u.*
       FROM users u
       JOIN friends f ON f.user_id = u.id
       WHERE u.email = ? AND ${visibility.sql}
       LIMIT 1`,
    )
    .bind(email, ...visibility.binds)
    .first<DbUser>();
}

async function getScopedUserByPhone(
  db: D1Database,
  phone: string,
  staff: SupportAccessStaff,
): Promise<DbUser | null> {
  const visibility = supportFriendVisibilitySql(staff, 'f.id');
  if (!visibility.sql) return getUserByPhone(db, phone);

  return db
    .prepare(
      `SELECT DISTINCT u.*
       FROM users u
       JOIN friends f ON f.user_id = u.id
       WHERE u.phone = ? AND ${visibility.sql}
       LIMIT 1`,
    )
    .bind(phone, ...visibility.binds)
    .first<DbUser>();
}

async function getScopedUserFriends(
  db: D1Database,
  userId: string,
  staff: SupportAccessStaff,
): Promise<LinkedFriend[]> {
  const visibility = supportFriendVisibilitySql(staff, 'f.id');
  if (!visibility.sql) return getUserFriends(db, userId);

  const result = await db
    .prepare(
      `SELECT f.id, f.line_user_id, f.display_name, f.is_following
       FROM friends f
       WHERE f.user_id = ? AND ${visibility.sql}
       ORDER BY f.updated_at DESC, f.created_at DESC`,
    )
    .bind(userId, ...visibility.binds)
    .all<LinkedFriend>();
  return result.results ?? [];
}

// GET /api/users - list all
users.get('/api/users', async (c) => {
  try {
    const items = await getScopedUsers(c.env.DB, currentSupportStaff(c));
    return c.json({ success: true, data: items.map(serializeUser) });
  } catch (err) {
    console.error('GET /api/users error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/users/:id - get single
users.get('/api/users/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const user = await getScopedUserById(c.env.DB, id, currentSupportStaff(c));
    if (!user) {
      return c.json({ success: false, error: 'User not found' }, 404);
    }
    return c.json({ success: true, data: serializeUser(user) });
  } catch (err) {
    console.error('GET /api/users/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/users - create
users.post('/api/users', requireRole('owner', 'admin'), async (c) => {
  try {
    const body = await c.req.json<{
      email?: string | null;
      phone?: string | null;
      externalId?: string | null;
      displayName?: string | null;
    }>();

    const user = await createUser(c.env.DB, body);
    return c.json({ success: true, data: serializeUser(user) }, 201);
  } catch (err) {
    console.error('POST /api/users error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PUT /api/users/:id - update
users.put('/api/users/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = c.req.param('id');
    if (!id) {
      return c.json({ success: false, error: 'User id is required' }, 400);
    }
    const body = await c.req.json<{
      email?: string | null;
      phone?: string | null;
      externalId?: string | null;
      displayName?: string | null;
    }>();

    const updated = await updateUser(c.env.DB, id, {
      email: body.email,
      phone: body.phone,
      external_id: body.externalId,
      display_name: body.displayName,
    });

    if (!updated) {
      return c.json({ success: false, error: 'User not found' }, 404);
    }
    return c.json({ success: true, data: serializeUser(updated) });
  } catch (err) {
    console.error('PUT /api/users/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/users/:id - delete
users.delete('/api/users/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = c.req.param('id');
    if (!id) {
      return c.json({ success: false, error: 'User id is required' }, 400);
    }
    await deleteUser(c.env.DB, id);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/users/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/users/:id/link - link friend to user UUID
users.post('/api/users/:id/link', async (c) => {
  try {
    const staff = currentSupportStaff(c);
    const userId = c.req.param('id');
    const body = await c.req.json<{ friendId: string }>();

    if (!body.friendId) {
      return c.json({ success: false, error: 'friendId is required' }, 400);
    }

    const user = await getScopedUserById(c.env.DB, userId, staff);
    if (!user) {
      return c.json({ success: false, error: 'User not found' }, 404);
    }

    const denied = await ensureSupportFriendAccess(c, body.friendId);
    if (denied) return denied;

    await linkFriendToUser(c.env.DB, body.friendId, userId);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('POST /api/users/:id/link error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/users/:id/accounts - get all linked friends/accounts
users.get('/api/users/:id/accounts', async (c) => {
  try {
    const staff = currentSupportStaff(c);
    const userId = c.req.param('id');
    const user = await getScopedUserById(c.env.DB, userId, staff);
    if (!user) {
      return c.json({ success: false, error: 'User not found' }, 404);
    }

    const friends = await getScopedUserFriends(c.env.DB, userId, staff);
    return c.json({
      success: true,
      data: friends.map((f) => ({
        id: f.id,
        lineUserId: f.line_user_id,
        displayName: f.display_name,
        isFollowing: Boolean(f.is_following),
      })),
    });
  } catch (err) {
    console.error('GET /api/users/:id/accounts error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/users/match - find user by email or phone
users.post('/api/users/match', async (c) => {
  try {
    const staff = currentSupportStaff(c);
    const body = await c.req.json<{ email?: string; phone?: string }>();
    let user = null;

    if (body.email) {
      user = await getScopedUserByEmail(c.env.DB, body.email, staff);
    }
    if (!user && body.phone) {
      user = await getScopedUserByPhone(c.env.DB, body.phone, staff);
    }

    if (!user) {
      return c.json({ success: false, error: 'User not found' }, 404);
    }
    return c.json({ success: true, data: serializeUser(user) });
  } catch (err) {
    console.error('POST /api/users/match error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { users };

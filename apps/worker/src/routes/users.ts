import { Hono, type Context } from 'hono';
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

const USER_VISIBLE_ID_MAX_LENGTH = 128;
const USER_TEXT_MAX_LENGTH = 128;
const USER_EMAIL_MAX_LENGTH = 254;
const USER_PHONE_MAX_LENGTH = 32;
const USER_VISIBLE_ASCII_PATTERN = /^[!-~]+$/;
const USER_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USER_PHONE_PATTERN = /^[0-9+()\-\s]+$/;

type ValueResult<T> = { ok: true; value: T } | { ok: false; error: string };
type UserCreateInput = {
  email?: string | null;
  phone?: string | null;
  externalId?: string | null;
  displayName?: string | null;
};
type UserUpdateInput = {
  email?: string | null;
  phone?: string | null;
  external_id?: string | null;
  display_name?: string | null;
};
type UserMatchInput = { email?: string; phone?: string };

function hasOwn(body: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key);
}

async function readJsonObject(c: Context<Env>): Promise<ValueResult<Record<string, unknown>>> {
  try {
    const body = await c.req.json<unknown>();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { ok: false, error: 'invalid_payload' };
    }
    return { ok: true, value: body as Record<string, unknown> };
  } catch {
    return { ok: false, error: 'invalid_json' };
  }
}

function parseVisibleString(raw: unknown, label: string): ValueResult<string> {
  if (typeof raw !== 'string') return { ok: false, error: `invalid_${label}` };
  const value = raw.trim();
  if (!value || value.length > USER_VISIBLE_ID_MAX_LENGTH || !USER_VISIBLE_ASCII_PATTERN.test(value)) {
    return { ok: false, error: `invalid_${label}` };
  }
  return { ok: true, value };
}

function parseOptionalVisibleString(raw: unknown, label: string): ValueResult<string | null | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: `invalid_${label}` };
  const value = raw.trim();
  if (!value) return { ok: true, value: null };
  const parsed = parseVisibleString(value, label);
  if (!parsed.ok) return parsed;
  return { ok: true, value: parsed.value };
}

function parseOptionalText(raw: unknown, error: string): ValueResult<string | null | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error };
  const value = raw.trim();
  if (!value) return { ok: true, value: null };
  if (value.length > USER_TEXT_MAX_LENGTH) return { ok: false, error };
  return { ok: true, value };
}

function parseOptionalEmail(raw: unknown): ValueResult<string | null | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: 'invalid_email' };
  const value = raw.trim();
  if (!value) return { ok: true, value: null };
  if (value.length > USER_EMAIL_MAX_LENGTH || !USER_EMAIL_PATTERN.test(value)) {
    return { ok: false, error: 'invalid_email' };
  }
  return { ok: true, value };
}

function parseOptionalPhone(raw: unknown): ValueResult<string | null | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: 'invalid_phone' };
  const value = raw.trim();
  if (!value) return { ok: true, value: null };
  if (value.length > USER_PHONE_MAX_LENGTH || !USER_PHONE_PATTERN.test(value)) {
    return { ok: false, error: 'invalid_phone' };
  }
  return { ok: true, value };
}

function hasMeaningfulValue(input: Record<string, unknown>): boolean {
  return Object.values(input).some((value) => value !== undefined && value !== null);
}

function parseUserCreateInput(body: Record<string, unknown>): ValueResult<UserCreateInput> {
  const email = parseOptionalEmail(body.email);
  if (!email.ok) return email;
  const phone = parseOptionalPhone(body.phone);
  if (!phone.ok) return phone;
  const externalId = parseOptionalVisibleString(body.externalId, 'external_id');
  if (!externalId.ok) return externalId;
  const displayName = parseOptionalText(body.displayName, 'invalid_display_name');
  if (!displayName.ok) return displayName;
  const input: UserCreateInput = {
    email: email.value,
    phone: phone.value,
    externalId: externalId.value,
    displayName: displayName.value,
  };
  if (!hasMeaningfulValue(input)) return { ok: false, error: 'invalid_payload' };
  return { ok: true, value: input };
}

function parseUserUpdateInput(body: Record<string, unknown>): ValueResult<UserUpdateInput> {
  const input: UserUpdateInput = {};
  if (hasOwn(body, 'email')) {
    const email = parseOptionalEmail(body.email);
    if (!email.ok) return email;
    input.email = email.value ?? null;
  }
  if (hasOwn(body, 'phone')) {
    const phone = parseOptionalPhone(body.phone);
    if (!phone.ok) return phone;
    input.phone = phone.value ?? null;
  }
  if (hasOwn(body, 'externalId')) {
    const externalId = parseOptionalVisibleString(body.externalId, 'external_id');
    if (!externalId.ok) return externalId;
    input.external_id = externalId.value ?? null;
  }
  if (hasOwn(body, 'displayName')) {
    const displayName = parseOptionalText(body.displayName, 'invalid_display_name');
    if (!displayName.ok) return displayName;
    input.display_name = displayName.value ?? null;
  }
  if (Object.keys(input).length === 0) return { ok: false, error: 'invalid_payload' };
  return { ok: true, value: input };
}

function parseUserMatchInput(body: Record<string, unknown>): ValueResult<UserMatchInput> {
  const email = parseOptionalEmail(body.email);
  if (!email.ok) return email;
  const phone = parseOptionalPhone(body.phone);
  if (!phone.ok) return phone;
  if (!email.value && !phone.value) return { ok: false, error: 'invalid_payload' };
  return {
    ok: true,
    value: {
      ...(email.value ? { email: email.value } : {}),
      ...(phone.value ? { phone: phone.value } : {}),
    },
  };
}

function usersRouteErrorKind(err: unknown): string {
  if (err instanceof TypeError) return 'network_error';
  if (err instanceof Error) return err.name || 'error';
  return typeof err;
}

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
    console.error(`GET /api/users error: ${usersRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/users/:id - get single
users.get('/api/users/:id', async (c) => {
  try {
    const id = parseVisibleString(c.req.param('id'), 'user_id');
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const user = await getScopedUserById(c.env.DB, id.value, currentSupportStaff(c));
    if (!user) {
      return c.json({ success: false, error: 'User not found' }, 404);
    }
    return c.json({ success: true, data: serializeUser(user) });
  } catch (err) {
    console.error(`GET /api/users/:id error: ${usersRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/users - create
users.post('/api/users', requireRole('owner', 'admin'), async (c) => {
  try {
    const rawBody = await readJsonObject(c);
    if (!rawBody.ok) return c.json({ success: false, error: rawBody.error }, 400);
    const body = parseUserCreateInput(rawBody.value);
    if (!body.ok) return c.json({ success: false, error: body.error }, 400);

    const user = await createUser(c.env.DB, body.value);
    return c.json({ success: true, data: serializeUser(user) }, 201);
  } catch (err) {
    console.error(`POST /api/users error: ${usersRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PUT /api/users/:id - update
users.put('/api/users/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = parseVisibleString(c.req.param('id'), 'user_id');
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const rawBody = await readJsonObject(c);
    if (!rawBody.ok) return c.json({ success: false, error: rawBody.error }, 400);
    const body = parseUserUpdateInput(rawBody.value);
    if (!body.ok) return c.json({ success: false, error: body.error }, 400);

    const updated = await updateUser(c.env.DB, id.value, body.value);

    if (!updated) {
      return c.json({ success: false, error: 'User not found' }, 404);
    }
    return c.json({ success: true, data: serializeUser(updated) });
  } catch (err) {
    console.error(`PUT /api/users/:id error: ${usersRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/users/:id - delete
users.delete('/api/users/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = parseVisibleString(c.req.param('id'), 'user_id');
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    await deleteUser(c.env.DB, id.value);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error(`DELETE /api/users/:id error: ${usersRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/users/:id/link - link friend to user UUID
users.post('/api/users/:id/link', async (c) => {
  try {
    const staff = currentSupportStaff(c);
    const userId = parseVisibleString(c.req.param('id'), 'user_id');
    if (!userId.ok) return c.json({ success: false, error: userId.error }, 400);
    const rawBody = await readJsonObject(c);
    if (!rawBody.ok) return c.json({ success: false, error: rawBody.error }, 400);
    const friendId = parseVisibleString(rawBody.value.friendId, 'friend_id');
    if (!friendId.ok) return c.json({ success: false, error: friendId.error }, 400);

    const user = await getScopedUserById(c.env.DB, userId.value, staff);
    if (!user) {
      return c.json({ success: false, error: 'User not found' }, 404);
    }

    const denied = await ensureSupportFriendAccess(c, friendId.value);
    if (denied) return denied;

    await linkFriendToUser(c.env.DB, friendId.value, userId.value);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error(`POST /api/users/:id/link error: ${usersRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/users/:id/accounts - get all linked friends/accounts
users.get('/api/users/:id/accounts', async (c) => {
  try {
    const staff = currentSupportStaff(c);
    const userId = parseVisibleString(c.req.param('id'), 'user_id');
    if (!userId.ok) return c.json({ success: false, error: userId.error }, 400);
    const user = await getScopedUserById(c.env.DB, userId.value, staff);
    if (!user) {
      return c.json({ success: false, error: 'User not found' }, 404);
    }

    const friends = await getScopedUserFriends(c.env.DB, userId.value, staff);
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
    console.error(`GET /api/users/:id/accounts error: ${usersRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/users/match - find user by email or phone
users.post('/api/users/match', async (c) => {
  try {
    const staff = currentSupportStaff(c);
    const rawBody = await readJsonObject(c);
    if (!rawBody.ok) return c.json({ success: false, error: rawBody.error }, 400);
    const body = parseUserMatchInput(rawBody.value);
    if (!body.ok) return c.json({ success: false, error: body.error }, 400);
    let user = null;

    if (body.value.email) {
      user = await getScopedUserByEmail(c.env.DB, body.value.email, staff);
    }
    if (!user && body.value.phone) {
      user = await getScopedUserByPhone(c.env.DB, body.value.phone, staff);
    }

    if (!user) {
      return c.json({ success: false, error: 'User not found' }, 404);
    }
    return c.json({ success: true, data: serializeUser(user) });
  } catch (err) {
    console.error(`POST /api/users/match error: ${usersRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { users };

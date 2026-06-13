import { Hono, type Context } from 'hono';
import {
  getStaffMembers,
  getStaffById,
  createStaffMember,
  updateStaffMember,
  deleteStaffMember,
  regenerateStaffApiKey,
  countActiveStaffByRole,
} from '@line-crm/db';
import type { StaffMember } from '@line-crm/db';
import { requireRole } from '../middleware/role-guard.js';
import type { Env } from '../index.js';

const staff = new Hono<Env>();

const STAFF_ID_MAX_LENGTH = 128;
const STAFF_NAME_MAX_LENGTH = 128;
const STAFF_EMAIL_MAX_LENGTH = 254;
const STAFF_VISIBLE_ASCII_PATTERN = /^[!-~]+$/;
const STAFF_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_STAFF_ROLES = ['owner', 'admin', 'staff'] as const;

type ValueResult<T> = { ok: true; value: T } | { ok: false; error: string };
type StaffRole = StaffMember['role'];
type StaffCreateInput = {
  name: string;
  email: string | null;
  role: StaffRole;
};
type StaffUpdateInput = {
  name?: string;
  email?: string | null;
  role?: StaffRole;
  isActive?: boolean;
};

function maskApiKey(key: string): string {
  return `lh_****${key.slice(-4)}`;
}

function serializeStaff(row: StaffMember, masked = true) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    apiKey: masked ? maskApiKey(row.api_key) : row.api_key,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

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

function parseStaffId(raw: unknown): ValueResult<string> {
  if (typeof raw !== 'string') return { ok: false, error: 'invalid_staff_id' };
  const value = raw.trim();
  if (!value || value.length > STAFF_ID_MAX_LENGTH || !STAFF_VISIBLE_ASCII_PATTERN.test(value)) {
    return { ok: false, error: 'invalid_staff_id' };
  }
  return { ok: true, value };
}

function parseStaffName(raw: unknown): ValueResult<string> {
  if (typeof raw !== 'string') return { ok: false, error: 'name is required' };
  const value = raw.trim();
  if (!value) return { ok: false, error: 'name is required' };
  if (value.length > STAFF_NAME_MAX_LENGTH) return { ok: false, error: 'invalid_name' };
  return { ok: true, value };
}

function parseOptionalStaffEmail(raw: unknown): ValueResult<string | null | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: 'invalid_email' };
  const value = raw.trim();
  if (!value) return { ok: true, value: null };
  if (value.length > STAFF_EMAIL_MAX_LENGTH || !STAFF_EMAIL_PATTERN.test(value)) {
    return { ok: false, error: 'invalid_email' };
  }
  return { ok: true, value };
}

function parseStaffRole(raw: unknown): ValueResult<StaffRole> {
  if (typeof raw !== 'string' || !VALID_STAFF_ROLES.includes(raw as StaffRole)) {
    return { ok: false, error: 'role must be owner, admin, or staff' };
  }
  return { ok: true, value: raw as StaffRole };
}

function parseOptionalBoolean(raw: unknown, label: string): ValueResult<boolean | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== 'boolean') return { ok: false, error: `invalid_${label}` };
  return { ok: true, value: raw };
}

function parseStaffCreateInput(body: Record<string, unknown>): ValueResult<StaffCreateInput> {
  const name = parseStaffName(body.name);
  if (!name.ok) return name;
  const email = parseOptionalStaffEmail(body.email);
  if (!email.ok) return email;
  const role = parseStaffRole(body.role);
  if (!role.ok) return role;
  return {
    ok: true,
    value: {
      name: name.value,
      email: email.value ?? null,
      role: role.value,
    },
  };
}

function parseStaffUpdateInput(body: Record<string, unknown>): ValueResult<StaffUpdateInput> {
  const input: StaffUpdateInput = {};

  if (hasOwn(body, 'name')) {
    const name = parseStaffName(body.name);
    if (!name.ok) return name;
    input.name = name.value;
  }
  if (hasOwn(body, 'email')) {
    const email = parseOptionalStaffEmail(body.email);
    if (!email.ok) return email;
    input.email = email.value ?? null;
  }
  if (hasOwn(body, 'role')) {
    const role = parseStaffRole(body.role);
    if (!role.ok) return role;
    input.role = role.value;
  }
  if (hasOwn(body, 'isActive')) {
    const isActive = parseOptionalBoolean(body.isActive, 'is_active');
    if (!isActive.ok) return isActive;
    input.isActive = isActive.value;
  }

  if (Object.keys(input).length === 0) return { ok: false, error: 'invalid_payload' };
  return { ok: true, value: input };
}

function staffRouteErrorKind(err: unknown): string {
  if (err instanceof TypeError) return 'network_error';
  if (err instanceof Error) return err.name || 'error';
  return typeof err;
}

// GET /api/staff/me — any authenticated user (MUST be before /:id)
staff.get('/api/staff/me', async (c) => {
  try {
    const currentStaff = c.get('staff');

    // env-owner: return minimal info
    if (currentStaff.id === 'env-owner') {
      return c.json({
        success: true,
        data: {
          id: 'env-owner',
          name: 'Owner',
          role: 'owner',
          email: null,
        },
      });
    }

    const member = await getStaffById(c.env.DB, currentStaff.id);
    if (!member) {
      return c.json({ success: false, error: 'Staff member not found' }, 404);
    }

    return c.json({
      success: true,
      data: {
        id: member.id,
        name: member.name,
        role: member.role,
        email: member.email,
      },
    });
  } catch (err) {
    console.error(`GET /api/staff/me error: ${staffRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/staff — owner only. List all staff with masked API keys.
staff.get('/api/staff', requireRole('owner'), async (c) => {
  try {
    const members = await getStaffMembers(c.env.DB);
    return c.json({ success: true, data: members.map((m) => serializeStaff(m, true)) });
  } catch (err) {
    console.error(`GET /api/staff error: ${staffRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/staff/:id — owner only. Get staff detail with masked key.
staff.get('/api/staff/:id', requireRole('owner'), async (c) => {
  try {
    const id = parseStaffId(c.req.param('id'));
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const member = await getStaffById(c.env.DB, id.value);
    if (!member) {
      return c.json({ success: false, error: 'Staff member not found' }, 404);
    }
    return c.json({ success: true, data: serializeStaff(member, true) });
  } catch (err) {
    console.error(`GET /api/staff/:id error: ${staffRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/staff — owner only. Create staff. Returns full API key (one-time visible).
staff.post('/api/staff', requireRole('owner'), async (c) => {
  try {
    const rawBody = await readJsonObject(c);
    if (!rawBody.ok) return c.json({ success: false, error: rawBody.error }, 400);
    const body = parseStaffCreateInput(rawBody.value);
    if (!body.ok) return c.json({ success: false, error: body.error }, 400);

    const member = await createStaffMember(c.env.DB, {
      name: body.value.name,
      email: body.value.email,
      role: body.value.role,
    });

    // Return full (unmasked) API key one-time
    return c.json({ success: true, data: serializeStaff(member, false) }, 201);
  } catch (err) {
    console.error(`POST /api/staff error: ${staffRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PATCH /api/staff/:id — owner only. Update staff.
staff.patch('/api/staff/:id', requireRole('owner'), async (c) => {
  try {
    const id = parseStaffId(c.req.param('id'));
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const rawBody = await readJsonObject(c);
    if (!rawBody.ok) return c.json({ success: false, error: rawBody.error }, 400);
    const body = parseStaffUpdateInput(rawBody.value);
    if (!body.ok) return c.json({ success: false, error: body.error }, 400);

    // Prevent removing the last active owner
    const target = await getStaffById(c.env.DB, id.value);
    if (!target) {
      return c.json({ success: false, error: 'Staff member not found' }, 404);
    }
    if (target.role === 'owner' && target.is_active === 1) {
      const willLoseOwner =
        (body.value.role !== undefined && body.value.role !== 'owner') ||
        body.value.isActive === false;
      if (willLoseOwner) {
        const ownerCount = await countActiveStaffByRole(c.env.DB, 'owner');
        if (ownerCount <= 1) {
          return c.json({ success: false, error: 'オーナーは最低1人必要です' }, 400);
        }
      }
    }

    const updated = await updateStaffMember(c.env.DB, id.value, {
      name: body.value.name,
      email: body.value.email,
      role: body.value.role,
      is_active: body.value.isActive !== undefined ? (body.value.isActive ? 1 : 0) : undefined,
    });

    if (!updated) {
      return c.json({ success: false, error: 'Staff member not found' }, 404);
    }

    return c.json({ success: true, data: serializeStaff(updated, true) });
  } catch (err) {
    console.error(`PATCH /api/staff/:id error: ${staffRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/staff/:id — owner only. Cannot delete self. Must keep at least 1 owner.
staff.delete('/api/staff/:id', requireRole('owner'), async (c) => {
  try {
    const id = parseStaffId(c.req.param('id'));
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const currentStaff = c.get('staff');

    if (id.value === currentStaff.id) {
      return c.json({ success: false, error: '自分自身は削除できません' }, 400);
    }

    const target = await getStaffById(c.env.DB, id.value);
    if (!target) {
      return c.json({ success: false, error: 'Staff member not found' }, 404);
    }

    if (target.role === 'owner' && target.is_active === 1) {
      const ownerCount = await countActiveStaffByRole(c.env.DB, 'owner');
      if (ownerCount <= 1) {
        return c.json({ success: false, error: 'オーナーは最低1人必要です' }, 400);
      }
    }

    await deleteStaffMember(c.env.DB, id.value);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error(`DELETE /api/staff/:id error: ${staffRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/staff/:id/regenerate-key — owner only. Return new API key.
staff.post('/api/staff/:id/regenerate-key', requireRole('owner'), async (c) => {
  try {
    const id = parseStaffId(c.req.param('id'));
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const exists = await getStaffById(c.env.DB, id.value);
    if (!exists) {
      return c.json({ success: false, error: 'Staff member not found' }, 404);
    }
    const newKey = await regenerateStaffApiKey(c.env.DB, id.value);
    return c.json({ success: true, data: { apiKey: newKey } });
  } catch (err) {
    console.error(`POST /api/staff/:id/regenerate-key error: ${staffRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { staff };

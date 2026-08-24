import { Hono, type Context } from 'hono';
import {
  getStaffMembers,
  getStaffById,
  createStaffMember,
  updateStaffMember,
  deleteStaffMember,
  regenerateStaffApiKey,
  countActiveStaffByRole,
  jstNow,
} from '@line-crm/db';
import type { StaffMember } from '@line-crm/db';
import { requireRole } from '../middleware/role-guard.js';
import { ENV_OWNER_DISPLAY_NAME } from '../services/owner-display.js';
import type { Env } from '../index.js';

const staff = new Hono<Env>();

const STAFF_ID_MAX_LENGTH = 128;
const STAFF_NAME_MAX_LENGTH = 128;
const STAFF_EMAIL_MAX_LENGTH = 254;
const STAFF_USER_AGENT_MAX_LENGTH = 512;
const STAFF_ONLINE_WINDOW_MS = 5 * 60_000;
const STAFF_TICKET_SHARE_MAX = 20;
const ENV_OWNER_ID = 'env-owner';
const STAFF_VISIBLE_ASCII_PATTERN = /^[!-~]+$/;
const STAFF_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_STAFF_ROLES = ['owner', 'admin', 'staff', 'secondary'] as const;

type ValueResult<T> = { ok: true; value: T } | { ok: false; error: string };
type StaffRole = StaffMember['role'];
type StaffCreateInput = {
  name: string;
  email: string | null;
  role: StaffRole;
  secondaryCanRespond: boolean;
};
type StaffUpdateInput = {
  name?: string;
  email?: string | null;
  role?: StaffRole;
  secondaryCanRespond?: boolean;
  isActive?: boolean;
};
type StaffPresenceRow = {
  id: string;
  name: string;
  role: StaffRole;
  is_active: number;
  last_seen_at: string | null;
  last_login_at: string | null;
  user_agent: string | null;
  updated_at: string | null;
};

function maskApiKey(key: string): string {
  return `lh_****${key.slice(-4)}`;
}

function serializeStaff(row: StaffMember, masked = true, ticketShareStaffIds: string[] = []) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    secondaryCanRespond: Boolean(row.secondary_can_respond),
    apiKey: masked ? maskApiKey(row.api_key) : row.api_key,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ticketShareStaffIds,
  };
}

function isEnvironmentOwnerId(id: string): boolean {
  return id === ENV_OWNER_ID;
}

function parsePresenceSessionStarted(body: Record<string, unknown> | null): boolean {
  return body?.sessionStarted === true;
}

function serializeStaffPresence(row: StaffPresenceRow, nowMs = Date.now()) {
  const seenMs = row.last_seen_at ? new Date(row.last_seen_at).getTime() : Number.NaN;
  const isOnline = Number.isFinite(seenMs) && nowMs - seenMs <= STAFF_ONLINE_WINDOW_MS;
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    isActive: Boolean(row.is_active),
    isOnline,
    lastSeenAt: row.last_seen_at,
    lastLoginAt: row.last_login_at,
    userAgent: row.user_agent,
    updatedAt: row.updated_at,
  };
}

function requestUserAgent(c: Context<Env>): string | null {
  const value = c.req.header('User-Agent')?.trim();
  if (!value) return null;
  return value.slice(0, STAFF_USER_AGENT_MAX_LENGTH);
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
    return { ok: false, error: 'role must be owner, admin, staff, or secondary' };
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
      secondaryCanRespond: body.secondaryCanRespond === true,
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
  if (hasOwn(body, 'secondaryCanRespond')) {
    const secondaryCanRespond = parseOptionalBoolean(body.secondaryCanRespond, 'secondary_can_respond');
    if (!secondaryCanRespond.ok) return secondaryCanRespond;
    input.secondaryCanRespond = secondaryCanRespond.value;
  }

  if (Object.keys(input).length === 0) return { ok: false, error: 'invalid_payload' };
  return { ok: true, value: input };
}

function parseTicketShareStaffIds(raw: unknown): ValueResult<string[]> {
  if (!Array.isArray(raw) || raw.length > STAFF_TICKET_SHARE_MAX) {
    return { ok: false, error: 'invalid_ticket_share_staff_ids' };
  }
  const parsed: string[] = [];
  for (const item of raw) {
    const id = parseStaffId(item);
    if (!id.ok) return id;
    parsed.push(id.value);
  }
  return { ok: true, value: Array.from(new Set(parsed)) };
}

function staffRouteErrorKind(err: unknown): string {
  if (err instanceof TypeError) return 'network_error';
  if (err instanceof Error) return err.name || 'error';
  return typeof err;
}

function isLastActiveOwnerError(err: unknown): boolean {
  return err instanceof Error && err.name === 'LastActiveOwnerError';
}

// GET /api/staff/me — any authenticated user (MUST be before /:id)
staff.get('/api/staff/me', async (c) => {
  try {
    const currentStaff = c.get('staff');

    // env-owner: return minimal info
    if (isEnvironmentOwnerId(currentStaff.id)) {
      return c.json({
        success: true,
        data: {
          id: ENV_OWNER_ID,
          name: ENV_OWNER_DISPLAY_NAME,
          role: 'owner',
          secondaryCanRespond: true,
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
        secondaryCanRespond: Boolean(member.secondary_can_respond),
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
    const members = (await getStaffMembers(c.env.DB))
      .filter((member) => !isEnvironmentOwnerId(member.id));
    const shareRows = await c.env.DB
      .prepare('SELECT staff_a_id, staff_b_id FROM staff_ticket_shares WHERE removed_at IS NULL')
      .all<{ staff_a_id: string; staff_b_id: string }>();
    const sharesByStaff = new Map<string, string[]>();
    for (const row of shareRows.results) {
      sharesByStaff.set(row.staff_a_id, [...(sharesByStaff.get(row.staff_a_id) ?? []), row.staff_b_id]);
      sharesByStaff.set(row.staff_b_id, [...(sharesByStaff.get(row.staff_b_id) ?? []), row.staff_a_id]);
    }
    return c.json({
      success: true,
      data: members.map((member) => serializeStaff(member, true, sharesByStaff.get(member.id) ?? [])),
    });
  } catch (err) {
    console.error(`GET /api/staff error: ${staffRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PUT /api/staff/:id/ticket-shares — owner only. Configure mutual primary-support coverage.
staff.put('/api/staff/:id/ticket-shares', requireRole('owner'), async (c) => {
  try {
    const id = parseStaffId(c.req.param('id'));
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    if (isEnvironmentOwnerId(id.value)) {
      return c.json({ success: false, error: 'Staff member not found' }, 404);
    }
    const rawBody = await readJsonObject(c);
    if (!rawBody.ok) return c.json({ success: false, error: rawBody.error }, 400);
    const peerStaffIds = parseTicketShareStaffIds(rawBody.value.peerStaffIds);
    if (!peerStaffIds.ok) return c.json({ success: false, error: peerStaffIds.error }, 400);
    if (peerStaffIds.value.includes(id.value)) {
      return c.json({ success: false, error: '自分自身は共有相手に指定できません' }, 400);
    }

    const members = await getStaffMembers(c.env.DB);
    const activePrimaryStaffIds = new Set(
      members
        .filter((member) => member.role === 'staff' && Boolean(member.is_active))
        .map((member) => member.id),
    );
    if (!activePrimaryStaffIds.has(id.value)) {
      return c.json({ success: false, error: '一次対応かつ有効なスタッフだけ設定できます' }, 400);
    }
    if (peerStaffIds.value.some((peerId) => !activePrimaryStaffIds.has(peerId))) {
      return c.json({ success: false, error: '共有相手は一次対応かつ有効なスタッフから選んでください' }, 400);
    }

    const actor = c.get('staff');
    const createdBy = isEnvironmentOwnerId(actor.id) ? null : actor.id;
    const currentRows = await c.env.DB
      .prepare(
        `SELECT staff_a_id, staff_b_id
         FROM staff_ticket_shares
         WHERE removed_at IS NULL AND (staff_a_id = ? OR staff_b_id = ?)`,
      )
      .bind(id.value, id.value)
      .all<{ staff_a_id: string; staff_b_id: string }>();
    const currentPeers = new Set(currentRows.results.map((row) => (
      row.staff_a_id === id.value ? row.staff_b_id : row.staff_a_id
    )));
    const desiredPeers = new Set(peerStaffIds.value);
    const now = jstNow();
    const statements: D1PreparedStatement[] = [];

    for (const peerId of currentPeers) {
      if (desiredPeers.has(peerId)) continue;
      const [staffAId, staffBId] = [id.value, peerId].sort();
      statements.push(
        c.env.DB
          .prepare(
            `UPDATE staff_ticket_shares
             SET removed_at = ?
             WHERE staff_a_id = ? AND staff_b_id = ? AND removed_at IS NULL`,
          )
          .bind(now, staffAId, staffBId),
        c.env.DB
          .prepare(
            `INSERT INTO staff_ticket_share_events (
               id, staff_a_id, staff_b_id, action, actor_id, actor_name, created_at
             ) VALUES (?, ?, ?, 'revoked', ?, ?, ?)`,
          )
          .bind(crypto.randomUUID(), staffAId, staffBId, createdBy, actor.name, now),
      );
    }

    for (const peerId of desiredPeers) {
      if (currentPeers.has(peerId)) continue;
      const [staffAId, staffBId] = [id.value, peerId].sort();
      statements.push(
        c.env.DB
          .prepare(
            `INSERT INTO staff_ticket_shares (staff_a_id, staff_b_id, created_by, removed_at)
             VALUES (?, ?, ?, NULL)
             ON CONFLICT(staff_a_id, staff_b_id) DO UPDATE SET
               removed_at = NULL,
               created_by = excluded.created_by`,
          )
          .bind(staffAId, staffBId, createdBy),
        c.env.DB
          .prepare(
            `INSERT INTO staff_ticket_share_events (
               id, staff_a_id, staff_b_id, action, actor_id, actor_name, created_at
             ) VALUES (?, ?, ?, 'granted', ?, ?, ?)`,
          )
          .bind(crypto.randomUUID(), staffAId, staffBId, createdBy, actor.name, now),
      );
    }
    if (statements.length > 0) await c.env.DB.batch(statements);
    return c.json({ success: true, data: { staffId: id.value, peerStaffIds: peerStaffIds.value } });
  } catch (err) {
    console.error(`PUT /api/staff/:id/ticket-shares error: ${staffRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/staff/assignee-options — authenticated users can see active names
// for assignment selectors, without exposing API keys or emails.
staff.get('/api/staff/assignee-options', async (c) => {
  try {
    const members = (await getStaffMembers(c.env.DB))
      .filter((member) => !isEnvironmentOwnerId(member.id));
    return c.json({
      success: true,
      data: members
        .filter((m) => Boolean(m.is_active))
        .map((m) => ({
          id: m.id,
          name: m.name,
          role: m.role,
          secondaryCanRespond: Boolean(m.secondary_can_respond),
          isActive: Boolean(m.is_active),
        })),
    });
  } catch (err) {
    console.error(`GET /api/staff/assignee-options error: ${staffRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/staff/presence — authenticated users can see who currently has L-Link open.
staff.get('/api/staff/presence', async (c) => {
  try {
    const rows = await c.env.DB
      .prepare(
        `WITH visible_staff AS (
           SELECT id, name, role, is_active, created_at
           FROM staff_members
           WHERE is_active = 1
             AND id != 'env-owner'
           UNION ALL
           SELECT 'env-owner' AS id, ? AS name, 'owner' AS role, 1 AS is_active, '9999-12-31T23:59:59+09:00' AS created_at
         )
         SELECT
           vs.id,
           vs.name,
           vs.role,
           vs.is_active,
           sp.last_seen_at,
           sp.last_login_at,
           sp.user_agent,
           sp.updated_at
         FROM visible_staff vs
         LEFT JOIN staff_presence sp ON sp.staff_id = vs.id
         ORDER BY
           CASE vs.role
             WHEN 'owner' THEN 0
             WHEN 'admin' THEN 1
             WHEN 'staff' THEN 2
             WHEN 'secondary' THEN 3
             ELSE 4
           END,
           vs.created_at ASC`,
      )
      .bind(ENV_OWNER_DISPLAY_NAME)
      .all<StaffPresenceRow>();
    const nowMs = Date.now();
    const items = rows.results.map((row) => serializeStaffPresence(row, nowMs));
    return c.json({
      success: true,
      data: {
        onlineWindowSeconds: Math.floor(STAFF_ONLINE_WINDOW_MS / 1000),
        onlineCount: items.filter((item) => item.isOnline).length,
        items,
      },
    });
  } catch (err) {
    console.error(`GET /api/staff/presence error: ${staffRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/staff/presence/heartbeat — called by the browser while L-Link is open.
staff.post('/api/staff/presence/heartbeat', async (c) => {
  try {
    let body: Record<string, unknown> | null = null;
    try {
      const raw = await c.req.json<unknown>();
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        body = raw as Record<string, unknown>;
      }
    } catch {
      body = null;
    }

    const currentStaff = c.get('staff');
    const now = jstNow();
    const sessionStarted = parsePresenceSessionStarted(body);
    await c.env.DB
      .prepare(
        `INSERT INTO staff_presence (
           staff_id,
           staff_name,
           staff_role,
           last_seen_at,
           last_login_at,
           user_agent,
           updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(staff_id) DO UPDATE SET
           staff_name = excluded.staff_name,
           staff_role = excluded.staff_role,
           last_seen_at = excluded.last_seen_at,
           last_login_at = CASE
             WHEN ? = 1 OR staff_presence.last_login_at IS NULL THEN excluded.last_login_at
             ELSE staff_presence.last_login_at
           END,
           user_agent = excluded.user_agent,
           updated_at = excluded.updated_at`,
      )
      .bind(
        currentStaff.id,
        currentStaff.name,
        currentStaff.role,
        now,
        now,
        requestUserAgent(c),
        now,
        sessionStarted ? 1 : 0,
      )
      .run();

    const row = await c.env.DB
      .prepare(
        `SELECT
           sm.id,
           sm.name,
           sm.role,
           sm.is_active,
           sp.last_seen_at,
           sp.last_login_at,
           sp.user_agent,
           sp.updated_at
         FROM (
           SELECT id, name, role, is_active
           FROM staff_members
           WHERE id = ? AND id != 'env-owner'
           UNION ALL
           SELECT 'env-owner' AS id, ? AS name, 'owner' AS role, 1 AS is_active
           WHERE ? = 'env-owner'
         ) sm
         LEFT JOIN staff_presence sp ON sp.staff_id = sm.id
         LIMIT 1`,
      )
      .bind(currentStaff.id, ENV_OWNER_DISPLAY_NAME, currentStaff.id)
      .first<StaffPresenceRow>();

    return c.json({ success: true, data: row ? serializeStaffPresence(row) : null });
  } catch (err) {
    console.error(`POST /api/staff/presence/heartbeat error: ${staffRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/staff/:id — owner only. Get staff detail with masked key.
staff.get('/api/staff/:id', requireRole('owner'), async (c) => {
  try {
    const id = parseStaffId(c.req.param('id'));
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    if (isEnvironmentOwnerId(id.value)) {
      return c.json({ success: false, error: 'Staff member not found' }, 404);
    }
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

    const secondaryCanRespond = body.value.role === 'secondary' && body.value.secondaryCanRespond;
    const actor = c.get('staff');
    const member = await createStaffMember(c.env.DB, {
      name: body.value.name,
      email: body.value.email,
      role: body.value.role,
      secondary_can_respond: secondaryCanRespond ? 1 : 0,
    }, {
      action: 'created',
      metadata: {
        role: body.value.role,
        secondaryCanRespond,
      },
      actorId: isEnvironmentOwnerId(actor.id) ? null : actor.id,
      actorName: actor.name,
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
    if (isEnvironmentOwnerId(id.value)) {
      return c.json({ success: false, error: 'Staff member not found' }, 404);
    }
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

    const updateInput = {
      name: body.value.name,
      email: body.value.email,
      role: body.value.role,
      secondary_can_respond: body.value.role !== undefined && body.value.role !== 'secondary'
        ? 0
        : body.value.secondaryCanRespond !== undefined
          ? (body.value.secondaryCanRespond ? 1 : 0)
          : undefined,
      is_active: body.value.isActive !== undefined ? (body.value.isActive ? 1 : 0) : undefined,
    };
    const nextRole = updateInput.role ?? target.role;
    const nextIsActive = updateInput.is_active ?? target.is_active;
    const nextSecondaryCanRespond = updateInput.secondary_can_respond ?? target.secondary_can_respond;
    const actor = c.get('staff');
    const action = target.is_active !== nextIsActive
      ? (nextIsActive === 1 ? 'enabled' : 'disabled')
      : 'updated';
    let updated: StaffMember | null;
    try {
      updated = await updateStaffMember(c.env.DB, id.value, updateInput, {
        action,
        metadata: {
          before: {
            role: target.role,
            isActive: Boolean(target.is_active),
            secondaryCanRespond: Boolean(target.secondary_can_respond),
          },
          after: {
            role: nextRole,
            isActive: Boolean(nextIsActive),
            secondaryCanRespond: Boolean(nextSecondaryCanRespond),
          },
        },
        actorId: isEnvironmentOwnerId(actor.id) ? null : actor.id,
        actorName: actor.name,
      });
    } catch (err) {
      if (isLastActiveOwnerError(err)) {
        return c.json({ success: false, error: 'オーナー情報が同時に更新されました。再読み込みしてください' }, 409);
      }
      throw err;
    }

    if (!updated) {
      return c.json({ success: false, error: 'Staff member not found' }, 404);
    }

    return c.json({ success: true, data: serializeStaff(updated, true) });
  } catch (err) {
    console.error(`PATCH /api/staff/:id error: ${staffRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/staff/:id — legacy-compatible endpoint. It only disables the
// member so task assignments, ticket shares, and audit history remain intact.
staff.delete('/api/staff/:id', requireRole('owner'), async (c) => {
  try {
    const id = parseStaffId(c.req.param('id'));
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    if (isEnvironmentOwnerId(id.value)) {
      return c.json({ success: false, error: 'Staff member not found' }, 404);
    }
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

    try {
      await deleteStaffMember(c.env.DB, id.value, {
        action: 'disabled',
        metadata: { reason: 'legacy_delete_endpoint' },
        actorId: isEnvironmentOwnerId(currentStaff.id) ? null : currentStaff.id,
        actorName: currentStaff.name,
      });
    } catch (err) {
      if (isLastActiveOwnerError(err)) {
        return c.json({ success: false, error: 'オーナー情報が同時に更新されました。再読み込みしてください' }, 409);
      }
      throw err;
    }
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
    if (isEnvironmentOwnerId(id.value)) {
      return c.json({ success: false, error: 'Staff member not found' }, 404);
    }
    const exists = await getStaffById(c.env.DB, id.value);
    if (!exists) {
      return c.json({ success: false, error: 'Staff member not found' }, 404);
    }
    const actor = c.get('staff');
    const newKey = await regenerateStaffApiKey(c.env.DB, id.value, {
      action: 'api_key_regenerated',
      actorId: isEnvironmentOwnerId(actor.id) ? null : actor.id,
      actorName: actor.name,
    });
    return c.json({ success: true, data: { apiKey: newKey } });
  } catch (err) {
    console.error(`POST /api/staff/:id/regenerate-key error: ${staffRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { staff };

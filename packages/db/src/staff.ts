import { jstNow } from './utils.js';

export type StaffRole = 'owner' | 'admin' | 'staff' | 'secondary';

export interface StaffMember {
  id: string;
  name: string;
  email: string | null;
  role: StaffRole;
  secondary_can_respond: number;
  sales_only: number;
  api_key: string;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface CreateStaffInput {
  name: string;
  email?: string | null;
  role: StaffRole;
  secondary_can_respond?: number;
  sales_only?: number;
}

export interface UpdateStaffInput {
  name?: string;
  email?: string | null;
  role?: StaffRole;
  secondary_can_respond?: number;
  sales_only?: number;
  is_active?: number;
}

export type StaffMemberEventAction =
  | 'created'
  | 'updated'
  | 'disabled'
  | 'enabled'
  | 'api_key_regenerated';

export interface StaffMemberEventInput<
  Action extends StaffMemberEventAction = StaffMemberEventAction,
> {
  staffId: string;
  action: Action;
  metadata?: Record<string, unknown>;
  actorId?: string | null;
  actorName?: string | null;
}

export type StaffMemberMutationEventInput<
  Action extends StaffMemberEventAction = StaffMemberEventAction,
> = Omit<StaffMemberEventInput<Action>, 'staffId'>;

export class LastActiveOwnerError extends Error {
  constructor() {
    super('At least one active owner is required');
    this.name = 'LastActiveOwnerError';
  }
}

function generateApiKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return `lh_${hex}`;
}

export async function getStaffByApiKey(
  db: D1Database,
  apiKey: string,
): Promise<StaffMember | null> {
  return db
    .prepare('SELECT * FROM staff_members WHERE api_key = ? AND is_active = 1')
    .bind(apiKey)
    .first<StaffMember>();
}

export async function getStaffMembers(db: D1Database): Promise<StaffMember[]> {
  const result = await db
    .prepare('SELECT * FROM staff_members ORDER BY created_at ASC')
    .all<StaffMember>();
  return result.results;
}

export async function getStaffById(
  db: D1Database,
  id: string,
): Promise<StaffMember | null> {
  return db
    .prepare('SELECT * FROM staff_members WHERE id = ?')
    .bind(id)
    .first<StaffMember>();
}

export async function createStaffMember(
  db: D1Database,
  input: CreateStaffInput,
  event: StaffMemberMutationEventInput<'created'>,
): Promise<StaffMember> {
  const id = crypto.randomUUID();
  const now = jstNow();
  const apiKey = generateApiKey();

  await db.batch([
    db.prepare(
      `INSERT INTO staff_members (
         id, name, email, role, secondary_can_respond, sales_only, api_key, is_active, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).bind(
      id,
      input.name,
      input.email ?? null,
      input.role,
      input.role === 'secondary' ? (input.secondary_can_respond ?? 0) : 0,
      input.role === 'staff' ? (input.sales_only ?? 0) : 0,
      apiKey,
      now,
      now,
    ),
    prepareStaffMemberEvent(db, { ...event, staffId: id }),
  ]);

  return (await db
    .prepare('SELECT * FROM staff_members WHERE id = ?')
    .bind(id)
    .first<StaffMember>())!;
}

export async function updateStaffMember(
  db: D1Database,
  id: string,
  input: UpdateStaffInput,
  event: StaffMemberMutationEventInput<'updated' | 'disabled' | 'enabled'>,
): Promise<StaffMember | null> {
  const now = jstNow();
  const sets: string[] = ['updated_at = ?'];
  const values: (string | number | null)[] = [now];

  if (input.name !== undefined) { sets.push('name = ?'); values.push(input.name); }
  if (input.email !== undefined) { sets.push('email = ?'); values.push(input.email ?? null); }
  if (input.role !== undefined) { sets.push('role = ?'); values.push(input.role); }
  if (input.secondary_can_respond !== undefined) {
    sets.push('secondary_can_respond = ?');
    values.push(input.secondary_can_respond);
  }
  if (input.sales_only !== undefined) {
    sets.push('sales_only = ?');
    values.push(input.sales_only);
  }
  if (input.is_active !== undefined) { sets.push('is_active = ?'); values.push(input.is_active); }

  const protectsLastActiveOwner = (
    (input.role !== undefined && input.role !== 'owner')
    || input.is_active === 0
  );
  values.push(id);
  const ownerGuard = protectsLastActiveOwner
    ? ` AND (
        role != 'owner'
        OR is_active != 1
        OR EXISTS (
          SELECT 1 FROM staff_members other_owner
          WHERE other_owner.id != staff_members.id
            AND other_owner.role = 'owner'
            AND other_owner.is_active = 1
        )
      )`
    : '';
  const [mutationResult] = await db.batch([
    db.prepare(`UPDATE staff_members SET ${sets.join(', ')} WHERE id = ?${ownerGuard}`)
      .bind(...values),
    prepareStaffMemberEvent(
      db,
      { ...event, staffId: id },
      protectsLastActiveOwner
        ? `EXISTS (
            SELECT 1 FROM staff_members changed_staff
            WHERE changed_staff.id = ?
              AND (changed_staff.role != 'owner' OR changed_staff.is_active != 1)
          )`
        : undefined,
      protectsLastActiveOwner ? [id] : [],
    ),
  ]);
  if (protectsLastActiveOwner && mutationResult.meta.changes === 0) {
    throw new LastActiveOwnerError();
  }

  return db.prepare('SELECT * FROM staff_members WHERE id = ?').bind(id).first<StaffMember>();
}

export async function deleteStaffMember(
  db: D1Database,
  id: string,
  event: StaffMemberMutationEventInput<'disabled'>,
): Promise<void> {
  const [mutationResult] = await db.batch([
    db.prepare(
      `UPDATE staff_members
       SET is_active = 0, updated_at = ?
       WHERE id = ?
         AND (
           role != 'owner'
           OR is_active != 1
           OR EXISTS (
             SELECT 1 FROM staff_members other_owner
             WHERE other_owner.id != staff_members.id
               AND other_owner.role = 'owner'
               AND other_owner.is_active = 1
           )
         )`,
    )
      .bind(jstNow(), id),
    prepareStaffMemberEvent(
      db,
      { ...event, staffId: id },
      `EXISTS (
        SELECT 1 FROM staff_members changed_staff
        WHERE changed_staff.id = ? AND changed_staff.is_active = 0
      )`,
      [id],
    ),
  ]);
  if (mutationResult.meta.changes === 0) throw new LastActiveOwnerError();
}

function prepareStaffMemberEvent(
  db: D1Database,
  input: StaffMemberEventInput,
  conditionSql?: string,
  conditionBinds: unknown[] = [],
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO staff_member_events (id, staff_id, action, metadata, actor_id, actor_name)
     SELECT ?, ?, ?, ?, ?, ?
     ${conditionSql ? `WHERE ${conditionSql}` : ''}`,
  )
    .bind(
      crypto.randomUUID(),
      input.staffId,
      input.action,
      JSON.stringify(input.metadata ?? {}),
      input.actorId ?? null,
      input.actorName ?? null,
      ...conditionBinds,
    );
}

export async function recordStaffMemberEvent(
  db: D1Database,
  input: StaffMemberEventInput,
): Promise<void> {
  await prepareStaffMemberEvent(db, input).run();
}

export async function regenerateStaffApiKey(
  db: D1Database,
  id: string,
  event: StaffMemberMutationEventInput<'api_key_regenerated'>,
): Promise<string> {
  const newKey = generateApiKey();
  const now = jstNow();
  const [result] = await db.batch([
    db.prepare('UPDATE staff_members SET api_key = ?, updated_at = ? WHERE id = ?')
      .bind(newKey, now, id),
    prepareStaffMemberEvent(db, { ...event, staffId: id }),
  ]);
  if (result.meta.changes === 0) {
    throw new Error(`Staff member not found: ${id}`);
  }
  return newKey;
}

export async function countStaffByRole(db: D1Database, role: string): Promise<number> {
  const result = await db
    .prepare('SELECT COUNT(*) as count FROM staff_members WHERE role = ?')
    .bind(role)
    .first<{ count: number }>();
  return result?.count ?? 0;
}

export async function countActiveStaffByRole(db: D1Database, role: string): Promise<number> {
  const result = await db
    .prepare('SELECT COUNT(*) as count FROM staff_members WHERE role = ? AND is_active = 1')
    .bind(role)
    .first<{ count: number }>();
  return result?.count ?? 0;
}

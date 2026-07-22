import type { SupportAccessStaff } from './support-access.js';
import type { MentionStaffTarget } from './internal-message-mentions.js';

export type InternalMessageEventSource = 'support' | 'chat';

export type InternalMessageEventRow = {
  id: string;
  source_type: InternalMessageEventSource;
  source_message_id: string;
  version: number;
  action: 'edit' | 'delete';
  body: string | null;
  mentions: string;
  mention_staff_ids: string;
  reason: string | null;
  actor_id: string | null;
  actor_name: string | null;
  created_at: string;
};

type SourceMessage = {
  id: string;
  body: string;
  mentions: string;
  created_by: string | null;
};

type AppendInput = {
  db: D1Database;
  source: InternalMessageEventSource;
  message: SourceMessage;
  staff: SupportAccessStaff;
  baseVersion: number;
  action: 'edit' | 'delete';
  body?: string;
  mentions?: string[];
  mentionTargets?: MentionStaffTarget[];
  reason?: string | null;
  now: string;
};

export type AppendInternalMessageEventResult =
  | { ok: true; event: InternalMessageEventRow }
  | { ok: false; reason: 'conflict' | 'forbidden' | 'deleted' };

export function parseInternalMessageEventArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : [];
  } catch {
    return [];
  }
}

export async function latestInternalMessageEvents(
  db: D1Database,
  source: InternalMessageEventSource,
  messageIds: string[],
): Promise<Map<string, InternalMessageEventRow>> {
  if (messageIds.length === 0) return new Map();
  const placeholders = messageIds.map(() => '?').join(', ');
  const rows = await db
    .prepare(
      `SELECT *
       FROM internal_message_events
       WHERE source_type = ? AND source_message_id IN (${placeholders})
       ORDER BY source_message_id, version DESC`,
    )
    .bind(source, ...messageIds)
    .all<InternalMessageEventRow>();
  const latest = new Map<string, InternalMessageEventRow>();
  for (const row of rows.results) {
    if (!latest.has(row.source_message_id)) latest.set(row.source_message_id, row);
  }
  return latest;
}

export function internalMessagePermissions(
  message: Pick<SourceMessage, 'created_by'>,
  event: InternalMessageEventRow | undefined,
  staff: SupportAccessStaff,
): { canEdit: boolean; canDelete: boolean } {
  const deleted = event?.action === 'delete';
  const isAuthor = Boolean(message.created_by && message.created_by === staff.id);
  return {
    canEdit: !deleted && isAuthor,
    canDelete: !deleted && (isAuthor || staff.role === 'owner' || staff.role === 'admin'),
  };
}

export function projectInternalMessage(
  message: Pick<SourceMessage, 'body' | 'mentions' | 'created_by'>,
  event: InternalMessageEventRow | undefined,
  staff: SupportAccessStaff,
) {
  const isDeleted = event?.action === 'delete';
  const edited = event?.action === 'edit';
  return {
    body: isDeleted ? 'このメッセージは削除されました' : edited ? (event.body ?? '') : message.body,
    mentions: isDeleted
      ? []
      : edited
        ? parseInternalMessageEventArray(event.mentions)
        : parseInternalMessageEventArray(message.mentions),
    mentionStaffIds: isDeleted || !edited
      ? []
      : parseInternalMessageEventArray(event.mention_staff_ids),
    version: event?.version ?? 0,
    editedAt: edited ? event.created_at : null,
    deletedAt: isDeleted ? event.created_at : null,
    deletedByName: isDeleted ? event.actor_name : null,
    isDeleted,
    ...internalMessagePermissions(message, event, staff),
  };
}

export async function appendInternalMessageEvent(
  input: AppendInput,
): Promise<AppendInternalMessageEventResult> {
  const current = (await latestInternalMessageEvents(input.db, input.source, [input.message.id])).get(input.message.id);
  const currentVersion = current?.version ?? 0;
  if (currentVersion !== input.baseVersion) return { ok: false, reason: 'conflict' };
  if (current?.action === 'delete') return { ok: false, reason: 'deleted' };
  const permissions = internalMessagePermissions(input.message, current, input.staff);
  if (input.action === 'edit' ? !permissions.canEdit : !permissions.canDelete) {
    return { ok: false, reason: 'forbidden' };
  }

  const version = currentVersion + 1;
  const event: InternalMessageEventRow = {
    id: crypto.randomUUID(),
    source_type: input.source,
    source_message_id: input.message.id,
    version,
    action: input.action,
    body: input.action === 'edit' ? (input.body ?? '') : null,
    mentions: JSON.stringify(input.action === 'edit' ? (input.mentions ?? []) : []),
    mention_staff_ids: JSON.stringify(input.action === 'edit' ? (input.mentionTargets ?? []).map((target) => target.id) : []),
    reason: input.reason?.trim() || null,
    actor_id: input.staff.id,
    actor_name: input.staff.name,
    created_at: input.now,
  };

  const statements: D1PreparedStatement[] = [
    input.db
      .prepare(
        `INSERT INTO internal_message_events (
          id, source_type, source_message_id, version, action, body, mentions,
          mention_staff_ids, reason, actor_id, actor_name, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        event.id,
        event.source_type,
        event.source_message_id,
        event.version,
        event.action,
        event.body,
        event.mentions,
        event.mention_staff_ids,
        event.reason,
        event.actor_id,
        event.actor_name,
        event.created_at,
      ),
    input.db
      .prepare(`DELETE FROM internal_message_mentions WHERE source_type = ? AND source_message_id = ?`)
      .bind(input.source, input.message.id),
  ];
  if (input.action === 'edit') {
    for (const target of input.mentionTargets ?? []) {
      statements.push(
        input.db
          .prepare(
            `INSERT INTO internal_message_mentions (
              source_type, source_message_id, staff_id, staff_name_snapshot, created_at
            ) VALUES (?, ?, ?, ?, ?)`,
          )
          .bind(input.source, input.message.id, target.id, target.name, input.now),
      );
    }
  }
  try {
    await input.db.batch(statements);
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) {
      return { ok: false, reason: 'conflict' };
    }
    throw err;
  }
  return { ok: true, event };
}

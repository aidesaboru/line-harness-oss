const DEFAULT_MAX_MENTIONS = 20;
const STAFF_ID_MAX_LENGTH = 128;
const VISIBLE_ASCII_PATTERN = /^[!-~]+$/;

export type InternalMessageSource = 'support' | 'chat' | 'channel';

export type MentionStaffTarget = {
  id: string;
  name: string;
};

export type MentionStaffIdParseResult =
  | { ok: true; value: string[] }
  | { ok: false; error: string };

export function parseMentionStaffIds(
  raw: unknown,
  maxMentions = DEFAULT_MAX_MENTIONS,
): MentionStaffIdParseResult {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, error: 'mentionStaffIds must be an array' };
  if (raw.length > maxMentions) return { ok: false, error: 'mentionStaffIds is too long' };

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') {
      return { ok: false, error: 'mentionStaffIds must contain strings' };
    }
    const id = item.trim();
    if (!id) continue;
    if (id.length > STAFF_ID_MAX_LENGTH || !VISIBLE_ASCII_PATTERN.test(id)) {
      return { ok: false, error: 'mentionStaffId is invalid' };
    }
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return { ok: true, value: ids };
}

export async function resolveMentionStaffTargets(
  db: D1Database,
  staffIds: string[],
): Promise<{ targets: MentionStaffTarget[]; missingIds: string[] }> {
  if (staffIds.length === 0) return { targets: [], missingIds: [] };
  const placeholders = staffIds.map(() => '?').join(', ');
  const rows = await db
    .prepare(
      `SELECT id, name
       FROM staff_members
       WHERE is_active = 1 AND id IN (${placeholders})`,
    )
    .bind(...staffIds)
    .all<{ id: string; name: string }>();
  const byId = new Map(rows.results.map((row) => [row.id, row]));
  return {
    targets: staffIds.flatMap((id) => {
      const target = byId.get(id);
      return target ? [{ id: target.id, name: target.name }] : [];
    }),
    missingIds: staffIds.filter((id) => !byId.has(id)),
  };
}

export function mentionTargetsMatchBody(body: string, targets: MentionStaffTarget[]): boolean {
  return targets.every((target) => body.includes(`@${target.name}`));
}

export async function recordInternalMessageMentions(
  db: D1Database,
  sourceType: InternalMessageSource,
  sourceMessageId: string,
  targets: MentionStaffTarget[],
  createdAt: string,
): Promise<void> {
  if (targets.length === 0) return;
  await db.batch(targets.map((target) => (
    db.prepare(
      `INSERT OR IGNORE INTO internal_message_mentions (
        source_type, source_message_id, staff_id, staff_name_snapshot, created_at
      ) VALUES (?, ?, ?, ?, ?)`,
    ).bind(sourceType, sourceMessageId, target.id, target.name, createdAt)
  )));
}

export async function mentionStaffIdsForMessages(
  db: D1Database,
  sourceType: InternalMessageSource,
  messageIds: string[],
): Promise<Map<string, string[]>> {
  if (messageIds.length === 0) return new Map();
  const placeholders = messageIds.map(() => '?').join(', ');
  const rows = await db
    .prepare(
      `SELECT source_message_id, staff_id
       FROM internal_message_mentions
       WHERE source_type = ? AND source_message_id IN (${placeholders})`,
    )
    .bind(sourceType, ...messageIds)
    .all<{ source_message_id: string; staff_id: string }>();
  const result = new Map<string, string[]>();
  for (const row of rows.results) {
    const ids = result.get(row.source_message_id) ?? [];
    ids.push(row.staff_id);
    result.set(row.source_message_id, ids);
  }
  return result;
}

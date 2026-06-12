export type SupportAccessStaff = {
  id: string;
  name: string;
  role: 'owner' | 'admin' | 'staff';
};

type SqlScope = {
  sql: string;
  binds: unknown[];
};

export function isRestrictedSupportStaff(staff: SupportAccessStaff): boolean {
  return staff.role === 'staff';
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export function supportStaffLikePattern(staff: SupportAccessStaff): string | null {
  const name = staff.name.trim();
  if (!name) return null;
  return `%${escapeLike(name)}%`;
}

export function supportCaseVisibilitySql(
  staff: SupportAccessStaff,
  caseAlias = 'sc',
  escalationAlias = 'se_scope',
): SqlScope {
  if (!isRestrictedSupportStaff(staff)) return { sql: '', binds: [] };

  const pattern = supportStaffLikePattern(staff);
  const parts = [`${caseAlias}.created_by = ?`];
  const binds: unknown[] = [staff.id];
  if (pattern) {
    parts.push(
      `${caseAlias}.primary_assignee LIKE ? ESCAPE '\\'`,
      `${caseAlias}.escalation_assignee LIKE ? ESCAPE '\\'`,
      `EXISTS (
        SELECT 1
        FROM support_escalations ${escalationAlias}
        WHERE ${escalationAlias}.case_id = ${caseAlias}.id
          AND ${escalationAlias}.status != 'closed'
          AND ${escalationAlias}.assignee LIKE ? ESCAPE '\\'
      )`,
    );
    binds.push(pattern, pattern, pattern);
  }

  return {
    sql: `(${parts.join('\n      OR ')})`,
    binds,
  };
}

export function supportEscalationVisibilitySql(
  staff: SupportAccessStaff,
  escalationAlias = 'se',
  caseAlias = 'sc_scope',
): SqlScope {
  if (!isRestrictedSupportStaff(staff)) return { sql: '', binds: [] };

  const caseScope = supportCaseVisibilitySql(staff, caseAlias, 'se_case_scope');
  const pattern = supportStaffLikePattern(staff);
  const parts = pattern ? [`${escalationAlias}.assignee LIKE ? ESCAPE '\\'`] : [];
  const binds: unknown[] = pattern ? [pattern] : [];
  parts.push(`EXISTS (
        SELECT 1
        FROM support_cases ${caseAlias}
        WHERE ${caseAlias}.id = ${escalationAlias}.case_id
          AND ${caseScope.sql}
      )`);
  binds.push(...caseScope.binds);

  return {
    sql: `(${parts.join('\n      OR ')})`,
    binds,
  };
}

export function supportFriendVisibilitySql(
  staff: SupportAccessStaff,
  friendIdExpression: string,
): SqlScope {
  if (!isRestrictedSupportStaff(staff)) return { sql: '', binds: [] };

  const caseScope = supportCaseVisibilitySql(staff, 'sc_friend_scope', 'se_friend_scope');
  return {
    sql: `EXISTS (
      SELECT 1
      FROM support_cases sc_friend_scope
      WHERE sc_friend_scope.friend_id = ${friendIdExpression}
        AND ${caseScope.sql}
    )`,
    binds: caseScope.binds,
  };
}

export async function canAccessSupportFriend(
  db: D1Database,
  staff: SupportAccessStaff,
  friendId: string,
): Promise<boolean> {
  const visibility = supportFriendVisibilitySql(staff, '?');
  if (!visibility.sql) return true;

  const row = await db
    .prepare(`SELECT 1 AS ok WHERE ${visibility.sql}`)
    .bind(friendId, ...visibility.binds)
    .first<{ ok: number }>();
  return Boolean(row);
}

export type SupportAccessStaff = {
  id: string;
  name: string;
  role: 'owner' | 'admin' | 'staff' | 'secondary';
};

type SqlScope = {
  sql: string;
  binds: unknown[];
};

const SECONDARY_ONLY_SUPPORT_MODE = true;

export function isRestrictedSupportStaff(staff: SupportAccessStaff): boolean {
  return staff.role === 'staff' || staff.role === 'secondary';
}

export function isSecondaryOnlySupportStaff(staff: SupportAccessStaff): boolean {
  return SECONDARY_ONLY_SUPPORT_MODE && staff.role === 'secondary';
}

export function supportStaffAssignmentName(staff: SupportAccessStaff): string | null {
  const name = staff.name.trim();
  return name || null;
}

export function supportCaseVisibilitySql(
  staff: SupportAccessStaff,
  caseAlias = 'sc',
  escalationAlias = 'se_scope',
): SqlScope {
  if (!isRestrictedSupportStaff(staff)) return { sql: '', binds: [] };

  const assignmentName = supportStaffAssignmentName(staff);
  if (isSecondaryOnlySupportStaff(staff)) {
    if (!assignmentName) return { sql: '(0 = 1)', binds: [] };
    return {
      sql: `(
        ${caseAlias}.escalation_assignee = ?
        OR EXISTS (
          SELECT 1
          FROM support_escalations ${escalationAlias}
          WHERE ${escalationAlias}.case_id = ${caseAlias}.id
            AND ${escalationAlias}.status != 'closed'
            AND ${escalationAlias}.assignee = ?
        )
      )`,
      binds: [assignmentName, assignmentName],
    };
  }

  const parts = [`${caseAlias}.created_by = ?`];
  const binds: unknown[] = [staff.id];
  if (assignmentName) {
    parts.push(
      `${caseAlias}.primary_assignee = ?`,
      `${caseAlias}.escalation_assignee = ?`,
      `EXISTS (
        SELECT 1
        FROM support_escalations ${escalationAlias}
        WHERE ${escalationAlias}.case_id = ${caseAlias}.id
          AND ${escalationAlias}.status != 'closed'
          AND ${escalationAlias}.assignee = ?
      )`,
    );
    binds.push(assignmentName, assignmentName, assignmentName);
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

  const assignmentName = supportStaffAssignmentName(staff);
  if (isSecondaryOnlySupportStaff(staff)) {
    if (!assignmentName) return { sql: '(0 = 1)', binds: [] };
    return {
      sql: `(${escalationAlias}.assignee = ?)`,
      binds: [assignmentName],
    };
  }

  const caseScope = supportCaseVisibilitySql(staff, caseAlias, 'se_case_scope');
  const parts = assignmentName ? [`${escalationAlias}.assignee = ?`] : [];
  const binds: unknown[] = assignmentName ? [assignmentName] : [];
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
  if (isSecondaryOnlySupportStaff(staff)) return { sql: '(0 = 1)', binds: [] };

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
  if (isSecondaryOnlySupportStaff(staff)) return false;
  const visibility = supportFriendVisibilitySql(staff, '?');
  if (!visibility.sql) return true;

  const row = await db
    .prepare(`SELECT 1 AS ok WHERE ${visibility.sql}`)
    .bind(friendId, ...visibility.binds)
    .first<{ ok: number }>();
  return Boolean(row);
}

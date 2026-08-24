export type SupportAccessStaff = {
  id: string;
  name: string;
  role: 'owner' | 'admin' | 'staff' | 'secondary';
  secondaryCanRespond?: boolean;
};

type SqlScope = {
  sql: string;
  binds: unknown[];
};

export function isRestrictedSupportStaff(staff: SupportAccessStaff): boolean {
  return staff.role === 'staff' || staff.role === 'secondary';
}

export function isSecondaryOnlySupportStaff(staff: SupportAccessStaff): boolean {
  // `secondaryCanRespond` grants only the scoped ticket escalation actions
  // that verify assignee_staff_id. It must never widen customer chat, friend,
  // profile, LINE send, or full-conversation access.
  return staff.role === 'secondary';
}

export function supportStaffAssignmentName(staff: SupportAccessStaff): string | null {
  const name = staff.name.trim();
  return name || null;
}

function supportCaseAssigneeStaffIdSql(
  caseAlias: string,
  idColumn: 'primary_assignee_staff_id' | 'escalation_assignee_staff_id',
): string {
  return `${caseAlias}.${idColumn}`;
}

export function supportCaseDirectVisibilitySql(
  staff: SupportAccessStaff,
  caseAlias = 'sc',
  escalationAlias = 'se_scope',
): SqlScope {
  if (!isRestrictedSupportStaff(staff)) return { sql: '', binds: [] };

  const assignmentName = supportStaffAssignmentName(staff);
  if (staff.role === 'secondary') {
    const escalationStaffId = supportCaseAssigneeStaffIdSql(
      caseAlias,
      'escalation_assignee_staff_id',
    );
    const directParts = [`${escalationStaffId} = ?`];
    const directBinds: unknown[] = [staff.id];
    if (assignmentName) {
      directParts.push(`(
        ${escalationStaffId} IS NULL
        AND ${caseAlias}.escalation_assignee = ?
        AND 1 = (
          SELECT COUNT(*) FROM staff_members legacy_case_secondary_staff
          WHERE legacy_case_secondary_staff.name = ?
        )
      )`);
      directBinds.push(assignmentName, assignmentName);
    }
    const escalationScope = supportEscalationVisibilitySql(staff, escalationAlias, caseAlias);
    return {
      sql: `(
        ${directParts.join('\n        OR ')}
        OR EXISTS (
          SELECT 1
          FROM support_escalations ${escalationAlias}
          WHERE ${escalationAlias}.case_id = ${caseAlias}.id
            AND ${escalationAlias}.status != 'closed'
            AND ${escalationScope.sql}
        )
      )`,
      binds: [...directBinds, ...escalationScope.binds],
    };
  }

  const parts = [`${caseAlias}.created_by = ?`];
  const binds: unknown[] = [staff.id];
  if (assignmentName) {
    const primaryStaffId = supportCaseAssigneeStaffIdSql(
      caseAlias,
      'primary_assignee_staff_id',
    );
    const escalationStaffId = supportCaseAssigneeStaffIdSql(
      caseAlias,
      'escalation_assignee_staff_id',
    );
    parts.push(
      `${primaryStaffId} = ?`,
      `${escalationStaffId} = ?`,
      `(
        ${primaryStaffId} IS NULL
        AND ${caseAlias}.primary_assignee = ?
        AND 1 = (
          SELECT COUNT(*) FROM staff_members legacy_primary_case_staff
          WHERE legacy_primary_case_staff.name = ?
        )
      )`,
      `(
        ${escalationStaffId} IS NULL
        AND ${caseAlias}.escalation_assignee = ?
        AND 1 = (
          SELECT COUNT(*) FROM staff_members legacy_escalation_case_staff
          WHERE legacy_escalation_case_staff.name = ?
        )
      )`,
      `EXISTS (
        SELECT 1
          FROM support_escalations ${escalationAlias}
          WHERE ${escalationAlias}.case_id = ${caseAlias}.id
            AND ${escalationAlias}.status != 'closed'
            AND (
              ${escalationAlias}.assignee_staff_id = ?
              OR (
                ${escalationAlias}.assignee_staff_id IS NULL
                AND ${escalationAlias}.assignee = ?
                AND 1 = (
                  SELECT COUNT(*) FROM staff_members legacy_primary_staff
                  WHERE legacy_primary_staff.name = ?
                )
              )
            )
      )`,
    );
    binds.push(
      staff.id,
      staff.id,
      assignmentName,
      assignmentName,
      assignmentName,
      assignmentName,
      staff.id,
      assignmentName,
      assignmentName,
    );
  }

  return {
    sql: `(${parts.join('\n      OR ')})`,
    binds,
  };
}

export function supportCaseSharedVisibilitySql(
  staff: SupportAccessStaff,
  caseAlias = 'sc',
  escalationAlias = 'se_shared_scope',
): SqlScope {
  if (staff.role !== 'staff') return { sql: '', binds: [] };

  return {
    sql: `EXISTS (
      SELECT 1
      FROM staff_ticket_shares ticket_share
      INNER JOIN staff_members shared_staff
        ON shared_staff.id = CASE
          WHEN ticket_share.staff_a_id = ? THEN ticket_share.staff_b_id
          ELSE ticket_share.staff_a_id
        END
       AND shared_staff.is_active = 1
       AND shared_staff.role = 'staff'
      WHERE (ticket_share.staff_a_id = ? OR ticket_share.staff_b_id = ?)
        AND ticket_share.removed_at IS NULL
        AND (
          ${caseAlias}.created_by = shared_staff.id
          OR ${supportCaseAssigneeStaffIdSql(caseAlias, 'primary_assignee_staff_id')} = shared_staff.id
          OR ${supportCaseAssigneeStaffIdSql(caseAlias, 'escalation_assignee_staff_id')} = shared_staff.id
          OR EXISTS (
            SELECT 1
            FROM support_escalations ${escalationAlias}
            WHERE ${escalationAlias}.case_id = ${caseAlias}.id
              AND ${escalationAlias}.status != 'closed'
              AND (
                ${escalationAlias}.assignee_staff_id = shared_staff.id
                OR (
                ${escalationAlias}.assignee_staff_id IS NULL
                AND ${escalationAlias}.assignee = shared_staff.name
                AND 1 = (
                  SELECT COUNT(*) FROM staff_members legacy_shared_staff
                  WHERE legacy_shared_staff.name = shared_staff.name
                )
              )
              )
          )
        )
    )`,
    binds: [staff.id, staff.id, staff.id],
  };
}

export function supportCaseVisibilitySql(
  staff: SupportAccessStaff,
  caseAlias = 'sc',
  escalationAlias = 'se_scope',
): SqlScope {
  return supportCaseDirectVisibilitySql(staff, caseAlias, escalationAlias);
}

export function supportCaseReadVisibilitySql(
  staff: SupportAccessStaff,
  caseAlias = 'sc',
  escalationAlias = 'se_scope',
): SqlScope {
  const direct = supportCaseDirectVisibilitySql(staff, caseAlias, escalationAlias);
  const shared = supportCaseSharedVisibilitySql(staff, caseAlias, `${escalationAlias}_shared`);
  if (!shared.sql) return direct;
  return {
    sql: `(${direct.sql}\n      OR ${shared.sql})`,
    binds: [...direct.binds, ...shared.binds],
  };
}

export function supportEscalationVisibilitySql(
  staff: SupportAccessStaff,
  escalationAlias = 'se',
  caseAlias = 'sc_scope',
): SqlScope {
  if (!isRestrictedSupportStaff(staff)) return { sql: '', binds: [] };

  if (staff.role === 'secondary') {
    const assignmentName = supportStaffAssignmentName(staff);
    const legacyEscalationMatch = assignmentName
      ? `OR (
              ${escalationAlias}.assignee_staff_id IS NULL
              AND ${escalationAlias}.assignee = ?
              AND 1 = (
                SELECT COUNT(*) FROM staff_members legacy_secondary_staff
                WHERE legacy_secondary_staff.name = ?
              )
            )`
      : '';
    return {
      sql: `(
        ${escalationAlias}.assignee_staff_id = ?
        ${legacyEscalationMatch}
      )`,
      binds: assignmentName ? [staff.id, assignmentName, assignmentName] : [staff.id],
    };
  }

  const caseScope = supportCaseVisibilitySql(staff, caseAlias, 'se_case_scope');
  const assignmentName = supportStaffAssignmentName(staff);
  const parts = [`${escalationAlias}.assignee_staff_id = ?`];
  const binds: unknown[] = [staff.id];
  if (assignmentName) {
    parts.push(`(
      ${escalationAlias}.assignee_staff_id IS NULL
      AND ${escalationAlias}.assignee = ?
      AND 1 = (
        SELECT COUNT(*) FROM staff_members legacy_escalation_staff
        WHERE legacy_escalation_staff.name = ?
      )
    )`);
    binds.push(assignmentName, assignmentName);
  }
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
  if (staff.role === 'secondary') return { sql: '(0 = 1)', binds: [] };

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

import { describe, expect, test } from 'vitest';
import {
  supportCaseVisibilitySql,
  supportEscalationVisibilitySql,
  supportFriendVisibilitySql,
  supportStaffAssignmentName,
  type SupportAccessStaff,
} from './support-access.js';

const staff: SupportAccessStaff = {
  id: 'staff-1',
  name: '田島_%',
  role: 'staff',
};

describe('support access SQL helpers', () => {
  test('normalizes the exact staff assignment name', () => {
    expect(supportStaffAssignmentName(staff)).toBe('田島_%');
    expect(supportStaffAssignmentName({ ...staff, name: '  田島  ' })).toBe('田島');
    expect(supportStaffAssignmentName({ ...staff, name: '   ' })).toBeNull();
  });

  test('owner/admin scopes are unrestricted', () => {
    expect(supportCaseVisibilitySql({ ...staff, role: 'owner' })).toEqual({ sql: '', binds: [] });
    expect(supportFriendVisibilitySql({ ...staff, role: 'admin' }, 'f.id')).toEqual({ sql: '', binds: [] });
  });

  test('staff case scope includes created-by and exact assignee matches', () => {
    const scope = supportCaseVisibilitySql(staff, 'case_alias', 'escalation_alias');

    expect(scope.sql).toContain('case_alias.created_by = ?');
    expect(scope.sql).toContain('case_alias.primary_assignee = ?');
    expect(scope.sql).toContain('FROM support_escalations escalation_alias');
    expect(scope.binds).toEqual(['staff-1', '田島_%', '田島_%', 'staff-1', '田島_%']);
  });

  test('staff escalation and friend scopes reuse the same case visibility guard', () => {
    const escalationScope = supportEscalationVisibilitySql(staff, 'se', 'sc');
    const friendScope = supportFriendVisibilitySql(staff, 'f.id');

    expect(escalationScope.sql).toContain('se.assignee = ?');
    expect(escalationScope.sql).toContain('FROM support_cases sc');
    expect(escalationScope.binds).toEqual(['staff-1', '田島_%', 'staff-1', '田島_%', '田島_%', 'staff-1', '田島_%']);

    expect(friendScope.sql).toContain('sc_friend_scope.friend_id = f.id');
    expect(friendScope.sql).toContain('FROM support_cases sc_friend_scope');
    expect(friendScope.binds).toEqual(['staff-1', '田島_%', '田島_%', 'staff-1', '田島_%']);
  });

  test('secondary staff only sees their own secondary assignments and no friends', () => {
    const secondary: SupportAccessStaff = { id: 'secondary-1', name: '松山', role: 'secondary' };
    const caseScope = supportCaseVisibilitySql(secondary, 'sc', 'se');
    const escalationScope = supportEscalationVisibilitySql(secondary, 'se', 'sc');
    const friendScope = supportFriendVisibilitySql(secondary, 'f.id');

    expect(caseScope.sql).toContain('sc.escalation_assignee = ?');
    expect(caseScope.sql).toContain('FROM support_escalations se');
    expect(caseScope.sql).not.toContain('sc.created_by = ?');
    expect(caseScope.sql).not.toContain('sc.primary_assignee = ?');
    expect(caseScope.binds).toEqual(['松山', 'secondary-1', '松山']);

    expect(escalationScope.sql).toContain('se.assignee = ?');
    expect(escalationScope.sql).not.toContain('FROM support_cases sc');
    expect(escalationScope.binds).toEqual(['secondary-1', '松山']);

    expect(friendScope).toEqual({ sql: '(0 = 1)', binds: [] });
  });

  test('blank staff names do not widen visibility to every assignee', () => {
    const nameless = { ...staff, name: '   ' };
    const caseScope = supportCaseVisibilitySql(nameless, 'sc', 'se');
    const escalationScope = supportEscalationVisibilitySql(nameless, 'se', 'sc');

    expect(caseScope.sql).toContain('sc.created_by = ?');
    expect(caseScope.sql).not.toContain('primary_assignee = ?');
    expect(caseScope.sql).not.toContain('FROM support_escalations se');
    expect(caseScope.binds).toEqual(['staff-1']);

    expect(escalationScope.sql).not.toContain('se.assignee = ?');
    expect(escalationScope.sql).toContain('FROM support_cases sc');
    expect(escalationScope.binds).toEqual(['staff-1', 'staff-1']);
  });

  test('blank secondary staff names cannot see secondary cases or friends', () => {
    const nameless: SupportAccessStaff = { id: 'secondary-1', name: '   ', role: 'secondary' };

    const caseScope = supportCaseVisibilitySql(nameless, 'sc', 'se');
    const escalationScope = supportEscalationVisibilitySql(nameless, 'se', 'sc');
    const friendScope = supportFriendVisibilitySql(nameless, 'f.id');

    expect(caseScope).toEqual({ sql: '(0 = 1)', binds: [] });
    expect(escalationScope).toEqual({ sql: '(0 = 1)', binds: [] });
    expect(friendScope).toEqual({ sql: '(0 = 1)', binds: [] });
  });
});

import { describe, expect, test } from 'vitest';
import {
  supportCaseVisibilitySql,
  supportEscalationVisibilitySql,
  supportFriendVisibilitySql,
  supportStaffLikePattern,
  type SupportAccessStaff,
} from './support-access.js';

const staff: SupportAccessStaff = {
  id: 'staff-1',
  name: '田島_%',
  role: 'staff',
};

describe('support access SQL helpers', () => {
  test('escapes staff names before using them in LIKE patterns', () => {
    expect(supportStaffLikePattern(staff)).toBe('%田島\\_\\%%');
    expect(supportStaffLikePattern({ ...staff, name: '  田島  ' })).toBe('%田島%');
    expect(supportStaffLikePattern({ ...staff, name: '   ' })).toBeNull();
  });

  test('owner/admin scopes are unrestricted', () => {
    expect(supportCaseVisibilitySql({ ...staff, role: 'owner' })).toEqual({ sql: '', binds: [] });
    expect(supportFriendVisibilitySql({ ...staff, role: 'admin' }, 'f.id')).toEqual({ sql: '', binds: [] });
  });

  test('staff case scope includes created-by and escaped assignee matches', () => {
    const scope = supportCaseVisibilitySql(staff, 'case_alias', 'escalation_alias');

    expect(scope.sql).toContain('case_alias.created_by = ?');
    expect(scope.sql).toContain("LIKE ? ESCAPE '\\'");
    expect(scope.sql).toContain('FROM support_escalations escalation_alias');
    expect(scope.binds).toEqual(['staff-1', '%田島\\_\\%%', '%田島\\_\\%%', '%田島\\_\\%%']);
  });

  test('staff escalation and friend scopes reuse the same case visibility guard', () => {
    const escalationScope = supportEscalationVisibilitySql(staff, 'se', 'sc');
    const friendScope = supportFriendVisibilitySql(staff, 'f.id');

    expect(escalationScope.sql).toContain('se.assignee LIKE ?');
    expect(escalationScope.sql).toContain('FROM support_cases sc');
    expect(escalationScope.binds).toEqual(['%田島\\_\\%%', 'staff-1', '%田島\\_\\%%', '%田島\\_\\%%', '%田島\\_\\%%']);

    expect(friendScope.sql).toContain('sc_friend_scope.friend_id = f.id');
    expect(friendScope.sql).toContain('FROM support_cases sc_friend_scope');
    expect(friendScope.binds).toEqual(['staff-1', '%田島\\_\\%%', '%田島\\_\\%%', '%田島\\_\\%%']);
  });

  test('blank staff names do not widen LIKE visibility to every assignee', () => {
    const nameless = { ...staff, name: '   ' };
    const caseScope = supportCaseVisibilitySql(nameless, 'sc', 'se');
    const escalationScope = supportEscalationVisibilitySql(nameless, 'se', 'sc');

    expect(caseScope.sql).toContain('sc.created_by = ?');
    expect(caseScope.sql).not.toContain('LIKE ?');
    expect(caseScope.sql).not.toContain('FROM support_escalations se');
    expect(caseScope.binds).toEqual(['staff-1']);

    expect(escalationScope.sql).not.toContain('se.assignee LIKE ?');
    expect(escalationScope.sql).toContain('FROM support_cases sc');
    expect(escalationScope.binds).toEqual(['staff-1']);
  });
});

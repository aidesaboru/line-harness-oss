import { describe, expect, test } from 'vitest';
import {
  currentFollowUpCycleDueAt,
  isFollowUpReminderDue,
  nextFollowUpDueAt,
  serializeSupportCaseFollowUpReminder,
  type SupportCaseFollowUpReminderRow,
} from './support-case-reminders.js';

const reminder: SupportCaseFollowUpReminderRow = {
  id: 'reminder-1',
  case_id: 'case-1',
  line_account_id: 'account-1',
  owner_staff_id: 'staff-primary',
  owner_name: '一次 担当',
  interval_days: 3,
  next_due_at: '2026-07-01T10:00:00.000+09:00',
  status: 'active',
  version: 1,
  last_confirmed_at: null,
  last_confirmed_by: null,
  last_confirmed_name: null,
  created_by: 'staff-admin',
  created_by_name: '管理者',
  created_at: '2026-06-30T10:00:00.000+09:00',
  updated_at: '2026-06-30T10:00:00.000+09:00',
};

describe('support case follow-up reminders', () => {
  test('calculates an arbitrary interval from the confirmation time', () => {
    expect(nextFollowUpDueAt(14, new Date('2026-07-22T10:00:00.000+09:00')))
      .toBe('2026-08-05T10:00:00.000+09:00');
  });

  test('uses the latest elapsed cycle for recurring notifications', () => {
    expect(currentFollowUpCycleDueAt(
      reminder.next_due_at,
      reminder.interval_days,
      new Date('2026-07-08T12:00:00.000+09:00'),
    )).toBe('2026-07-07T10:00:00.000+09:00');
  });

  test('does not become due before the configured date', () => {
    const futureReminder = { ...reminder, next_due_at: '2026-07-25T10:00:00.000+09:00' };
    expect(isFollowUpReminderDue(
      futureReminder,
      'in_progress',
      new Date('2026-07-22T10:00:00.000+09:00'),
    )).toBe(false);
    expect(serializeSupportCaseFollowUpReminder(futureReminder, {
      caseStatus: 'in_progress',
      currentStaffId: 'staff-primary',
      now: new Date('2026-07-22T10:00:00.000+09:00'),
    }).canConfirm).toBe(false);
  });

  test('keeps a resolved case waiting for primary confirmation', () => {
    const serialized = serializeSupportCaseFollowUpReminder(reminder, {
      caseStatus: 'resolved',
      currentStaffId: 'staff-other',
      now: new Date('2026-07-22T10:00:00.000+09:00'),
    });

    expect(serialized.requiresPrimaryConfirmation).toBe(true);
    expect(serialized.canConfirm).toBe(false);
  });

  test('allows only the registered primary staff member to confirm', () => {
    const serialized = serializeSupportCaseFollowUpReminder(reminder, {
      caseStatus: 'in_progress',
      currentStaffId: 'staff-primary',
      now: new Date('2026-07-22T10:00:00.000+09:00'),
    });

    expect(serialized.isDue).toBe(true);
    expect(serialized.canConfirm).toBe(true);
  });
});

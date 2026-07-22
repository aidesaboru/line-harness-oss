import { toJstString } from '@line-crm/db';

const DAY_MS = 24 * 60 * 60_000;

export type SupportCaseFollowUpReminderStatus = 'active' | 'completed' | 'disabled';

export type SupportCaseFollowUpReminderRow = {
  id: string;
  case_id: string;
  line_account_id: string;
  owner_staff_id: string | null;
  owner_name: string;
  interval_days: number;
  next_due_at: string;
  status: SupportCaseFollowUpReminderStatus;
  version: number;
  last_confirmed_at: string | null;
  last_confirmed_by: string | null;
  last_confirmed_name: string | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
};

export function nextFollowUpDueAt(intervalDays: number, from = new Date()): string {
  return toJstString(new Date(from.getTime() + intervalDays * DAY_MS));
}

export function currentFollowUpCycleDueAt(
  nextDueAt: string,
  intervalDays: number,
  now = new Date(),
): string | null {
  const firstDue = new Date(nextDueAt).getTime();
  if (!Number.isFinite(firstDue) || intervalDays < 1) return null;
  const nowMs = now.getTime();
  if (firstDue > nowMs) return null;
  const intervalMs = intervalDays * DAY_MS;
  const elapsedCycles = Math.floor((nowMs - firstDue) / intervalMs);
  return toJstString(new Date(firstDue + elapsedCycles * intervalMs));
}

export function isFollowUpReminderDue(
  reminder: Pick<SupportCaseFollowUpReminderRow, 'status' | 'next_due_at' | 'interval_days'>,
  caseStatus: string,
  now = new Date(),
): boolean {
  if (reminder.status !== 'active') return false;
  if (caseStatus === 'resolved') return true;
  return currentFollowUpCycleDueAt(reminder.next_due_at, reminder.interval_days, now) !== null;
}

export function serializeSupportCaseFollowUpReminder(
  reminder: SupportCaseFollowUpReminderRow,
  options: { caseStatus: string; currentStaffId?: string; now?: Date },
) {
  const due = isFollowUpReminderDue(reminder, options.caseStatus, options.now);
  return {
    id: reminder.id,
    caseId: reminder.case_id,
    lineAccountId: reminder.line_account_id,
    ownerStaffId: reminder.owner_staff_id,
    ownerName: reminder.owner_name,
    intervalDays: reminder.interval_days,
    nextDueAt: reminder.next_due_at,
    status: reminder.status,
    isDue: due,
    requiresPrimaryConfirmation: reminder.status === 'active' && (due || options.caseStatus === 'resolved'),
    canConfirm: reminder.status === 'active'
      && due
      && Boolean(options.currentStaffId)
      && reminder.owner_staff_id === options.currentStaffId,
    lastConfirmedAt: reminder.last_confirmed_at,
    lastConfirmedBy: reminder.last_confirmed_by,
    lastConfirmedName: reminder.last_confirmed_name,
    version: reminder.version,
    createdAt: reminder.created_at,
    updatedAt: reminder.updated_at,
  };
}

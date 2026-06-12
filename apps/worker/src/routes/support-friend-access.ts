import type { Context } from 'hono';
import type { Env } from '../index.js';
import {
  canAccessSupportFriend,
  type SupportAccessStaff,
} from '../services/support-access.js';

type StaffContext = {
  get: (key: 'staff') => SupportAccessStaff | undefined;
};

export function currentSupportStaff(c: StaffContext): SupportAccessStaff {
  return c.get('staff') ?? { id: 'system', name: 'system', role: 'staff' };
}

export async function ensureSupportFriendAccess(
  c: Context<Env>,
  friendId: string,
  notFoundMessage = 'Friend not found',
): Promise<Response | null> {
  if (await canAccessSupportFriend(c.env.DB, currentSupportStaff(c), friendId)) return null;
  return c.json({ success: false, error: notFoundMessage }, 404);
}

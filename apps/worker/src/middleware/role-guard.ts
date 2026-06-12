import type { Context, Next } from 'hono';
import type { Env } from '../index.js';

type Role = 'owner' | 'admin' | 'staff';

export function requireRole(...allowed: Role[]) {
  return async (c: Context<Env>, next: Next): Promise<Response | void> => {
    const staff = c.get('staff');
    if (!staff || !allowed.includes(staff.role)) {
      const label = allowed.join('/');
      return c.json(
        { success: false, error: `この操作には${label}権限が必要です` },
        403,
      );
    }
    return next();
  };
}

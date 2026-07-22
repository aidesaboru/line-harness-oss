import type { Context, Next } from 'hono';
import type { Env } from '../index.js';

const TEMPLATE_ENABLED_STAFF_NAMES = new Set([
  '林 静香',
  '小野里 歩乃佳',
]);

function normalizeStaffName(name: string | null | undefined): string {
  return typeof name === 'string' ? name.trim().replace(/\s+/gu, ' ') : '';
}

export function canManageTemplates(staff: Env['Variables']['staff'] | null | undefined): boolean {
  if (!staff) return false;
  if (staff.role === 'owner' || staff.role === 'admin') return true;
  return staff.role === 'staff' && TEMPLATE_ENABLED_STAFF_NAMES.has(normalizeStaffName(staff.name));
}

export async function requireTemplateAccess(c: Context<Env>, next: Next): Promise<Response | void> {
  if (!canManageTemplates(c.get('staff'))) {
    return c.json({ success: false, error: 'テンプレート機能を利用する権限が必要です' }, 403);
  }
  return next();
}

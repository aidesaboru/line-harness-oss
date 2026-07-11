import { Hono } from 'hono';
import type { Env } from '../index.js';
import { requireRole } from '../middleware/role-guard.js';

const updateHistory = new Hono<Env>();

function updateHistoryErrorKind(err: unknown): string {
  if (err instanceof TypeError) return 'network_error';
  if (err instanceof Error) return err.name || 'error';
  return typeof err;
}

updateHistory.get('/api/update-history', requireRole('owner', 'admin'), async (c) => {
  try {
    const rows = await c.env.DB
      .prepare(
        `SELECT
           id,
           started_at,
           completed_at,
           from_version,
           to_version,
           status,
           events_jsonl,
           error,
           rollback_expires_at,
           rollback_of
         FROM update_history
         ORDER BY started_at DESC
         LIMIT 20`,
      )
      .all();
    return c.json({ success: true, data: rows.results });
  } catch (err) {
    console.error(`GET /api/update-history error: ${updateHistoryErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { updateHistory };

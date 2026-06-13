import { Hono, type Context } from 'hono';
import {
  getAccountHealthLogs,
  getLatestRiskLevel,
  getAccountMigrations,
  getAccountMigrationById,
  createAccountMigration,
  updateAccountMigration,
} from '@line-crm/db';
import type { Env } from '../index.js';
import { requireRole } from '../middleware/role-guard.js';

const health = new Hono<Env>();

const HEALTH_VISIBLE_ID_MAX_LENGTH = 128;
const HEALTH_VISIBLE_ASCII_PATTERN = /^[!-~]+$/;

type ValueResult<T> = { ok: true; value: T } | { ok: false; error: string };

async function readJsonObject(c: Context<Env>): Promise<ValueResult<Record<string, unknown>>> {
  try {
    const body = await c.req.json<unknown>();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { ok: false, error: 'invalid_payload' };
    }
    return { ok: true, value: body as Record<string, unknown> };
  } catch {
    return { ok: false, error: 'invalid_json' };
  }
}

function parseVisibleId(raw: unknown, label: string): ValueResult<string> {
  if (typeof raw !== 'string') return { ok: false, error: `invalid_${label}` };
  const value = raw.trim();
  if (!value || value.length > HEALTH_VISIBLE_ID_MAX_LENGTH || !HEALTH_VISIBLE_ASCII_PATTERN.test(value)) {
    return { ok: false, error: `invalid_${label}` };
  }
  return { ok: true, value };
}

health.use('/api/accounts/*', requireRole('owner', 'admin'));

// ========== アカウントヘルス ==========

health.get('/api/accounts/:id/health', async (c) => {
  try {
    const lineAccountId = parseVisibleId(c.req.param('id'), 'line_account_id');
    if (!lineAccountId.ok) return c.json({ success: false, error: lineAccountId.error }, 400);
    const [riskLevel, logs] = await Promise.all([
      getLatestRiskLevel(c.env.DB, lineAccountId.value),
      getAccountHealthLogs(c.env.DB, lineAccountId.value),
    ]);
    return c.json({
      success: true,
      data: {
        lineAccountId: lineAccountId.value,
        riskLevel,
        logs: logs.map((l) => ({
          id: l.id,
          errorCode: l.error_code,
          errorCount: l.error_count,
          checkPeriod: l.check_period,
          riskLevel: l.risk_level,
          createdAt: l.created_at,
        })),
      },
    });
  } catch (err) {
    console.error('GET /api/accounts/:id/health error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ========== アカウント移行 ==========

health.get('/api/accounts/migrations', async (c) => {
  try {
    const items = await getAccountMigrations(c.env.DB);
    return c.json({
      success: true,
      data: items.map((m) => ({
        id: m.id,
        fromAccountId: m.from_account_id,
        toAccountId: m.to_account_id,
        status: m.status,
        migratedCount: m.migrated_count,
        totalCount: m.total_count,
        createdAt: m.created_at,
        completedAt: m.completed_at,
      })),
    });
  } catch (err) {
    console.error('GET /api/accounts/migrations error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

health.post('/api/accounts/:id/migrate', async (c) => {
  try {
    const fromAccountId = parseVisibleId(c.req.param('id'), 'from_account_id');
    if (!fromAccountId.ok) return c.json({ success: false, error: fromAccountId.error }, 400);
    const rawBody = await readJsonObject(c);
    if (!rawBody.ok) return c.json({ success: false, error: rawBody.error }, 400);
    const toAccountId = parseVisibleId(rawBody.value.toAccountId, 'to_account_id');
    if (!toAccountId.ok) return c.json({ success: false, error: toAccountId.error }, 400);

    const db = c.env.DB;

    // 移行対象: このアカウントに紐づく友だち数をカウント（line_accountsとの関連はuser_id経由）
    // 簡易版: is_following=1 の全友だちを移行対象とする
    const countResult = await db
      .prepare(`SELECT COUNT(*) as count FROM friends WHERE is_following = 1`)
      .first<{ count: number }>();
    const totalCount = countResult?.count ?? 0;

    const migration = await createAccountMigration(db, {
      fromAccountId: fromAccountId.value,
      toAccountId: toAccountId.value,
      totalCount,
    });

    // 移行処理は非同期で実行（実際の移行はUUIDベースなのでユーザーが新アカウントを友だち追加した時に自動マッチされる）
    await updateAccountMigration(db, migration.id, {
      status: 'in_progress',
    });

    return c.json({
      success: true,
      data: {
        id: migration.id,
        fromAccountId: migration.from_account_id,
        toAccountId: migration.to_account_id,
        status: 'in_progress',
        totalCount: migration.total_count,
        createdAt: migration.created_at,
      },
    }, 201);
  } catch (err) {
    console.error('POST /api/accounts/:id/migrate error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

health.get('/api/accounts/migrations/:migrationId', async (c) => {
  try {
    const migrationId = parseVisibleId(c.req.param('migrationId'), 'migration_id');
    if (!migrationId.ok) return c.json({ success: false, error: migrationId.error }, 400);
    const item = await getAccountMigrationById(c.env.DB, migrationId.value);
    if (!item) return c.json({ success: false, error: 'Migration not found' }, 404);
    return c.json({
      success: true,
      data: {
        id: item.id,
        fromAccountId: item.from_account_id,
        toAccountId: item.to_account_id,
        status: item.status,
        migratedCount: item.migrated_count,
        totalCount: item.total_count,
        createdAt: item.created_at,
        completedAt: item.completed_at,
      },
    });
  } catch (err) {
    console.error('GET /api/accounts/migrations/:migrationId error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { health };

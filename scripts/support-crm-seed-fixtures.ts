#!/usr/bin/env tsx
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { argv, env, exit, stderr, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { escapeSqlLiteral } from './support-crm-fixture-candidates';

export type SupportCrmSeedConfig = {
  lineAccountId: string;
  staffName: string;
  staffApiKey: string;
  prefix: string;
  database: string;
  wranglerConfig: string;
  wranglerEnv?: string;
  remote: boolean;
  confirmWrite: boolean;
};

export type SeedFixtureIds = {
  staffId: string;
  visibleFriendId: string;
  forbiddenFriendId: string;
  visibleOpenCaseId: string;
  visibleResolvedCaseId: string;
  forbiddenCaseId: string;
};

const DEFAULT_PREFIX = 'support-crm-preflight';
const DEFAULT_STAFF_NAME = 'Preflight Staff';

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function truthy(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());
}

function sqlString(value: string): string {
  return `'${escapeSqlLiteral(value)}'`;
}

function normalizePrefix(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || DEFAULT_PREFIX;
}

function generatedApiKey(): string {
  return `lh_pf_${randomUUID().replace(/-/g, '')}`;
}

export function configFromEnv(source: NodeJS.ProcessEnv): { ok: true; config: SupportCrmSeedConfig } | { ok: false; error: string } {
  const lineAccountId = optional(source.SUPPORT_CRM_LINE_ACCOUNT_ID);
  if (!lineAccountId) return { ok: false, error: 'Missing required env: SUPPORT_CRM_LINE_ACCOUNT_ID' };

  return {
    ok: true,
    config: {
      lineAccountId,
      staffName: optional(source.SUPPORT_CRM_FIXTURE_STAFF_NAME) ?? optional(source.SUPPORT_CRM_STAFF_NAME) ?? DEFAULT_STAFF_NAME,
      staffApiKey: optional(source.SUPPORT_CRM_FIXTURE_STAFF_API_KEY) ?? generatedApiKey(),
      prefix: normalizePrefix(optional(source.SUPPORT_CRM_FIXTURE_PREFIX) ?? DEFAULT_PREFIX),
      database: optional(source.SUPPORT_CRM_D1_DATABASE) ?? 'DB',
      wranglerConfig: optional(source.SUPPORT_CRM_D1_CONFIG) ?? 'apps/worker/wrangler.toml',
      wranglerEnv: optional(source.SUPPORT_CRM_D1_ENV),
      remote: source.SUPPORT_CRM_D1_REMOTE === undefined
        ? true
        : truthy(source.SUPPORT_CRM_D1_REMOTE),
      confirmWrite: truthy(source.SUPPORT_CRM_FIXTURE_WRITE),
    },
  };
}

export function fixtureIds(prefix: string): SeedFixtureIds {
  return {
    staffId: `${prefix}-staff`,
    visibleFriendId: `${prefix}-visible-friend`,
    forbiddenFriendId: `${prefix}-forbidden-friend`,
    visibleOpenCaseId: `${prefix}-visible-open-case`,
    visibleResolvedCaseId: `${prefix}-visible-resolved-case`,
    forbiddenCaseId: `${prefix}-forbidden-case`,
  };
}

export function buildSeedFixtureSql(config: Pick<SupportCrmSeedConfig, 'lineAccountId' | 'staffName' | 'staffApiKey' | 'prefix'>): string {
  const ids = fixtureIds(config.prefix);
  const now = "strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')";

  return `
INSERT OR REPLACE INTO staff_members
  (id, name, email, role, api_key, is_active, created_at, updated_at)
VALUES
  (${sqlString(ids.staffId)}, ${sqlString(config.staffName)}, NULL, 'staff', ${sqlString(config.staffApiKey)}, 1, ${now}, ${now});

INSERT OR REPLACE INTO friends
  (id, line_user_id, display_name, picture_url, status_message, is_following, line_account_id, created_at, updated_at)
VALUES
  (${sqlString(ids.visibleFriendId)}, ${sqlString(`${config.prefix}-visible-user`)}, 'Preflight Visible Friend', NULL, NULL, 1, ${sqlString(config.lineAccountId)}, ${now}, ${now}),
  (${sqlString(ids.forbiddenFriendId)}, ${sqlString(`${config.prefix}-forbidden-user`)}, 'Preflight Forbidden Friend', NULL, NULL, 1, ${sqlString(config.lineAccountId)}, ${now}, ${now});

INSERT OR REPLACE INTO messages_log
  (id, friend_id, direction, message_type, content, source, line_account_id, created_at)
VALUES
  (${sqlString(`${config.prefix}-visible-message`)}, ${sqlString(ids.visibleFriendId)}, 'incoming', 'text', 'preflight visible fixture message', 'support_crm_preflight_fixture', ${sqlString(config.lineAccountId)}, ${now}),
  (${sqlString(`${config.prefix}-forbidden-message`)}, ${sqlString(ids.forbiddenFriendId)}, 'incoming', 'text', 'preflight forbidden fixture message', 'support_crm_preflight_fixture', ${sqlString(config.lineAccountId)}, ${now});

INSERT OR REPLACE INTO support_cases
  (
    id, line_account_id, friend_id, title, category, priority, status,
    primary_assignee, escalation_assignee, escalation_level, due_at,
    customer_summary, internal_note, customer_reply_draft, resolution_note,
    manual_ids, created_by, updated_by, closed_at, created_at, updated_at
  )
VALUES
  (
    ${sqlString(ids.visibleOpenCaseId)}, ${sqlString(config.lineAccountId)}, ${sqlString(ids.visibleFriendId)},
    'Preflight visible open case', 'other', 'medium', 'open',
    ${sqlString(config.staffName)}, NULL, 'L1', NULL,
    'Synthetic fixture for strict Support CRM Preflight.', '', 'Preflight reply draft.', '',
    '[]', ${sqlString(ids.staffId)}, ${sqlString(ids.staffId)}, NULL, ${now}, ${now}
  ),
  (
    ${sqlString(ids.visibleResolvedCaseId)}, ${sqlString(config.lineAccountId)}, ${sqlString(ids.visibleFriendId)},
    'Preflight visible resolved case', 'other', 'medium', 'resolved',
    ${sqlString(config.staffName)}, NULL, 'L1', NULL,
    'Synthetic resolved fixture for strict Support CRM Preflight.', '', 'Preflight resolved reply draft.', 'Resolved fixture.',
    '[]', ${sqlString(ids.staffId)}, ${sqlString(ids.staffId)}, ${now}, ${now}, ${now}
  ),
  (
    ${sqlString(ids.forbiddenCaseId)}, ${sqlString(config.lineAccountId)}, ${sqlString(ids.forbiddenFriendId)},
    'Preflight forbidden case', 'other', 'medium', 'open',
    'Other Assignee', NULL, 'L1', NULL,
    'Synthetic hidden fixture for strict Support CRM Preflight.', '', '', '',
    '[]', 'env-owner', 'env-owner', NULL, ${now}, ${now}
  );

INSERT OR REPLACE INTO support_case_events
  (id, case_id, event_type, actor_id, actor_name, body, metadata, created_at)
VALUES
  (${sqlString(`${config.prefix}-visible-open-event`)}, ${sqlString(ids.visibleOpenCaseId)}, 'fixture_seeded', ${sqlString(ids.staffId)}, ${sqlString(config.staffName)}, 'Strict Preflight fixture seeded.', '{}', ${now}),
  (${sqlString(`${config.prefix}-visible-resolved-event`)}, ${sqlString(ids.visibleResolvedCaseId)}, 'fixture_seeded', ${sqlString(ids.staffId)}, ${sqlString(config.staffName)}, 'Strict Preflight fixture seeded.', '{}', ${now}),
  (${sqlString(`${config.prefix}-forbidden-event`)}, ${sqlString(ids.forbiddenCaseId)}, 'fixture_seeded', 'env-owner', 'Owner', 'Strict Preflight hidden fixture seeded.', '{}', ${now});
`.trim();
}

export function buildCleanupFixtureSql(config: Pick<SupportCrmSeedConfig, 'lineAccountId' | 'prefix'>): string {
  const ids = fixtureIds(config.prefix);
  const prefixLike = `${config.prefix}-%`;
  return `
DELETE FROM support_case_events
WHERE id LIKE ${sqlString(prefixLike)}
   OR case_id LIKE ${sqlString(prefixLike)}
   OR case_id IN (
     SELECT id
     FROM support_cases
     WHERE line_account_id = ${sqlString(config.lineAccountId)}
       AND title = 'preflight case creation guard'
   );

DELETE FROM support_cases
WHERE id LIKE ${sqlString(prefixLike)}
   OR (
     line_account_id = ${sqlString(config.lineAccountId)}
     AND title = 'preflight case creation guard'
   );

DELETE FROM messages_log
WHERE id LIKE ${sqlString(prefixLike)}
   OR source = 'support_crm_preflight_fixture';

DELETE FROM friends
WHERE id IN (${sqlString(ids.visibleFriendId)}, ${sqlString(ids.forbiddenFriendId)})
   OR id LIKE ${sqlString(prefixLike)};

DELETE FROM staff_members
WHERE id = ${sqlString(ids.staffId)};
`.trim();
}

export function formatSeedReport(config: Pick<SupportCrmSeedConfig, 'lineAccountId' | 'staffName' | 'staffApiKey' | 'prefix'>): string {
  const ids = fixtureIds(config.prefix);
  return [
    'Support CRM strict Preflight fixtures seeded.',
    '',
    'Use these env values with `corepack pnpm preflight:support-crm`:',
    `export SUPPORT_CRM_LINE_ACCOUNT_ID=${config.lineAccountId}`,
    `export SUPPORT_CRM_STAFF_API_KEY=${config.staffApiKey}`,
    `export SUPPORT_CRM_STAFF_NAME=${config.staffName}`,
    `export SUPPORT_CRM_STAFF_VISIBLE_CASE_ID=${ids.visibleOpenCaseId}`,
    `export SUPPORT_CRM_STAFF_FORBIDDEN_CASE_ID=${ids.forbiddenCaseId}`,
    `export SUPPORT_CRM_STAFF_NON_RESOLVED_CASE_ID=${ids.visibleOpenCaseId}`,
    `export SUPPORT_CRM_STAFF_RESOLVED_CASE_ID=${ids.visibleResolvedCaseId}`,
    `export SUPPORT_CRM_STAFF_VISIBLE_FRIEND_ID=${ids.visibleFriendId}`,
    `export SUPPORT_CRM_STAFF_FORBIDDEN_FRIEND_ID=${ids.forbiddenFriendId}`,
    `export SUPPORT_CRM_STAFF_RESOLVED_FRIEND_ID=${ids.visibleFriendId}`,
    'export SUPPORT_CRM_REQUIRE_FULL_COVERAGE=1',
    '',
    'Next: add SUPPORT_CRM_API_URL and SUPPORT_CRM_ADMIN_ORIGIN for the target Worker/Admin, then run strict Preflight.',
    '',
  ].join('\n');
}

export function formatCleanupReport(config: Pick<SupportCrmSeedConfig, 'prefix'>): string {
  return `Support CRM strict Preflight fixtures cleaned for prefix ${config.prefix}.\n`;
}

function runWrangler(config: SupportCrmSeedConfig, sql: string): { ok: true } | { ok: false; error: string; raw?: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), 'support-crm-seed-'));
  const sqlFile = join(tmpDir, 'fixtures.sql');
  writeFileSync(sqlFile, sql);

  const args = [
    'pnpm',
    'exec',
    'wrangler',
    'd1',
    'execute',
    config.database,
    '--config',
    config.wranglerConfig,
    '--file',
    sqlFile,
    config.remote ? '--remote' : '--local',
  ];
  if (config.wranglerEnv) args.push('--env', config.wranglerEnv);

  try {
    const result = spawnSync('corepack', args, { encoding: 'utf8' });
    if (result.status !== 0) {
      return {
        ok: false,
        error: result.stderr.trim() || result.stdout.trim() || `wrangler exited with ${result.status ?? 'unknown status'}`,
        raw: result.stdout,
      };
    }
    return { ok: true };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function usage(): string {
  return [
    'Support CRM strict Preflight fixture seed helper.',
    '',
    'This writes synthetic staff/friend/support-case rows only when SUPPORT_CRM_FIXTURE_WRITE=1 is set.',
    '',
    'Required env:',
    '  SUPPORT_CRM_LINE_ACCOUNT_ID',
    '',
    'Optional env:',
    '  SUPPORT_CRM_FIXTURE_STAFF_NAME=Preflight Staff',
    '  SUPPORT_CRM_FIXTURE_STAFF_API_KEY=<generated when omitted>',
    '  SUPPORT_CRM_FIXTURE_PREFIX=support-crm-preflight',
    '  SUPPORT_CRM_D1_DATABASE=DB',
    '  SUPPORT_CRM_D1_CONFIG=apps/worker/wrangler.toml',
    '  SUPPORT_CRM_D1_ENV=production',
    '  SUPPORT_CRM_D1_REMOTE=1',
    '',
    'Modes:',
    '  --print-sql  print the write SQL only',
    '  --run        run wrangler d1 execute; requires SUPPORT_CRM_FIXTURE_WRITE=1',
    '  --cleanup-sql  print the cleanup SQL only',
    '  --cleanup      run cleanup; requires SUPPORT_CRM_FIXTURE_WRITE=1',
  ].join('\n');
}

const isCliEntry = (() => {
  if (!argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === argv[1];
  } catch {
    return false;
  }
})();

if (isCliEntry) {
  if (argv.includes('--help') || argv.includes('-h')) {
    stdout.write(`${usage()}\n`);
    exit(0);
  }

  const parsed = configFromEnv(env);
  if (!parsed.ok) {
    stderr.write(`${parsed.error}\n\n${usage()}\n`);
    exit(2);
  }

  const cleanupMode = argv.includes('--cleanup') || argv.includes('--cleanup-sql');
  const runMode = argv.includes('--run') || argv.includes('--cleanup');
  const printMode = argv.includes('--print-sql') || argv.includes('--cleanup-sql') || !runMode;
  const sql = cleanupMode
    ? buildCleanupFixtureSql(parsed.config)
    : buildSeedFixtureSql(parsed.config);
  if (printMode) {
    stdout.write(`${sql}\n`);
    exit(0);
  }

  if (!parsed.config.confirmWrite) {
    stderr.write('Refusing to write D1 fixtures. Set SUPPORT_CRM_FIXTURE_WRITE=1 to confirm this synthetic fixture seed.\n');
    exit(2);
  }

  const result = runWrangler(parsed.config, sql);
  if (!result.ok) {
    stderr.write(`support-crm-seed-fixtures: ${result.error}\n`);
    if (result.raw) stderr.write(`\nRaw output:\n${result.raw}\n`);
    exit(1);
  }

  stdout.write(cleanupMode ? formatCleanupReport(parsed.config) : formatSeedReport(parsed.config));
  exit(0);
}

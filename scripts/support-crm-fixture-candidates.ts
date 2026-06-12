#!/usr/bin/env tsx
import { spawnSync } from 'node:child_process';
import { argv, env, exit, stderr, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

export type SupportCrmFixtureConfig = {
  lineAccountId: string;
  staffName: string;
  staffMemberId?: string;
  limit: number;
  database: string;
  wranglerConfig: string;
  wranglerEnv?: string;
  remote: boolean;
};

export type FixtureCandidateRow = {
  env_name: string;
  value: string;
  source?: string;
  case_id?: string | null;
  friend_id?: string | null;
  status?: string | null;
  title?: string | null;
  display_name?: string | null;
  updated_at?: string | null;
};

export type FixtureSelection = {
  env: Record<string, string>;
  missingEnvNames: string[];
};

export type FixtureCandidateReportOptions = {
  lineAccountId?: string;
};

const STRICT_ENV_NAMES = [
  'SUPPORT_CRM_STAFF_VISIBLE_CASE_ID',
  'SUPPORT_CRM_STAFF_FORBIDDEN_CASE_ID',
  'SUPPORT_CRM_STAFF_NON_RESOLVED_CASE_ID',
  'SUPPORT_CRM_STAFF_RESOLVED_CASE_ID',
  'SUPPORT_CRM_STAFF_VISIBLE_FRIEND_ID',
  'SUPPORT_CRM_STAFF_FORBIDDEN_FRIEND_ID',
  'SUPPORT_CRM_STAFF_RESOLVED_FRIEND_ID',
];

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function truthy(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());
}

export function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function sqlString(value: string): string {
  return `'${escapeSqlLiteral(value)}'`;
}

function sqlNullableString(value: string | undefined): string {
  return value ? sqlString(value) : 'NULL';
}

function parseLimit(raw: string | undefined): number {
  const value = Number(raw ?? 3);
  if (!Number.isFinite(value)) return 3;
  return Math.max(1, Math.min(20, Math.floor(value)));
}

export function configFromEnv(source: NodeJS.ProcessEnv): { ok: true; config: SupportCrmFixtureConfig } | { ok: false; error: string } {
  const lineAccountId = optional(source.SUPPORT_CRM_LINE_ACCOUNT_ID);
  const staffName = optional(source.SUPPORT_CRM_STAFF_NAME);
  if (!lineAccountId || !staffName) {
    const missing = [
      !lineAccountId ? 'SUPPORT_CRM_LINE_ACCOUNT_ID' : null,
      !staffName ? 'SUPPORT_CRM_STAFF_NAME' : null,
    ].filter(Boolean).join(', ');
    return { ok: false, error: `Missing required env: ${missing}` };
  }

  return {
    ok: true,
    config: {
      lineAccountId,
      staffName,
      staffMemberId: optional(source.SUPPORT_CRM_STAFF_MEMBER_ID),
      limit: parseLimit(source.SUPPORT_CRM_FIXTURE_LIMIT),
      database: optional(source.SUPPORT_CRM_D1_DATABASE) ?? 'DB',
      wranglerConfig: optional(source.SUPPORT_CRM_D1_CONFIG) ?? 'apps/worker/wrangler.toml',
      wranglerEnv: optional(source.SUPPORT_CRM_D1_ENV),
      remote: source.SUPPORT_CRM_D1_REMOTE === undefined
        ? true
        : truthy(source.SUPPORT_CRM_D1_REMOTE),
    },
  };
}

export function buildFixtureCandidateSql(config: Pick<SupportCrmFixtureConfig, 'lineAccountId' | 'staffName' | 'staffMemberId' | 'limit'>): string {
  const staffPattern = `%${escapeLikePattern(config.staffName)}%`;
  const limit = Math.max(1, Math.min(20, Math.floor(config.limit)));
  const visibleCaseCondition = `(
      ((SELECT id FROM staff_identity) IS NOT NULL AND sc.created_by = (SELECT id FROM staff_identity))
      OR sc.primary_assignee LIKE (SELECT staff_pattern FROM input) ESCAPE '\\'
      OR sc.escalation_assignee LIKE (SELECT staff_pattern FROM input) ESCAPE '\\'
      OR EXISTS (
        SELECT 1
        FROM support_escalations se_scope
        WHERE se_scope.case_id = sc.id
          AND se_scope.status != 'closed'
          AND se_scope.assignee LIKE (SELECT staff_pattern FROM input) ESCAPE '\\'
      )
    )`;

  const commonCtes = `
WITH
input AS (
  SELECT
    ${sqlString(config.lineAccountId)} AS line_account_id,
    ${sqlString(config.staffName)} AS staff_name,
    ${sqlNullableString(config.staffMemberId)} AS staff_member_id,
    ${sqlString(staffPattern)} AS staff_pattern
),
staff_identity AS (
  SELECT sm.id, sm.name
  FROM staff_members sm, input
  WHERE sm.role = 'staff'
    AND sm.is_active = 1
    AND (
      (input.staff_member_id IS NOT NULL AND sm.id = input.staff_member_id)
      OR (input.staff_member_id IS NULL AND sm.name = input.staff_name)
    )
  ORDER BY sm.updated_at DESC
  LIMIT 1
),
case_pool AS (
  SELECT
    sc.id,
    sc.friend_id,
    sc.status,
    sc.title,
    sc.primary_assignee,
    sc.escalation_assignee,
    sc.updated_at,
    CASE WHEN ${visibleCaseCondition} THEN 1 ELSE 0 END AS visible_to_staff
  FROM support_cases sc, input
  WHERE sc.line_account_id = input.line_account_id
    AND sc.friend_id IS NOT NULL
),
visible_cases AS (
  SELECT *
  FROM case_pool
  WHERE visible_to_staff = 1
  ORDER BY updated_at DESC
  LIMIT ${limit}
),
forbidden_cases AS (
  SELECT *
  FROM case_pool
  WHERE visible_to_staff = 0
  ORDER BY updated_at DESC
  LIMIT ${limit}
),
visible_non_resolved_cases AS (
  SELECT *
  FROM case_pool
  WHERE visible_to_staff = 1
    AND status != 'resolved'
  ORDER BY updated_at DESC
  LIMIT ${limit}
),
visible_resolved_cases AS (
  SELECT *
  FROM case_pool
  WHERE visible_to_staff = 1
    AND status = 'resolved'
  ORDER BY updated_at DESC
  LIMIT ${limit}
),
visible_friends AS (
  SELECT
    f.id AS friend_id,
    f.display_name,
    MAX(sc.updated_at) AS updated_at
  FROM friends f
  JOIN support_cases sc ON sc.friend_id = f.id
  JOIN input ON input.line_account_id = sc.line_account_id
  WHERE ${visibleCaseCondition}
  GROUP BY f.id, f.display_name
  ORDER BY updated_at DESC
  LIMIT ${limit}
),
forbidden_friends AS (
  SELECT f.id AS friend_id, f.display_name, f.updated_at
  FROM friends f, input
  WHERE f.line_account_id = input.line_account_id
    AND NOT EXISTS (
      SELECT 1
      FROM support_cases sc
      WHERE sc.friend_id = f.id
        AND sc.line_account_id = input.line_account_id
        AND ${visibleCaseCondition}
    )
  ORDER BY f.updated_at DESC
  LIMIT ${limit}
)
`.trim();

  const selects = [
    `
SELECT
  'SUPPORT_CRM_STAFF_VISIBLE_CASE_ID' AS env_name,
  id AS value,
  'visible case' AS source,
  id AS case_id,
  friend_id,
  status,
  title,
  NULL AS display_name,
  updated_at
FROM visible_cases
ORDER BY updated_at DESC
`.trim(),
    `
SELECT
  'SUPPORT_CRM_STAFF_FORBIDDEN_CASE_ID' AS env_name,
  id AS value,
  'forbidden case' AS source,
  id AS case_id,
  friend_id,
  status,
  title,
  NULL AS display_name,
  updated_at
FROM forbidden_cases
ORDER BY updated_at DESC
`.trim(),
    `
SELECT
  'SUPPORT_CRM_STAFF_NON_RESOLVED_CASE_ID' AS env_name,
  id AS value,
  'visible non-resolved case' AS source,
  id AS case_id,
  friend_id,
  status,
  title,
  NULL AS display_name,
  updated_at
FROM visible_non_resolved_cases
ORDER BY updated_at DESC
`.trim(),
    `
SELECT
  'SUPPORT_CRM_STAFF_RESOLVED_CASE_ID' AS env_name,
  id AS value,
  'visible resolved case' AS source,
  id AS case_id,
  friend_id,
  status,
  title,
  NULL AS display_name,
  updated_at
FROM visible_resolved_cases
ORDER BY updated_at DESC
`.trim(),
    `
SELECT
  'SUPPORT_CRM_STAFF_VISIBLE_FRIEND_ID' AS env_name,
  friend_id AS value,
  'visible friend' AS source,
  NULL AS case_id,
  friend_id,
  NULL AS status,
  NULL AS title,
  display_name,
  updated_at
FROM visible_friends
ORDER BY updated_at DESC
`.trim(),
    `
SELECT
  'SUPPORT_CRM_STAFF_FORBIDDEN_FRIEND_ID' AS env_name,
  friend_id AS value,
  'forbidden friend' AS source,
  NULL AS case_id,
  friend_id,
  NULL AS status,
  NULL AS title,
  display_name,
  updated_at
FROM forbidden_friends
ORDER BY updated_at DESC
`.trim(),
    `
SELECT
  'SUPPORT_CRM_STAFF_RESOLVED_FRIEND_ID' AS env_name,
  friend_id AS value,
  'friend for visible resolved case' AS source,
  id AS case_id,
  friend_id,
  status,
  title,
  NULL AS display_name,
  updated_at
FROM visible_resolved_cases
ORDER BY updated_at DESC
`.trim(),
  ];

  return selects.map((select) => `${commonCtes}\n${select}`).join(';\n\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringifyCell(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

export function extractFixtureRows(value: unknown): FixtureCandidateRow[] {
  const rows: FixtureCandidateRow[] = [];

  function visit(node: unknown): void {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!isRecord(node)) return;
    if (Array.isArray(node.results)) {
      visit(node.results);
      return;
    }

    const envName = stringifyCell(node.env_name);
    const candidateValue = stringifyCell(node.value);
    if (envName && candidateValue) {
      rows.push({
        env_name: envName,
        value: candidateValue,
        source: stringifyCell(node.source) ?? undefined,
        case_id: stringifyCell(node.case_id),
        friend_id: stringifyCell(node.friend_id),
        status: stringifyCell(node.status),
        title: stringifyCell(node.title),
        display_name: stringifyCell(node.display_name),
        updated_at: stringifyCell(node.updated_at),
      });
    }
  }

  visit(value);
  return rows;
}

export function selectFixtureEnvCandidates(rows: FixtureCandidateRow[]): FixtureSelection {
  const selected: Record<string, string> = {};
  for (const envName of STRICT_ENV_NAMES) {
    const row = rows.find((item) => item.env_name === envName && item.value.trim());
    if (row) selected[envName] = row.value;
  }

  return {
    env: selected,
    missingEnvNames: STRICT_ENV_NAMES.filter((envName) => !selected[envName]),
  };
}

function formatRow(row: FixtureCandidateRow): string {
  const detail = [
    row.source,
    row.status ? `status=${row.status}` : null,
    row.case_id ? `case=${row.case_id}` : null,
    row.friend_id ? `friend=${row.friend_id}` : null,
  ].filter(Boolean).join(', ');
  return `- ${row.env_name}=${row.value}${detail ? ` (${detail})` : ''}`;
}

function formatStrictPreflightTemplate(selection: FixtureSelection, options: FixtureCandidateReportOptions): string[] {
  const lines = [
    'Strict Preflight command template:',
    '# Fill URL/API key placeholders locally. Do not paste real secrets into PRs or docs.',
    'export SUPPORT_CRM_API_URL=https://your-worker.example.com',
    'export SUPPORT_CRM_ADMIN_ORIGIN=https://your-admin.example.com',
    `export SUPPORT_CRM_LINE_ACCOUNT_ID=${options.lineAccountId ?? 'REPLACE_WITH_LINE_ACCOUNT_ID'}`,
    'export SUPPORT_CRM_OWNER_API_KEY=REPLACE_WITH_OWNER_OR_ADMIN_API_KEY',
    'export SUPPORT_CRM_STAFF_API_KEY=REPLACE_WITH_STAFF_API_KEY',
    'export SUPPORT_CRM_REQUIRE_FULL_COVERAGE=1',
  ];

  for (const envName of STRICT_ENV_NAMES) {
    const value = selection.env[envName];
    lines.push(value ? `export ${envName}=${value}` : `# TODO export ${envName}=<required-fixture-id>`);
  }

  lines.push('');
  lines.push('corepack pnpm preflight:support-crm:dry-run');
  lines.push('corepack pnpm preflight:support-crm > support-crm-preflight.log');
  lines.push('corepack pnpm preflight:support-crm:summary --file support-crm-preflight.log');
  return lines;
}

export function formatFixtureCandidateReport(rows: FixtureCandidateRow[], options: FixtureCandidateReportOptions = {}): string {
  const lines: string[] = [];
  const selection = selectFixtureEnvCandidates(rows);
  lines.push('Support CRM fixture candidates');
  lines.push('');

  if (Object.keys(selection.env).length > 0) {
    lines.push('Suggested strict Preflight env:');
    for (const envName of STRICT_ENV_NAMES) {
      const value = selection.env[envName];
      if (value) lines.push(`export ${envName}=${value}`);
    }
  } else {
    lines.push('No fixture candidates found.');
  }

  if (selection.missingEnvNames.length > 0) {
    lines.push('');
    lines.push('Missing fixture candidates:');
    selection.missingEnvNames.forEach((envName) => lines.push(`- ${envName}`));
  }

  if (rows.length > 0) {
    lines.push('');
    lines.push('All candidates:');
    rows.forEach((row) => lines.push(formatRow(row)));
  }

  lines.push('');
  lines.push(...formatStrictPreflightTemplate(selection, options));
  lines.push('');
  lines.push('Next: run the dry-run first. Only run strict Preflight after every TODO fixture env is filled, then paste only the PR-safe summary.');
  return `${lines.join('\n')}\n`;
}

function runWrangler(config: SupportCrmFixtureConfig, sql: string): { ok: true; rows: FixtureCandidateRow[] } | { ok: false; error: string; raw?: string } {
  const args = [
    'pnpm',
    'exec',
    'wrangler',
    'd1',
    'execute',
    config.database,
    '--config',
    config.wranglerConfig,
    '--command',
    sql,
    '--json',
    config.remote ? '--remote' : '--local',
  ];
  if (config.wranglerEnv) args.push('--env', config.wranglerEnv);

  const result = spawnSync('corepack', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    return {
      ok: false,
      error: result.stderr.trim() || result.stdout.trim() || `wrangler exited with ${result.status ?? 'unknown status'}`,
      raw: result.stdout,
    };
  }

  try {
    const parsed = JSON.parse(result.stdout);
    return { ok: true, rows: extractFixtureRows(parsed) };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'failed to parse wrangler JSON output',
      raw: result.stdout,
    };
  }
}

function usage(): string {
  return [
    'Support CRM strict Preflight fixture candidate helper.',
    '',
    'Required env:',
    '  SUPPORT_CRM_LINE_ACCOUNT_ID',
    '  SUPPORT_CRM_STAFF_NAME',
    '',
    'Optional env:',
    '  SUPPORT_CRM_STAFF_MEMBER_ID       disambiguates duplicate staff names',
    '  SUPPORT_CRM_FIXTURE_LIMIT=3       rows per fixture type, 1-20',
    '  SUPPORT_CRM_D1_DATABASE=DB        D1 database name or binding',
    '  SUPPORT_CRM_D1_CONFIG=apps/worker/wrangler.toml',
    '  SUPPORT_CRM_D1_ENV=production     wrangler --env value',
    '  SUPPORT_CRM_D1_REMOTE=1           1=--remote, 0=--local',
    '',
    'Modes:',
    '  --print-sql  print the read-only SQL only',
    '  --run        run wrangler d1 execute and print env suggestions',
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

  const sql = buildFixtureCandidateSql(parsed.config);
  if (argv.includes('--print-sql') || !argv.includes('--run')) {
    stdout.write(`${sql}\n`);
    exit(0);
  }

  const result = runWrangler(parsed.config, sql);
  if (!result.ok) {
    stderr.write(`support-crm-fixture-candidates: ${result.error}\n`);
    if (result.raw) stderr.write(`\nRaw output:\n${result.raw}\n`);
    exit(1);
  }

  stdout.write(formatFixtureCandidateReport(result.rows, { lineAccountId: parsed.config.lineAccountId }));
  exit(result.rows.length > 0 ? 0 : 1);
}

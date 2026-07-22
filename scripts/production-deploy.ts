#!/usr/bin/env tsx

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { argv, env, stderr, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { checkMigration, type CheckResult } from './check-migrations.js';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_MIGRATIONS_DIR = join(ROOT_DIR, 'packages/db/migrations');
const DEFAULT_WRANGLER_CONFIG = join(ROOT_DIR, 'apps/worker/wrangler.toml');
const MIGRATION_NAME_PATTERN = /^\d{3}_[A-Za-z0-9][A-Za-z0-9._-]*\.sql$/;
const WORKER_VERSION_PATTERN = /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i;

export type MigrationFile = {
  name: string;
  path: string;
  sql: string;
};

export type MigrationLedgerState = {
  exists: boolean;
  appliedNames: string[];
};

export type MigrationPlan = {
  orderedNames: string[];
  pendingNames: string[];
};

export const CORE_TABLES = [
  'line_accounts',
  'friends',
  'messages_log',
  'chats',
  'support_cases',
  'support_case_events',
  'support_escalations',
  'support_internal_messages',
  'chat_internal_messages',
  'internal_message_events',
  'internal_message_bookmark_events',
  'internal_tasks',
  'internal_task_events',
  'support_case_attachments',
  'chat_confirmation_events',
  'support_case_followup_reminders',
  'support_case_followup_reminder_events',
  'line_conversations',
  'line_conversation_messages',
] as const;

export type CoreTableName = typeof CORE_TABLES[number];
export type CoreTableCounts = Record<CoreTableName, number>;

export type CoreTableDecrease = {
  table: CoreTableName;
  before: number;
  after: number;
};

export type SmokeResult =
  | { ok: true }
  | { ok: false; reason: string };

export type ProductionDeployConfig = {
  rootDir: string;
  wranglerConfigPath: string;
  migrationsDir: string;
  databaseName: string;
  workerName: string;
  workerUrl: string;
  smokeApiKey: string;
  backupDir: string;
  smokeAttempts: number;
  smokeDelayMs: number;
};

export type ProductionDeployDependencies = {
  buildWorker: () => Promise<void>;
  readMigrationLedger: () => Promise<MigrationLedgerState>;
  readCurrentDeployments: () => Promise<unknown>;
  backupDatabase: (backupPath: string) => Promise<void>;
  ensureMigrationLedger: () => Promise<void>;
  readCoreTableCounts: () => Promise<CoreTableCounts>;
  applyMigration: (migration: MigrationFile) => Promise<void>;
  deployWorker: () => Promise<void>;
  smokeWorker: () => Promise<SmokeResult>;
  rollbackWorker: (versionId: string) => Promise<void>;
  log: (message: string) => void;
  now: () => Date;
};

export type ProductionDeployResult = {
  backupPath: string | null;
  appliedMigrations: string[];
  rollbackVersionId: string;
};

type CommandResult = {
  stdout: string;
  stderr: string;
};

type CommandOptions = {
  printOutput?: boolean;
};

type WranglerDefaults = {
  databaseName: string;
  workerName: string;
  workerUrl: string;
};

const EXTRA_DESTRUCTIVE_RULES: Array<{ label: string; pattern: RegExp }> = [
  {
    label: 'DELETE FROM is forbidden in production migrations',
    pattern: /\bDELETE\s+FROM\b/i,
  },
  {
    label: 'UPDATE backfills are forbidden in automatic production migrations',
    pattern: /\bUPDATE\s+(?:["`\[]?[A-Za-z_][\w$]*["`\]]?)\s+SET\b/i,
  },
  {
    label: 'REPLACE is forbidden in production migrations',
    pattern: /\b(?:INSERT\s+OR\s+REPLACE|REPLACE\s+INTO)\b/i,
  },
  {
    label: 'DROP of schema objects is forbidden in production migrations',
    pattern: /\bDROP\s+(?:INDEX|TRIGGER|VIEW)\b/i,
  },
  {
    label: 'TRUNCATE is forbidden in production migrations',
    pattern: /\bTRUNCATE\b/i,
  },
  {
    label: 'VACUUM is forbidden in automatic production migrations',
    pattern: /\bVACUUM\b/i,
  },
  {
    label: 'writable_schema must never be enabled by a production migration',
    pattern: /\bPRAGMA\s+writable_schema\b/i,
  },
];

function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const index = line.indexOf('--');
      return index === -1 ? line : line.slice(0, index);
    })
    .join('\n');
}

/** Production-only checks layered on top of the repository migration policy. */
export function checkProductionMigration(sql: string): CheckResult {
  const repositoryResult = checkMigration(sql);
  if (!repositoryResult.ok) return repositoryResult;

  const stripped = stripSqlComments(sql);
  for (const rule of EXTRA_DESTRUCTIVE_RULES) {
    const match = stripped.match(rule.pattern);
    if (match) {
      return {
        ok: false,
        violation: `${rule.label} (matched: "${match[0].trim()}")`,
      };
    }
  }
  return { ok: true };
}

/**
 * Applied migrations must be an exact prefix of the sorted local files.
 * This turns gaps such as 068/069 missing while 070 exists into a hard stop.
 */
export function planPendingMigrations(
  localNames: string[],
  appliedNames: string[],
): MigrationPlan {
  if (localNames.length === 0) {
    throw new Error('migrationファイルが見つかりません');
  }

  for (const name of localNames) {
    if (!MIGRATION_NAME_PATTERN.test(name)) {
      throw new Error(`migration名が規則に合っていません: ${name}`);
    }
  }

  const orderedNames = [...localNames].sort();
  if (new Set(orderedNames).size !== orderedNames.length) {
    throw new Error('同名のmigrationファイルがあります');
  }
  if (new Set(appliedNames).size !== appliedNames.length) {
    throw new Error('本番migration台帳に重複があります');
  }

  const localSet = new Set(orderedNames);
  const unknownApplied = appliedNames.filter((name) => !localSet.has(name));
  if (unknownApplied.length > 0) {
    throw new Error(
      `本番だけに存在するmigration記録があります: ${unknownApplied.sort().join(', ')}`,
    );
  }

  const appliedSet = new Set(appliedNames);
  let foundPending = false;
  for (const name of orderedNames) {
    if (!appliedSet.has(name)) {
      foundPending = true;
      continue;
    }
    if (foundPending) {
      throw new Error(
        `migrationの適用順が破綻しています: 未適用migrationより後の${name}が適用済みです`,
      );
    }
  }

  return {
    orderedNames,
    pendingNames: orderedNames.filter((name) => !appliedSet.has(name)),
  };
}

export function parseD1Rows(raw: string): Array<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Wranglerから有効なJSONが返りませんでした');
  }

  const containers = Array.isArray(parsed) ? parsed : [parsed];
  const rows: Array<Record<string, unknown>> = [];
  for (const container of containers) {
    if (!container || typeof container !== 'object') continue;
    const results = (container as { results?: unknown }).results;
    if (!Array.isArray(results)) continue;
    for (const row of results) {
      if (row && typeof row === 'object' && !Array.isArray(row)) {
        rows.push(row as Record<string, unknown>);
      }
    }
  }
  return rows;
}

export function selectRollbackVersion(deploymentsInput: unknown): string {
  const deployments = Array.isArray(deploymentsInput)
    ? deploymentsInput
    : deploymentsInput && typeof deploymentsInput === 'object'
      ? (deploymentsInput as { deployments?: unknown }).deployments
      : null;

  if (!Array.isArray(deployments) || deployments.length === 0) {
    throw new Error('現在稼働中のWorkerバージョンを取得できません');
  }

  const sorted = [...deployments].sort((left, right) => {
    const leftDate = String((left as { created_on?: unknown })?.created_on ?? '');
    const rightDate = String((right as { created_on?: unknown })?.created_on ?? '');
    return leftDate.localeCompare(rightDate);
  });
  const latest = sorted.at(-1);
  if (!latest || typeof latest !== 'object') {
    throw new Error('現在のWorkerデプロイ情報が不正です');
  }

  const versions = (latest as { versions?: unknown }).versions;
  if (!Array.isArray(versions)) {
    throw new Error('現在のWorkerバージョン情報が不正です');
  }
  const activeVersions = versions.filter((version) => {
    const percentage = Number((version as { percentage?: unknown })?.percentage);
    return Number.isFinite(percentage) && percentage > 0;
  });
  if (activeVersions.length !== 1) {
    throw new Error('段階デプロイ中のため自動rollback先を一意に決められません');
  }

  const active = activeVersions[0] as {
    percentage?: unknown;
    version_id?: unknown;
  };
  if (Math.abs(Number(active.percentage) - 100) > 0.001) {
    throw new Error('現在のWorkerが100%単一バージョンではありません');
  }
  const versionId = String(active.version_id ?? '');
  if (!WORKER_VERSION_PATTERN.test(versionId)) {
    throw new Error('rollback先のWorkerバージョンIDが不正です');
  }
  return versionId;
}

export function assessSmokeResponse(status: number, body: unknown): SmokeResult {
  if (status !== 200) {
    return { ok: false, reason: `HTTP ${status}` };
  }
  if (!body || typeof body !== 'object') {
    return { ok: false, reason: 'JSONレスポンスではありません' };
  }
  const response = body as { success?: unknown; data?: unknown };
  if (response.success !== true || !Array.isArray(response.data)) {
    return { ok: false, reason: 'チャット一覧の応答形式が不正です' };
  }
  return { ok: true };
}

export function redactSecrets(message: string, secrets: string[]): string {
  let redacted = message.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]');
  const uniqueSecrets = [...new Set(secrets.filter((value) => value.length >= 4))]
    .sort((left, right) => right.length - left.length);
  for (const secret of uniqueSecrets) {
    redacted = redacted.split(secret).join('[REDACTED]');
  }
  return redacted;
}

export function buildBackupPath(
  backupDir: string,
  databaseName: string,
  now: Date,
): string {
  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  const safeDatabaseName = databaseName.replace(/[^A-Za-z0-9_-]/g, '_');
  return join(backupDir, `${timestamp}-${safeDatabaseName}.sql`);
}

export function buildAtomicMigrationSql(migration: MigrationFile): string {
  const body = migration.sql.trimEnd();
  const terminatedBody = body.endsWith(';') ? body : `${body};`;
  return [
    `-- ${migration.name} and its ledger marker are ingested as one D1 import.`,
    terminatedBody,
    '',
    `INSERT INTO _migrations (name, applied_at) VALUES (${sqlString(migration.name)}, datetime('now'));`,
    '',
  ].join('\n');
}

export function findCoreTableCountDecreases(
  before: CoreTableCounts,
  after: CoreTableCounts,
): CoreTableDecrease[] {
  return CORE_TABLES.flatMap((table) => after[table] < before[table]
    ? [{ table, before: before[table], after: after[table] }]
    : []);
}

export function isPathInside(parentPath: string, childPath: string): boolean {
  const pathFromParent = relative(resolve(parentPath), resolve(childPath));
  return pathFromParent === ''
    || (!pathFromParent.startsWith('..') && !isAbsolute(pathFromParent));
}

export function buildWranglerCliArgs(
  wranglerConfigPath: string,
  ...args: string[]
): string[] {
  return [
    'pnpm',
    'exec',
    'wrangler',
    ...args,
    '--config',
    wranglerConfigPath,
  ];
}

export function parseWranglerDefaults(toml: string): WranglerDefaults {
  const defaultSection = toml.split(/^\[env\./m, 1)[0] ?? toml;
  const workerName = defaultSection.match(/^name\s*=\s*"([^"]+)"/m)?.[1] ?? '';
  const databaseName = defaultSection.match(/^database_name\s*=\s*"([^"]+)"/m)?.[1] ?? '';
  const workerUrl = defaultSection.match(/^WORKER_PUBLIC_URL\s*=\s*"([^"]+)"/m)?.[1] ?? '';
  if (!workerName || !databaseName || !workerUrl) {
    throw new Error('wrangler.tomlからWorker名、D1名、公開URLを取得できません');
  }
  return { workerName, databaseName, workerUrl };
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('smoke testの回数と待機時間は正の整数で指定してください');
  }
  return parsed;
}

export function resolveProductionDeployConfig(
  source: NodeJS.ProcessEnv,
  options: {
    rootDir?: string;
    homeDir?: string;
    tempDir?: string;
    wranglerConfigPath?: string;
  } = {},
): ProductionDeployConfig {
  const rootDir = options.rootDir ?? ROOT_DIR;
  const wranglerConfigPath = options.wranglerConfigPath ?? join(rootDir, 'apps/worker/wrangler.toml');
  const defaults = parseWranglerDefaults(readFileSync(wranglerConfigPath, 'utf8'));
  const smokeApiKey = source.PRODUCTION_SMOKE_API_KEY?.trim()
    || source.SUPPORT_CRM_OWNER_API_KEY?.trim()
    || '';
  if (!smokeApiKey) {
    throw new Error(
      'PRODUCTION_SMOKE_API_KEYまたはSUPPORT_CRM_OWNER_API_KEYを安全な環境変数として設定してください',
    );
  }

  const workerUrl = (source.PRODUCTION_WORKER_URL?.trim() || defaults.workerUrl).replace(/\/$/, '');
  const parsedWorkerUrl = new URL(workerUrl);
  if (parsedWorkerUrl.protocol !== 'https:' || parsedWorkerUrl.hostname === 'localhost') {
    throw new Error('本番smoke testのURLはlocalhost以外のHTTPS URLである必要があります');
  }

  const isCi = source.CI === 'true' || source.GITHUB_ACTIONS === 'true';
  const backupDir = resolve(
    source.PRODUCTION_D1_BACKUP_DIR?.trim()
      || (isCi
        ? join(source.RUNNER_TEMP?.trim() || options.tempDir || tmpdir(), 'l-link-d1-backups')
        : join(options.homeDir ?? homedir(), '.l-link', 'backups', 'd1')),
  );
  const githubWorkspace = source.GITHUB_WORKSPACE?.trim();
  if (isCi && githubWorkspace && isPathInside(githubWorkspace, backupDir)) {
    throw new Error(
      'CIのD1バックアップ先をGitHub workspace配下には設定できません',
    );
  }

  return {
    rootDir,
    wranglerConfigPath,
    migrationsDir: join(rootDir, 'packages/db/migrations'),
    databaseName: defaults.databaseName,
    workerName: defaults.workerName,
    workerUrl,
    smokeApiKey,
    backupDir,
    smokeAttempts: Math.min(parsePositiveInteger(source.PRODUCTION_SMOKE_ATTEMPTS, 5), 10),
    smokeDelayMs: Math.min(parsePositiveInteger(source.PRODUCTION_SMOKE_DELAY_MS, 2_000), 30_000),
  };
}

function migrationMap(migrations: MigrationFile[]): Map<string, MigrationFile> {
  return new Map(migrations.map((migration) => [migration.name, migration]));
}

export async function runProductionDeployment(
  config: ProductionDeployConfig,
  migrations: MigrationFile[],
  dependencies: ProductionDeployDependencies,
): Promise<ProductionDeployResult> {
  dependencies.log('Workerをローカルでビルドして事前確認します');
  await dependencies.buildWorker();

  const initialLedger = await dependencies.readMigrationLedger();
  const plan = planPendingMigrations(
    migrations.map((migration) => migration.name),
    initialLedger.appliedNames,
  );
  const byName = migrationMap(migrations);
  const pending = plan.pendingNames.map((name) => {
    const migration = byName.get(name);
    if (!migration) throw new Error(`migrationを読み込めません: ${name}`);
    const safety = checkProductionMigration(migration.sql);
    if (!safety.ok) {
      throw new Error(`${name}: ${safety.violation}`);
    }
    return migration;
  });

  const deploymentData = await dependencies.readCurrentDeployments();
  const rollbackVersionId = selectRollbackVersion(deploymentData);
  let backupPath: string | null = null;

  if (pending.length > 0) {
    backupPath = buildBackupPath(config.backupDir, config.databaseName, dependencies.now());
    dependencies.log(`D1全体をmigration前にバックアップします: ${backupPath}`);
    await dependencies.backupDatabase(backupPath);
    const countsBefore = await dependencies.readCoreTableCounts();
    if (!initialLedger.exists) {
      await dependencies.ensureMigrationLedger();
    }
    for (const migration of pending) {
      dependencies.log(`migrationを順番に適用します: ${migration.name}`);
      await dependencies.applyMigration(migration);
    }

    const countsAfter = await dependencies.readCoreTableCounts();
    const decreases = findCoreTableCountDecreases(countsBefore, countsAfter);
    if (decreases.length > 0) {
      const details = decreases
        .map((decrease) => `${decrease.table}: ${decrease.before} -> ${decrease.after}`)
        .join(', ');
      throw new Error(
        `重要テーブルの件数が減少したためWorkerをデプロイしません: ${details}`,
      );
    }

    const verifiedLedger = await dependencies.readMigrationLedger();
    const verifiedPlan = planPendingMigrations(
      migrations.map((migration) => migration.name),
      verifiedLedger.appliedNames,
    );
    if (!verifiedLedger.exists || verifiedPlan.pendingNames.length > 0) {
      throw new Error('migration適用後の台帳確認に失敗したためWorkerをデプロイしません');
    }
  } else {
    dependencies.log('未適用migrationはありません');
  }

  dependencies.log('DBの準備完了後にWorkerをデプロイします');
  try {
    await dependencies.deployWorker();
  } catch (deployError) {
    dependencies.log('Workerデプロイコマンドが失敗したため直前のWorkerへrollbackします');
    try {
      await dependencies.rollbackWorker(rollbackVersionId);
    } catch (rollbackError) {
      const deployReason = deployError instanceof Error ? deployError.message : String(deployError);
      const rollbackReason = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      throw new Error(
        `Workerデプロイとrollbackの両方に失敗しました: deploy=${deployReason}; rollback=${rollbackReason}`,
      );
    }
    throw new Error('Workerデプロイコマンドに失敗したため直前のWorkerへrollbackしました');
  }
  const smoke = await dependencies.smokeWorker();
  if (smoke.ok) {
    dependencies.log('認証付きチャット一覧smoke testに成功しました');
    return {
      backupPath,
      appliedMigrations: pending.map((migration) => migration.name),
      rollbackVersionId,
    };
  }

  dependencies.log(`smoke test失敗のため直前のWorkerへrollbackします: ${smoke.reason}`);
  await dependencies.rollbackWorker(rollbackVersionId);
  const rollbackSmoke = await dependencies.smokeWorker();
  if (!rollbackSmoke.ok) {
    throw new Error(
      `Workerをrollbackしましたが復旧確認にも失敗しました: ${rollbackSmoke.reason}`,
    );
  }
  throw new Error('新Workerのsmoke testに失敗したため直前のWorkerへrollbackしました');
}

function collectSecretValues(source: NodeJS.ProcessEnv, smokeApiKey: string): string[] {
  const secrets = [smokeApiKey];
  for (const [key, value] of Object.entries(source)) {
    if (value && /(TOKEN|SECRET|PASSWORD|API_KEY|COOKIE|AUTH)/i.test(key)) {
      secrets.push(value);
    }
  }
  return secrets;
}

function createCommandRunner(
  config: ProductionDeployConfig,
  source: NodeJS.ProcessEnv,
): (command: string, args: string[], options?: CommandOptions) => CommandResult {
  const secrets = collectSecretValues(source, config.smokeApiKey);
  return (command, args, options = {}) => {
    const result = spawnSync(command, args, {
      cwd: config.rootDir,
      env: source,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const safeStdout = redactSecrets(result.stdout ?? '', secrets);
    const safeStderr = redactSecrets(result.stderr ?? '', secrets);
    if (options.printOutput !== false) {
      if (safeStdout) stdout.write(safeStdout);
      if (safeStderr) stderr.write(safeStderr);
    }
    if (result.error) {
      throw new Error(redactSecrets(result.error.message, secrets));
    }
    if (result.status !== 0) {
      const detail = (safeStderr || safeStdout).trim();
      throw new Error(detail || `${command}が終了コード${String(result.status)}で失敗しました`);
    }
    // Keep raw output only in memory for JSON parsing. Everything written to
    // the terminal or included in an error has already been redacted above.
    return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function emptyCoreTableCounts(): CoreTableCounts {
  return Object.fromEntries(CORE_TABLES.map((table) => [table, 0])) as CoreTableCounts;
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function authenticatedSmokeTest(
  config: ProductionDeployConfig,
): Promise<SmokeResult> {
  let lastFailure: SmokeResult = { ok: false, reason: '未実行' };
  for (let attempt = 1; attempt <= config.smokeAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(`${config.workerUrl}/api/chats`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${config.smokeApiKey}`,
        },
        signal: controller.signal,
      });
      const body: unknown = await response.json().catch(() => null);
      lastFailure = assessSmokeResponse(response.status, body);
      if (lastFailure.ok) return lastFailure;
    } catch (error) {
      lastFailure = {
        ok: false,
        reason: error instanceof Error && error.name === 'AbortError'
          ? '15秒でタイムアウトしました'
          : 'Workerへ接続できませんでした',
      };
    } finally {
      clearTimeout(timeout);
    }
    if (attempt < config.smokeAttempts) await sleep(config.smokeDelayMs);
  }
  return lastFailure;
}

function loadMigrationFiles(migrationsDir: string): MigrationFile[] {
  return readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => ({
      name,
      path: join(migrationsDir, name),
      sql: readFileSync(join(migrationsDir, name), 'utf8'),
    }));
}

export function createProductionDependencies(
  config: ProductionDeployConfig,
  source: NodeJS.ProcessEnv,
): ProductionDeployDependencies {
  const run = createCommandRunner(config, source);
  const wranglerArgs = (...args: string[]): string[] => buildWranglerCliArgs(
    config.wranglerConfigPath,
    ...args,
  );

  const executeD1 = (sql: string): CommandResult => run(
    'corepack',
    wranglerArgs(
      'd1',
      'execute',
      config.databaseName,
      '--remote',
      '--command',
      sql,
      '--json',
      '--yes',
    ),
    { printOutput: false },
  );

  return {
    buildWorker: async () => {
      run('corepack', ['pnpm', '--filter', 'worker', 'build']);
    },
    readMigrationLedger: async () => {
      const existence = executeD1(
        "SELECT CASE WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_migrations') THEN 1 ELSE 0 END AS ledger_exists",
      );
      const exists = Number(parseD1Rows(existence.stdout)[0]?.ledger_exists ?? 0) === 1;
      if (!exists) return { exists: false, appliedNames: [] };
      const applied = executeD1('SELECT name FROM _migrations ORDER BY name');
      return {
        exists: true,
        appliedNames: parseD1Rows(applied.stdout).map((row) => String(row.name ?? '')),
      };
    },
    readCurrentDeployments: async () => {
      const result = run(
        'corepack',
        wranglerArgs('deployments', 'list', '--name', config.workerName, '--json'),
        { printOutput: false },
      );
      try {
        return JSON.parse(result.stdout) as unknown;
      } catch {
        throw new Error('現在のWorkerデプロイ情報をJSONで取得できません');
      }
    },
    backupDatabase: async (backupPath) => {
      mkdirSync(dirname(backupPath), { recursive: true, mode: 0o700 });
      chmodSync(dirname(backupPath), 0o700);
      const previousUmask = process.umask(0o077);
      try {
        run('corepack', wranglerArgs(
          'd1',
          'export',
          config.databaseName,
          '--remote',
          '--output',
          backupPath,
        ));
      } finally {
        process.umask(previousUmask);
      }
      const size = statSync(backupPath).size;
      if (size <= 0) throw new Error('D1バックアップが空のため処理を中断します');
      chmodSync(backupPath, 0o600);
    },
    ensureMigrationLedger: async () => {
      executeD1(
        'CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
      );
    },
    readCoreTableCounts: async () => {
      const quotedNames = CORE_TABLES.map((table) => sqlString(table)).join(', ');
      const tableRows = executeD1(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${quotedNames}) ORDER BY name`,
      );
      const existingTables = new Set(
        parseD1Rows(tableRows.stdout).map((row) => String(row.name ?? '')),
      );
      const counts = emptyCoreTableCounts();
      for (const table of CORE_TABLES) {
        if (!existingTables.has(table)) continue;
        const result = executeD1(`SELECT COUNT(*) AS row_count FROM "${table}"`);
        const count = Number(parseD1Rows(result.stdout)[0]?.row_count);
        if (!Number.isSafeInteger(count) || count < 0) {
          throw new Error(`重要テーブル${table}の件数を確認できません`);
        }
        counts[table] = count;
      }
      return counts;
    },
    applyMigration: async (migration) => {
      const temporaryDirectory = mkdtempSync(join(tmpdir(), 'l-link-migration-'));
      const importPath = join(temporaryDirectory, migration.name);
      try {
        writeFileSync(importPath, buildAtomicMigrationSql(migration), {
          encoding: 'utf8',
          mode: 0o600,
          flag: 'wx',
        });
        run('corepack', wranglerArgs(
          'd1',
          'execute',
          config.databaseName,
          '--remote',
          '--file',
          importPath,
          '--yes',
        ));
      } finally {
        rmSync(temporaryDirectory, { recursive: true, force: true });
      }
    },
    deployWorker: async () => {
      run('corepack', ['pnpm', '--filter', 'worker', 'deploy:raw']);
    },
    smokeWorker: async () => authenticatedSmokeTest(config),
    rollbackWorker: async (versionId) => {
      run('corepack', wranglerArgs(
        'rollback',
        versionId,
        '--name',
        config.workerName,
        '--message',
        'Automated rollback after authenticated smoke test failure',
        '--yes',
      ));
    },
    log: (message) => stdout.write(`${message}\n`),
    now: () => new Date(),
  };
}

function printHelp(): void {
  stdout.write(`L-Link production Worker deploy\n\n`);
  stdout.write(`Usage: corepack pnpm deploy:worker\n\n`);
  stdout.write(`Required secret environment variable:\n`);
  stdout.write(`  PRODUCTION_SMOKE_API_KEY (or SUPPORT_CRM_OWNER_API_KEY)\n\n`);
  stdout.write(`Optional:\n`);
  stdout.write(`  PRODUCTION_WORKER_URL\n`);
  stdout.write(`  PRODUCTION_D1_BACKUP_DIR\n`);
  stdout.write(`  PRODUCTION_SMOKE_ATTEMPTS\n`);
  stdout.write(`  PRODUCTION_SMOKE_DELAY_MS\n`);
}

async function main(rawArgs: string[]): Promise<void> {
  if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
    printHelp();
    return;
  }
  if (rawArgs.length > 0) {
    throw new Error(`未対応の引数です: ${rawArgs.join(' ')}`);
  }
  const config = resolveProductionDeployConfig(env, {
    rootDir: ROOT_DIR,
    homeDir: homedir(),
    wranglerConfigPath: DEFAULT_WRANGLER_CONFIG,
  });
  const migrations = loadMigrationFiles(DEFAULT_MIGRATIONS_DIR);
  const dependencies = createProductionDependencies(config, env);
  await runProductionDeployment(config, migrations, dependencies);
  stdout.write('本番Workerの安全デプロイが完了しました\n');
}

const isCliEntry = argv[1]
  ? fileURLToPath(import.meta.url) === resolve(argv[1])
  : false;

if (isCliEntry) {
  main(argv.slice(2)).catch((error: unknown) => {
    const source = error instanceof Error ? error.message : String(error);
    const secrets = collectSecretValues(env, env.PRODUCTION_SMOKE_API_KEY ?? '');
    stderr.write(`本番デプロイを中断しました: ${redactSecrets(source, secrets)}\n`);
    process.exitCode = 1;
  });
}

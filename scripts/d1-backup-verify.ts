#!/usr/bin/env tsx

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { argv, stderr, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { CORE_TABLES, type CoreTableName } from './production-deploy.js';

export const BACKUP_REQUIRED_TABLES = [
  ...CORE_TABLES,
  'internal_conversations',
  'internal_conversation_reads',
  'internal_message_mentions',
  'internal_task_assignees',
  'internal_task_comments',
  'app_notification_inbox',
] as const;

type WranglerQuery = {
  results?: unknown;
};

export type BackupSnapshot = {
  tableNames: string[];
  protectedCounts: Record<CoreTableName, number>;
};

export function buildBackupVerificationSql(): string {
  return [
    'SELECT',
    "  (SELECT json_group_array(name) FROM (SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name)) AS table_names_json,",
    ...CORE_TABLES.map((table, index) => (
      `  (SELECT COUNT(*) FROM "${table}") AS count_${table}${index === CORE_TABLES.length - 1 ? ';' : ','}`
    )),
  ].join('\n');
}

function queryRows(payload: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(payload)) throw new Error('Wranglerの検証結果が配列ではありません');
  const rows: Array<Record<string, unknown>> = [];
  for (const item of payload) {
    if (!item || typeof item !== 'object') continue;
    const results = (item as WranglerQuery).results;
    if (Array.isArray(results)) {
      for (const row of results) {
        if (row && typeof row === 'object') rows.push(row as Record<string, unknown>);
      }
      continue;
    }
    rows.push(item as Record<string, unknown>);
  }
  return rows;
}

export function parseBackupSnapshot(payload: unknown): BackupSnapshot {
  const rows = queryRows(payload);
  if (rows.length !== 1) throw new Error('バックアップ検証結果が1行ではありません');
  const row = rows[0];
  const tableNamesRaw = row.table_names_json;
  if (typeof tableNamesRaw !== 'string') {
    throw new Error('バックアップ対象テーブルを確認できません');
  }
  const decodedTableNames: unknown = JSON.parse(tableNamesRaw);
  if (!Array.isArray(decodedTableNames)) {
    throw new Error('バックアップ対象テーブルの形式が不正です');
  }
  const tableNames = decodedTableNames.filter(
    (name): name is string => typeof name === 'string' && name.length > 0,
  );
  if (tableNames.length !== decodedTableNames.length) {
    throw new Error('バックアップ対象テーブルの形式が不正です');
  }
  if (tableNames.length === 0) throw new Error('バックアップ対象テーブルを確認できません');
  if (new Set(tableNames).size !== tableNames.length) {
    throw new Error('バックアップ対象テーブルの一覧に重複があります');
  }

  const counts = new Map<CoreTableName, number>();
  for (const table of CORE_TABLES) {
    const count = Number(row[`count_${table}`]);
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(`重要テーブル${table}の件数が不正です`);
    }
    counts.set(table, count);
  }

  return {
    tableNames: [...tableNames].sort(),
    protectedCounts: Object.fromEntries(counts) as Record<CoreTableName, number>,
  };
}

export function assertIntegrityCheck(payload: unknown): void {
  const rows = queryRows(payload);
  const values = rows.flatMap((row) => Object.entries(row))
    .filter(([key]) => key.toLowerCase().includes('integrity_check'))
    .map(([, value]) => value);
  if (values.length !== 1 || values[0] !== 'ok') {
    throw new Error('復元したD1のintegrity_checkが正常ではありません');
  }
}

export function assertForeignKeyCheck(payload: unknown): void {
  const rows = queryRows(payload);
  const values = rows.flatMap((row) => Object.entries(row))
    .filter(([key]) => key.toLowerCase().includes('foreign_key_check'))
    .map(([, value]) => value);
  if (values.length !== 1 || values[0] !== 'ok') {
    throw new Error('復元したD1の外部キー整合性が正常ではありません');
  }
}

export function validateRestoredBackup(
  source: BackupSnapshot,
  restored: BackupSnapshot,
): void {
  const sourceTables = new Set(source.tableNames);
  const restoredTables = new Set(restored.tableNames);
  const missingRequired = BACKUP_REQUIRED_TABLES.filter((table) => !sourceTables.has(table));
  if (missingRequired.length > 0) {
    throw new Error(`本番D1に必須テーブルがありません: ${missingRequired.join(', ')}`);
  }
  const missingRestored = source.tableNames.filter((table) => !restoredTables.has(table));
  if (missingRestored.length > 0) {
    throw new Error(`復元後に不足しているテーブルがあります: ${missingRestored.join(', ')}`);
  }
  const decreased = CORE_TABLES.flatMap((table) => {
    const before = source.protectedCounts[table];
    const after = restored.protectedCounts[table];
    return after < before ? [`${table}: ${before} -> ${after}`] : [];
  });
  if (decreased.length > 0) {
    throw new Error(`復元後に重要テーブルの件数が減っています: ${decreased.join(', ')}`);
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

type VerifyCliOptions = {
  sourcePath: string;
  restoredPath: string;
  integrityPath: string;
  foreignKeyPath: string;
  encryptedPath: string;
  receiptPath: string;
};

function parseVerifyOptions(rawArgs: string[]): VerifyCliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < rawArgs.length; index += 2) {
    const key = rawArgs[index];
    const value = rawArgs[index + 1];
    if (!key?.startsWith('--') || !value) throw new Error('verifyの引数が不正です');
    values.set(key, value);
  }
  const required = [
    '--source',
    '--restored',
    '--integrity',
    '--foreign-key',
    '--encrypted',
    '--receipt',
  ] as const;
  for (const key of required) {
    if (!values.get(key)) throw new Error(`${key}が必要です`);
  }
  return {
    sourcePath: values.get('--source')!,
    restoredPath: values.get('--restored')!,
    integrityPath: values.get('--integrity')!,
    foreignKeyPath: values.get('--foreign-key')!,
    encryptedPath: values.get('--encrypted')!,
    receiptPath: values.get('--receipt')!,
  };
}

async function verifyFromFiles(options: VerifyCliOptions): Promise<void> {
  const [
    sourceRaw,
    restoredRaw,
    integrityRaw,
    foreignKeyRaw,
    encryptedStat,
    encryptedSha256,
  ] = await Promise.all([
    readFile(options.sourcePath, 'utf8'),
    readFile(options.restoredPath, 'utf8'),
    readFile(options.integrityPath, 'utf8'),
    readFile(options.foreignKeyPath, 'utf8'),
    stat(options.encryptedPath),
    sha256File(options.encryptedPath),
  ]);
  if (!encryptedStat.isFile() || encryptedStat.size <= 0) {
    throw new Error('暗号化バックアップが空です');
  }
  const source = parseBackupSnapshot(JSON.parse(sourceRaw) as unknown);
  const restored = parseBackupSnapshot(JSON.parse(restoredRaw) as unknown);
  assertIntegrityCheck(JSON.parse(integrityRaw) as unknown);
  assertForeignKeyCheck(JSON.parse(foreignKeyRaw) as unknown);
  validateRestoredBackup(source, restored);

  await writeFile(options.receiptPath, `${JSON.stringify({
    formatVersion: 1,
    verifiedAt: new Date().toISOString(),
    encryption: 'AES-256-GCM',
    encryptedBytes: encryptedStat.size,
    encryptedSha256,
    sourceTableCount: source.tableNames.length,
    protectedTableCount: CORE_TABLES.length,
    restoreVerified: true,
  }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

function printHelp(): void {
  stdout.write('Usage:\n');
  stdout.write('  pnpm tsx scripts/d1-backup-verify.ts sql\n');
  stdout.write('  pnpm tsx scripts/d1-backup-verify.ts verify --source FILE --restored FILE --integrity FILE --foreign-key FILE --encrypted FILE --receipt FILE\n');
}

async function main(rawArgs: string[]): Promise<void> {
  const [command, ...rest] = rawArgs;
  if (command === 'sql') {
    if (rest.length > 0) throw new Error('sqlに追加引数は指定できません');
    stdout.write(`${buildBackupVerificationSql()}\n`);
    return;
  }
  if (command === 'verify') {
    await verifyFromFiles(parseVerifyOptions(rest));
    stdout.write('暗号化バックアップの復元検証に成功しました\n');
    return;
  }
  if (command === '--help' || command === '-h' || !command) {
    printHelp();
    return;
  }
  throw new Error('未対応のコマンドです');
}

const isCliEntry = argv[1]
  ? fileURLToPath(import.meta.url) === resolve(argv[1])
  : false;

if (isCliEntry) {
  process.umask(0o077);
  main(argv.slice(2)).catch((error: unknown) => {
    const reason = error instanceof Error ? error.message : '不明なエラー';
    stderr.write(`D1バックアップ復元検証を中断しました: ${reason}\n`);
    process.exitCode = 1;
  });
}

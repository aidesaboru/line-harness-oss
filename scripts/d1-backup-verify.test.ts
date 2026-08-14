import { describe, expect, it } from 'vitest';
import { CORE_TABLES } from './production-deploy';
import {
  BACKUP_REQUIRED_TABLES,
  assertForeignKeyCheck,
  assertIntegrityCheck,
  buildBackupVerificationSql,
  parseBackupSnapshot,
  validateRestoredBackup,
} from './d1-backup-verify';

function queryPayload(options: {
  tables?: string[];
  countOffset?: number;
} = {}): unknown {
  const tables = options.tables ?? [...new Set([...BACKUP_REQUIRED_TABLES, 'staff_members'])];
  const offset = options.countOffset ?? 0;
  return [{
    results: [{
      table_names_json: JSON.stringify(tables),
      ...Object.fromEntries(CORE_TABLES.map((table, index) => [
        `count_${table}`,
        index + 10 + offset,
      ])),
    }],
  }];
}

describe('D1 backup restore verification', () => {
  it('builds read-only SQL for all protected tables', () => {
    const sql = buildBackupVerificationSql();
    expect(sql).toContain('FROM sqlite_master');
    CORE_TABLES.forEach((table) => {
      expect(sql).toContain(`COUNT(*) FROM "${table}") AS count_${table}`);
    });
    expect(sql).not.toMatch(/\b(?:DELETE|UPDATE|DROP|ALTER|INSERT)\b/i);
  });

  it('accepts a complete restore whose protected counts did not decrease', () => {
    const source = parseBackupSnapshot(queryPayload());
    const restored = parseBackupSnapshot(queryPayload({ countOffset: 2 }));
    expect(() => validateRestoredBackup(source, restored)).not.toThrow();
    expect(() => assertIntegrityCheck([{ results: [{ integrity_check: 'ok' }] }])).not.toThrow();
    expect(() => assertForeignKeyCheck([{ foreign_key_check: 'ok' }])).not.toThrow();
  });

  it('rejects a missing task-history table', () => {
    const tables = [...new Set([...BACKUP_REQUIRED_TABLES, 'staff_members'])]
      .filter((table) => table !== 'internal_task_comments');
    const source = parseBackupSnapshot(queryPayload({ tables }));
    const restored = parseBackupSnapshot(queryPayload());
    expect(() => validateRestoredBackup(source, restored)).toThrow(/internal_task_comments/);
  });

  it('rejects protected row loss after restore', () => {
    const source = parseBackupSnapshot(queryPayload({ countOffset: 2 }));
    const restored = parseBackupSnapshot(queryPayload());
    expect(() => validateRestoredBackup(source, restored)).toThrow(/件数が減っています/);
  });

  it('rejects a failed SQLite integrity check', () => {
    expect(() => assertIntegrityCheck([{ results: [{ integrity_check: 'row 10 missing' }] }]))
      .toThrow(/正常ではありません/);
  });

  it('rejects a failed foreign-key check', () => {
    expect(() => assertForeignKeyCheck([{ foreign_key_check: 'failed' }]))
      .toThrow(/外部キー整合性/);
  });
});

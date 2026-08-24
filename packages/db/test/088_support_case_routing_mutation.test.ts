import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationSql = readFileSync(
  join(__dirname, '..', 'migrations', '088_support_case_routing_mutation.sql'),
  'utf8',
);

describe('088_support_case_routing_mutation migration', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE support_cases (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO support_cases (id, title, updated_at)
      VALUES ('case-1', '既存案件', '2026-08-24T10:00:00.000+09:00');
    `);
    db.exec(migrationSql);
  });

  afterEach(() => db.close());

  it('adds a nullable marker without changing existing case data', () => {
    expect(db.prepare(
      'SELECT id, title, updated_at, routing_mutation_id FROM support_cases',
    ).all()).toEqual([{
      id: 'case-1',
      title: '既存案件',
      updated_at: '2026-08-24T10:00:00.000+09:00',
      routing_mutation_id: null,
    }]);
  });
});

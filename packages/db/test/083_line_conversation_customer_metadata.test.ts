import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationSql = readFileSync(
  join(__dirname, '..', 'migrations', '083_line_conversation_customer_metadata.sql'),
  'utf8',
);

describe('083_line_conversation_customer_metadata migration', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE line_conversations (
        id TEXT PRIMARY KEY,
        line_account_id TEXT,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        picture_url TEXT,
        last_message_at TEXT,
        status TEXT NOT NULL,
        workflow_status TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO line_conversations (
        id, source_type, source_id, display_name, status, created_at, updated_at
      ) VALUES ('group-1', 'group', 'C1', 'ECオーナー通達LINEグループ', 'resolved', '2026-08-05', '2026-08-05');
    `);
  });

  afterEach(() => db.close());

  it('adds valid JSON metadata without changing the LINE group name', () => {
    db.exec(migrationSql);
    expect(db.prepare(
      'SELECT display_name, customer_metadata FROM line_conversations WHERE id = ?',
    ).get('group-1')).toEqual({
      display_name: 'ECオーナー通達LINEグループ',
      customer_metadata: '{}',
    });

    db.prepare('UPDATE line_conversations SET customer_metadata = ? WHERE id = ?')
      .run(JSON.stringify({ customerNumber: '2449', companyName: '河原通信' }), 'group-1');
    expect(db.prepare(
      `SELECT json_extract(customer_metadata, '$.customerNumber') AS customer_number
       FROM line_conversations WHERE id = ?`,
    ).get('group-1')).toEqual({ customer_number: '2449' });
  });

  it('rejects malformed metadata JSON', () => {
    db.exec(migrationSql);
    expect(() => db.prepare(
      'UPDATE line_conversations SET customer_metadata = ? WHERE id = ?',
    ).run('{', 'group-1')).toThrow(/check constraint failed/i);
  });
});

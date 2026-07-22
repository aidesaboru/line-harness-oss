import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const GENERATOR = join(PKG_ROOT, 'scripts', 'generate-bootstrap.mjs');
const BOOTSTRAP_PATH = join(PKG_ROOT, 'bootstrap.sql');
const MIGRATIONS_DIR = join(PKG_ROOT, 'migrations');

const BENIGN_SQLITE_ERROR = /duplicate column name|already exists/i;

function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let buffer: string[] = [];
  let inTrigger = false;

  for (const line of sql.split(/\r?\n/)) {
    buffer.push(line);
    const bufferedSql = buffer.join('\n');
    if (!inTrigger && /\bCREATE\s+TRIGGER\b/i.test(bufferedSql)) inTrigger = true;

    const statementEnded = inTrigger
      ? /^\s*END;\s*(?:--.*)?$/i.test(line)
      : /;\s*(?:--.*)?$/.test(line);
    if (!statementEnded) continue;

    const statement = bufferedSql.trim();
    if (statement) statements.push(statement);
    buffer = [];
    inTrigger = false;
  }

  const remainder = buffer.join('\n').trim();
  if (remainder) statements.push(remainder);
  return statements;
}

function applyMigrationReplay(db: Database.Database): void {
  db.exec(readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
  const migrationFiles = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  for (const file of migrationFiles) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    for (const statement of splitSqlStatements(sql)) {
      try {
        db.exec(statement);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!BENIGN_SQLITE_ERROR.test(message)) {
          throw new Error(`${file}: ${message}`);
        }
      }
    }
  }
}

function readSchemaObjects(db: Database.Database) {
  return db
    .prepare(
      `
        SELECT type, name, sql
        FROM sqlite_master
        WHERE sql IS NOT NULL
          AND name NOT LIKE 'sqlite_%'
        ORDER BY
          CASE type
            WHEN 'table' THEN 0
            WHEN 'index' THEN 1
            WHEN 'trigger' THEN 2
            WHEN 'view' THEN 3
            ELSE 4
          END,
          name
      `,
    )
    .all() as Array<{ type: string; name: string; sql: string }>;
}

describe('bootstrap.sql', () => {
  it('stays in sync with schema.sql + migrations', () => {
    expect(() =>
      execFileSync('node', [GENERATOR, '--check'], {
        cwd: PKG_ROOT,
        stdio: 'pipe',
      }),
    ).not.toThrow();
  });

  it('matches the schema produced by replaying all migrations', () => {
    const bootstrapDb = new Database(':memory:');
    const replayDb = new Database(':memory:');

    bootstrapDb.exec(readFileSync(BOOTSTRAP_PATH, 'utf8'));
    applyMigrationReplay(replayDb);

    expect(readSchemaObjects(bootstrapDb)).toEqual(readSchemaObjects(replayDb));
  });

  it('keeps internal message edit history append-only', () => {
    const db = new Database(':memory:');
    db.exec(readFileSync(BOOTSTRAP_PATH, 'utf8'));
    db.prepare(
      `INSERT INTO internal_message_events (
        id, source_type, source_message_id, version, action, body, actor_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('event-1', 'chat', 'message-1', 1, 'edit', '修正後の本文', '担当者');

    expect(() => db.prepare('UPDATE internal_message_events SET body = ? WHERE id = ?').run('上書き', 'event-1'))
      .toThrow(/cannot be updated/i);
    expect(() => db.prepare('DELETE FROM internal_message_events WHERE id = ?').run('event-1'))
      .toThrow(/cannot be deleted/i);
    expect(db.prepare('SELECT body FROM internal_message_events WHERE id = ?').get('event-1'))
      .toEqual({ body: '修正後の本文' });
  });
});

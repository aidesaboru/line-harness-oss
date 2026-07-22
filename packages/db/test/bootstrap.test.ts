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

  it('retains case follow-up settings and confirmation history', () => {
    const db = new Database(':memory:');
    db.exec(readFileSync(BOOTSTRAP_PATH, 'utf8'));
    db.prepare(
      `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('account-1', 'channel-1', 'テストアカウント', 'token', 'secret');
    db.prepare(
      `INSERT INTO support_cases (id, line_account_id, title)
       VALUES (?, ?, ?)`,
    ).run('case-1', 'account-1', 'フォロー確認');
    db.prepare(
      `INSERT INTO support_case_followup_reminders (
        id, case_id, line_account_id, owner_name, interval_days, next_due_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('reminder-1', 'case-1', 'account-1', '一次担当', 7, '2026-07-29T10:00:00.000+09:00');
    db.prepare(
      `INSERT INTO support_case_followup_reminder_events (
        id, reminder_id, case_id, action, actor_name
      ) VALUES (?, ?, ?, ?, ?)`,
    ).run('event-1', 'reminder-1', 'case-1', 'confirmed', '一次担当');

    expect(() => db.prepare('DELETE FROM support_case_followup_reminders WHERE id = ?').run('reminder-1'))
      .toThrow(/cannot be deleted/i);
    expect(() => db.prepare('UPDATE support_case_followup_reminder_events SET actor_name = ? WHERE id = ?').run('別担当', 'event-1'))
      .toThrow(/cannot be updated/i);
    expect(() => db.prepare('DELETE FROM support_case_followup_reminder_events WHERE id = ?').run('event-1'))
      .toThrow(/cannot be deleted/i);
    expect(db.prepare('SELECT COUNT(*) AS count FROM support_case_followup_reminder_events').get())
      .toEqual({ count: 1 });
  });

  it('retains LINE group conversations and message history', () => {
    const db = new Database(':memory:');
    db.exec(readFileSync(BOOTSTRAP_PATH, 'utf8'));
    db.prepare(
      `INSERT INTO line_conversations (
        id, source_type, source_id, display_name, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      'conversation-1',
      'group',
      'Cgroup1',
      'ECオーナー連絡グループ',
      '2026-07-22T12:00:00.000+09:00',
      '2026-07-22T12:00:00.000+09:00',
    );
    db.prepare(
      `INSERT INTO line_conversation_messages (
        id, conversation_id, direction, message_type, content, source, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'message-1',
      'conversation-1',
      'incoming',
      'text',
      '銀行名はりそな銀行です',
      'group',
      '2026-07-22T12:01:00.000+09:00',
    );

    expect(() => db.prepare('DELETE FROM line_conversation_messages WHERE id = ?').run('message-1'))
      .toThrow(/history is protected/i);
    expect(() => db.prepare('DELETE FROM line_conversations WHERE id = ?').run('conversation-1'))
      .toThrow(/history is protected/i);
    expect(db.prepare('SELECT COUNT(*) AS count FROM line_conversation_messages').get())
      .toEqual({ count: 1 });
  });
});

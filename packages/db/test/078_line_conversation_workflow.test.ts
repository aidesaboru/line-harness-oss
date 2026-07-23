import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, '..');
const migrationSql = readFileSync(
  join(pkgRoot, 'migrations', '078_line_conversation_workflow.sql'),
  'utf8',
);

describe('078_line_conversation_workflow migration', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE line_conversations (
        id              TEXT PRIMARY KEY,
        line_account_id TEXT,
        source_type     TEXT NOT NULL,
        source_id       TEXT NOT NULL,
        display_name    TEXT NOT NULL,
        picture_url     TEXT,
        last_message_at TEXT,
        status          TEXT NOT NULL DEFAULT 'unread'
                        CHECK (status IN ('unread', 'resolved')),
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );

      CREATE TABLE line_conversation_messages (
        id                 TEXT PRIMARY KEY,
        conversation_id    TEXT NOT NULL,
        direction          TEXT NOT NULL,
        message_type       TEXT NOT NULL,
        content            TEXT NOT NULL,
        source             TEXT NOT NULL,
        line_account_id    TEXT,
        line_message_id    TEXT,
        webhook_event_id   TEXT,
        quote_token        TEXT,
        sender_user_id     TEXT,
        sender_name        TEXT,
        sender_picture_url TEXT,
        deleted_at         TEXT,
        deleted_reason     TEXT,
        created_at         TEXT NOT NULL
      );

      INSERT INTO line_conversations (
        id, source_type, source_id, display_name, status, created_at, updated_at
      ) VALUES
        ('conversation-unread', 'group', 'C1', '未読グループ', 'unread', '2026-07-23', '2026-07-23'),
        ('conversation-resolved', 'room', 'R1', '対応済みルーム', 'resolved', '2026-07-23', '2026-07-23');

      INSERT INTO line_conversation_messages (
        id, conversation_id, direction, message_type, content, source, created_at
      ) VALUES (
        'message-existing', 'conversation-unread', 'incoming', 'text',
        '既存メッセージ', 'group', '2026-07-23'
      );
    `);
  });

  afterEach(() => {
    db.close();
  });

  it('adds nullable workflow state without rewriting or recreating history', () => {
    expect(migrationSql).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(migrationSql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(migrationSql).not.toMatch(/\bCREATE\s+TABLE\b/i);
    expect(migrationSql).not.toMatch(/\bUPDATE\b/i);

    db.exec(migrationSql);

    expect(
      db.prepare(
        `SELECT id, status, workflow_status
         FROM line_conversations
         ORDER BY id`,
      ).all(),
    ).toEqual([
      {
        id: 'conversation-resolved',
        status: 'resolved',
        workflow_status: null,
      },
      {
        id: 'conversation-unread',
        status: 'unread',
        workflow_status: null,
      },
    ]);

    const messageColumns = db.prepare('PRAGMA table_info(line_conversation_messages)')
      .all() as Array<{ name: string }>;
    expect(messageColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'mark_as_read_token',
      'marked_as_read_at',
      'marked_as_read_by',
      'quoted_message_id',
      'sent_by_staff_id',
      'sent_by_staff_name',
    ]));
    expect(
      db.prepare('SELECT content FROM line_conversation_messages WHERE id = ?')
        .get('message-existing'),
    ).toEqual({ content: '既存メッセージ' });
  });

  it('accepts all supported workflow states and rejects unknown values', () => {
    db.exec(migrationSql);

    for (const status of ['unread', 'in_progress', 'long_term', 'resolved']) {
      expect(() =>
        db.prepare(
          'UPDATE line_conversations SET workflow_status = ? WHERE id = ?',
        ).run(status, 'conversation-unread'),
      ).not.toThrow();
    }

    expect(() =>
      db.prepare(
        'UPDATE line_conversations SET workflow_status = ? WHERE id = ?',
      ).run('archived', 'conversation-unread'),
    ).toThrow(/check constraint failed/i);
  });
});

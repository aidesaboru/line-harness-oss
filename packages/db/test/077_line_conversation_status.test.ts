import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function openMigratedDatabase() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE line_conversations (
      id              TEXT PRIMARY KEY,
      line_account_id TEXT,
      source_type     TEXT NOT NULL CHECK (source_type IN ('group', 'room')),
      source_id       TEXT NOT NULL,
      display_name    TEXT NOT NULL,
      picture_url     TEXT,
      last_message_at TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );

    CREATE TRIGGER protect_line_conversations_delete
    BEFORE DELETE ON line_conversations
    BEGIN
      SELECT RAISE(ABORT, 'line conversations history is protected');
    END;

    INSERT INTO line_conversations (
      id, source_type, source_id, display_name, last_message_at, created_at, updated_at
    ) VALUES
      (
        'conversation-with-message',
        'group',
        'Cgroup1',
        '既存メッセージあり',
        '2026-07-22T12:00:00.000+09:00',
        '2026-07-22T11:00:00.000+09:00',
        '2026-07-22T12:00:00.000+09:00'
      ),
      (
        'conversation-without-message',
        'room',
        'Rroom1',
        '既存メッセージなし',
        NULL,
        '2026-07-22T11:00:00.000+09:00',
        '2026-07-22T11:00:00.000+09:00'
      );
  `);
  db.exec(readFileSync(join(pkgRoot, 'migrations', '077_line_conversation_status.sql'), 'utf8'));
  return db;
}

describe('077 LINE conversation status', () => {
  it('keeps existing conversations and makes them visible for one-time review', () => {
    const db = openMigratedDatabase();

    expect(
      db.prepare(
        `SELECT id, status
         FROM line_conversations
         ORDER BY id`,
      ).all(),
    ).toEqual([
      { id: 'conversation-with-message', status: 'unread' },
      { id: 'conversation-without-message', status: 'unread' },
    ]);
    expect(() => db.prepare(
      `DELETE FROM line_conversations WHERE id = ?`,
    ).run('conversation-with-message')).toThrow(/history is protected/i);
    db.close();
  });

  it('uses the migration-safe unread default and rejects unknown states', () => {
    const db = openMigratedDatabase();
    db.prepare(
      `INSERT INTO line_conversations (
        id, source_type, source_id, display_name, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      'conversation-new',
      'group',
      'Cgroup2',
      '新規グループ',
      '2026-07-23T10:00:00.000+09:00',
      '2026-07-23T10:00:00.000+09:00',
    );

    expect(
      db.prepare(`SELECT status FROM line_conversations WHERE id = ?`).get('conversation-new'),
    ).toEqual({ status: 'unread' });
    expect(() => db.prepare(
      `UPDATE line_conversations SET status = 'archived' WHERE id = ?`,
    ).run('conversation-new')).toThrow(/check constraint/i);
    db.close();
  });
});

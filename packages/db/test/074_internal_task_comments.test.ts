import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function openMigratedDatabase() {
  const db = new Database(':memory:');
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE staff_members (id TEXT PRIMARY KEY);
    CREATE TABLE line_accounts (id TEXT PRIMARY KEY);
    CREATE TABLE internal_tasks (
      id TEXT PRIMARY KEY,
      line_account_id TEXT NOT NULL REFERENCES line_accounts(id),
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      title TEXT NOT NULL
    );
    INSERT INTO line_accounts (id) VALUES ('account-1');
    INSERT INTO staff_members (id) VALUES ('staff-1');
    INSERT INTO internal_tasks (id, line_account_id, source_type, source_id, title)
    VALUES ('task-existing', 'account-1', 'chat', 'friend-1', '既存タスク');
  `);
  db.exec(readFileSync(join(pkgRoot, 'migrations', '074_internal_task_comments.sql'), 'utf8'));
  return db;
}

describe('074 internal task comments', () => {
  it('adds comments without changing existing tasks', () => {
    const db = openMigratedDatabase();
    expect(db.prepare(`SELECT id, title FROM internal_tasks`).all()).toEqual([
      { id: 'task-existing', title: '既存タスク' },
    ]);

    db.prepare(
      `INSERT INTO internal_task_comments (
        id, task_id, body, created_by, created_by_name
      ) VALUES (?, ?, ?, ?, ?)`,
    ).run('comment-1', 'task-existing', '確認を進めています', 'staff-1', '担当者');

    expect(db.prepare(`SELECT task_id, body FROM internal_task_comments`).all()).toEqual([
      { task_id: 'task-existing', body: '確認を進めています' },
    ]);
    db.close();
  });

  it('keeps task discussion append-only', () => {
    const db = openMigratedDatabase();
    db.prepare(
      `INSERT INTO internal_task_comments (
        id, task_id, body, created_by, created_by_name
      ) VALUES (?, ?, ?, ?, ?)`,
    ).run('comment-1', 'task-existing', '初回コメント', 'staff-1', '担当者');

    expect(() => db.prepare(`UPDATE internal_task_comments SET body = ? WHERE id = ?`).run('書き換え', 'comment-1'))
      .toThrow(/cannot be updated/);
    expect(() => db.prepare(`DELETE FROM internal_task_comments WHERE id = ?`).run('comment-1'))
      .toThrow(/cannot be deleted/);
    db.close();
  });
});

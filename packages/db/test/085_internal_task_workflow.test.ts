import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationSql = readFileSync(
  join(__dirname, '..', 'migrations', '085_internal_task_workflow.sql'),
  'utf8',
);

describe('085_internal_task_workflow migration', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE staff_members (id TEXT PRIMARY KEY);
      CREATE TABLE internal_tasks (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('open', 'done')),
        line_account_id TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO staff_members (id) VALUES ('staff-1');
      INSERT INTO internal_tasks (id, status, line_account_id, updated_at) VALUES
        ('task-open', 'open', 'account-1', '2026-08-24'),
        ('task-done', 'done', 'account-1', '2026-08-24');
    `);
    db.exec(migrationSql);
  });

  afterEach(() => db.close());

  it('maps legacy status into four-stage workflow without changing legacy status', () => {
    expect(db.prepare(
      'SELECT id, status, workflow_status, priority, version FROM internal_tasks ORDER BY id',
    ).all()).toEqual([
      { id: 'task-done', status: 'done', workflow_status: 'done', priority: 'medium', version: 1 },
      { id: 'task-open', status: 'open', workflow_status: 'todo', priority: 'medium', version: 1 },
    ]);
  });

  it('accepts workflow stages and rejects malformed labels', () => {
    db.prepare(
      'UPDATE internal_tasks SET workflow_status = ?, priority = ?, labels = ? WHERE id = ?',
    ).run('review', 'urgent', '["要確認"]', 'task-open');
    expect(db.prepare(
      'SELECT workflow_status, priority, labels FROM internal_tasks WHERE id = ?',
    ).get('task-open')).toEqual({ workflow_status: 'review', priority: 'urgent', labels: '["要確認"]' });
    expect(() => db.prepare(
      'UPDATE internal_tasks SET labels = ? WHERE id = ?',
    ).run('{}', 'task-open')).toThrow(/check constraint failed/i);
  });

  it('keeps legacy Worker completion and reopen writes visible to new clients', () => {
    db.prepare('UPDATE internal_tasks SET status = ? WHERE id = ?').run('done', 'task-open');
    expect(db.prepare(
      'SELECT status, workflow_status, version FROM internal_tasks WHERE id = ?',
    ).get('task-open')).toEqual({ status: 'done', workflow_status: 'done', version: 2 });

    db.prepare('UPDATE internal_tasks SET status = ? WHERE id = ?').run('open', 'task-open');
    expect(db.prepare(
      'SELECT status, workflow_status, version FROM internal_tasks WHERE id = ?',
    ).get('task-open')).toEqual({ status: 'open', workflow_status: 'todo', version: 3 });
  });

  it('does not override a new Worker update that changes both status columns', () => {
    db.prepare(
      'UPDATE internal_tasks SET status = ?, workflow_status = ?, version = version + 1 WHERE id = ?',
    ).run('open', 'review', 'task-open');
    expect(db.prepare(
      'SELECT status, workflow_status, version FROM internal_tasks WHERE id = ?',
    ).get('task-open')).toEqual({ status: 'open', workflow_status: 'review', version: 2 });
  });

  it('keeps checklist rows as soft-removable task history', () => {
    db.prepare(
      `INSERT INTO internal_task_checklist_items (
         id, task_id, body, created_by, created_by_name
       ) VALUES ('item-1', 'task-open', '顧客へ確認', 'staff-1', '林')`,
    ).run();
    db.prepare(
      'UPDATE internal_task_checklist_items SET is_completed = 1, removed_at = ? WHERE id = ?',
    ).run('2026-08-24T20:00:00+09:00', 'item-1');
    expect(db.prepare(
      'SELECT is_completed, removed_at FROM internal_task_checklist_items WHERE id = ?',
    ).get('item-1')).toEqual({ is_completed: 1, removed_at: '2026-08-24T20:00:00+09:00' });
  });
});

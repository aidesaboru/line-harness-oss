import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationSql = readFileSync(
  join(__dirname, '..', 'migrations', '082_staff_ticket_shares.sql'),
  'utf8',
);

describe('082_staff_ticket_shares migration', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE staff_members (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE internal_task_assignees (
        task_id TEXT NOT NULL,
        staff_id TEXT NOT NULL REFERENCES staff_members(id) ON DELETE CASCADE,
        staff_name TEXT NOT NULL,
        assigned_at TEXT NOT NULL,
        removed_at TEXT,
        PRIMARY KEY (task_id, staff_id)
      );
      INSERT INTO staff_members (id, name, role) VALUES
        ('staff-a', '林', 'staff'),
        ('staff-b', '小野里', 'staff'),
        ('owner-1', '宮本', 'owner');
      INSERT INTO internal_task_assignees (task_id, staff_id, staff_name, assigned_at)
      VALUES ('task-before-082', 'staff-a', '林', '2026-08-20T10:00:00+09:00');
    `);
    db.exec(migrationSql);
  });

  afterEach(() => db.close());

  it('stores one canonical row for a mutual ticket share', () => {
    db.prepare(
      `INSERT INTO staff_ticket_shares (staff_a_id, staff_b_id, created_by)
       VALUES (?, ?, ?)`,
    ).run('staff-a', 'staff-b', 'owner-1');

    expect(db.prepare('SELECT staff_a_id, staff_b_id, created_by FROM staff_ticket_shares').all())
      .toEqual([{ staff_a_id: 'staff-a', staff_b_id: 'staff-b', created_by: 'owner-1' }]);
    expect(() => db.prepare(
      `INSERT INTO staff_ticket_shares (staff_a_id, staff_b_id) VALUES (?, ?)`,
    ).run('staff-b', 'staff-a')).toThrow(/check constraint failed/i);
  });

  it('rejects self sharing and turns legacy staff deletion into a history-preserving soft disable', () => {
    expect(() => db.prepare(
      `INSERT INTO staff_ticket_shares (staff_a_id, staff_b_id) VALUES (?, ?)`,
    ).run('staff-a', 'staff-a')).toThrow(/check constraint failed/i);

    db.prepare(
      `INSERT INTO staff_ticket_shares (staff_a_id, staff_b_id) VALUES (?, ?)`,
    ).run('staff-a', 'staff-b');
    db.prepare('DELETE FROM staff_members WHERE id = ?').run('staff-a');
    expect(db.prepare('SELECT is_active FROM staff_members WHERE id = ?').get('staff-a'))
      .toEqual({ is_active: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM staff_ticket_shares').get())
      .toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM internal_task_assignees').get())
      .toEqual({ count: 1 });
  });
});

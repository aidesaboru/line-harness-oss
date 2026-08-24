import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationSql = readFileSync(
  join(__dirname, '..', 'migrations', '084_staff_permissions_and_audit.sql'),
  'utf8',
);

describe('084_staff_permissions_and_audit migration', () => {
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
      CREATE TABLE staff_ticket_shares (
        staff_a_id TEXT NOT NULL REFERENCES staff_members(id) ON DELETE CASCADE,
        staff_b_id TEXT NOT NULL REFERENCES staff_members(id) ON DELETE CASCADE,
        created_by TEXT REFERENCES staff_members(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT '2026-08-24',
        PRIMARY KEY (staff_a_id, staff_b_id),
        CHECK (staff_a_id < staff_b_id)
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
        ('owner-1', '宮本', 'owner'),
        ('secondary-1', 'アベ', 'secondary'),
        ('staff-a', '林', 'staff'),
        ('staff-b', '小野里', 'staff');
      INSERT INTO staff_ticket_shares (staff_a_id, staff_b_id, created_by)
      VALUES ('staff-a', 'staff-b', 'owner-1');
      INSERT INTO internal_task_assignees (task_id, staff_id, staff_name, assigned_at)
      VALUES ('task-old', 'staff-a', '林', '2026-08-20T10:00:00+09:00');
    `);
    db.exec(migrationSql);
  });

  afterEach(() => db.close());

  it('keeps existing secondary staff read-only until explicitly enabled', () => {
    expect(db.prepare(
      'SELECT secondary_can_respond FROM staff_members WHERE id = ?',
    ).get('secondary-1')).toEqual({ secondary_can_respond: 0 });

    db.prepare(
      'UPDATE staff_members SET secondary_can_respond = 1 WHERE id = ?',
    ).run('secondary-1');
    expect(db.prepare(
      'SELECT secondary_can_respond FROM staff_members WHERE id = ?',
    ).get('secondary-1')).toEqual({ secondary_can_respond: 1 });
  });

  it('retires ticket shares and preserves append-only grant history', () => {
    db.prepare(
      'UPDATE staff_ticket_shares SET removed_at = ? WHERE staff_a_id = ? AND staff_b_id = ?',
    ).run('2026-08-24T20:00:00+09:00', 'staff-a', 'staff-b');
    db.prepare(
      `INSERT INTO staff_ticket_share_events (
         id, staff_a_id, staff_b_id, action, actor_id, actor_name
       ) VALUES ('event-1', 'staff-a', 'staff-b', 'revoked', 'owner-1', '宮本')`,
    ).run();

    expect(db.prepare(
      'SELECT removed_at FROM staff_ticket_shares WHERE staff_a_id = ? AND staff_b_id = ?',
    ).get('staff-a', 'staff-b')).toEqual({ removed_at: '2026-08-24T20:00:00+09:00' });
    expect(() => db.prepare(
      'DELETE FROM staff_ticket_share_events WHERE id = ?',
    ).run('event-1')).toThrow(/cannot be deleted/i);
  });

  it('protects staff permission audit events from update and delete', () => {
    db.prepare(
      `INSERT INTO staff_member_events (
         id, staff_id, action, metadata, actor_id, actor_name
       ) VALUES ('event-1', 'secondary-1', 'updated', '{}', 'owner-1', '宮本')`,
    ).run();

    expect(() => db.prepare(
      'UPDATE staff_member_events SET metadata = ? WHERE id = ?',
    ).run('{"changed":true}', 'event-1')).toThrow(/cannot be updated/i);
    expect(() => db.prepare(
      'DELETE FROM staff_member_events WHERE id = ?',
    ).run('event-1')).toThrow(/cannot be deleted/i);
  });

  it('turns a legacy physical staff delete into a soft disable without cascading history', () => {
    const shareCount = db.prepare('SELECT COUNT(*) AS count FROM staff_ticket_shares').get();
    const assignmentCount = db.prepare('SELECT COUNT(*) AS count FROM internal_task_assignees').get();

    db.prepare('DELETE FROM staff_members WHERE id = ?').run('staff-a');

    expect(db.prepare('SELECT is_active FROM staff_members WHERE id = ?').get('staff-a'))
      .toEqual({ is_active: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM staff_ticket_shares').get()).toEqual(shareCount);
    expect(db.prepare('SELECT COUNT(*) AS count FROM internal_task_assignees').get()).toEqual(assignmentCount);
  });
});

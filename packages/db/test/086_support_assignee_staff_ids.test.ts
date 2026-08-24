import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationSql = readFileSync(
  join(__dirname, '..', 'migrations', '086_support_assignee_staff_ids.sql'),
  'utf8',
);

describe('086_support_assignee_staff_ids migration', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE staff_members (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );
      CREATE TABLE support_cases (
        id TEXT PRIMARY KEY,
        primary_assignee TEXT,
        escalation_assignee TEXT,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE support_escalations (
        id TEXT PRIMARY KEY,
        assignee TEXT,
        assignee_staff_id TEXT REFERENCES staff_members(id) ON DELETE SET NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO staff_members VALUES
        ('staff-current', '林', 1, '2026-01-01'),
        ('secondary-1', 'アベ', 1, '2026-02-01'),
        ('duplicate-1', '佐藤', 1, '2026-03-01'),
        ('duplicate-2', '佐藤', 1, '2026-04-01');
      INSERT INTO support_cases VALUES
        ('case-1', '林', 'アベ', 'open', '2026-08-24'),
        ('case-duplicate', '佐藤', '佐藤', 'open', '2026-08-24');
      INSERT INTO support_escalations VALUES
        ('escalation-unique', 'アベ', NULL, 'pending', '2026-08-24'),
        ('escalation-duplicate', '佐藤', NULL, 'pending', '2026-08-24');
    `);
    db.exec(migrationSql);
  });

  afterEach(() => db.close());

  it('backfills active immutable staff IDs without changing display names', () => {
    expect(db.prepare(`
      SELECT primary_assignee, primary_assignee_staff_id,
             escalation_assignee, escalation_assignee_staff_id
      FROM support_cases WHERE id = 'case-1'
    `).get()).toEqual({
      primary_assignee: '林',
      primary_assignee_staff_id: 'staff-current',
      escalation_assignee: 'アベ',
      escalation_assignee_staff_id: 'secondary-1',
    });
  });

  it('does not guess an immutable ID when multiple staff have the same name', () => {
    expect(db.prepare(`
      SELECT primary_assignee_staff_id, escalation_assignee_staff_id
      FROM support_cases WHERE id = 'case-duplicate'
    `).get()).toEqual({ primary_assignee_staff_id: null, escalation_assignee_staff_id: null });
    expect(db.prepare(`
      SELECT assignee_staff_id FROM support_escalations WHERE id = 'escalation-duplicate'
    `).get()).toEqual({ assignee_staff_id: null });
  });

  it('backfills a legacy escalation only when its assignee name is unique', () => {
    expect(db.prepare(`
      SELECT assignee_staff_id FROM support_escalations WHERE id = 'escalation-unique'
    `).get()).toEqual({ assignee_staff_id: 'secondary-1' });
  });

  it('fills unique IDs for legacy inserts and name-only updates', () => {
    db.prepare(`
      INSERT INTO support_cases (
        id, primary_assignee, escalation_assignee, status, updated_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run('legacy-case', '林', 'アベ', 'open', '2026-08-24');
    expect(db.prepare(`
      SELECT primary_assignee_staff_id, escalation_assignee_staff_id
      FROM support_cases WHERE id = 'legacy-case'
    `).get()).toEqual({
      primary_assignee_staff_id: 'staff-current',
      escalation_assignee_staff_id: 'secondary-1',
    });

    db.prepare(
      'UPDATE support_cases SET primary_assignee = ?, escalation_assignee = ? WHERE id = ?',
    ).run('佐藤', '佐藤', 'legacy-case');
    expect(db.prepare(`
      SELECT primary_assignee_staff_id, escalation_assignee_staff_id
      FROM support_cases WHERE id = 'legacy-case'
    `).get()).toEqual({ primary_assignee_staff_id: null, escalation_assignee_staff_id: null });

    db.prepare(`
      INSERT INTO support_escalations (id, assignee, status, updated_at)
      VALUES (?, ?, ?, ?)
    `).run('legacy-escalation', 'アベ', 'pending', '2026-08-24');
    expect(db.prepare(`
      SELECT assignee_staff_id FROM support_escalations WHERE id = 'legacy-escalation'
    `).get()).toEqual({ assignee_staff_id: 'secondary-1' });
    db.prepare('UPDATE support_escalations SET assignee = ? WHERE id = ?')
      .run('佐藤', 'legacy-escalation');
    expect(db.prepare(`
      SELECT assignee_staff_id FROM support_escalations WHERE id = 'legacy-escalation'
    `).get()).toEqual({ assignee_staff_id: null });
  });
});

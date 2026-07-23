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
    CREATE TABLE staff_members (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      role TEXT NOT NULL,
      api_key TEXT UNIQUE NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE line_accounts (id TEXT PRIMARY KEY);
    CREATE TABLE support_cases (
      id TEXT PRIMARY KEY,
      line_account_id TEXT REFERENCES line_accounts(id) ON DELETE RESTRICT
    );
    INSERT INTO line_accounts (id) VALUES ('account-1');
    INSERT INTO staff_members (
      id, name, role, api_key, created_at, updated_at
    ) VALUES (
      'staff-1', '二次担当', 'staff', 'test-key', '2026-07-23T22:00:00.000+09:00', '2026-07-23T22:00:00.000+09:00'
    );
    INSERT INTO support_cases (id, line_account_id) VALUES ('case-1', 'account-1');
  `);
  db.exec(readFileSync(join(pkgRoot, 'migrations', '076_support_ticket_slack_outbox.sql'), 'utf8'));
  return db;
}

describe('076 support ticket Slack outbox', () => {
  it('stores a durable delivery intent and a stable staff Slack identity', () => {
    const db = openMigratedDatabase();
    db.prepare(`UPDATE staff_members SET slack_user_id = ? WHERE id = ?`).run('U06SWBHATLY', 'staff-1');
    db.prepare(
      `INSERT INTO support_slack_notification_outbox (
        id, case_id, line_account_id, notification_type, payload, next_attempt_at
      ) VALUES (?, ?, ?, 'ticket_created', ?, ?)`,
    ).run(
      'outbox-1',
      'case-1',
      'account-1',
      JSON.stringify({ caseId: 'case-1' }),
      '2026-07-23T22:00:00.000+09:00',
    );

    expect(db.prepare(`SELECT slack_user_id FROM staff_members WHERE id = ?`).get('staff-1'))
      .toEqual({ slack_user_id: 'U06SWBHATLY' });
    expect(db.prepare(`SELECT status, attempts FROM support_slack_notification_outbox`).get())
      .toEqual({ status: 'pending', attempts: 0 });
    db.close();
  });

  it('prevents deleting delivery history or reopening a sent notification', () => {
    const db = openMigratedDatabase();
    db.prepare(
      `INSERT INTO support_slack_notification_outbox (
        id, case_id, line_account_id, notification_type, payload, status,
        next_attempt_at, sent_at
      ) VALUES (?, ?, ?, 'ticket_created', ?, 'sent', ?, ?)`,
    ).run(
      'outbox-1',
      'case-1',
      'account-1',
      JSON.stringify({ caseId: 'case-1' }),
      '2026-07-23T22:00:00.000+09:00',
      '2026-07-23T22:01:00.000+09:00',
    );

    expect(() => db.prepare(`DELETE FROM support_slack_notification_outbox WHERE id = ?`).run('outbox-1'))
      .toThrow(/cannot be deleted/);
    expect(() => db.prepare(
      `UPDATE support_slack_notification_outbox SET status = 'failed' WHERE id = ?`,
    ).run('outbox-1')).toThrow(/cannot be reopened/);
    db.close();
  });
});

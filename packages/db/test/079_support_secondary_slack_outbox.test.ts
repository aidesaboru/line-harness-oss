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
    CREATE TABLE line_accounts (id TEXT PRIMARY KEY);
    CREATE TABLE support_cases (
      id TEXT PRIMARY KEY,
      line_account_id TEXT REFERENCES line_accounts(id) ON DELETE RESTRICT
    );
    CREATE TABLE support_case_events (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL REFERENCES support_cases(id) ON DELETE RESTRICT
    );
    INSERT INTO line_accounts (id) VALUES ('account-1');
    INSERT INTO support_cases (id, line_account_id) VALUES ('case-1', 'account-1');
    INSERT INTO support_case_events (id, case_id) VALUES ('event-1', 'case-1');
  `);
  db.exec(readFileSync(join(pkgRoot, 'migrations', '079_support_secondary_slack_outbox.sql'), 'utf8'));
  return db;
}

describe('079 support secondary Slack outbox', () => {
  it('deduplicates the same secondary-support event', () => {
    const db = openMigratedDatabase();
    const insert = db.prepare(
      `INSERT INTO support_secondary_slack_notification_outbox (
        id, case_id, line_account_id, source_event_id, notification_type, payload, next_attempt_at
      ) VALUES (?, ?, ?, ?, 'secondary_assigned', ?, ?)`,
    );
    insert.run(
      'outbox-1',
      'case-1',
      'account-1',
      'event-1',
      JSON.stringify({ caseId: 'case-1' }),
      '2026-07-28T09:00:00.000+09:00',
    );

    expect(() => insert.run(
      'outbox-2',
      'case-1',
      'account-1',
      'event-1',
      JSON.stringify({ caseId: 'case-1' }),
      '2026-07-28T09:00:00.000+09:00',
    )).toThrow(/UNIQUE constraint failed/);
    db.close();
  });

  it('protects secondary notification history from deletion and sent-state rollback', () => {
    const db = openMigratedDatabase();
    db.prepare(
      `INSERT INTO support_secondary_slack_notification_outbox (
        id, case_id, line_account_id, source_event_id, notification_type, payload,
        status, next_attempt_at, sent_at
      ) VALUES (?, ?, ?, ?, 'secondary_reopened', ?, 'sent', ?, ?)`,
    ).run(
      'outbox-1',
      'case-1',
      'account-1',
      'event-1',
      JSON.stringify({ caseId: 'case-1' }),
      '2026-07-28T09:00:00.000+09:00',
      '2026-07-28T09:01:00.000+09:00',
    );

    expect(() => db.prepare(
      `DELETE FROM support_secondary_slack_notification_outbox WHERE id = ?`,
    ).run('outbox-1')).toThrow(/cannot be deleted/);
    expect(() => db.prepare(
      `UPDATE support_secondary_slack_notification_outbox SET status = 'failed' WHERE id = ?`,
    ).run('outbox-1')).toThrow(/cannot be reopened/);
    db.close();
  });
});

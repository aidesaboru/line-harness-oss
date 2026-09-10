import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const migrationSql = readFileSync(
  join(pkgRoot, 'migrations', '094_support_primary_response_deadline.sql'),
  'utf8',
)

describe('094 support primary response deadline', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE line_accounts (id TEXT PRIMARY KEY);
      CREATE TABLE staff_members (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        slack_user_id TEXT
      );
      CREATE TABLE support_cases (
        id TEXT PRIMARY KEY,
        line_account_id TEXT REFERENCES line_accounts(id) ON DELETE RESTRICT,
        status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL
      );
      INSERT INTO line_accounts (id) VALUES ('account-1');
      INSERT INTO staff_members (id, name, slack_user_id)
      VALUES ('staff-1', '一次担当', 'U01234567');
      INSERT INTO support_cases (id, line_account_id, status, created_at)
      VALUES ('legacy-case', 'account-1', 'open', '2026-09-11T09:00:00.000+09:00');
    `)
    db.exec(migrationSql)
  })

  afterEach(() => db.close())

  it('does not backfill existing cases', () => {
    expect(db.prepare(`
      SELECT customer_response_due_at, customer_response_reminder_at
      FROM support_cases WHERE id = 'legacy-case'
    `).get()).toEqual({
      customer_response_due_at: null,
      customer_response_reminder_at: null,
    })
  })

  it('defaults a Friday receipt to Wednesday and reminds on Tuesday', () => {
    db.prepare(`
      INSERT INTO support_cases (id, line_account_id, status, created_at)
      VALUES (?, ?, 'open', ?)
    `).run('new-case', 'account-1', '2026-09-11T09:00:00.000+09:00')

    expect(db.prepare(`
      SELECT customer_response_due_at, customer_response_reminder_at
      FROM support_cases WHERE id = 'new-case'
    `).get()).toEqual({
      customer_response_due_at: '2026-09-16T18:00:00.000+09:00',
      customer_response_reminder_at: '2026-09-15T10:00:00.000+09:00',
    })
  })

  it('uses the previous Friday when the promise date is Monday', () => {
    db.prepare(`
      INSERT INTO support_cases (
        id, line_account_id, status, created_at,
        customer_response_due_at, customer_response_reminder_at
      ) VALUES (?, ?, 'open', ?, ?, ?)
    `).run(
      'custom-case',
      'account-1',
      '2026-09-10T09:00:00.000+09:00',
      '2026-09-14T18:00:00.000+09:00',
      '2026-09-11T10:00:00.000+09:00',
    )

    expect(db.prepare(`
      SELECT customer_response_reminder_at
      FROM support_cases WHERE id = 'custom-case'
    `).get()).toEqual({ customer_response_reminder_at: '2026-09-11T10:00:00.000+09:00' })
  })

  it('deduplicates a recipient and deadline and protects delivery history', () => {
    const insert = db.prepare(`
      INSERT INTO support_primary_response_slack_outbox (
        id, case_id, line_account_id, response_due_at, reminder_at,
        recipient_staff_id, status, next_attempt_at, sent_at
      ) VALUES (?, 'legacy-case', 'account-1', ?, ?, 'staff-1', ?, ?, ?)
    `)
    insert.run(
      'outbox-1',
      '2026-09-14T18:00:00.000+09:00',
      '2026-09-11T10:00:00.000+09:00',
      'sent',
      '2026-09-11T10:00:00.000+09:00',
      '2026-09-11T10:01:00.000+09:00',
    )

    expect(() => insert.run(
      'outbox-2',
      '2026-09-14T18:00:00.000+09:00',
      '2026-09-11T10:00:00.000+09:00',
      'pending',
      '2026-09-11T10:00:00.000+09:00',
      null,
    )).toThrow(/UNIQUE constraint failed/i)
    expect(() => db.prepare(`DELETE FROM support_primary_response_slack_outbox`).run())
      .toThrow(/cannot be deleted/i)
    expect(() => db.prepare(`
      UPDATE support_primary_response_slack_outbox SET status = 'failed' WHERE id = 'outbox-1'
    `).run()).toThrow(/cannot be reopened/i)
  })
})

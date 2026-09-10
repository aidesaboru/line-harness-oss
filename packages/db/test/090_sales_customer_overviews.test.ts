import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const migrationSql = readFileSync(
  join(__dirname, '..', 'migrations', '090_sales_customer_overviews.sql'),
  'utf8',
)

describe('090_sales_customer_overviews migration', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE staff_members (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE friends (id TEXT PRIMARY KEY);
      CREATE TABLE line_conversations (id TEXT PRIMARY KEY);
      INSERT INTO staff_members (id, name) VALUES ('staff-1', '運営担当');
      INSERT INTO friends (id) VALUES ('friend-1');
      INSERT INTO line_conversations (id) VALUES ('conversation-1');
    `)
    db.exec(migrationSql)
  })

  afterEach(() => db.close())

  it('stores an overview independently from customer status', () => {
    db.prepare(`
      INSERT INTO sales_customer_overviews (
        id, friend_id, overview, topic_codes, generation_method,
        source_fingerprint, mutation_id, updated_by, updated_by_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'overview-1',
      'friend-1',
      '直近90日の活動概要。ステータスは人が設定します。',
      JSON.stringify(['payment']),
      'rules_v1',
      'a'.repeat(64),
      'mutation-1',
      'staff-1',
      '運営担当',
    )

    expect(db.prepare('SELECT friend_id, version FROM sales_customer_overviews').get())
      .toEqual({ friend_id: 'friend-1', version: 1 })
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sales_customer_statuses'").get())
      .toBeUndefined()
  })

  it('keeps one current overview per subject and append-only history', () => {
    db.prepare(`
      INSERT INTO sales_customer_overviews (
        id, friend_id, overview, topic_codes, generation_method, source_fingerprint, mutation_id
      ) VALUES (?, ?, ?, '[]', 'rules_v1', ?, ?)
    `).run('overview-1', 'friend-1', '最初の概要', 'a'.repeat(64), 'mutation-1')
    db.prepare(`
      INSERT INTO sales_customer_overview_events (
        id, overview_id, overview, period_days, topic_codes,
        generation_method, source_fingerprint
      ) VALUES (?, ?, ?, 90, '[]', 'rules_v1', ?)
    `).run('event-1', 'overview-1', '最初の概要', 'a'.repeat(64))

    expect(() => db.prepare(`
      INSERT INTO sales_customer_overviews (
        id, friend_id, overview, topic_codes, generation_method, source_fingerprint, mutation_id
      ) VALUES (?, ?, ?, '[]', 'rules_v1', ?, ?)
    `).run('overview-2', 'friend-1', '重複概要', 'b'.repeat(64), 'mutation-2'))
      .toThrow(/UNIQUE constraint failed/i)
    expect(() => db.prepare('UPDATE sales_customer_overview_events SET overview = ? WHERE id = ?').run('上書き', 'event-1'))
      .toThrow(/append-only/i)
    expect(() => db.prepare('DELETE FROM sales_customer_overview_events WHERE id = ?').run('event-1'))
      .toThrow(/append-only/i)
    expect(() => db.prepare('DELETE FROM sales_customer_overviews WHERE id = ?').run('overview-1'))
      .toThrow(/history is protected/i)
  })

  it('requires exactly one subject, valid JSON topics, and a fixed method', () => {
    const insert = db.prepare(`
      INSERT INTO sales_customer_overviews (
        id, friend_id, conversation_id, overview, topic_codes,
        generation_method, source_fingerprint, mutation_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    expect(() => insert.run(
      'both', 'friend-1', 'conversation-1', '概要', '[]', 'rules_v1', 'a'.repeat(64), 'mutation-both',
    )).toThrow(/CHECK constraint failed/i)
    expect(() => insert.run(
      'json', 'friend-1', null, '概要', 'not-json', 'rules_v1', 'a'.repeat(64), 'mutation-json',
    )).toThrow(/malformed JSON|CHECK constraint failed/i)
    expect(() => insert.run(
      'method', 'friend-1', null, '概要', '[]', 'ai_status_v1', 'a'.repeat(64), 'mutation-method',
    )).toThrow(/CHECK constraint failed/i)
  })
})

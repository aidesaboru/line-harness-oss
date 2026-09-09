import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const migrationSql = readFileSync(
  join(__dirname, '..', 'migrations', '089_sales_customer_status.sql'),
  'utf8',
)

describe('089_sales_customer_status migration', () => {
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

  it('adds sales-only permission with existing staff disabled by default', () => {
    expect(db.prepare('SELECT sales_only FROM staff_members WHERE id = ?').get('staff-1'))
      .toEqual({ sales_only: 0 })
    expect(() => db.prepare('UPDATE staff_members SET sales_only = 2 WHERE id = ?').run('staff-1'))
      .toThrow(/CHECK constraint failed/i)
  })

  it('stores one current status per subject and preserves append-only history', () => {
    db.prepare(`
      INSERT INTO sales_customer_statuses (
        id, friend_id, status, summary, mutation_id, updated_by, updated_by_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('status-1', 'friend-1', 'complaint', '営業連絡を停止', 'mutation-1', 'staff-1', '運営担当')
    db.prepare(`
      INSERT INTO sales_customer_status_events (
        id, status_id, from_status, to_status, summary, actor_id, actor_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('event-1', 'status-1', 'unreviewed', 'complaint', '営業連絡を停止', 'staff-1', '運営担当')

    expect(() => db.prepare(`
      INSERT INTO sales_customer_statuses (
        id, friend_id, status, summary, mutation_id
      ) VALUES (?, ?, ?, ?, ?)
    `).run('status-2', 'friend-1', 'normal', '通常対応可', 'mutation-2'))
      .toThrow(/UNIQUE constraint failed/i)
    expect(() => db.prepare('UPDATE sales_customer_status_events SET summary = ? WHERE id = ?').run('上書き', 'event-1'))
      .toThrow(/append-only/i)
    expect(() => db.prepare('DELETE FROM sales_customer_status_events WHERE id = ?').run('event-1'))
      .toThrow(/append-only/i)
    expect(() => db.prepare('DELETE FROM sales_customer_statuses WHERE id = ?').run('status-1'))
      .toThrow(/history is protected/i)
  })

  it('requires exactly one subject and a non-empty sales-safe summary', () => {
    expect(() => db.prepare(`
      INSERT INTO sales_customer_statuses (
        id, friend_id, conversation_id, status, summary, mutation_id
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run('status-both', 'friend-1', 'conversation-1', 'normal', '通常', 'mutation-both'))
      .toThrow(/CHECK constraint failed/i)
    expect(() => db.prepare(`
      INSERT INTO sales_customer_statuses (
        id, friend_id, status, summary, mutation_id
      ) VALUES (?, ?, ?, ?, ?)
    `).run('status-empty', 'friend-1', 'normal', '   ', 'mutation-empty'))
      .toThrow(/CHECK constraint failed/i)
  })
})

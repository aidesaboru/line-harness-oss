import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const migrationSql = readFileSync(
  join(__dirname, '..', 'migrations', '092_sales_customer_semantic_summaries_v2.sql'),
  'utf8',
)

describe('092_sales_customer_semantic_summaries_v2 migration', () => {
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
      INSERT INTO friends (id) VALUES ('friend-2');
      INSERT INTO line_conversations (id) VALUES ('conversation-1');
    `)
    db.exec(migrationSql)
  })

  afterEach(() => db.close())

  it('stores v2 independently without creating or changing a sales status', () => {
    db.prepare(`
      INSERT INTO sales_customer_semantic_summaries_v2 (
        id, friend_id, summary, generation_method, ai_generated, model,
        prompt_version, source_fingerprint, source_message_count,
        source_from_at, source_to_at, input_char_count, prompt_tokens,
        completion_tokens, total_tokens, attempt_count, mutation_id,
        updated_by, updated_by_name
      ) VALUES (?, ?, ?, 'semantic_v2', 1, ?, 'sales_conversation_summary_v2',
        ?, 2, ?, ?, 300, 120, 80, 200, 1, ?, ?, ?)
    `).run(
      'summary-1',
      'friend-1',
      '【相談内容】\n返品方法について相談している。',
      '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      'a'.repeat(64),
      '2026-09-09T10:00:00+09:00',
      '2026-09-09T11:00:00+09:00',
      'mutation-1',
      'staff-1',
      '運営担当',
    )

    expect(db.prepare('SELECT friend_id, generation_method, version FROM sales_customer_semantic_summaries_v2').get())
      .toEqual({ friend_id: 'friend-1', generation_method: 'semantic_v2', version: 1 })
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sales_customer_statuses'").get())
      .toBeUndefined()
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sales_customer_semantic_summaries'").get())
      .toBeUndefined()
  })

  it('enforces one current row per subject and v2 metadata', () => {
    const insert = db.prepare(`
      INSERT INTO sales_customer_semantic_summaries_v2 (
        id, friend_id, summary, generation_method, ai_generated, model,
        prompt_version, source_fingerprint, source_message_count,
        source_from_at, source_to_at, input_char_count, attempt_count, mutation_id
      ) VALUES (?, ?, ?, ?, 0, NULL, ?, ?, 0, NULL, NULL, 0, 0, ?)
    `)
    insert.run(
      'summary-1', 'friend-1', '会話内容は確認できません。',
      'semantic_v2', 'sales_conversation_summary_v2', 'a'.repeat(64), 'mutation-1',
    )
    expect(() => insert.run(
      'summary-2', 'friend-1', '重複',
      'semantic_v2', 'sales_conversation_summary_v2', 'b'.repeat(64), 'mutation-2',
    )).toThrow(/UNIQUE constraint failed/i)
    expect(() => insert.run(
      'summary-v1', 'friend-2', '旧方式',
      'semantic_v1', 'sales_conversation_summary_v1', 'c'.repeat(64), 'mutation-v1',
    )).toThrow(/CHECK constraint failed/i)
  })

  it('protects current records and append-only events', () => {
    db.prepare(`
      INSERT INTO sales_customer_semantic_summaries_v2 (
        id, conversation_id, summary, generation_method, ai_generated, model,
        prompt_version, source_fingerprint, source_message_count,
        source_from_at, source_to_at, input_char_count, prompt_tokens,
        completion_tokens, total_tokens, attempt_count, mutation_id
      ) VALUES ('summary-1', 'conversation-1', '要約', 'semantic_v2', 1, 'model',
        'sales_conversation_summary_v2', ?, 1, '2026-09-09', '2026-09-09', 20, 1, 1, 2, 1, 'mutation-1')
    `).run('a'.repeat(64))
    db.prepare(`
      INSERT INTO sales_customer_semantic_summary_events_v2 (
        id, summary_id, summary, generation_method, ai_generated, model,
        prompt_version, source_fingerprint, source_message_count,
        source_from_at, source_to_at, input_char_count, prompt_tokens,
        completion_tokens, total_tokens, attempt_count
      ) VALUES ('event-1', 'summary-1', '要約', 'semantic_v2', 1, 'model',
        'sales_conversation_summary_v2', ?, 1, '2026-09-09', '2026-09-09', 20, 1, 1, 2, 1)
    `).run('a'.repeat(64))

    expect(() => db.prepare('UPDATE sales_customer_semantic_summary_events_v2 SET summary = ?').run('変更'))
      .toThrow(/append-only/i)
    expect(() => db.prepare('DELETE FROM sales_customer_semantic_summary_events_v2').run())
      .toThrow(/append-only/i)
    expect(() => db.prepare('DELETE FROM sales_customer_semantic_summaries_v2').run())
      .toThrow(/history is protected/i)
  })
})

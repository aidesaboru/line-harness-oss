import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const statusMigrationSql = readFileSync(
  join(__dirname, '..', 'migrations', '089_sales_customer_status.sql'),
  'utf8',
)
const migrationSql = readFileSync(
  join(__dirname, '..', 'migrations', '093_sales_customer_situation_timelines.sql'),
  'utf8',
)

const timeline = JSON.stringify([{
  occurredAt: '2026-09-09T10:00:00+09:00',
  kind: 'customer_contact',
  title: '返品の苦情を受信',
  detail: '顧客から返品方法について苦情が届いた。',
  state: 'open',
}])

describe('093_sales_customer_situation_timelines migration', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE staff_members (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        sales_only INTEGER NOT NULL DEFAULT 0 CHECK (sales_only IN (0, 1))
      );
      CREATE TABLE line_accounts (
        id TEXT PRIMARY KEY,
        is_active INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE friends (
        id TEXT PRIMARY KEY,
        line_account_id TEXT REFERENCES line_accounts(id)
      );
      CREATE TABLE line_conversations (
        id TEXT PRIMARY KEY,
        line_account_id TEXT REFERENCES line_accounts(id),
        source_type TEXT NOT NULL DEFAULT 'group'
      );
      CREATE TABLE messages_log (
        id TEXT PRIMARY KEY,
        friend_id TEXT NOT NULL REFERENCES friends(id),
        direction TEXT NOT NULL,
        message_type TEXT NOT NULL,
        content TEXT NOT NULL,
        delivery_type TEXT,
        source TEXT,
        deleted_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE line_conversation_messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES line_conversations(id),
        direction TEXT NOT NULL,
        message_type TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT NOT NULL,
        deleted_at TEXT,
        created_at TEXT NOT NULL
      );
      INSERT INTO staff_members (id, name) VALUES ('staff-1', '運営担当');
      INSERT INTO line_accounts (id, is_active) VALUES ('account-1', 1), ('account-off', 0);
      INSERT INTO friends (id, line_account_id) VALUES ('friend-1', 'account-1');
      INSERT INTO friends (id, line_account_id) VALUES ('friend-2', 'account-1');
      INSERT INTO friends (id, line_account_id) VALUES ('friend-off', 'account-off');
      INSERT INTO line_conversations (id, line_account_id, source_type)
      VALUES ('conversation-1', 'account-1', 'group');
    `)
    // 089 also adds staff_members.sales_only, so apply only its status DDL.
    db.exec(statusMigrationSql.slice(statusMigrationSql.indexOf('CREATE TABLE IF NOT EXISTS sales_customer_statuses')))
    db.prepare(`
      INSERT INTO sales_customer_statuses (id, friend_id, status, summary, mutation_id)
      VALUES ('legacy-status', 'friend-2', 'attention', '既存判断', 'legacy-mutation')
    `).run()
    db.exec(migrationSql)
  })

  afterEach(() => db.close())

  it('preserves existing statuses as manual and supports AI provenance', () => {
    expect(db.prepare('SELECT source, source_fingerprint FROM sales_customer_statuses WHERE id = ?').get('legacy-status'))
      .toEqual({ source: 'manual', source_fingerprint: null })
    db.prepare(`
      UPDATE sales_customer_statuses
      SET source = 'ai', source_fingerprint = ?
      WHERE id = 'legacy-status'
    `).run('a'.repeat(64))
    expect(db.prepare('SELECT source, length(source_fingerprint) AS fingerprint_length FROM sales_customer_statuses WHERE id = ?').get('legacy-status'))
      .toEqual({ source: 'ai', fingerprint_length: 64 })
    expect(() => db.prepare("UPDATE sales_customer_statuses SET source = 'unknown' WHERE id = 'legacy-status'").run())
      .toThrow(/CHECK constraint failed/i)
  })

  it('stores one current dated timeline per subject with structured metadata', () => {
    db.prepare(`
      INSERT INTO sales_customer_situation_timelines (
        id, friend_id, current_state, recognized_status, resolution_confirmed,
        timeline_json, generation_method, ai_generated, model, prompt_version,
        source_fingerprint, source_message_count, source_from_at, source_to_at,
        input_char_count, prompt_tokens, completion_tokens, total_tokens,
        attempt_count, mutation_id, updated_by, updated_by_name
      ) VALUES (?, ?, ?, ?, 0, ?, 'situation_timeline_v1', 1, ?,
        'sales_situation_timeline_v1', ?, 2, ?, ?, 300, 120, 80, 200, 1, ?, ?, ?)
    `).run(
      'timeline-1',
      'friend-1',
      '返品の苦情を受け、返送方法を確認中である。',
      'complaint',
      timeline,
      '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      'a'.repeat(64),
      '2026-09-09T10:00:00+09:00',
      '2026-09-09T11:00:00+09:00',
      'mutation-1',
      'staff-1',
      '運営担当',
    )

    expect(db.prepare('SELECT friend_id, recognized_status, generation_method, version FROM sales_customer_situation_timelines').get())
      .toEqual({ friend_id: 'friend-1', recognized_status: 'complaint', generation_method: 'situation_timeline_v1', version: 1 })
    expect(() => db.prepare(`
      INSERT INTO sales_customer_situation_timelines (
        id, friend_id, current_state, recognized_status, resolution_confirmed,
        timeline_json, generation_method, ai_generated, model, prompt_version,
        source_fingerprint, source_message_count, source_from_at, source_to_at,
        input_char_count, attempt_count, mutation_id
      ) VALUES ('timeline-2', 'friend-1', '重複', 'normal', 0, '[]',
        'situation_timeline_v1', 0, NULL, 'sales_situation_timeline_v1', ?,
        0, NULL, NULL, 0, 0, 'mutation-2')
    `).run('b'.repeat(64))).toThrow(/UNIQUE constraint failed/i)
  })

  it('rejects invalid timeline JSON and incompatible AI metadata', () => {
    const insert = db.prepare(`
      INSERT INTO sales_customer_situation_timelines (
        id, friend_id, current_state, recognized_status, resolution_confirmed,
        timeline_json, generation_method, ai_generated, model, prompt_version,
        source_fingerprint, source_message_count, source_from_at, source_to_at,
        input_char_count, attempt_count, mutation_id
      ) VALUES (?, ?, '未判定', 'unreviewed', 0, ?, ?, 0, NULL, ?, ?,
        0, NULL, NULL, 0, 0, ?)
    `)
    expect(() => insert.run('bad-json', 'friend-1', '{}', 'situation_timeline_v1', 'sales_situation_timeline_v1', 'a'.repeat(64), 'm-1'))
      .toThrow(/CHECK constraint failed/i)
    expect(() => insert.run('bad-method', 'friend-1', '[]', 'semantic_v3', 'sales_conversation_summary_v3', 'a'.repeat(64), 'm-2'))
      .toThrow(/CHECK constraint failed/i)
  })

  it('protects current records and append-only snapshot events', () => {
    db.prepare(`
      INSERT INTO sales_customer_situation_timelines (
        id, conversation_id, current_state, recognized_status,
        resolution_confirmed, timeline_json, generation_method, ai_generated,
        model, prompt_version, source_fingerprint, source_message_count,
        source_from_at, source_to_at, input_char_count, prompt_tokens,
        completion_tokens, total_tokens, attempt_count, mutation_id
      ) VALUES ('timeline-1', 'conversation-1', '返品対応中', 'attention',
        0, ?, 'situation_timeline_v1', 1, 'model',
        'sales_situation_timeline_v1', ?, 1, '2026-09-09', '2026-09-09',
        20, 1, 1, 2, 1, 'mutation-1')
    `).run(timeline, 'a'.repeat(64))
    db.prepare(`
      INSERT INTO sales_customer_situation_timeline_events (
        id, timeline_id, current_state, recognized_status,
        resolution_confirmed, timeline_json, generation_method, ai_generated,
        model, prompt_version, source_fingerprint, source_message_count,
        source_from_at, source_to_at, input_char_count, prompt_tokens,
        completion_tokens, total_tokens, attempt_count
      ) VALUES ('event-1', 'timeline-1', '返品対応中', 'attention',
        0, ?, 'situation_timeline_v1', 1, 'model',
        'sales_situation_timeline_v1', ?, 1, '2026-09-09', '2026-09-09',
        20, 1, 1, 2, 1)
    `).run(timeline, 'a'.repeat(64))

    expect(() => db.prepare("UPDATE sales_customer_situation_timeline_events SET current_state = '変更'").run())
      .toThrow(/append-only/i)
    expect(() => db.prepare('DELETE FROM sales_customer_situation_timeline_events').run())
      .toThrow(/append-only/i)
    expect(() => db.prepare('DELETE FROM sales_customer_situation_timelines').run())
      .toThrow(/history is protected/i)
  })

  it('queues only eligible human text and coalesces later messages per customer', () => {
    const insertFriend = db.prepare(`
      INSERT INTO messages_log (
        id, friend_id, direction, message_type, content,
        delivery_type, source, deleted_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '2026-09-09T10:00:00+09:00')
    `)
    insertFriend.run('message-1', 'friend-1', 'incoming', 'text', '返品について相談したい', null, 'user', null)
    const first = db.prepare(`
      SELECT subject_kind, subject_id, line_account_id, attempts,
             last_error_kind, claim_token, claimed_at,
             datetime(available_at) > datetime(queued_at) AS is_debounced
      FROM sales_customer_situation_queue
    `).get()
    expect(first).toEqual({
      subject_kind: 'friend',
      subject_id: 'friend-1',
      line_account_id: 'account-1',
      attempts: 0,
      last_error_kind: null,
      claim_token: null,
      claimed_at: null,
      is_debounced: 1,
    })

    db.prepare(`
      UPDATE sales_customer_situation_queue
      SET attempts = 3, last_error_kind = 'ai_unavailable',
          claim_token = 'old-claim', claimed_at = queued_at
      WHERE subject_kind = 'friend' AND subject_id = 'friend-1'
    `).run()
    insertFriend.run('message-2', 'friend-1', 'outgoing', 'text', '返送方法をご案内しました', null, 'manual', null)
    expect(db.prepare(`
      SELECT COUNT(*) AS count, attempts, last_error_kind, claim_token, claimed_at
      FROM sales_customer_situation_queue
      WHERE subject_kind = 'friend' AND subject_id = 'friend-1'
    `).get()).toEqual({ count: 1, attempts: 0, last_error_kind: null, claim_token: null, claimed_at: null })

    insertFriend.run('message-auto', 'friend-1', 'outgoing', 'text', '自動配信', null, 'broadcast', null)
    insertFriend.run('message-test', 'friend-2', 'incoming', 'text', 'テスト', 'test', 'user', null)
    insertFriend.run('message-media', 'friend-2', 'incoming', 'image', '画像', null, 'user', null)
    insertFriend.run('message-off', 'friend-off', 'incoming', 'text', '無効アカウント', null, 'user', null)
    expect(db.prepare('SELECT COUNT(*) AS count FROM sales_customer_situation_queue').get())
      .toEqual({ count: 1 })

    db.prepare(`
      INSERT INTO line_conversation_messages (
        id, conversation_id, direction, message_type, content, source, deleted_at, created_at
      ) VALUES ('group-message', 'conversation-1', 'incoming', 'text',
        '苦情の連絡', 'user', NULL, '2026-09-09T11:00:00+09:00')
    `).run()
    expect(db.prepare(`
      SELECT subject_kind, subject_id, line_account_id
      FROM sales_customer_situation_queue
      WHERE subject_kind = 'conversation'
    `).get()).toEqual({
      subject_kind: 'conversation',
      subject_id: 'conversation-1',
      line_account_id: 'account-1',
    })
  })
})

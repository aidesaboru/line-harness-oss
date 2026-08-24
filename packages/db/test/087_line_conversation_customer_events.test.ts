import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationSql = readFileSync(
  join(__dirname, '..', 'migrations', '087_line_conversation_customer_events.sql'),
  'utf8',
);

describe('087_line_conversation_customer_events migration', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE line_conversations (id TEXT PRIMARY KEY);
      INSERT INTO line_conversations VALUES ('group-1');
    `);
    db.exec(migrationSql);
  });

  afterEach(() => db.close());

  it('keeps before and after customer profiles as append-only JSON history', () => {
    db.prepare(`
      INSERT INTO line_conversation_customer_events (
        id, conversation_id, line_account_id, event_type, actor_id, actor_name,
        before_profile, after_profile, created_at
      ) VALUES (?, ?, ?, 'customer_profile_updated', ?, ?, ?, ?, ?)
    `).run(
      'event-1',
      'group-1',
      'account-1',
      'staff-1',
      '林',
      JSON.stringify({ customerNumber: '1000' }),
      JSON.stringify({ customerNumber: '2449', companyName: '河原通信' }),
      '2026-08-24T12:00:00+09:00',
    );
    expect(db.prepare(`
      SELECT before_profile, after_profile
      FROM line_conversation_customer_events WHERE id = 'event-1'
    `).get()).toEqual({
      before_profile: '{"customerNumber":"1000"}',
      after_profile: '{"customerNumber":"2449","companyName":"河原通信"}',
    });
    expect(() => db.prepare(
      `UPDATE line_conversation_customer_events SET actor_name = 'x' WHERE id = 'event-1'`,
    ).run()).toThrow(/append-only/);
    expect(() => db.prepare(
      `DELETE FROM line_conversation_customer_events WHERE id = 'event-1'`,
    ).run()).toThrow(/append-only/);
  });
});

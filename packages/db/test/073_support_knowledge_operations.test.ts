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
    CREATE TABLE support_knowledge_imports (id TEXT PRIMARY KEY);
    CREATE TABLE support_manuals (
      id TEXT PRIMARY KEY,
      line_account_id TEXT,
      title TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'basic',
      body TEXT NOT NULL DEFAULT '',
      url TEXT,
      keywords TEXT NOT NULL DEFAULT '',
      owner TEXT,
      approved_by TEXT,
      revised_at TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_by TEXT,
      updated_by TEXT,
      created_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT ''
    );
    INSERT INTO support_manuals (id, title, body) VALUES ('manual-existing', '既存ナレッジ', '既存本文');
  `);
  db.exec(readFileSync(join(pkgRoot, 'migrations', '073_support_knowledge_operations.sql'), 'utf8'));
  return db;
}

describe('073 support knowledge operations', () => {
  it('adds operational fields without removing existing manuals', () => {
    const db = openMigratedDatabase();
    const columns = db.prepare(`PRAGMA table_info('support_manuals')`).all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));

    expect(db.prepare(`SELECT COUNT(*) AS count FROM support_manuals`).get()).toEqual({ count: 1 });
    for (const name of [
      'knowledge_question',
      'knowledge_resolution',
      'knowledge_procedure',
      'knowledge_source_body',
      'knowledge_status',
      'knowledge_quality_score',
    ]) expect(names.has(name)).toBe(true);
    db.close();
  });

  it('protects manuals and revision history from physical deletion', () => {
    const db = openMigratedDatabase();
    db.prepare(
      `INSERT INTO support_manual_revisions (
        id, manual_id, line_account_id, change_type, snapshot, actor_id, actor_name
      ) VALUES (?, ?, NULL, ?, ?, ?, ?)`,
    ).run('revision-1', 'manual-existing', 'edited', '{}', 'owner-1', 'Owner');

    expect(() => db.prepare(`DELETE FROM support_manuals WHERE id = ?`).run('manual-existing'))
      .toThrow(/cannot be deleted/);
    expect(() => db.prepare(`UPDATE support_manual_revisions SET snapshot = ? WHERE id = ?`).run('{"changed":true}', 'revision-1'))
      .toThrow(/append-only/);
    expect(() => db.prepare(`DELETE FROM support_manual_revisions WHERE id = ?`).run('revision-1'))
      .toThrow(/append-only/);
    db.close();
  });
});

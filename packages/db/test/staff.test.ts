import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createStaffMember,
  deleteStaffMember,
  regenerateStaffApiKey,
  updateStaffMember,
} from '../src/staff.js';

type TestD1Result = {
  success: true;
  results: unknown[];
  meta: { changes: number };
};

type TestD1Statement = {
  bind: (...values: unknown[]) => TestD1Statement;
  run: () => Promise<TestD1Result>;
  first: <T>() => Promise<T | null>;
  execute: () => TestD1Result;
};

function createTestD1Database(sqlite: Database.Database): D1Database {
  const prepare = (sql: string): TestD1Statement => {
    let boundValues: unknown[] = [];
    const statement: TestD1Statement = {
      bind(...values: unknown[]) {
        boundValues = values;
        return statement;
      },
      async run() {
        return statement.execute();
      },
      async first<T>() {
        const row = sqlite.prepare(sql).get(...boundValues) as T | undefined;
        return row ?? null;
      },
      execute() {
        const result = sqlite.prepare(sql).run(...boundValues);
        return { success: true, results: [], meta: { changes: result.changes } };
      },
    };
    return statement;
  };

  return {
    prepare,
    async batch(statements: D1PreparedStatement[]) {
      const executeBatch = sqlite.transaction((pending: TestD1Statement[]) => (
        pending.map((statement) => statement.execute())
      ));
      return executeBatch(statements as unknown as TestD1Statement[]) as unknown as D1Result[];
    },
  } as unknown as D1Database;
}

describe('staff member mutation audit atomicity and owner safety', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE staff_members (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT,
        role TEXT NOT NULL,
        secondary_can_respond INTEGER NOT NULL DEFAULT 0,
        sales_only INTEGER NOT NULL DEFAULT 0,
        api_key TEXT UNIQUE NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE staff_member_events (
        id TEXT PRIMARY KEY,
        staff_id TEXT NOT NULL REFERENCES staff_members(id) ON DELETE RESTRICT,
        action TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        actor_id TEXT,
        actor_name TEXT
      );
      INSERT INTO staff_members (
        id, name, email, role, secondary_can_respond, sales_only, api_key, is_active, created_at, updated_at
      ) VALUES (
        'staff-1', '変更前', 'before@example.com', 'staff', 0, 0, 'lh_original', 1,
        '2026-08-24T10:00:00.000+09:00', '2026-08-24T10:00:00.000+09:00'
      );
      CREATE TRIGGER reject_staff_member_event
      BEFORE INSERT ON staff_member_events
      BEGIN
        SELECT RAISE(ABORT, 'staff event insert failed');
      END;
    `);
    db = createTestD1Database(sqlite);
  });

  afterEach(() => sqlite.close());

  it('rolls back staff creation when its audit event insert fails', async () => {
    await expect(createStaffMember(db, {
      name: '新規担当',
      email: 'new@example.com',
      role: 'staff',
    }, {
      action: 'created',
      actorId: 'owner-1',
      actorName: 'Owner',
    })).rejects.toThrow(/staff event insert failed/);

    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM staff_members').get())
      .toEqual({ count: 1 });
  });

  it('rolls back staff updates when their audit event insert fails', async () => {
    await expect(updateStaffMember(db, 'staff-1', {
      name: '変更後',
      role: 'secondary',
      secondary_can_respond: 1,
    }, {
      action: 'updated',
      actorId: 'owner-1',
      actorName: 'Owner',
    })).rejects.toThrow(/staff event insert failed/);

    expect(sqlite.prepare(
      `SELECT name, role, secondary_can_respond, updated_at
       FROM staff_members WHERE id = 'staff-1'`,
    ).get()).toEqual({
      name: '変更前',
      role: 'staff',
      secondary_can_respond: 0,
      updated_at: '2026-08-24T10:00:00.000+09:00',
    });
  });

  it('rolls back staff disablement when its audit event insert fails', async () => {
    await expect(deleteStaffMember(db, 'staff-1', {
      action: 'disabled',
      metadata: { reason: 'legacy_delete_endpoint' },
      actorId: 'owner-1',
      actorName: 'Owner',
    })).rejects.toThrow(/staff event insert failed/);

    expect(sqlite.prepare(
      `SELECT is_active, updated_at FROM staff_members WHERE id = 'staff-1'`,
    ).get()).toEqual({
      is_active: 1,
      updated_at: '2026-08-24T10:00:00.000+09:00',
    });
  });

  it('keeps the current API key when its regeneration audit event insert fails', async () => {
    await expect(regenerateStaffApiKey(db, 'staff-1', {
      action: 'api_key_regenerated',
      actorId: 'owner-1',
      actorName: 'Owner',
    })).rejects.toThrow(/staff event insert failed/);

    expect(sqlite.prepare(
      `SELECT api_key, updated_at FROM staff_members WHERE id = 'staff-1'`,
    ).get()).toEqual({
      api_key: 'lh_original',
      updated_at: '2026-08-24T10:00:00.000+09:00',
    });
  });

  it('keeps one active owner when two stale requests disable different owners', async () => {
    sqlite.exec(`
      DROP TRIGGER reject_staff_member_event;
      INSERT INTO staff_members (
        id, name, email, role, secondary_can_respond, sales_only, api_key, is_active, created_at, updated_at
      ) VALUES
        ('owner-a', 'Owner A', NULL, 'owner', 0, 0, 'lh_owner_a', 1,
         '2026-08-24T10:00:00.000+09:00', '2026-08-24T10:00:00.000+09:00'),
        ('owner-b', 'Owner B', NULL, 'owner', 0, 0, 'lh_owner_b', 1,
         '2026-08-24T10:00:00.000+09:00', '2026-08-24T10:00:00.000+09:00');
    `);

    const results = await Promise.allSettled([
      deleteStaffMember(db, 'owner-a', { action: 'disabled', actorName: 'Owner B' }),
      deleteStaffMember(db, 'owner-b', { action: 'disabled', actorName: 'Owner A' }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count FROM staff_members WHERE role = 'owner' AND is_active = 1`,
    ).get()).toEqual({ count: 1 });
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count FROM staff_member_events WHERE action = 'disabled'`,
    ).get()).toEqual({ count: 1 });
  });
});

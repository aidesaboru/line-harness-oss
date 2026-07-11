import { describe, expect, it } from 'vitest';
import {
  getFrozenLineAccountIds,
  getLineSafetyMode,
  getLineSendSafetyBlock,
  parseLineSafetySetting,
  setLineSafetyMode,
} from './line-safety.js';

type SettingRow = { value: string; updated_at: string };

function makeDb(initial: Record<string, SettingRow> = {}) {
  const settings = new Map<string, SettingRow>(Object.entries(initial));
  const calls: Array<{ method: 'first' | 'run'; binds: unknown[] }> = [];

  const db = {
    prepare() {
      let bound: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          bound = args;
          return stmt;
        },
        async first<T>() {
          calls.push({ method: 'first', binds: bound });
          const [accountId, key] = bound as [string, string];
          return (settings.get(`${accountId}:${key}`) ?? null) as T | null;
        },
        async run() {
          calls.push({ method: 'run', binds: bound });
          const [, accountId, key, value, , updatedAt, updateValue, updateUpdatedAt] = bound;
          settings.set(`${accountId}:${key}`, {
            value: String(updateValue ?? value),
            updated_at: String(updateUpdatedAt ?? updatedAt),
          });
          return { success: true, meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  } as unknown as D1Database & { calls: typeof calls; settings: typeof settings };

  db.calls = calls;
  db.settings = settings;
  return db;
}

describe('line safety mode', () => {
  it('parses empty, JSON, and legacy settings defensively', () => {
    expect(parseLineSafetySetting(null)).toEqual({
      frozen: false,
      reason: null,
      updatedAt: null,
      updatedBy: null,
    });
    expect(parseLineSafetySetting('true', '2026-06-01T00:00:00+09:00')).toEqual({
      frozen: true,
      reason: null,
      updatedAt: '2026-06-01T00:00:00+09:00',
      updatedBy: null,
    });
    expect(parseLineSafetySetting(JSON.stringify({
      frozen: true,
      reason: 'risk check',
      updatedAt: '2026-06-02T00:00:00+09:00',
      updatedBy: 'owner',
    }))).toEqual({
      frozen: true,
      reason: 'risk check',
      updatedAt: '2026-06-02T00:00:00+09:00',
      updatedBy: 'owner',
    });
  });

  it('returns null when an account is not frozen and block details when frozen', async () => {
    const db = makeDb({
      'acc-1:line_safety_freeze': {
        value: JSON.stringify({ frozen: true, reason: 'BANリスク確認', updatedAt: '2026-06-01T10:00:00+09:00', updatedBy: 'admin' }),
        updated_at: '2026-06-01T10:00:00+09:00',
      },
    });

    await expect(getLineSendSafetyBlock(db, 'acc-2')).resolves.toBeNull();
    const block = await getLineSendSafetyBlock(db, 'acc-1');

    expect(block).toMatchObject({
      accountId: 'acc-1',
      frozen: true,
      reason: 'BANリスク確認',
      message: 'LINE送信セーフティ停止中です: BANリスク確認',
    });
  });

  it('upserts safety mode and reads it back', async () => {
    const db = makeDb();

    await setLineSafetyMode(db, 'acc-1', {
      frozen: true,
      reason: '一時停止',
      updatedBy: 'Tajima (staff-1)',
    });
    await expect(getLineSafetyMode(db, 'acc-1')).resolves.toMatchObject({
      frozen: true,
      reason: '一時停止',
      updatedBy: 'Tajima (staff-1)',
    });

    await setLineSafetyMode(db, 'acc-1', { frozen: false });
    await expect(getLineSendSafetyBlock(db, 'acc-1')).resolves.toBeNull();
  });

  it('deduplicates account IDs when collecting frozen accounts', async () => {
    const db = makeDb({
      'acc-1:line_safety_freeze': {
        value: JSON.stringify({ frozen: true, reason: null }),
        updated_at: '2026-06-01T10:00:00+09:00',
      },
      'acc-2:line_safety_freeze': {
        value: JSON.stringify({ frozen: false }),
        updated_at: '2026-06-01T10:00:00+09:00',
      },
    });

    const blocks = await getFrozenLineAccountIds(db, ['acc-1', 'acc-1', 'acc-2', null]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].accountId).toBe('acc-1');
    expect(db.calls.filter((call) => call.method === 'first')).toHaveLength(2);
  });
});

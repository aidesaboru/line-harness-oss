import { describe, expect, it } from 'vitest';
import {
  buildCleanupFixtureSql,
  buildCleanupVerificationSql,
  buildSeedFixtureSql,
  configFromEnv,
  extractCleanupVerificationRows,
  fixtureIds,
  formatCleanupReport,
  formatCleanupVerificationReport,
  formatSeedReport,
  hasCleanupResidualRows,
} from './support-crm-seed-fixtures';

describe('support CRM seed fixture helpers', () => {
  it('builds config with generated defaults and write guard off', () => {
    const parsed = configFromEnv({
      SUPPORT_CRM_LINE_ACCOUNT_ID: ' acc-1 ',
      SUPPORT_CRM_FIXTURE_PREFIX: ' support crm fixtures! ',
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.lineAccountId).toBe('acc-1');
    expect(parsed.config.staffName).toBe('Preflight Staff');
    expect(parsed.config.prefix).toBe('support-crm-fixtures');
    expect(parsed.config.staffApiKey).toMatch(/^lh_pf_[a-f0-9]{32}$/);
    expect(parsed.config.confirmWrite).toBe(false);
    expect(parsed.config.createLineAccount).toBe(false);
  });

  it('requires a line account id', () => {
    const parsed = configFromEnv({});
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain('SUPPORT_CRM_LINE_ACCOUNT_ID');
  });

  it('uses stable fixture ids from the prefix', () => {
    expect(fixtureIds('pf')).toEqual({
      staffId: 'pf-staff',
      visibleFriendId: 'pf-visible-friend',
      forbiddenFriendId: 'pf-forbidden-friend',
      visibleOpenCaseId: 'pf-visible-open-case',
      visibleResolvedCaseId: 'pf-visible-resolved-case',
      forbiddenCaseId: 'pf-forbidden-case',
    });
  });

  it('builds idempotent synthetic fixture SQL', () => {
    const sql = buildSeedFixtureSql({
      lineAccountId: "acc-'1",
      staffName: "O'Hara",
      staffApiKey: 'staff-key',
      prefix: 'pf',
    });

    expect(sql).toContain("acc-''1");
    expect(sql).toContain("O''Hara");
    expect(sql).toContain('INSERT INTO staff_members');
    expect(sql).toContain('INSERT INTO friends');
    expect(sql).toContain('INSERT OR IGNORE INTO messages_log');
    expect(sql).toContain('INSERT INTO support_cases');
    expect(sql).toContain('ON CONFLICT(id) DO UPDATE SET');
    expect(sql).toContain('pf-visible-open-case');
    expect(sql).toContain('pf-visible-resolved-case');
    expect(sql).toContain('pf-forbidden-case');
    expect(sql).not.toContain('INSERT OR IGNORE INTO line_accounts');
    expect(sql).not.toMatch(/\bDELETE\b|\bDROP\b/i);
  });

  it('can seed a synthetic line account when explicitly requested', () => {
    const sql = buildSeedFixtureSql({
      lineAccountId: "acc-'1",
      staffName: 'Preflight Staff',
      staffApiKey: 'staff-key',
      prefix: 'pf',
      createLineAccount: true,
    });

    expect(sql).toContain('INSERT OR IGNORE INTO line_accounts');
    expect(sql).toContain('pf-channel');
    expect(sql).toContain('Support CRM Preflight Fixture');
    expect(sql).toContain('pf-access-token');
    expect(sql).toContain('pf-channel-secret');
  });

  it('prints strict preflight env suggestions', () => {
    const output = formatSeedReport({
      lineAccountId: 'acc-1',
      staffName: 'Preflight Staff',
      staffApiKey: 'staff-key',
      prefix: 'pf',
    });

    expect(output).toContain('Support CRM strict Preflight fixtures seeded.');
    expect(output).toContain('export SUPPORT_CRM_STAFF_API_KEY=staff-key');
    expect(output).toContain('export SUPPORT_CRM_STAFF_VISIBLE_CASE_ID=pf-visible-open-case');
    expect(output).toContain('export SUPPORT_CRM_STAFF_RESOLVED_FRIEND_ID=pf-visible-friend');
    expect(output).toContain('export SUPPORT_CRM_REQUIRE_FULL_COVERAGE=1');
  });

  it('retires synthetic fixtures without deleting historical rows', () => {
    const sql = buildCleanupFixtureSql({
      lineAccountId: "acc-'1",
      prefix: 'pf',
    });

    expect(sql).toContain("acc-''1");
    expect(sql).toContain('UPDATE support_cases');
    expect(sql).toContain("SET status = 'resolved'");
    expect(sql).toContain('UPDATE chats');
    expect(sql).toContain('UPDATE friends');
    expect(sql).toContain('UPDATE staff_members');
    expect(sql).toContain('UPDATE line_accounts');
    expect(sql).toContain('preflight case creation guard');
    expect(sql).not.toMatch(/\bDELETE\b|\bDROP\b/i);
  });

  it('prints cleanup confirmation without exposing API keys', () => {
    expect(formatCleanupReport({ prefix: 'pf' })).toBe('Support CRM strict Preflight fixtures retired without deleting history for prefix pf.\n');
  });

  it('builds read-only cleanup verification SQL including leaked chat rows', () => {
    const sql = buildCleanupVerificationSql({
      lineAccountId: "acc-'1",
      prefix: 'pf',
    });

    expect(sql).toContain("acc-''1");
    expect(sql).toContain('SELECT');
    expect(sql).toContain('line_accounts');
    expect(sql).toContain('support_cases');
    expect(sql).toContain('friends');
    expect(sql).toContain('staff_members');
    expect(sql).toContain('chats');
    expect(sql).toContain('preflight case creation guard');
    expect(sql).toContain('pf-visible-friend');
    expect(sql).not.toContain('UNION ALL');
    expect(sql).not.toMatch(/\bDELETE\b|\bDROP\b/i);
  });

  it('extracts cleanup verification rows from wrangler JSON output', () => {
    const rows = extractCleanupVerificationRows([
      {
        results: [
          { table_name: 'staff_members', residual_count: 0 },
          { table_name: 'chats', residual_count: '2' },
          { table_name: null, residual_count: 99 },
        ],
      },
    ]);

    expect(rows).toEqual([
      { table_name: 'staff_members', residual_count: 0 },
      { table_name: 'chats', residual_count: 2 },
    ]);
    expect(hasCleanupResidualRows(rows)).toBe(true);
  });

  it('extracts cleanup verification rows from wide wrangler JSON output', () => {
    const rows = extractCleanupVerificationRows([
      {
        results: [
          {
            line_accounts: 0,
            support_cases: '0',
            friends: 0,
            staff_members: 0,
            chats: 1,
          },
        ],
      },
    ]);

    expect(rows).toEqual([
      { table_name: 'line_accounts', residual_count: 0 },
      { table_name: 'support_cases', residual_count: 0 },
      { table_name: 'friends', residual_count: 0 },
      { table_name: 'staff_members', residual_count: 0 },
      { table_name: 'chats', residual_count: 1 },
    ]);
    expect(hasCleanupResidualRows(rows)).toBe(true);
  });

  it('formats cleanup verification results for pass and fail cases', () => {
    expect(formatCleanupVerificationReport({ prefix: 'pf' }, [
      { table_name: 'staff_members', residual_count: 0 },
      { table_name: 'chats', residual_count: 0 },
    ])).toContain('All checked active fixture row counts are 0.');

    expect(formatCleanupVerificationReport({ prefix: 'pf' }, [
      { table_name: 'staff_members', residual_count: 1 },
    ])).toContain('Active fixture rows remain.');
  });
});

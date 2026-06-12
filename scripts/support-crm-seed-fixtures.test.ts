import { describe, expect, it } from 'vitest';
import {
  buildCleanupFixtureSql,
  buildSeedFixtureSql,
  configFromEnv,
  fixtureIds,
  formatCleanupReport,
  formatSeedReport,
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
    expect(sql).toContain('INSERT OR REPLACE INTO staff_members');
    expect(sql).toContain('INSERT OR REPLACE INTO friends');
    expect(sql).toContain('INSERT OR REPLACE INTO messages_log');
    expect(sql).toContain('INSERT OR REPLACE INTO support_cases');
    expect(sql).toContain('pf-visible-open-case');
    expect(sql).toContain('pf-visible-resolved-case');
    expect(sql).toContain('pf-forbidden-case');
    expect(sql).not.toMatch(/\bDELETE\b|\bDROP\b/i);
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

  it('builds cleanup SQL for synthetic fixtures and leaked old-preflight rows', () => {
    const sql = buildCleanupFixtureSql({
      lineAccountId: "acc-'1",
      prefix: 'pf',
    });

    expect(sql).toContain("acc-''1");
    expect(sql).toContain('DELETE FROM support_case_events');
    expect(sql).toContain('DELETE FROM support_cases');
    expect(sql).toContain('DELETE FROM messages_log');
    expect(sql).toContain('DELETE FROM friends');
    expect(sql).toContain('DELETE FROM staff_members');
    expect(sql).toContain('preflight case creation guard');
    expect(sql).toContain('support_crm_preflight_fixture');
    expect(sql).not.toMatch(/\bDROP\b/i);
  });

  it('prints cleanup confirmation without exposing API keys', () => {
    expect(formatCleanupReport({ prefix: 'pf' })).toBe('Support CRM strict Preflight fixtures cleaned for prefix pf.\n');
  });
});

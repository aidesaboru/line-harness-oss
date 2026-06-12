import { describe, expect, it } from 'vitest';
import {
  buildFixtureCandidateSql,
  configFromEnv,
  escapeLikePattern,
  escapeSqlLiteral,
  extractFixtureRows,
  formatFixtureCandidateReport,
  selectFixtureEnvCandidates,
} from './support-crm-fixture-candidates';

describe('support CRM fixture candidate helpers', () => {
  it('builds config from env with safe defaults', () => {
    const parsed = configFromEnv({
      SUPPORT_CRM_LINE_ACCOUNT_ID: ' acc-1 ',
      SUPPORT_CRM_STAFF_NAME: ' 田島 ',
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config).toMatchObject({
      lineAccountId: 'acc-1',
      staffName: '田島',
      limit: 3,
      database: 'DB',
      wranglerConfig: 'apps/worker/wrangler.toml',
      remote: true,
    });
  });

  it('reports required env values together', () => {
    const parsed = configFromEnv({});
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain('SUPPORT_CRM_LINE_ACCOUNT_ID');
    expect(parsed.error).toContain('SUPPORT_CRM_STAFF_NAME');
  });

  it('escapes SQL literals and LIKE control characters', () => {
    expect(escapeSqlLiteral("O'Hara")).toBe("O''Hara");
    expect(escapeLikePattern('a%b_c\\d')).toBe('a\\%b\\_c\\\\d');
  });

  it('builds read-only SQL for all strict preflight fixture envs', () => {
    const sql = buildFixtureCandidateSql({
      lineAccountId: "acc-'1",
      staffName: '田_%',
      staffMemberId: 'staff-1',
      limit: 50,
    });

    expect(sql).toContain("acc-''1");
    expect(sql).toContain("'staff-1'");
    expect(sql).toContain("'%田\\_\\%%'");
    expect(sql).toContain('LIMIT 20');
    expect(sql).toContain('SUPPORT_CRM_STAFF_VISIBLE_CASE_ID');
    expect(sql).toContain('SUPPORT_CRM_STAFF_FORBIDDEN_CASE_ID');
    expect(sql).toContain('SUPPORT_CRM_STAFF_NON_RESOLVED_CASE_ID');
    expect(sql).toContain('SUPPORT_CRM_STAFF_RESOLVED_CASE_ID');
    expect(sql).toContain('SUPPORT_CRM_STAFF_VISIBLE_FRIEND_ID');
    expect(sql).toContain('SUPPORT_CRM_STAFF_FORBIDDEN_FRIEND_ID');
    expect(sql).toContain('SUPPORT_CRM_STAFF_RESOLVED_FRIEND_ID');
    expect(sql).not.toMatch(/\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bDROP\b/i);
  });

  it('extracts rows from nested wrangler D1 JSON output', () => {
    const rows = extractFixtureRows([
      {
        success: true,
        results: [
          {
            env_name: 'SUPPORT_CRM_STAFF_VISIBLE_CASE_ID',
            value: 'case-1',
            source: 'visible case',
            friend_id: 'friend-1',
          },
        ],
      },
      { results: [{ ignored: true }] },
    ]);

    expect(rows).toEqual([
      expect.objectContaining({
        env_name: 'SUPPORT_CRM_STAFF_VISIBLE_CASE_ID',
        value: 'case-1',
        source: 'visible case',
        friend_id: 'friend-1',
      }),
    ]);
  });

  it('selects one candidate per strict preflight env', () => {
    const selection = selectFixtureEnvCandidates([
      { env_name: 'SUPPORT_CRM_STAFF_VISIBLE_CASE_ID', value: 'case-visible-old' },
      { env_name: 'SUPPORT_CRM_STAFF_VISIBLE_CASE_ID', value: 'case-visible-new' },
      { env_name: 'SUPPORT_CRM_STAFF_RESOLVED_CASE_ID', value: 'case-resolved' },
      { env_name: 'SUPPORT_CRM_STAFF_RESOLVED_FRIEND_ID', value: 'friend-resolved' },
    ]);

    expect(selection.env.SUPPORT_CRM_STAFF_VISIBLE_CASE_ID).toBe('case-visible-old');
    expect(selection.env.SUPPORT_CRM_STAFF_RESOLVED_CASE_ID).toBe('case-resolved');
    expect(selection.env.SUPPORT_CRM_STAFF_RESOLVED_FRIEND_ID).toBe('friend-resolved');
    expect(selection.missingEnvNames).toContain('SUPPORT_CRM_STAFF_FORBIDDEN_CASE_ID');
  });

  it('formats env suggestions and missing fixture guidance', () => {
    const output = formatFixtureCandidateReport([
      {
        env_name: 'SUPPORT_CRM_STAFF_VISIBLE_CASE_ID',
        value: 'case-visible',
        source: 'visible case',
        friend_id: 'friend-visible',
        status: 'open',
        title: '問い合わせ',
      },
    ], { lineAccountId: 'line-1' });

    expect(output).toContain('Support CRM fixture candidates');
    expect(output).toContain('export SUPPORT_CRM_STAFF_VISIBLE_CASE_ID=case-visible');
    expect(output).toContain('Missing fixture candidates:');
    expect(output).toContain('SUPPORT_CRM_STAFF_RESOLVED_FRIEND_ID');
    expect(output).toContain('All candidates:');
    expect(output).toContain('friend=friend-visible');
    expect(output).toContain('Strict Preflight command template:');
    expect(output).toContain('export SUPPORT_CRM_LINE_ACCOUNT_ID=line-1');
    expect(output).toContain('export SUPPORT_CRM_OWNER_API_KEY=REPLACE_WITH_OWNER_OR_ADMIN_API_KEY');
    expect(output).toContain('export SUPPORT_CRM_STAFF_API_KEY=REPLACE_WITH_STAFF_API_KEY');
    expect(output).toContain('# TODO export SUPPORT_CRM_STAFF_RESOLVED_FRIEND_ID=<required-fixture-id>');
    expect(output).toContain('corepack pnpm preflight:support-crm:dry-run');
    expect(output).toContain('corepack pnpm preflight:support-crm > support-crm-preflight.log');
    expect(output).toContain('corepack pnpm preflight:support-crm:summary --file support-crm-preflight.log');
    expect(output).toContain('paste only the PR-safe summary');
    expect(output).not.toContain('title=問い合わせ');
  });
});

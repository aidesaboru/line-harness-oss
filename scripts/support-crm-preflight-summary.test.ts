import { describe, expect, it } from 'vitest';
import {
  formatPreflightPrSummary,
  parsePreflightSummaryLog,
  preflightSummaryExitCode,
  sanitizePreflightSummaryText,
} from './support-crm-preflight-summary';

describe('support CRM preflight PR-safe summary', () => {
  it('formats a successful strict preflight as a paste-safe PR summary', () => {
    const parsed = parsePreflightSummaryLog([
      'PASS owner: login identity - key ********',
      'PASS owner: capabilities',
      'PASS staff: unsupported chat message type is blocked - got 400',
      '',
      'Support CRM preflight: 20 passed, 0 skipped, 0 failed.',
    ].join('\n'));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const formatted = formatPreflightPrSummary(parsed.summary);
    expect(formatted).toContain('Support CRM Preflight PR-safe summary');
    expect(formatted).toContain('- Result: 20 passed, 0 skipped, 0 failed');
    expect(formatted).toContain('- Failures: none');
    expect(formatted).toContain('- Skipped optional checks: none');
    expect(formatted).toContain('- Safe to paste: yes.');
    expect(preflightSummaryExitCode(parsed)).toBe(0);
  });

  it('keeps failure and skip summaries free of URLs, secrets, and fixture IDs', () => {
    const parsed = parsePreflightSummaryLog([
      'PASS owner: login identity - key owner_live_1234567890abcdef',
      'FAIL staff: visible case can be opened - expected 200, got 404 from https://worker.example/api/support/cases/case-visible-abcdef',
      'FAIL friend-secret-123456 send guard - Bearer staff_secret_1234567890abcdef',
      'SKIP admin login CORS preflight - SUPPORT_CRM_ADMIN_ORIGIN is not set for https://admin.example',
      'SKIP case-hidden-123456 visibility check - friend-hidden-abcdef is not set',
      '',
      'Support CRM preflight: 1 passed, 2 skipped, 2 failed.',
      '',
      'Failures to fix:',
      '1. staff: visible case can be opened - expected 200, got 404 from https://worker.example/api/support/cases/case-visible-abcdef',
    ].join('\n'));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const formatted = formatPreflightPrSummary(parsed.summary);
    expect(formatted).toContain('- Result: 1 passed, 2 skipped, 2 failed');
    expect(formatted).toContain('staff: visible case can be opened');
    expect(formatted).toContain('[id-redacted] send guard');
    expect(formatted).toContain('[id-redacted] visibility check');
    expect(formatted).not.toContain('https://worker.example');
    expect(formatted).not.toContain('https://admin.example');
    expect(formatted).not.toContain('owner_live_1234567890abcdef');
    expect(formatted).not.toContain('staff_secret_1234567890abcdef');
    expect(formatted).not.toContain('case-visible-abcdef');
    expect(formatted).not.toContain('friend-hidden-abcdef');
    expect(preflightSummaryExitCode(parsed)).toBe(1);
  });

  it('returns parse failure when the preflight summary line is missing', () => {
    const parsed = parsePreflightSummaryLog('PASS owner: login identity\n');

    expect(parsed.ok).toBe(false);
    expect(preflightSummaryExitCode(parsed)).toBe(2);
  });

  it('does not say none when a truncated log only has failing counts', () => {
    const parsed = parsePreflightSummaryLog('Support CRM preflight: 18 passed, 1 skipped, 1 failed.\n');

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const formatted = formatPreflightPrSummary(parsed.summary);
    expect(formatted).toContain('- Failures: see local log');
    expect(formatted).toContain('- Skipped optional checks: see local log');
    expect(preflightSummaryExitCode(parsed)).toBe(1);
  });

  it('redacts common accidental sensitive text in check names', () => {
    expect(sanitizePreflightSummaryText('https://worker.example case-visible-abcdef Bearer staff_secret_1234567890abcdef'))
      .toBe('[url-redacted] [id-redacted] Bearer [secret-redacted]');
  });
});

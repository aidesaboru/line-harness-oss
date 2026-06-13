#!/usr/bin/env tsx
import { readFileSync } from 'node:fs';
import { argv, exit, stdin, stderr, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

type ParsedStatus = 'pass' | 'skip' | 'fail';

export type PreflightSummaryCounts = {
  passed: number;
  skipped: number;
  failed: number;
};

export type PreflightSummaryCheck = {
  status: ParsedStatus;
  name: string;
};

export type PreflightSummary = {
  counts: PreflightSummaryCounts;
  checks: PreflightSummaryCheck[];
};

export type PreflightSummaryResult =
  | { ok: true; summary: PreflightSummary }
  | { ok: false; error: string };

const SUMMARY_RE = /Support CRM preflight:\s*(\d+)\s+passed,\s*(\d+)\s+skipped,\s*(\d+)\s+failed\./i;
const CHECK_RE = /^(PASS|SKIP|FAIL)\s+(.+)$/;

function parsePositiveInteger(raw: string): number {
  return Number.parseInt(raw, 10);
}

export function sanitizePreflightSummaryText(raw: string): string {
  return raw
    .replace(/https?:\/\/[^\s)]+/gi, '[url-redacted]')
    .replace(/\b(Bearer|Authorization|Api-Key)\s+[^\s]+/gi, '$1 [secret-redacted]')
    .replace(/\b(?:sk|pk|rk|owner|admin|staff|secret|token|key)_[A-Za-z0-9_-]{8,}\b/g, '[secret-redacted]')
    .replace(/\b[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\b/gi, '[id-redacted]')
    .replace(/\b(?:case|friend|chat|line|staff|msg|event|account|acc|la)[-_][A-Za-z0-9][A-Za-z0-9_-]{5,}\b/gi, '[id-redacted]');
}

function parseCheckLine(rawLine: string): PreflightSummaryCheck | null {
  const match = rawLine.match(CHECK_RE);
  if (!match) return null;
  const rawStatus = match[1];
  const rawRest = match[2] ?? '';
  const detailIndex = rawRest.indexOf(' - ');
  const rawName = detailIndex >= 0 ? rawRest.slice(0, detailIndex) : rawRest;
  const name = sanitizePreflightSummaryText(rawName.trim());
  if (!name) return null;

  return {
    status: rawStatus.toLowerCase() as ParsedStatus,
    name,
  };
}

export function parsePreflightSummaryLog(rawLog: string): PreflightSummaryResult {
  const summaryMatch = rawLog.match(SUMMARY_RE);
  if (!summaryMatch) {
    return { ok: false, error: 'Could not find `Support CRM preflight: N passed, N skipped, N failed.` in the log.' };
  }

  const checks = rawLog
    .split(/\r?\n/)
    .map((line) => parseCheckLine(line.trim()))
    .filter((item): item is PreflightSummaryCheck => item !== null);

  return {
    ok: true,
    summary: {
      counts: {
        passed: parsePositiveInteger(summaryMatch[1] ?? '0'),
        skipped: parsePositiveInteger(summaryMatch[2] ?? '0'),
        failed: parsePositiveInteger(summaryMatch[3] ?? '0'),
      },
      checks,
    },
  };
}

function formatCheckList(label: string, checks: PreflightSummaryCheck[], expectedCount: number): string[] {
  if (checks.length === 0) return [`- ${label}: ${expectedCount > 0 ? 'see local log' : 'none'}`];
  return [
    `- ${label}:`,
    ...checks.map((check) => `  - ${check.name}`),
  ];
}

export function formatPreflightPrSummary(summary: PreflightSummary): string {
  const failures = summary.checks.filter((check) => check.status === 'fail');
  const skipped = summary.checks.filter((check) => check.status === 'skip');
  const { passed, skipped: skippedCount, failed } = summary.counts;

  return [
    'Support CRM Preflight PR-safe summary',
    `- Result: ${passed} passed, ${skippedCount} skipped, ${failed} failed`,
    ...formatCheckList('Failures', failures, failed),
    ...formatCheckList('Skipped optional checks', skipped, skippedCount),
    '- Safe to paste: yes. Check details are intentionally omitted; keep the full log local.',
    '',
  ].join('\n');
}

export function preflightSummaryExitCode(result: PreflightSummaryResult): number {
  if (!result.ok) return 2;
  if (result.summary.counts.failed > 0 || result.summary.counts.skipped > 0) return 1;
  return 0;
}

export async function readStreamText(stream: AsyncIterable<unknown>): Promise<string> {
  let text = '';
  for await (const chunk of stream) {
    if (typeof chunk === 'string') {
      text += chunk;
    } else if (chunk instanceof Uint8Array) {
      text += Buffer.from(chunk).toString('utf8');
    } else {
      text += String(chunk);
    }
  }
  return text;
}

function usage(): string {
  return [
    'Support CRM preflight PR-safe summary helper.',
    '',
    'Usage:',
    '  corepack pnpm preflight:support-crm > support-crm-preflight.log',
    '  corepack pnpm preflight:support-crm:summary --file support-crm-preflight.log',
    '  corepack pnpm preflight:support-crm | corepack pnpm preflight:support-crm:summary',
    '',
    'The output omits check details so URLs, API keys, friend IDs, and case IDs stay out of PR text.',
  ].join('\n');
}

async function readInput(args: string[]): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const fileFlag = args.find((arg) => arg === '--file' || arg === '-f' || arg.startsWith('--file='));
  if (fileFlag) {
    const path = fileFlag.startsWith('--file=')
      ? fileFlag.slice('--file='.length)
      : args[args.indexOf(fileFlag) + 1];
    if (!path) return { ok: false, error: 'Missing path after --file.' };
    return { ok: true, text: readFileSync(path, 'utf8') };
  }

  if (stdin.isTTY) {
    return { ok: false, error: 'Pass --file <log> or pipe preflight output into this command.' };
  }
  return { ok: true, text: await readStreamText(stdin as AsyncIterable<unknown>) };
}

async function main(): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    stdout.write(`${usage()}\n`);
    exit(0);
  }

  try {
    const input = await readInput(argv.slice(2));
    if (!input.ok) {
      stderr.write(`support-crm-preflight-summary: ${input.error}\n\n${usage()}\n`);
      exit(2);
    }

    const result = parsePreflightSummaryLog(input.text);
    if (!result.ok) {
      stderr.write(`support-crm-preflight-summary: ${result.error}\n`);
      exit(preflightSummaryExitCode(result));
    }

    stdout.write(formatPreflightPrSummary(result.summary));
    exit(preflightSummaryExitCode(result));
  } catch (err) {
    stderr.write(`support-crm-preflight-summary: ${err instanceof Error ? err.message : String(err)}\n`);
    exit(2);
  }
}

const isCliEntry = (() => {
  if (!argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === argv[1];
  } catch {
    return false;
  }
})();

if (isCliEntry) {
  void main();
}

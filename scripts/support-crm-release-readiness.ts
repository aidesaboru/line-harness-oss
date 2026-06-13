#!/usr/bin/env tsx
import { spawnSync } from 'node:child_process';
import { argv, exit, stderr, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

export type ReadinessStatus = 'pass' | 'wait' | 'fail';

export type ReadinessItem = {
  status: ReadinessStatus;
  name: string;
  detail: string;
  next?: string;
};

export type PullRequestSnapshot = {
  url?: string;
  headRefOid?: string;
  isDraft?: boolean;
  state?: string;
  mergeStateStatus?: string;
  body?: string;
};

export type WorkflowRunSnapshot = {
  status?: string;
  conclusion?: string;
  headSha?: string;
  workflowName?: string;
  databaseId?: number;
  url?: string;
};

export type ReadinessSnapshot = {
  branch?: string;
  localHead?: string;
  worktreeClean?: boolean;
  pr?: PullRequestSnapshot;
  prError?: string;
  latestRun?: WorkflowRunSnapshot;
  runError?: string;
};

type CommandResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
};

const REQUIRED_PR_BODY_EVIDENCE = [
  'corepack pnpm preflight:support-crm:dry-run',
  'corepack pnpm preflight:support-crm:summary',
  'Remote staff strict Preflight',
  'Remote cleanup verification',
  'GitHub Actions status',
] as const;

function item(status: ReadinessStatus, name: string, detail: string, next?: string): ReadinessItem {
  return next ? { status, name, detail, next } : { status, name, detail };
}

function run(command: string, args: string[]): CommandResult {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return {
    ok: result.status === 0,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function parseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function commandError(command: string, result: CommandResult): string {
  return result.stderr || result.stdout || `${command} failed`;
}

function mergeStateItem(mergeStateStatus: string | undefined): ReadinessItem {
  const status = mergeStateStatus ?? 'unknown';
  switch (status) {
    case 'CLEAN':
    case 'HAS_HOOKS':
      return item('pass', 'pr: merge state', status);
    case 'DIRTY':
      return item('fail', 'pr: merge state', status, 'Resolve merge conflicts with the base branch before draft release review.');
    case 'BEHIND':
      return item('fail', 'pr: merge state', status, 'Update this branch with the latest base branch before draft release review.');
    case 'UNSTABLE':
      return item('wait', 'pr: merge state', status, 'Wait for required checks or branch protection state to clear.');
    case 'BLOCKED':
      return item('wait', 'pr: merge state', status, 'Resolve the blocking review, policy, or branch protection requirement.');
    default:
      return item('wait', 'pr: merge state', status, 'Refresh PR metadata and confirm GitHub reports a mergeable state.');
  }
}

function workflowRunAction(run: WorkflowRunSnapshot, fallback: string): string {
  return run.url ? `${fallback} ${run.url}` : fallback;
}

export function evaluateReleaseReadiness(snapshot: ReadinessSnapshot): ReadinessItem[] {
  const items: ReadinessItem[] = [];

  items.push(snapshot.worktreeClean
    ? item('pass', 'local: worktree clean', 'no local changes')
    : item('fail', 'local: worktree clean', 'local changes are present', 'Commit, stash, or intentionally discard local changes before draft release review.'));

  if (snapshot.localHead) {
    items.push(item('pass', 'local: head detected', snapshot.localHead.slice(0, 12)));
  } else {
    items.push(item('fail', 'local: head detected', 'could not read git HEAD', 'Run `git rev-parse HEAD` and fix the local repository state.'));
  }

  if (snapshot.pr) {
    const pr = snapshot.pr;
    items.push(pr.state === 'OPEN'
      ? item('pass', 'pr: open', pr.url ?? 'open')
      : item('fail', 'pr: open', `state=${pr.state ?? 'unknown'}`, 'Reopen or recreate the support CRM PR.'));

    if (snapshot.localHead && pr.headRefOid) {
      items.push(pr.headRefOid === snapshot.localHead
        ? item('pass', 'pr: head matches local', pr.headRefOid.slice(0, 12))
        : item('fail', 'pr: head matches local', `PR ${pr.headRefOid.slice(0, 12)} != local ${snapshot.localHead.slice(0, 12)}`, 'Push the current branch before asking for review.'));
    } else {
      items.push(item('wait', 'pr: head matches local', 'missing PR head or local head', 'Fetch PR metadata and local HEAD again.'));
    }

    items.push(mergeStateItem(pr.mergeStateStatus));

    items.push(pr.isDraft
      ? item('wait', 'pr: draft status', 'PR is still draft', 'Keep draft until CI is approved/green and production strict Preflight inputs are ready.')
      : item('pass', 'pr: draft status', 'PR is ready for review'));

    const body = pr.body ?? '';
    const expectedBodyHead = pr.headRefOid ?? snapshot.localHead;
    if (expectedBodyHead) {
      items.push(body.includes(expectedBodyHead)
        ? item('pass', 'pr body: latest verified commit', expectedBodyHead.slice(0, 12))
        : item('fail', 'pr body: latest verified commit', 'missing current head SHA', 'Update the PR body so Latest verified commit matches the current PR head.'));
    } else {
      items.push(item('wait', 'pr body: latest verified commit', 'missing PR head or local head', 'Fetch PR metadata and local HEAD again.'));
    }

    for (const evidence of REQUIRED_PR_BODY_EVIDENCE) {
      items.push(body.includes(evidence)
        ? item('pass', `pr body: ${evidence}`, 'present')
        : item('fail', `pr body: ${evidence}`, 'missing', 'Update the PR body with the latest verification evidence.'));
    }

    if (body.includes('Not tested:')) {
      items.push(item('wait', 'production: real LINE cutover', 'not tested yet', 'Run final strict Preflight against real production LINE account data before production cutover.'));
    } else {
      items.push(item('pass', 'production: real LINE cutover', 'PR body no longer marks it untested'));
    }
  } else {
    items.push(item('wait', 'pr: metadata', snapshot.prError ?? 'PR metadata unavailable', 'Run `gh pr view` after authenticating GitHub CLI.'));
  }

  if (snapshot.latestRun) {
    const run = snapshot.latestRun;
    const detail = `${run.workflowName ?? 'workflow'} #${run.databaseId ?? 'unknown'} ${run.status ?? 'unknown'}/${run.conclusion ?? 'none'}`;
    const expectedHead = snapshot.pr?.headRefOid ?? snapshot.localHead;
    let runHeadMatchesCurrent: boolean | undefined;
    if (expectedHead && run.headSha) {
      runHeadMatchesCurrent = run.headSha === expectedHead;
      items.push(runHeadMatchesCurrent
        ? item('pass', 'ci: run head matches current head', run.headSha.slice(0, 12))
        : item('wait', 'ci: run head matches current head', `run ${run.headSha.slice(0, 12)} != current ${expectedHead.slice(0, 12)}`, 'Wait for GitHub Actions to create a run for the current PR head, or push an empty commit to retrigger it.'));
    } else {
      items.push(item('wait', 'ci: run head matches current head', 'missing run head or current head', 'Fetch PR and Actions metadata again.'));
    }

    if (runHeadMatchesCurrent === false) {
      items.push(item('wait', 'ci: latest GitHub Actions run', detail, 'Do not use stale CI results; wait for a run whose head matches the current PR head.'));
    } else if (run.conclusion === 'success') {
      items.push(item('pass', 'ci: latest GitHub Actions run', detail));
    } else if (run.conclusion === 'action_required') {
      items.push(item('wait', 'ci: latest GitHub Actions run', detail, workflowRunAction(run, 'Repository maintainer/admin must approve the fork PR workflow run.')));
    } else if (run.status === 'in_progress' || run.status === 'queued' || !run.conclusion) {
      items.push(item('wait', 'ci: latest GitHub Actions run', detail, workflowRunAction(run, 'Wait for GitHub Actions to finish.')));
    } else {
      items.push(item('fail', 'ci: latest GitHub Actions run', detail, workflowRunAction(run, 'Open the failed run logs and fix the failing check.')));
    }
  } else {
    items.push(item('wait', 'ci: latest GitHub Actions run', snapshot.runError ?? 'run metadata unavailable', 'Run `gh run list --branch <branch>` after authenticating GitHub CLI.'));
  }

  return items;
}

export function formatReleaseReadiness(items: ReadinessItem[]): string {
  const lines: string[] = ['Support CRM release readiness'];
  for (const readiness of items) {
    const detail = readiness.detail ? ` - ${readiness.detail}` : '';
    lines.push(`${readiness.status.toUpperCase()} ${readiness.name}${detail}`);
    if (readiness.next) lines.push(`  Next: ${readiness.next}`);
  }

  const passed = items.filter((entry) => entry.status === 'pass').length;
  const waiting = items.filter((entry) => entry.status === 'wait').length;
  const failed = items.filter((entry) => entry.status === 'fail').length;
  lines.push('', `Readiness summary: ${passed} passed, ${waiting} waiting, ${failed} failed.`);
  return `${lines.join('\n')}\n`;
}

export function readinessExitCode(items: ReadinessItem[]): number {
  if (items.some((entry) => entry.status === 'fail')) return 2;
  if (items.some((entry) => entry.status === 'wait')) return 1;
  return 0;
}

export function collectReleaseReadiness(): ReadinessSnapshot {
  const status = run('git', ['status', '--porcelain']);
  const head = run('git', ['rev-parse', 'HEAD']);
  const branch = run('git', ['branch', '--show-current']);

  const snapshot: ReadinessSnapshot = {
    branch: branch.ok ? branch.stdout : undefined,
    localHead: head.ok ? head.stdout : undefined,
    worktreeClean: status.ok ? status.stdout.length === 0 : false,
  };

  const prResult = run('gh', ['pr', 'view', '--json', 'url,headRefOid,isDraft,state,mergeStateStatus,body']);
  if (prResult.ok) {
    snapshot.pr = parseJson<PullRequestSnapshot>(prResult.stdout) ?? undefined;
    if (!snapshot.pr) snapshot.prError = 'failed to parse gh pr view output';
  } else {
    snapshot.prError = commandError('gh pr view', prResult);
  }

  const runBranch = snapshot.branch || 'ec-owner-support-mvp';
  const runResult = run('gh', [
    'run',
    'list',
    '--branch',
    runBranch,
    '--limit',
    '1',
    '--json',
    'status,conclusion,headSha,workflowName,databaseId,url',
  ]);
  if (runResult.ok) {
    const runs = parseJson<WorkflowRunSnapshot[]>(runResult.stdout);
    snapshot.latestRun = Array.isArray(runs) ? runs[0] : undefined;
    if (!snapshot.latestRun) snapshot.runError = 'no workflow runs found';
  } else {
    snapshot.runError = commandError('gh run list', runResult);
  }

  return snapshot;
}

function usage(): string {
  return [
    'Support CRM release readiness helper.',
    '',
    'This reads local git status plus GitHub PR/Actions metadata through gh.',
    'It separates internal failures from external waits such as fork PR CI approval.',
  ].join('\n');
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
  if (argv.includes('--help') || argv.includes('-h')) {
    stdout.write(`${usage()}\n`);
    exit(0);
  }

  try {
    const items = evaluateReleaseReadiness(collectReleaseReadiness());
    stdout.write(formatReleaseReadiness(items));
    exit(readinessExitCode(items));
  } catch (err) {
    stderr.write(`support-crm-release-readiness: ${err instanceof Error ? err.message : String(err)}\n`);
    exit(2);
  }
}

import { describe, expect, it } from 'vitest';
import {
  evaluateReleaseReadiness,
  formatReleaseReadiness,
  readinessExitCode,
  type ReadinessSnapshot,
} from './support-crm-release-readiness';

function completeSnapshot(overrides: Partial<ReadinessSnapshot> = {}): ReadinessSnapshot {
  const head = 'abc1234567890abcdef';
  return {
    branch: 'ec-owner-support-mvp',
    localHead: head,
    worktreeClean: true,
    pr: {
      url: 'https://github.com/example/repo/pull/1',
      headRefOid: head,
      isDraft: false,
      state: 'OPEN',
      mergeStateStatus: 'CLEAN',
      body: [
        head,
        'corepack pnpm preflight:support-crm:dry-run',
        'corepack pnpm preflight:support-crm:summary',
        'Remote staff strict Preflight',
        'Remote cleanup verification',
        'GitHub Actions status',
      ].join('\n'),
    },
    latestRun: {
      status: 'completed',
      conclusion: 'success',
      workflowName: 'Worker CI',
      databaseId: 1,
      headSha: head,
    },
    ...overrides,
  };
}

describe('support CRM release readiness', () => {
  it('passes when local, PR, evidence, and CI are ready', () => {
    const items = evaluateReleaseReadiness(completeSnapshot());

    expect(items.filter((entry) => entry.status !== 'pass')).toEqual([]);
    expect(readinessExitCode(items)).toBe(0);
    expect(formatReleaseReadiness(items)).toContain('Readiness summary:');
  });

  it('separates external waits from internal failures', () => {
    const basePr = completeSnapshot().pr!;
    const items = evaluateReleaseReadiness(completeSnapshot({
      pr: {
        ...basePr,
        isDraft: true,
        mergeStateStatus: 'UNSTABLE',
        body: [
          basePr.headRefOid,
          'corepack pnpm preflight:support-crm:dry-run',
          'corepack pnpm preflight:support-crm:summary',
          'Remote staff strict Preflight',
          'Remote cleanup verification',
          'GitHub Actions status',
          'Not tested:',
        ].join('\n'),
      },
      latestRun: {
        status: 'completed',
        conclusion: 'action_required',
        workflowName: 'Worker CI',
        databaseId: 27445335204,
        url: 'https://github.com/example/repo/actions/runs/27445335204',
      },
    }));

    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: 'wait',
        name: 'pr: draft status',
      }),
      expect.objectContaining({
        status: 'wait',
        name: 'pr: merge state',
        detail: 'UNSTABLE',
      }),
      expect.objectContaining({
        status: 'wait',
        name: 'production: real LINE cutover',
      }),
      expect.objectContaining({
        status: 'wait',
        name: 'ci: latest GitHub Actions run',
        next: expect.stringContaining('https://github.com/example/repo/actions/runs/27445335204'),
      }),
    ]));
    expect(items.some((entry) => entry.status === 'fail')).toBe(false);
    expect(readinessExitCode(items)).toBe(1);
  });

  it('waits when the latest CI run belongs to an older head', () => {
    const items = evaluateReleaseReadiness(completeSnapshot({
      latestRun: {
        status: 'completed',
        conclusion: 'success',
        workflowName: 'Worker CI',
        databaseId: 3,
        headSha: 'older1234567890abcdef',
      },
    }));

    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: 'wait',
        name: 'ci: run head matches current head',
        detail: expect.stringContaining('older1234567'),
      }),
      expect.objectContaining({
        status: 'wait',
        name: 'ci: latest GitHub Actions run',
        next: 'Do not use stale CI results; wait for a run whose head matches the current PR head.',
      }),
    ]));
    expect(items).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: 'pass',
        name: 'ci: latest GitHub Actions run',
      }),
    ]));
    expect(readinessExitCode(items)).toBe(1);
  });

  it('fails dirty local state, stale PR head, and missing PR evidence', () => {
    const items = evaluateReleaseReadiness(completeSnapshot({
      worktreeClean: false,
      pr: {
        url: 'https://github.com/example/repo/pull/1',
        headRefOid: 'def9876543210abcdef',
        isDraft: false,
        state: 'OPEN',
        mergeStateStatus: 'DIRTY',
        body: 'Remote cleanup verification',
      },
      latestRun: {
        status: 'completed',
        conclusion: 'failure',
        workflowName: 'Worker CI',
        databaseId: 2,
      },
    }));

    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: 'fail',
        name: 'local: worktree clean',
      }),
      expect.objectContaining({
        status: 'fail',
        name: 'pr: head matches local',
      }),
      expect.objectContaining({
        status: 'fail',
        name: 'pr: merge state',
        detail: 'DIRTY',
      }),
      expect.objectContaining({
        status: 'fail',
        name: 'pr body: latest verified commit',
      }),
      expect.objectContaining({
        status: 'fail',
        name: 'pr body: corepack pnpm preflight:support-crm:dry-run',
      }),
      expect.objectContaining({
        status: 'fail',
        name: 'pr body: corepack pnpm preflight:support-crm:summary',
      }),
      expect.objectContaining({
        status: 'fail',
        name: 'ci: latest GitHub Actions run',
      }),
    ]));
    expect(readinessExitCode(items)).toBe(2);
  });
});

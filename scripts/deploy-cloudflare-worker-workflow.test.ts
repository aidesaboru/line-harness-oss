import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  resolve('.github/workflows/deploy-cloudflare-worker.yml'),
  'utf8',
);

function position(text: string): number {
  const index = workflow.indexOf(text);
  expect(index, `workflow must contain: ${text}`).toBeGreaterThanOrEqual(0);
  return index;
}

function positionAfter(text: string, start: number): number {
  const index = workflow.indexOf(text, start);
  expect(index, `workflow must contain after ${start}: ${text}`).toBeGreaterThanOrEqual(0);
  return index;
}

describe('production Worker deploy workflow safety', () => {
  it('serializes deploys without cancelling an in-flight migration', () => {
    expect(workflow).toMatch(/concurrency:[\s\S]*cancel-in-progress: false/);
  });

  it('uses read-only GitHub permissions', () => {
    expect(workflow).toMatch(/permissions:\n\s+contents: read/);
    expect(workflow).not.toMatch(/contents: write/);
  });

  it('checks migrations before any remote D1 mutation', () => {
    expect(position('name: Check migration safety')).toBeLessThan(
      position('name: Capture recovery point and apply pending D1 migrations'),
    );
  });

  it('requires Time Travel and keeps the migration preflight copy private and ephemeral', () => {
    expect(workflow).toContain('wrangler d1 time-travel info');
    expect(workflow).toContain('D1 Time Travel bookmark was not returned');
    expect(workflow).toContain('.database_id == $id');
    expect(workflow).toContain('wrangler d1 export "$D1_DATABASE_NAME"');
    expect(workflow).toContain('mktemp -d "$RUNNER_TEMP/d1-migration-preflight-XXXXXX"');
    expect(workflow).toContain('chmod 600 "$preflight_log"');
    expect(workflow).toContain('> "$preflight_log" 2>&1');
    expect(workflow).toContain('cleanup_preflight');
    expect(position('D1 migration preflight integrity check failed')).toBeLessThan(
      position('Applying migration: $name'),
    );
    expect(workflow).toContain('path: deploy-safety/');
    expect(workflow).not.toMatch(/path:\s+.*\.sql(?:\.gz)?/);
    expect(workflow).not.toMatch(/path:\s+.*migration-preflight/);
  });

  it('applies and re-verifies migration markers before deploy', () => {
    const preflightDone = position('trap - EXIT');
    const apply = positionAfter('combined_migration="$(mktemp', preflightDone);
    const marker = positionAfter('INSERT INTO _migrations', apply);
    const importFile = positionAfter('--file="$combined_migration"', marker);
    const verify = position('D1 migration markers do not exactly match this checkout');
    const deploy = position('name: Deploy to Cloudflare Workers');
    expect(apply).toBeLessThan(marker);
    expect(marker).toBeLessThan(importFile);
    expect(importFile).toBeLessThan(verify);
    expect(verify).toBeLessThan(deploy);
    expect(workflow).not.toContain('--command "INSERT INTO _migrations');
    expect(workflow).toContain("then rm -f \"$combined_migration\"");
  });

  it('stops when the production migration ledger has a gap', () => {
    expect(workflow).toContain('D1 migration ledger has a gap before');
    expect(position('D1 migration ledger has a gap before')).toBeLessThan(
      position('combined_migration="$(mktemp'),
    );
  });

  it('blocks deploy when protected row counts decrease', () => {
    expect(workflow).toContain('protected-counts-before.json');
    expect(workflow).toContain('protected-counts-after.json');
    expect(position('Protected D1 row count decreased')).toBeLessThan(
      position('name: Deploy to Cloudflare Workers'),
    );
  });

  it('captures the previous version before deploy and rolls back on failure', () => {
    expect(position('previous-worker.json')).toBeLessThan(
      position('name: Deploy to Cloudflare Workers'),
    );
    expect(workflow).toContain('pnpm exec wrangler rollback "$PREVIOUS_VERSION"');
    expect(workflow).toContain("steps.smoke.outcome == 'failure'");
  });

  it('captures and restores Pages together with Worker and verifies deployed bytes', () => {
    expect(position('name: Capture current Pages production deployment')).toBeLessThan(
      position('name: Deploy exact hashed Admin artifact to Cloudflare Pages'),
    );
    expect(workflow).toContain('previous-pages.json');
    expect(workflow).toContain('pages-artifact-integrity.ts create');
    expect(workflow).toContain('pages-artifact-integrity.ts verify');
    expect(workflow).toContain('/deployments/${PREVIOUS_PAGES_ID}/rollback');
    expect(position('name: Roll back to previous Pages deployment')).toBeLessThan(
      position('name: Roll back to previous Worker'),
    );
    expect(workflow).toContain("steps.version-smoke.outcome == 'failure'");
    expect(workflow).toContain(
      "(steps.pages.outcome != 'failure' && steps.version-smoke.outcome != 'failure') || steps.rollback-pages.outcome == 'success'",
    );
    expect(workflow).toContain(
      'The new backward-compatible Worker was kept in place; restore Pages manually before changing Worker traffic.',
    );
  });

  it('uses a masked GitHub secret for the authenticated chats smoke test', () => {
    expect(position('name: Preflight production credentials')).toBeLessThan(
      position('name: Capture recovery point and apply pending D1 migrations'),
    );
    expect(workflow).toContain('API_KEY: ${{ secrets.API_KEY }}');
    expect(workflow).toContain('--header "Authorization: Bearer $API_KEY"');
    expect(workflow).toContain('/api/chats?q=__deployment_smoke_check__');
    expect(workflow).toContain('echo "::add-mask::$API_KEY"');
    expect(workflow).not.toMatch(/echo\s+.*\$API_KEY(?!")/);
  });
});

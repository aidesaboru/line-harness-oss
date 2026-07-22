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

  it('requires a Time Travel recovery point and never exports SQL', () => {
    expect(workflow).toContain('wrangler d1 time-travel info');
    expect(workflow).toContain('D1 Time Travel bookmark was not returned');
    expect(workflow).toContain('.database_id == $id');
    expect(workflow).not.toMatch(/wrangler d1 export/);
    expect(workflow).toContain('path: deploy-safety/');
    expect(workflow).not.toMatch(/path:\s+.*\.sql(?:\.gz)?/);
  });

  it('applies and re-verifies migration markers before deploy', () => {
    const apply = position('combined_migration="$(mktemp');
    const marker = position('INSERT INTO _migrations');
    const importFile = position('--file="$combined_migration"');
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

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  resolve('.github/workflows/d1-encrypted-backup.yml'),
  'utf8',
);

function position(text: string): number {
  const index = workflow.indexOf(text);
  expect(index, `workflow must contain: ${text}`).toBeGreaterThanOrEqual(0);
  return index;
}

describe('daily encrypted D1 backup workflow safety', () => {
  it('runs daily and can be triggered manually without write permissions', () => {
    expect(workflow).toContain("cron: '17 18 * * *'");
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain("vars.D1_ENCRYPTED_BACKUP_ENABLED == 'true'");
    expect(workflow).toMatch(/permissions:\n\s+contents: read/);
    expect(workflow).not.toContain('contents: write');
  });

  it('exports production in read-only mode and restores only to an ephemeral SQLite file', () => {
    const exportPosition = position('wrangler d1 export');
    const restorePosition = position('sqlite3 "$restored_db" < "$restored_sql"');
    expect(workflow.slice(exportPosition, position('test -s "$plain_backup"'))).toContain('--remote');
    expect(workflow.slice(restorePosition - 240, restorePosition + 80)).not.toContain('--remote');
    expect(workflow).not.toContain('time-travel restore');
    expect(workflow).toContain('sudo apt-get install --yes sqlite3');
  });

  it('limits secrets to the backup shell and pins third-party actions', () => {
    const jobStart = position('backup-and-restore-check:');
    const stepsStart = position('    steps:');
    const backupStep = position('- name: Export encrypt and restore-check D1');
    const uploadStep = position('- name: Upload verified encrypted backup');

    expect(workflow.slice(jobStart, stepsStart)).not.toContain('secrets.');
    expect(workflow.slice(backupStep, uploadStep)).toContain(
      'D1_BACKUP_ENCRYPTION_KEY: ${{ secrets.D1_BACKUP_ENCRYPTION_KEY }}',
    );
    expect(workflow.slice(uploadStep)).not.toContain('secrets.');
    expect(workflow).not.toMatch(/uses:\s+[^\s]+@v\d+(?:\s|$)/);
    expect(workflow).toMatch(/uses:\s+actions\/checkout@[0-9a-f]{40}/);
    expect(workflow).toMatch(/uses:\s+pnpm\/action-setup@[0-9a-f]{40}/);
    expect(workflow).toMatch(/uses:\s+actions\/setup-node@[0-9a-f]{40}/);
    expect(workflow).toMatch(/uses:\s+actions\/upload-artifact@[0-9a-f]{40}/);
  });

  it('uploads only after encryption and a successful restore verification', () => {
    expect(position('d1-backup-crypto.ts encrypt')).toBeLessThan(position('rm -f -- "$plain_backup"'));
    expect(position('d1-backup-crypto.ts decrypt')).toBeLessThan(position('sqlite3 "$restored_db" < "$restored_sql"'));
    expect(position('d1-backup-verify.ts verify')).toBeLessThan(position('name: Upload verified encrypted backup'));
    expect(workflow).toContain('path: ${{ steps.backup.outputs.artifact_dir }}/');
    expect(workflow).not.toMatch(/path:\s+[^\n]*backup\.sql\s*$/m);
    expect(workflow).toContain('retention-days: 90');
  });

  it('keeps plaintext in runner temp and removes it even on failure', () => {
    expect(workflow).toContain('mktemp -d "$RUNNER_TEMP/d1-backup-plain-XXXXXX"');
    expect(workflow).toContain("trap 'rm -rf -- \"$plain_dir\"' EXIT");
    expect(workflow).toContain('rm -f -- "$plain_backup"');
    expect(workflow).toContain('rm -f -- "$restored_sql"');
    expect(workflow).toContain('D1_BACKUP_ENCRYPTION_KEY: ${{ secrets.D1_BACKUP_ENCRYPTION_KEY }}');
    expect(workflow).toContain('without exposing its temporary download URL');
    expect(workflow).toContain('< "$restored_sql" > "$restore_log" 2>&1');
    expect(workflow).toContain('without exposing SQL contents');
  });
});

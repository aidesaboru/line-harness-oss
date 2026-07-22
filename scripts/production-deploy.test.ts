import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CORE_TABLES,
  assessSmokeResponse,
  buildAtomicMigrationSql,
  buildBackupPath,
  buildWranglerCliArgs,
  checkProductionMigration,
  findCoreTableCountDecreases,
  isPathInside,
  parseD1Rows,
  parseWranglerDefaults,
  planPendingMigrations,
  redactSecrets,
  runProductionDeployment,
  selectRollbackVersion,
  type MigrationFile,
  type MigrationLedgerState,
  type CoreTableCounts,
  type ProductionDeployConfig,
  type ProductionDeployDependencies,
  type SmokeResult,
} from './production-deploy';

const VERSION_A = '11111111-1111-4111-8111-111111111111';
const VERSION_B = '22222222-2222-4222-8222-222222222222';

function migration(name: string, sql = 'CREATE TABLE IF NOT EXISTS safe_table (id TEXT PRIMARY KEY);'): MigrationFile {
  return { name, path: `/repo/migrations/${name}`, sql };
}

function config(): ProductionDeployConfig {
  return {
    rootDir: '/repo',
    wranglerConfigPath: '/repo/apps/worker/wrangler.toml',
    migrationsDir: '/repo/packages/db/migrations',
    databaseName: 'production-db',
    workerName: 'production-worker',
    workerUrl: 'https://production-worker.example.com',
    smokeApiKey: 'top-secret-smoke-key',
    backupDir: '/secure/backups',
    smokeAttempts: 2,
    smokeDelayMs: 1,
  };
}

function deployment(versionId = VERSION_A, createdOn = '2026-07-22T00:00:00.000Z'): unknown {
  return [{
    created_on: createdOn,
    versions: [{ version_id: versionId, percentage: 100 }],
  }];
}

function dependencies(options: {
  initialLedger?: MigrationLedgerState;
  verifiedLedger?: MigrationLedgerState;
  smokeResults?: SmokeResult[];
  countSnapshots?: CoreTableCounts[];
} = {}): { deps: ProductionDeployDependencies; events: string[] } {
  const events: string[] = [];
  const ledgerStates = [
    options.initialLedger ?? { exists: true, appliedNames: ['001_initial.sql'] },
    options.verifiedLedger ?? { exists: true, appliedNames: ['001_initial.sql', '002_additive.sql'] },
  ];
  const smokeResults = [...(options.smokeResults ?? [{ ok: true } as const])];
  const counts = (): CoreTableCounts => ({
    line_accounts: 2,
    friends: 10,
    messages_log: 20,
    chats: 10,
    support_cases: 5,
    support_case_events: 7,
    support_escalations: 2,
    support_internal_messages: 3,
    chat_internal_messages: 4,
    internal_message_events: 5,
    internal_message_bookmark_events: 6,
    internal_tasks: 7,
    internal_task_events: 8,
    support_case_attachments: 9,
    chat_confirmation_events: 10,
    support_case_followup_reminders: 3,
    support_case_followup_reminder_events: 4,
    line_conversations: 1,
    line_conversation_messages: 2,
  });
  const countSnapshots = [...(options.countSnapshots ?? [counts(), counts()])];
  const deps: ProductionDeployDependencies = {
    buildWorker: vi.fn(async () => { events.push('build'); }),
    readMigrationLedger: vi.fn(async () => {
      events.push('read-ledger');
      return ledgerStates.shift() ?? ledgerStates.at(-1) ?? { exists: true, appliedNames: [] };
    }),
    readCurrentDeployments: vi.fn(async () => {
      events.push('read-deployment');
      return deployment();
    }),
    backupDatabase: vi.fn(async () => { events.push('backup'); }),
    ensureMigrationLedger: vi.fn(async () => { events.push('ensure-ledger'); }),
    readCoreTableCounts: vi.fn(async () => {
      events.push('read-counts');
      return countSnapshots.shift() ?? counts();
    }),
    applyMigration: vi.fn(async (file) => { events.push(`apply:${file.name}`); }),
    deployWorker: vi.fn(async () => { events.push('deploy'); }),
    smokeWorker: vi.fn(async () => {
      events.push('smoke');
      return smokeResults.shift() ?? { ok: true as const };
    }),
    rollbackWorker: vi.fn(async (versionId) => { events.push(`rollback:${versionId}`); }),
    log: vi.fn(),
    now: () => new Date('2026-07-22T09:10:11.123Z'),
  };
  return { deps, events };
}

describe('planPendingMigrations', () => {
  const names = ['001_initial.sql', '002_additive.sql', '003_more.sql'];

  it('returns pending files in filename order', () => {
    expect(planPendingMigrations(names, ['001_initial.sql'])).toEqual({
      orderedNames: names,
      pendingNames: ['002_additive.sql', '003_more.sql'],
    });
  });

  it('rejects a gap such as 068/069 missing while 070 is applied', () => {
    expect(() => planPendingMigrations(names, ['001_initial.sql', '003_more.sql']))
      .toThrow(/適用順が破綻/);
  });

  it('rejects a migration recorded only in production', () => {
    expect(() => planPendingMigrations(names, ['999_unknown.sql']))
      .toThrow(/本番だけに存在/);
  });
});

describe('checkProductionMigration', () => {
  it('allows additive schema changes', () => {
    expect(checkProductionMigration(
      'ALTER TABLE customers ADD COLUMN note TEXT;',
    )).toEqual({ ok: true });
  });

  it.each([
    'DROP TABLE customers;',
    'DELETE FROM customers;',
    "UPDATE customers SET name = 'x';",
    "INSERT OR REPLACE INTO customers (id) VALUES ('1');",
    'DROP INDEX idx_customers;',
    'VACUUM;',
  ])('rejects destructive SQL: %s', (sql) => {
    expect(checkProductionMigration(sql).ok).toBe(false);
  });

  it('does not treat protection trigger clauses as destructive DML', () => {
    const sql = `
      CREATE TRIGGER protect_delete
      BEFORE DELETE ON customers
      BEGIN
        SELECT RAISE(ABORT, 'protected');
      END;
    `;
    expect(checkProductionMigration(sql)).toEqual({ ok: true });
  });
});

describe('Wrangler response parsing', () => {
  it('parses D1 execute JSON rows', () => {
    expect(parseD1Rows(JSON.stringify([{
      results: [{ name: '001_initial.sql' }],
      success: true,
    }]))).toEqual([{ name: '001_initial.sql' }]);
  });

  it('selects the 100% version from the newest deployment', () => {
    expect(selectRollbackVersion([
      ...deployment(VERSION_B, '2026-07-22T02:00:00.000Z') as unknown[],
      ...deployment(VERSION_A, '2026-07-22T01:00:00.000Z') as unknown[],
    ])).toBe(VERSION_B);
  });

  it('refuses ambiguous split deployments', () => {
    expect(() => selectRollbackVersion([{
      created_on: '2026-07-22T02:00:00.000Z',
      versions: [
        { version_id: VERSION_A, percentage: 50 },
        { version_id: VERSION_B, percentage: 50 },
      ],
    }])).toThrow(/段階デプロイ中/);
  });
});

describe('secret and smoke handling', () => {
  it('redacts known values and bearer credentials', () => {
    const output = redactSecrets(
      'token=top-secret-smoke-key Authorization: Bearer another-secret',
      ['top-secret-smoke-key'],
    );
    expect(output).toBe('token=[REDACTED] Authorization: Bearer [REDACTED]');
  });

  it('requires an authenticated chat-list shaped response', () => {
    expect(assessSmokeResponse(200, { success: true, data: [] })).toEqual({ ok: true });
    expect(assessSmokeResponse(401, { success: false })).toEqual({ ok: false, reason: 'HTTP 401' });
    expect(assessSmokeResponse(200, { success: true, data: {} }).ok).toBe(false);
  });
});

describe('configuration helpers', () => {
  it('reads only the default deployment targets from wrangler TOML', () => {
    const toml = `
name = "live-worker"
[[d1_databases]]
database_name = "live-db"
[vars]
WORKER_PUBLIC_URL = "https://live-worker.example.com"
[env.production]
name = "placeholder-worker"
`;
    expect(parseWranglerDefaults(toml)).toEqual({
      workerName: 'live-worker',
      databaseName: 'live-db',
      workerUrl: 'https://live-worker.example.com',
    });
  });

  it('builds a deterministic backup path without unsafe database characters', () => {
    expect(buildBackupPath('/backups', 'live db', new Date('2026-07-22T09:10:11.123Z')))
      .toBe('/backups/2026-07-22T09-10-11-123Z-live_db.sql');
  });

  it('recognizes paths inside the GitHub workspace', () => {
    expect(isPathInside('/runner/work/repo', '/runner/work/repo/backups')).toBe(true);
    expect(isPathInside('/runner/work/repo', '/runner/temp/backups')).toBe(false);
  });

  it('keeps Wrangler arguments as an argv array with the intended config', () => {
    expect(buildWranglerCliArgs(
      '/repo/apps/worker/wrangler.toml',
      'd1',
      'execute',
      'live-db',
      '--remote',
      '--file',
      '/tmp/071.sql',
      '--yes',
    )).toEqual([
      'pnpm',
      'exec',
      'wrangler',
      'd1',
      'execute',
      'live-db',
      '--remote',
      '--file',
      '/tmp/071.sql',
      '--yes',
      '--config',
      '/repo/apps/worker/wrangler.toml',
    ]);
  });

  it('routes normal root and worker deploy commands through the safety script without recursion', () => {
    const rootPackage = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const workerPackage = JSON.parse(readFileSync(resolve('apps/worker/package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(rootPackage.scripts['deploy:worker']).toBe('tsx scripts/production-deploy.ts');
    expect(workerPackage.scripts.deploy).toBe('corepack pnpm --dir ../.. deploy:worker');
    expect(workerPackage.scripts['deploy:raw']).toBe('wrangler deploy --strict');
    expect(workerPackage.scripts['deploy:raw']).not.toContain('deploy:worker');
  });
});

describe('data preservation helpers', () => {
  it('covers every table protected by the workflow delete guards', () => {
    expect(CORE_TABLES).toEqual([
      'line_accounts',
      'friends',
      'messages_log',
      'chats',
      'support_cases',
      'support_case_events',
      'support_escalations',
      'support_internal_messages',
      'chat_internal_messages',
      'internal_message_events',
      'internal_message_bookmark_events',
      'internal_tasks',
      'internal_task_events',
      'support_case_attachments',
      'chat_confirmation_events',
      'support_case_followup_reminders',
      'support_case_followup_reminder_events',
      'line_conversations',
      'line_conversation_messages',
    ]);
  });

  it('adds the migration marker to the same D1 import body', () => {
    const combined = buildAtomicMigrationSql(migration(
      '002_additive.sql',
      'ALTER TABLE customers ADD COLUMN note TEXT;',
    ));
    expect(combined).toContain('ALTER TABLE customers ADD COLUMN note TEXT;');
    expect(combined).toContain("INSERT INTO _migrations (name, applied_at) VALUES ('002_additive.sql'");
  });

  it('reports every protected table whose row count decreases', () => {
    const before: CoreTableCounts = {
      line_accounts: 2,
      friends: 10,
      messages_log: 20,
      chats: 10,
      support_cases: 5,
      support_case_events: 7,
      support_escalations: 2,
      support_internal_messages: 3,
      chat_internal_messages: 4,
      internal_message_events: 5,
      internal_message_bookmark_events: 6,
      internal_tasks: 7,
      internal_task_events: 8,
      support_case_attachments: 9,
      chat_confirmation_events: 10,
      support_case_followup_reminders: 3,
      support_case_followup_reminder_events: 4,
      line_conversations: 1,
      line_conversation_messages: 2,
    };
    const after = { ...before, friends: 9, messages_log: 19 };
    expect(findCoreTableCountDecreases(before, after)).toEqual([
      { table: 'friends', before: 10, after: 9 },
      { table: 'messages_log', before: 20, after: 19 },
    ]);
  });
});

describe('runProductionDeployment', () => {
  const migrations = [migration('001_initial.sql'), migration('002_additive.sql')];

  it('builds, backs up, applies DB changes, deploys, then smokes in that order', async () => {
    const { deps, events } = dependencies();
    const result = await runProductionDeployment(config(), migrations, deps);
    expect(events).toEqual([
      'build',
      'read-ledger',
      'read-deployment',
      'backup',
      'read-counts',
      'apply:002_additive.sql',
      'read-counts',
      'read-ledger',
      'deploy',
      'smoke',
    ]);
    expect(result.appliedMigrations).toEqual(['002_additive.sql']);
    expect(result.backupPath).toContain('production-db.sql');
  });

  it('does not export a backup when there are no pending migrations', async () => {
    const { deps, events } = dependencies({
      initialLedger: { exists: true, appliedNames: ['001_initial.sql', '002_additive.sql'] },
    });
    await runProductionDeployment(config(), migrations, deps);
    expect(events).toEqual([
      'build',
      'read-ledger',
      'read-deployment',
      'deploy',
      'smoke',
    ]);
  });

  it('never deploys when migration order has a gap', async () => {
    const { deps, events } = dependencies({
      initialLedger: { exists: true, appliedNames: ['002_additive.sql'] },
    });
    await expect(runProductionDeployment(config(), migrations, deps)).rejects.toThrow(/適用順が破綻/);
    expect(events).toEqual(['build', 'read-ledger']);
  });

  it('never deploys when a protected table loses even one row', async () => {
    const before: CoreTableCounts = {
      line_accounts: 2,
      friends: 10,
      messages_log: 20,
      chats: 10,
      support_cases: 5,
      support_case_events: 7,
      support_escalations: 2,
      support_internal_messages: 3,
      chat_internal_messages: 4,
      internal_message_events: 5,
      internal_message_bookmark_events: 6,
      internal_tasks: 7,
      internal_task_events: 8,
      support_case_attachments: 9,
      chat_confirmation_events: 10,
      support_case_followup_reminders: 3,
      support_case_followup_reminder_events: 4,
      line_conversations: 1,
      line_conversation_messages: 2,
    };
    const { deps, events } = dependencies({
      countSnapshots: [before, { ...before, messages_log: 19 }],
    });
    await expect(runProductionDeployment(config(), migrations, deps))
      .rejects.toThrow(/messages_log: 20 -> 19/);
    expect(events).not.toContain('deploy');
  });

  it('rolls back and verifies recovery when the authenticated smoke test fails', async () => {
    const { deps, events } = dependencies({
      initialLedger: { exists: true, appliedNames: ['001_initial.sql', '002_additive.sql'] },
      smokeResults: [{ ok: false, reason: 'HTTP 500' }, { ok: true }],
    });
    await expect(runProductionDeployment(config(), migrations, deps))
      .rejects.toThrow(/rollbackしました/);
    expect(events.slice(-4)).toEqual([
      'deploy',
      'smoke',
      `rollback:${VERSION_A}`,
      'smoke',
    ]);
  });

  it('rolls back when the raw deploy command itself fails', async () => {
    const { deps, events } = dependencies({
      initialLedger: { exists: true, appliedNames: ['001_initial.sql', '002_additive.sql'] },
    });
    deps.deployWorker = vi.fn(async () => {
      events.push('deploy');
      throw new Error('upload failed');
    });
    await expect(runProductionDeployment(config(), migrations, deps))
      .rejects.toThrow(/直前のWorkerへrollbackしました/);
    expect(events.slice(-2)).toEqual(['deploy', `rollback:${VERSION_A}`]);
  });
});

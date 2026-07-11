import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Mock the engine before importing the route. Tests exercise HTTP behavior
// only — the engine itself is covered by its own package tests, so here we
// just want deterministic return values for runUpdate / manifest / snapshot
// reads. Mocks deliberately model both vanilla + fork outcomes so the route
// can choose between 202 / 200 (already_latest) / 409 (fork) branches.
const runUpdate = vi.fn();
const runRollback = vi.fn();
const fetchManifest = vi.fn();
const detectFork = vi.fn();
const findRelease = vi.fn();
const createRollbackSnapshot = vi.fn();
const createEventEmitter = vi.fn();
const getSnapshot = vi.fn();
const updateStatus = vi.fn();
const appendEvent = vi.fn();
const setError = vi.fn();
const markSnapshotRolledBack = vi.fn();
const listRecent = vi.fn();

vi.mock('@line-harness/update-engine', () => ({
  runUpdate: (...args: any[]) => runUpdate(...args),
  runRollback: (...args: any[]) => runRollback(...args),
  fetchManifest: (...args: any[]) => fetchManifest(...args),
  detectFork: (...args: any[]) => detectFork(...args),
  findRelease: (...args: any[]) => findRelease(...args),
  createRollbackSnapshot: (...args: any[]) => createRollbackSnapshot(...args),
  createEventEmitter: (...args: any[]) => createEventEmitter(...args),
  getSnapshot: (...args: any[]) => getSnapshot(...args),
  updateStatus: (...args: any[]) => updateStatus(...args),
  appendEvent: (...args: any[]) => appendEvent(...args),
  setError: (...args: any[]) => setError(...args),
  markSnapshotRolledBack: (...args: any[]) => markSnapshotRolledBack(...args),
  listRecent: (...args: any[]) => listRecent(...args),
}));

const baseRelease = {
  version: '0.8.0',
  released_at: '2026-05-01T00:00:00Z',
  worker_hash: 'sha256:aaaa',
  admin_hash: 'sha256:bbbb',
  liff_hash: 'sha256:cccc',
  bundle_url: 'https://example.com/bundle.tar.gz',
  bundle_size_bytes: 1000,
  required_secrets: [],
  new_required_secrets: [],
  migrations: [],
  changelog_url: '',
  min_from_version: '0.0.0',
};

const baseManifest = {
  schema_version: 1 as const,
  latest: '0.8.0',
  releases: [baseRelease],
};

// Import the route AFTER vi.mock so the engine import resolves through the
// stub. The route module is what we're testing.
async function loadRoute() {
  const mod = await import('./admin-update.js');
  return mod.default;
}

const baseEnv = {
  DB: {
    // The route never executes real SQL because every engine helper is mocked.
    // prepare() is here so any incidental call doesn't crash the test runner.
    prepare: vi.fn(() => ({
      bind: vi.fn(() => ({
        run: vi.fn().mockResolvedValue(undefined),
        first: vi.fn().mockResolvedValue(null),
        all: vi.fn().mockResolvedValue({ results: [] }),
      })),
    })),
  } as unknown as D1Database,
  ADMIN_API_KEY: 'test-admin-key',
  CF_API_TOKEN: 'cf-token',
  CF_ACCOUNT_ID: 'cf-acct',
  WORKER_NAME: 'line-harness',
  ADMIN_PAGES_PROJECT: 'line-harness-admin',
  LIFF_PAGES_PROJECT: 'line-harness-liff',
  D1_DATABASE_ID: 'd1-id',
  MANIFEST_URL: 'https://example.com/manifest.json',
  WORKER_PUBLIC_URL: 'https://worker.example.com',
  ADMIN_PUBLIC_URL: 'https://admin.example.com',
  LIFF_PUBLIC_URL: 'https://liff.example.com',
} as Record<string, unknown>;

const baseCtx = {
  // executionCtx.waitUntil runs the work async; in tests we want it to run
  // synchronously (await the promise) so we observe runUpdate side-effects.
  waitUntil: (p: Promise<unknown>) => p,
  passThroughOnException: vi.fn(),
  props: {},
} as unknown as ExecutionContext;

async function request(path: string, init?: RequestInit) {
  const app = new Hono();
  const adminUpdate = await loadRoute();
  app.route('/admin/update', adminUpdate);
  return app.request(path, init, baseEnv, baseCtx);
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default happy-path setups; individual tests override as needed.
  fetchManifest.mockResolvedValue(baseManifest);
  detectFork.mockReturnValue({ kind: 'vanilla', matchedRelease: baseRelease });
  findRelease.mockReturnValue({ ...baseRelease, version: '0.0.0-dev' });
  // The engine now returns an UpdateHandle: outer resolves quickly with the
  // id, `done` settles later with the terminal state. Tests mock the success
  // path by default; failure cases reject either outer (setup error) or
  // `done` (phase error).
  runUpdate.mockResolvedValue({
    updateId: 'UPDATE_ID_123',
    done: Promise.resolve('UPDATE_ID_123'),
  });
  runRollback.mockResolvedValue(undefined);
  createRollbackSnapshot.mockResolvedValue('ROLLBACK_ID_123');
  createEventEmitter.mockImplementation(({ persist }: { persist: (event: unknown) => Promise<void> }) => ({
    emit: vi.fn((event: unknown) => persist(event)),
  }));
  appendEvent.mockResolvedValue(undefined);
  updateStatus.mockResolvedValue(undefined);
  setError.mockResolvedValue(undefined);
  markSnapshotRolledBack.mockResolvedValue(undefined);
  getSnapshot.mockResolvedValue(null);
  listRecent.mockResolvedValue([]);
});

describe('POST /admin/update/start', () => {
  it('rejects requests without ADMIN_API_KEY header → 401', async () => {
    const res = await request('/admin/update/start', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('rejects requests with wrong key → 401', async () => {
    const res = await request('/admin/update/start', {
      method: 'POST',
      headers: { 'x-admin-api-key': 'wrong' },
    });
    expect(res.status).toBe(401);
  });

  it('starts an update and returns 202 with updateId', async () => {
    const res = await request('/admin/update/start', {
      method: 'POST',
      headers: { 'x-admin-api-key': 'test-admin-key' },
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { updateId: string };
    expect(body.updateId).toBe('UPDATE_ID_123');
    expect(runUpdate).toHaveBeenCalledTimes(1);
  });

  it('returns 200 with already_latest when target.version === current.version', async () => {
    // Force the target to match the build-time current version (0.0.0-dev).
    fetchManifest.mockResolvedValue({
      ...baseManifest,
      latest: '0.0.0-dev',
      releases: [{ ...baseRelease, version: '0.0.0-dev' }],
    });
    // detectFork returns vanilla because hashes happen to match (the engine
    // would actually compare them; we shortcut by returning vanilla here).
    detectFork.mockReturnValue({
      kind: 'vanilla',
      matchedRelease: { ...baseRelease, version: '0.0.0-dev' },
    });
    const res = await request('/admin/update/start', {
      method: 'POST',
      headers: { 'x-admin-api-key': 'test-admin-key' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('already_latest');
    expect(runUpdate).not.toHaveBeenCalled();
  });

  it('returns 409 fork_detected when detectFork reports a fork', async () => {
    detectFork.mockReturnValue({
      kind: 'fork',
      reason: 'worker hash mismatch (custom build)',
    });
    const res = await request('/admin/update/start', {
      method: 'POST',
      headers: { 'x-admin-api-key': 'test-admin-key' },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; reason: string };
    expect(body.error).toBe('fork_detected');
    expect(body.reason).toContain('worker hash mismatch');
    expect(runUpdate).not.toHaveBeenCalled();
  });

  it('returns 500 update_failed when runUpdate rejects before snapshot creation', async () => {
    // Simulate getLatestDeployment failing inside the engine — runUpdate
    // rejects synchronously before producing a handle, so there's no
    // updateId to return. The route should surface a safe 500 update_failed
    // without echoing Cloudflare/API response details to the dashboard.
    runUpdate.mockRejectedValueOnce(
      new Error('cf pages api down SECRET_ADMIN_TOKEN project=line-harness-admin'),
    );
    const res = await request('/admin/update/start', {
      method: 'POST',
      headers: { 'x-admin-api-key': 'test-admin-key' },
    });
    expect(res.status).toBe(500);
    const bodyText = await res.text();
    expect(bodyText).not.toContain('cf pages api down');
    expect(bodyText).not.toContain('SECRET_ADMIN_TOKEN');
    expect(bodyText).not.toContain('line-harness-admin');
    const body = JSON.parse(bodyText) as { error: string; message: string; errorKind: string };
    expect(body.error).toBe('update_failed');
    expect(body.message).toBe('Update setup failed');
    expect(body.errorKind).toBe('Error');
  });
});

describe('POST /admin/update/rollback/:id', () => {
  function rollbackSource(overrides: Record<string, unknown> = {}) {
    return {
      id: 'UPDATE_SOURCE',
      started_at: Date.now() - 1000,
      completed_at: Date.now() - 500,
      from_version: '0.7.0',
      to_version: '0.8.0',
      status: 'success',
      snapshot_worker_url: 'https://r2.example.com/worker-0.7.0.js',
      snapshot_admin_deployment: 'dep-admin-old',
      snapshot_liff_deployment: 'dep-liff-old',
      events_jsonl: '',
      error: null,
      rollback_of: null,
      rollback_expires_at: Date.now() + 60_000,
      ...overrides,
    };
  }

  it('rejects requests without ADMIN_API_KEY header → 401', async () => {
    const res = await request('/admin/update/rollback/UPDATE_SOURCE', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('rejects malformed update ids before snapshot lookup', async () => {
    const res = await request('/admin/update/rollback/bad%20id', {
      method: 'POST',
      headers: { 'x-admin-api-key': 'test-admin-key' },
    });

    expect(res.status).toBe(400);
    expect(getSnapshot).not.toHaveBeenCalled();
  });

  it('returns 404 when the source snapshot does not exist', async () => {
    getSnapshot.mockResolvedValueOnce(null);

    const res = await request('/admin/update/rollback/UPDATE_SOURCE', {
      method: 'POST',
      headers: { 'x-admin-api-key': 'test-admin-key' },
    });

    expect(res.status).toBe(404);
    expect(createRollbackSnapshot).not.toHaveBeenCalled();
  });

  it('returns 409 when rollback is unavailable for the row', async () => {
    getSnapshot.mockResolvedValueOnce(rollbackSource({ status: 'failed' }));

    const res = await request('/admin/update/rollback/UPDATE_SOURCE', {
      method: 'POST',
      headers: { 'x-admin-api-key': 'test-admin-key' },
    });

    expect(res.status).toBe(409);
    expect(createRollbackSnapshot).not.toHaveBeenCalled();
  });

  it('returns 409 when rollback is expired', async () => {
    getSnapshot.mockResolvedValueOnce(rollbackSource({ rollback_expires_at: Date.now() - 1 }));

    const res = await request('/admin/update/rollback/UPDATE_SOURCE', {
      method: 'POST',
      headers: { 'x-admin-api-key': 'test-admin-key' },
    });

    expect(res.status).toBe(409);
    expect(createRollbackSnapshot).not.toHaveBeenCalled();
  });

  it('returns 409 when rollback snapshot coordinates are missing', async () => {
    getSnapshot.mockResolvedValueOnce(rollbackSource({ snapshot_worker_url: null }));

    const res = await request('/admin/update/rollback/UPDATE_SOURCE', {
      method: 'POST',
      headers: { 'x-admin-api-key': 'test-admin-key' },
    });

    expect(res.status).toBe(409);
    expect(createRollbackSnapshot).not.toHaveBeenCalled();
  });

  it('starts rollback in the background and marks rows on success', async () => {
    getSnapshot.mockResolvedValueOnce(rollbackSource());

    const res = await request('/admin/update/rollback/UPDATE_SOURCE', {
      method: 'POST',
      headers: { 'x-admin-api-key': 'test-admin-key' },
    });
    await Promise.resolve();

    expect(res.status).toBe(202);
    const body = (await res.json()) as { updateId: string; rollbackOf: string };
    expect(body).toEqual({ updateId: 'ROLLBACK_ID_123', rollbackOf: 'UPDATE_SOURCE' });
    expect(createRollbackSnapshot).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      rollbackOf: 'UPDATE_SOURCE',
      from: '0.8.0',
      to: '0.7.0',
    }));
    expect(runRollback).toHaveBeenCalledWith(
      expect.objectContaining({
        workerName: 'line-harness',
        adminPagesProject: 'line-harness-admin',
        liffPagesProject: 'line-harness-liff',
      }),
      {
        snapshotWorkerBundleUrl: 'https://r2.example.com/worker-0.7.0.js',
        snapshotAdminDeployment: 'dep-admin-old',
        snapshotLiffDeployment: 'dep-liff-old',
      },
      expect.anything(),
    );
    expect(updateStatus).toHaveBeenCalledWith(expect.anything(), 'ROLLBACK_ID_123', 'success');
    expect(markSnapshotRolledBack).toHaveBeenCalledWith(expect.anything(), 'UPDATE_SOURCE');
  });

  it('redacts snapshot lookup failures before responding', async () => {
    getSnapshot.mockRejectedValueOnce(
      new Error('snapshot failed CF_API_TOKEN project=line-harness-admin'),
    );

    const res = await request('/admin/update/rollback/UPDATE_SOURCE', {
      method: 'POST',
      headers: { 'x-admin-api-key': 'test-admin-key' },
    });

    expect(res.status).toBe(500);
    const bodyText = await res.text();
    expect(bodyText).toContain('Rollback setup failed');
    expect(bodyText).not.toContain('CF_API_TOKEN');
    expect(bodyText).not.toContain('line-harness-admin');
  });
});

describe('GET /admin/update/status/:id', () => {
  it('returns 401 without auth', async () => {
    const res = await request('/admin/update/status/abc');
    expect(res.status).toBe(401);
  });

  it('returns 404 when no snapshot row exists', async () => {
    getSnapshot.mockResolvedValue(null);
    const res = await request('/admin/update/status/nope', {
      headers: { 'x-admin-api-key': 'test-admin-key' },
    });
    expect(res.status).toBe(404);
  });

  it('returns 200 with row + parsed events array when row exists', async () => {
    getSnapshot.mockResolvedValue({
      id: 'abc',
      status: 'success',
      events_jsonl:
        '{"step":"preflight","status":"done"}\n{"step":"complete","status":"done"}\n',
      error: null,
      from_version: '0.7.0',
      to_version: '0.8.0',
    });
    const res = await request('/admin/update/status/abc', {
      headers: { 'x-admin-api-key': 'test-admin-key' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      status: string;
      events: Array<{ step: string; status: string }>;
    };
    expect(body.id).toBe('abc');
    expect(body.status).toBe('success');
    expect(body.events).toHaveLength(2);
    expect(body.events[0]).toEqual({ step: 'preflight', status: 'done' });
    expect(body.events[1]).toEqual({ step: 'complete', status: 'done' });
  });
});

describe('POST /admin/update/manual-record', () => {
  it('returns 401 without auth', async () => {
    const res = await request('/admin/update/manual-record', {
      method: 'POST',
      body: JSON.stringify({ title: '権限整理', changes: ['メニューを整理'] }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects malformed manual history payloads before DB writes', async () => {
    const res = await request('/admin/update/manual-record', {
      method: 'POST',
      headers: { 'x-admin-api-key': 'test-admin-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: ' ', changes: [] }),
    });

    expect(res.status).toBe(400);
    expect((baseEnv.DB as { prepare: ReturnType<typeof vi.fn> }).prepare).not.toHaveBeenCalled();
  });

  it('persists a manual update history row', async () => {
    const res = await request('/admin/update/manual-record', {
      method: 'POST',
      headers: { 'x-admin-api-key': 'test-admin-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: '権限メニュー整理',
        changes: ['一次対応と二次対応の基本メニューを統一', 'スタッフ管理と緊急コントロールをオーナー専用化'],
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { success: boolean; id: string };
    expect(body.success).toBe(true);
    expect(body.id).toMatch(/^manual_/);
    expect((baseEnv.DB as { prepare: ReturnType<typeof vi.fn> }).prepare).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO update_history'),
    );
  });
});

describe('GET /admin/update/history', () => {
  it('returns 401 without auth', async () => {
    const res = await request('/admin/update/history');
    expect(res.status).toBe(401);
  });

  it('returns 200 with history array', async () => {
    listRecent.mockResolvedValue([
      { id: 'a', status: 'success', from_version: '0.7.0', to_version: '0.8.0' },
      { id: 'b', status: 'failed', from_version: '0.6.0', to_version: '0.7.0' },
    ]);
    const res = await request('/admin/update/history', {
      headers: { 'x-admin-api-key': 'test-admin-key' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { history: Array<{ id: string }> };
    expect(body.history).toHaveLength(2);
    expect(body.history[0].id).toBe('a');
    // listRecent should be called with limit=20
    expect(listRecent).toHaveBeenCalled();
    const callArgs = listRecent.mock.calls[0];
    expect(callArgs[1]).toBe(20);
  });
});

describe('GET /admin/update/stream/:id', () => {
  it('returns 401 without auth', async () => {
    const res = await request('/admin/update/stream/abc');
    expect(res.status).toBe(401);
  });

  it('sets correct SSE headers when authenticated', async () => {
    // Return a terminal snapshot so the stream loop exits after one tick.
    getSnapshot.mockResolvedValue({
      id: 'abc',
      status: 'success',
      events_jsonl: '{"step":"complete","status":"done"}\n',
      error: null,
      from_version: '0.7.0',
      to_version: '0.8.0',
    });
    const res = await request('/admin/update/stream/abc', {
      headers: { 'x-admin-api-key': 'test-admin-key' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    expect(res.headers.get('Cache-Control')).toBe('no-cache');
  });

  it('redacts unexpected stream errors in SSE error frames', async () => {
    getSnapshot.mockRejectedValueOnce(
      new Error('snapshot read failed UPDATE_SECRET_TOKEN id=UPDATE_ID_123'),
    );

    const res = await request('/admin/update/stream/abc', {
      headers: { 'x-admin-api-key': 'test-admin-key' },
    });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('event: error');
    expect(body).toContain('"error":"stream_failed"');
    expect(body).toContain('"errorKind":"Error"');
    expect(body).not.toContain('snapshot read failed');
    expect(body).not.toContain('UPDATE_SECRET_TOKEN');
    expect(body).not.toContain('UPDATE_ID_123');
  });
});

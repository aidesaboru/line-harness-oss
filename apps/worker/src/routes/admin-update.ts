/**
 * Self-update HTTP API — Phase 5 Task 18.
 *
 * Mounted at `/admin/update` from `index.ts`. Every endpoint is guarded by an
 * `x-admin-api-key` header check that must equal `c.env.ADMIN_API_KEY`. The
 * sibling `/admin/version` route is intentionally UN-authenticated (the
 * upgrade banner reads it pre-login) — that route lives in `admin-version.ts`
 * and is mounted at `/admin` directly. The per-router middleware here only
 * sees requests under `/admin/update/*`, so adding it does not leak auth to
 * `/admin/version`.
 *
 * High-level flow for `POST /start`:
 *   1. Read the release manifest.
 *   2. Locate the latest release as the *target*.
 *   3. Build a `CurrentVersion` from the build-stamped `_version.ts`.
 *   4. Detect fork — bail (409) on any mismatch so we never auto-update a
 *      custom build.
 *   5. Bail (200 already_latest) when target === current to keep the UI flow
 *      simple (operator clicked "update" with nothing to do).
 *   6. Call the engine's `runUpdate` which returns an {@link UpdateHandle}
 *      AS SOON AS the snapshot row exists (≈ 2 Pages API calls + 1 D1
 *      insert). The long-running phase work (`handle.done`) is fed into
 *      `executionCtx.waitUntil` so it keeps running after the response is
 *      sent. We return `202 { updateId }` immediately so the dashboard can
 *      open `/stream/:id` to watch progress live. Without the split the
 *      handler would block for 30-60s and risk hitting Worker CPU/wall
 *      limits before sending a single byte back.
 *
 * Compatibility note: `runUpdate` pulls in `node:stream`, `node:zlib`, and
 * `tar-stream`. The Worker requires `nodejs_compat` in `wrangler.toml`
 * (added by this task) — see the compatibility concerns in the PR
 * description.
 */

import { Hono } from 'hono';
import {
  runUpdate,
  runRollback,
  fetchManifest,
  detectFork,
  findRelease,
  createRollbackSnapshot,
  createEventEmitter,
  getSnapshot,
  updateStatus,
  appendEvent,
  setError,
  markSnapshotRolledBack,
  listRecent,
  type D1Like,
  type ReleaseEntry,
  type CurrentVersion,
  type UpdateContext,
} from '@line-harness/update-engine';
import {
  BUNDLE_VERSION,
  WORKER_HASH,
  ADMIN_HASH,
  LIFF_HASH,
} from '../_version.js';

/**
 * Env bindings consumed by this router. Kept local because only this file
 * needs the self-update vars; the main app `Env` in index.ts mirrors them
 * onto the global Bindings type.
 */
type UpdateEnv = {
  Bindings: {
    DB: D1Database;
    ADMIN_API_KEY: string;
    CF_API_TOKEN: string;
    CF_ACCOUNT_ID: string;
    WORKER_NAME: string;
    ADMIN_PAGES_PROJECT: string;
    LIFF_PAGES_PROJECT: string;
    D1_DATABASE_ID: string;
    MANIFEST_URL: string;
    WORKER_PUBLIC_URL: string;
    ADMIN_PUBLIC_URL: string;
    LIFF_PUBLIC_URL: string;
  };
};

const app = new Hono<UpdateEnv>();
const UPDATE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MANUAL_UPDATE_TITLE_MAX_LENGTH = 120;
const MANUAL_UPDATE_CHANGE_MAX_LENGTH = 180;
const MANUAL_UPDATE_MAX_CHANGES = 12;

/**
 * Adapter from Cloudflare's `D1Database` to the engine's local `D1Like`
 * interface. The engine deliberately doesn't depend on
 * `@cloudflare/workers-types` so it can also run under better-sqlite3 in
 * Node tests; we bridge the two shapes here.
 *
 * The engine only uses `prepare().bind().run()/first()/all()`, so the
 * adapter intentionally exposes nothing else.
 */
function adaptD1(db: D1Database): D1Like {
  return {
    prepare: (sql: string) => {
      const stmt = db.prepare(sql);
      return {
        bind: (...args: any[]) => {
          const bound = stmt.bind(...args);
          return {
            run: () => bound.run() as Promise<unknown>,
            first: <T = any>() => bound.first<T>() as Promise<T | null>,
            all: <T = any>() =>
              bound.all<T>() as Promise<{ results: T[] }>,
          };
        },
      };
    },
  };
}

function adminUpdateErrorKind(err: unknown): string {
  if (err instanceof TypeError) return 'network_error';
  if (err instanceof Error) return err.name || 'error';
  return typeof err;
}

function isSafeUpdateId(id: string): boolean {
  return UPDATE_ID_PATTERN.test(id);
}

function normalizeManualUpdateText(raw: unknown, maxLength: number): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

async function readManualUpdateBody(c: {
  req: { json(): Promise<unknown> };
}): Promise<{ ok: true; title: string; changes: string[] } | { ok: false; error: string }> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return { ok: false, error: 'invalid_json' };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'invalid_payload' };
  }
  const record = body as Record<string, unknown>;
  const title = normalizeManualUpdateText(record.title, MANUAL_UPDATE_TITLE_MAX_LENGTH);
  const rawChanges = Array.isArray(record.changes) ? record.changes : [];
  const changes = rawChanges
    .map((item) => normalizeManualUpdateText(item, MANUAL_UPDATE_CHANGE_MAX_LENGTH))
    .filter(Boolean)
    .slice(0, MANUAL_UPDATE_MAX_CHANGES);
  if (!title) return { ok: false, error: 'title_required' };
  if (changes.length === 0) return { ok: false, error: 'changes_required' };
  return { ok: true, title, changes };
}

function rollbackContext(
  env: UpdateEnv['Bindings'],
  fromVersion: string,
  toVersion: string,
): UpdateContext {
  const current: CurrentVersion = {
    version: fromVersion,
    worker_hash: WORKER_HASH,
    admin_hash: ADMIN_HASH,
    liff_hash: LIFF_HASH,
  };
  const target: ReleaseEntry = {
    version: toVersion,
    released_at: '',
    worker_hash: '',
    admin_hash: '',
    liff_hash: '',
    bundle_url: '',
    bundle_size_bytes: 0,
    required_secrets: [],
    new_required_secrets: [],
    migrations: [],
    changelog_url: '',
    min_from_version: '',
  };
  return {
    creds: {
      accountId: env.CF_ACCOUNT_ID,
      apiToken: env.CF_API_TOKEN,
    },
    workerName: env.WORKER_NAME,
    adminPagesProject: env.ADMIN_PAGES_PROJECT,
    liffPagesProject: env.LIFF_PAGES_PROJECT,
    d1DatabaseId: env.D1_DATABASE_ID,
    current,
    target,
    manifestUrl: env.MANIFEST_URL,
  };
}

/** Auth gate — single source of truth for every endpoint in this router. */
app.use('/*', async (c, next) => {
  const key = c.req.header('x-admin-api-key');
  if (!key || key !== c.env.ADMIN_API_KEY) {
    return c.text('unauthorized', 401);
  }
  await next();
});

/**
 * POST /admin/update/start — kick off a self-update.
 *
 * Returns:
 *   - 202 { updateId } on success (engine running in background)
 *   - 200 { error: 'already_latest' } when nothing to update
 *   - 409 { error: 'fork_detected', reason } for non-vanilla builds
 *   - 500 { error: 'manifest_missing_target' | 'no_current_release' } when
 *     the manifest is missing the version we need to look up
 *   - 500 { error: 'update_failed', message, errorKind } when engine setup fails
 *     BEFORE the snapshot row is created (e.g. CF Pages API down so
 *     `getLatestDeployment` rejects). Once `runUpdate` resolves with a
 *     handle this branch is unreachable — phase failures land in the
 *     snapshot row and are visible via `/status/:id`.
 */
app.post('/start', async (c) => {
  const manifest = await fetchManifest(c.env.MANIFEST_URL);
  // The manifest always pins one "latest" version; locate that entry. If the
  // manifest is malformed (latest doesn't appear in releases[]) we fail
  // closed rather than guess.
  const target = manifest.releases.find((r) => r.version === manifest.latest);
  if (!target) {
    return c.json({ error: 'manifest_missing_target' }, 500);
  }

  const current: CurrentVersion = {
    version: BUNDLE_VERSION,
    worker_hash: WORKER_HASH,
    admin_hash: ADMIN_HASH,
    liff_hash: LIFF_HASH,
  };

  const fork = detectFork(current, manifest);
  if (fork.kind === 'fork') {
    return c.json({ error: 'fork_detected', reason: fork.reason }, 409);
  }

  // No-op path: we matched a manifest entry AND the version equals the
  // target. Returning 200 (not 204) so the dashboard can show a
  // confirmation toast with the version label.
  if (target.version === current.version) {
    return c.json({ error: 'already_latest', version: current.version }, 200);
  }

  // For rollback purposes the engine needs to know where the *current*
  // worker bundle is stored. We carry that on the matching release entry.
  // If the manifest doesn't know about our current version we can't
  // construct a safe rollback path, so we bail.
  const currentRelease = findRelease(manifest, current.version);
  if (!currentRelease) {
    return c.json({ error: 'no_current_release' }, 500);
  }

  const d1 = adaptD1(c.env.DB);

  // The engine returns an UpdateHandle as soon as the snapshot row is
  // written (≈ 2 Pages API calls + 1 D1 insert). Phase work continues
  // in the background via `handle.done`. We hand that to
  // `executionCtx.waitUntil` so the isolate stays alive long enough for
  // the engine to flush its terminal status row, but the HTTP response
  // goes back immediately with the updateId — letting the dashboard
  // open `/stream/:id` for live progress.
  //
  // The outer `await runUpdate(...)` only rejects when SETUP fails
  // (CF Pages API down, etc.) — at that point no snapshot row exists
  // and we surface a 500 so the dashboard can tell the operator the
  // update never started. Phase failures (preflight/apply/verify) do
  // NOT throw here; they land in the snapshot row and are observable
  // via `/status/:id` and `/stream/:id`.
  let handle;
  try {
    handle = await runUpdate({
      ctx: {
        creds: {
          accountId: c.env.CF_ACCOUNT_ID,
          apiToken: c.env.CF_API_TOKEN,
        },
        workerName: c.env.WORKER_NAME,
        adminPagesProject: c.env.ADMIN_PAGES_PROJECT,
        liffPagesProject: c.env.LIFF_PAGES_PROJECT,
        d1DatabaseId: c.env.D1_DATABASE_ID,
        current,
        target,
        manifestUrl: c.env.MANIFEST_URL,
      },
      d1,
      workerHealthUrl: `${c.env.WORKER_PUBLIC_URL}/api/health`,
      adminUrl: c.env.ADMIN_PUBLIC_URL,
      liffUrl: c.env.LIFF_PUBLIC_URL,
      currentWorkerBundleUrl: currentRelease.bundle_url,
    });
  } catch (err) {
    // Setup failure (before snapshot row creation). No tracking id to
    // return; the operator must retry. We keep only a bounded exception kind
    // because Cloudflare/API errors can include project names or token-like
    // response details.
    return c.json({
      error: 'update_failed',
      message: 'Update setup failed',
      errorKind: adminUpdateErrorKind(err),
    }, 500);
  }

  // Phase work runs in the background. Attach a no-op .catch so an
  // unhandled rejection doesn't terminate the isolate — the engine has
  // already persisted the error to the snapshot row.
  c.executionCtx.waitUntil(handle.done.catch(() => undefined));

  return c.json({ updateId: handle.updateId }, 202);
});

/**
 * POST /admin/update/rollback/:id — manually roll back a successful update.
 *
 * Creates a new update_history row for the rollback operation (`rollback_of`
 * points at the original successful update), then runs the existing rollback
 * phase in the background. The original row is marked `rolled_back` only after
 * the rollback operation succeeds so the UI no longer offers repeated rollback
 * for the same update.
 */
app.post('/rollback/:id', async (c) => {
  const sourceId = c.req.param('id');
  if (!isSafeUpdateId(sourceId)) {
    return c.json({ error: 'bad_update_id' }, 400);
  }

  const d1 = adaptD1(c.env.DB);
  let source;
  try {
    source = await getSnapshot(d1, sourceId);
  } catch (err) {
    return c.json({
      error: 'rollback_failed',
      message: 'Rollback setup failed',
      errorKind: adminUpdateErrorKind(err),
    }, 500);
  }

  if (!source) {
    return c.json({ error: 'not_found' }, 404);
  }
  if (
    source.status !== 'success' ||
    source.rollback_of ||
    !source.rollback_expires_at ||
    Date.now() >= source.rollback_expires_at
  ) {
    return c.json({ error: 'rollback_unavailable' }, 409);
  }
  const snapshotWorkerUrl = source.snapshot_worker_url;
  const snapshotAdminDeployment = source.snapshot_admin_deployment;
  const snapshotLiffDeployment = source.snapshot_liff_deployment;
  if (!snapshotWorkerUrl || !snapshotAdminDeployment || !snapshotLiffDeployment) {
    return c.json({ error: 'rollback_snapshot_missing' }, 409);
  }

  let rollbackId;
  try {
    rollbackId = await createRollbackSnapshot(d1, {
      rollbackOf: source.id,
      from: source.to_version,
      to: source.from_version,
      snapshotWorkerUrl,
      snapshotAdminDeployment,
      snapshotLiffDeployment,
    });
  } catch (err) {
    return c.json({
      error: 'rollback_failed',
      message: 'Rollback setup failed',
      errorKind: adminUpdateErrorKind(err),
    }, 500);
  }

  const rollbackDone = (async () => {
    const ev = createEventEmitter({
      persist: async (event) => {
        await appendEvent(d1, rollbackId, event);
      },
    });
    try {
      await runRollback(
        rollbackContext(c.env, source.to_version, source.from_version),
        {
          snapshotWorkerBundleUrl: snapshotWorkerUrl,
          snapshotAdminDeployment,
          snapshotLiffDeployment,
        },
        ev,
      );
      await ev.emit({
        step: 'complete',
        status: 'done',
        reverted_to: source.from_version,
      });
      await updateStatus(d1, rollbackId, 'success');
      await markSnapshotRolledBack(d1, source.id);
    } catch (err) {
      await setError(
        d1,
        rollbackId,
        `manual rollback failed: ${adminUpdateErrorKind(err)}`,
      );
      await updateStatus(d1, rollbackId, 'failed');
    }
  })();

  c.executionCtx.waitUntil(rollbackDone.catch(() => undefined));

  return c.json({ updateId: rollbackId, rollbackOf: source.id }, 202);
});

/**
 * POST /admin/update/manual-record — persist a human-readable change summary.
 *
 * This is intentionally separate from the self-update engine. Custom product
 * tweaks are often deployed manually, but operators still need one place where
 * "what changed" is visible after the fact.
 */
app.post('/manual-record', async (c) => {
  const parsed = await readManualUpdateBody(c);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);

  const id = `manual_${crypto.randomUUID()}`;
  const now = Date.now();
  const event = {
    step: 'manual_change',
    status: 'done',
    title: parsed.title,
    changes: parsed.changes,
    recorded_at: now,
  };

  await c.env.DB
    .prepare(
      `INSERT INTO update_history (
        id, started_at, completed_at, from_version, to_version, status,
        snapshot_worker_url, snapshot_admin_deployment, snapshot_liff_deployment,
        events_jsonl, error, rollback_of, rollback_expires_at
      ) VALUES (?, ?, ?, ?, ?, 'success', ?, ?, ?, ?, NULL, NULL, NULL)`,
    )
    .bind(
      id,
      now,
      now,
      BUNDLE_VERSION,
      BUNDLE_VERSION,
      null,
      null,
      null,
      `${JSON.stringify(event)}\n`,
    )
    .run();

  return c.json({ id, success: true }, 201);
});

/**
 * GET /admin/update/status/:id — single-shot snapshot of an update.
 *
 * Splits `events_jsonl` into a parsed array on the way out so the dashboard
 * doesn't need to parse JSONL client-side.
 */
app.get('/status/:id', async (c) => {
  const d1 = adaptD1(c.env.DB);
  const id = c.req.param('id');
  const row = await getSnapshot(d1, id);
  if (!row) {
    return c.json({ error: 'not_found' }, 404);
  }
  const events = row.events_jsonl
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        // A malformed line shouldn't kill the whole response — return it as
        // a placeholder object so the UI can show "<unparsable event>"
        // instead of 500ing. Engine should never emit garbage here, but
        // defensiveness costs us nothing.
        return { raw: line, parse_error: true };
      }
    });
  return c.json({ ...row, events });
});

/**
 * GET /admin/update/stream/:id — SSE live feed of update events.
 *
 * Polls `getSnapshot` every 800ms and emits any new events as
 * `event: progress` frames. Emits a single `event: complete` frame when
 * the row's status reaches a terminal state, then closes the stream.
 *
 * Loop cap: 1000 iterations × 800ms ≈ 13 minutes — well past the worst
 * realistic update time (≈ 2-3 min). This protects against runaway loops
 * if the engine never writes a terminal status (e.g. silent crash).
 */
app.get('/stream/:id', (c) => {
  const id = c.req.param('id');
  const d1 = adaptD1(c.env.DB);
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();

  c.executionCtx.waitUntil(
    (async () => {
      try {
        let lastLen = 0;
        for (let i = 0; i < 1000; i++) {
          const row = await getSnapshot(d1, id);
          if (!row) {
            // Snapshot vanished or never existed — emit an error frame so
            // the dashboard doesn't hang waiting forever.
            await writer.write(
              enc.encode(
                `event: error\ndata: ${JSON.stringify({ error: 'not_found' })}\n\n`,
              ),
            );
            break;
          }
          const lines = row.events_jsonl
            .trim()
            .split('\n')
            .filter(Boolean);
          for (const line of lines.slice(lastLen)) {
            await writer.write(
              enc.encode(`event: progress\ndata: ${line}\n\n`),
            );
          }
          lastLen = lines.length;
          if (row.status !== 'running') {
            await writer.write(
              enc.encode(
                `event: complete\ndata: ${JSON.stringify({
                  status: row.status,
                  error: row.error,
                })}\n\n`,
              ),
            );
            break;
          }
          await new Promise((r) => setTimeout(r, 800));
        }
      } catch (err) {
        // Surface unexpected errors as an SSE error frame instead of
        // crashing the stream silently. Keep details out of the event payload;
        // polling `/status/:id` remains the source of truth for persisted
        // update phase errors.
        try {
          await writer.write(
            enc.encode(
              `event: error\ndata: ${JSON.stringify({
                error: 'stream_failed',
                errorKind: adminUpdateErrorKind(err),
              })}\n\n`,
            ),
          );
        } catch {
          // writer may already be closed by client; nothing to do.
        }
      } finally {
        try {
          await writer.close();
        } catch {
          // ignore — close races with client disconnect are expected.
        }
      }
    })(),
  );

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      // Disable proxy buffering so events stream in real-time. CF Workers
      // honors this hint on the way out via the dashboard's reverse proxy.
      'X-Accel-Buffering': 'no',
    },
  });
});

/**
 * GET /admin/update/history — last 20 update rows, newest first.
 */
app.get('/history', async (c) => {
  const d1 = adaptD1(c.env.DB);
  const history = await listRecent(d1, 20);
  return c.json({ history });
});

export default app;

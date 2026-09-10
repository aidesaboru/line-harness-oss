import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MANIFEST_PATH = '.well-known/l-link-build.json';
const PAGES_CONTROL_FILES = new Set([
  '_headers',
  '_redirects',
  '_routes.json',
  '_worker.js',
  MANIFEST_PATH,
]);
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

export type PagesArtifactFile = {
  sha256: string;
  size: number;
};

export type PagesArtifactManifest = {
  schemaVersion: 1;
  adminHash: string;
  files: Record<string, PagesArtifactFile>;
};

function walkSorted(root: string): string[] {
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      const stat = statSync(full);
      if (stat.isDirectory()) stack.push(full);
      else if (stat.isFile()) files.push(full);
    }
  }
  files.sort();
  return files;
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function assertHash(value: string, label: string): void {
  if (!HASH_PATTERN.test(value)) throw new Error(`${label} must be a sha256 hash`);
}

function assertSafeRelativePath(path: string): void {
  if (
    path.length === 0
    || path.startsWith('/')
    || path.includes('\\')
    || path.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error('Pages integrity manifest contains an unsafe file path');
  }
}

export function buildPagesArtifactManifest(
  rootDir: string,
  adminHash: string,
): PagesArtifactManifest {
  assertHash(adminHash, 'adminHash');
  const root = resolve(rootDir);
  const files: Record<string, PagesArtifactFile> = {};
  for (const fullPath of walkSorted(root)) {
    const path = relative(root, fullPath).split(sep).join('/');
    if (PAGES_CONTROL_FILES.has(path)) continue;
    assertSafeRelativePath(path);
    const bytes = readFileSync(fullPath);
    files[path] = { sha256: sha256(bytes), size: bytes.byteLength };
  }
  if (Object.keys(files).length === 0) {
    throw new Error('Pages artifact has no verifiable static files');
  }
  return { schemaVersion: 1, adminHash, files };
}

export function writePagesArtifactManifest(
  rootDir: string,
  adminHash: string,
): PagesArtifactManifest {
  const manifest = buildPagesArtifactManifest(rootDir, adminHash);
  const output = join(resolve(rootDir), MANIFEST_PATH);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(manifest)}\n`, { mode: 0o644 });
  return manifest;
}

function parseManifest(value: unknown): PagesArtifactManifest {
  if (!value || typeof value !== 'object') throw new Error('Pages integrity manifest is invalid');
  const record = value as Partial<PagesArtifactManifest>;
  if (record.schemaVersion !== 1 || typeof record.adminHash !== 'string') {
    throw new Error('Pages integrity manifest is invalid');
  }
  assertHash(record.adminHash, 'manifest adminHash');
  if (!record.files || typeof record.files !== 'object' || Array.isArray(record.files)) {
    throw new Error('Pages integrity manifest files are invalid');
  }
  const files: Record<string, PagesArtifactFile> = {};
  for (const [path, entry] of Object.entries(record.files)) {
    assertSafeRelativePath(path);
    if (
      !entry
      || typeof entry !== 'object'
      || typeof entry.sha256 !== 'string'
      || !Number.isSafeInteger(entry.size)
      || entry.size < 0
    ) {
      throw new Error('Pages integrity manifest file entry is invalid');
    }
    assertHash(entry.sha256, 'manifest file hash');
    files[path] = { sha256: entry.sha256, size: entry.size };
  }
  if (Object.keys(files).length === 0) throw new Error('Pages integrity manifest is empty');
  return { schemaVersion: 1, adminHash: record.adminHash, files };
}

function artifactUrl(baseUrl: string, path: string): URL {
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:') throw new Error('Pages deployment URL must use HTTPS');
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  return new URL(`/${encodedPath}`, base);
}

async function fetchBytes(
  url: URL,
  fetchImpl: typeof fetch,
  attempts = 5,
  retryDelayMs = 500,
): Promise<Uint8Array> {
  let lastStatus = 0;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        redirect: 'follow',
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache' },
      });
      lastStatus = response.status;
      if (response.ok) return new Uint8Array(await response.arrayBuffer());
    } catch {
      lastStatus = 0;
    }
    if (attempt < attempts) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, retryDelayMs));
    }
  }
  throw new Error(`Pages artifact fetch failed${lastStatus ? ` with HTTP ${lastStatus}` : ''}`);
}

export async function verifyPagesArtifact(options: {
  rootDir: string;
  deploymentUrl: string;
  expectedAdminHash: string;
  fetchImpl?: typeof fetch;
  concurrency?: number;
  manifestFetchAttempts?: number;
  manifestRetryDelayMs?: number;
}): Promise<{ fileCount: number }> {
  const {
    rootDir,
    deploymentUrl,
    expectedAdminHash,
    fetchImpl = fetch,
    concurrency = 8,
    manifestFetchAttempts = 12,
    manifestRetryDelayMs = 5_000,
  } = options;
  assertHash(expectedAdminHash, 'expectedAdminHash');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new Error('Pages verification concurrency is invalid');
  }
  if (
    !Number.isInteger(manifestFetchAttempts)
    || manifestFetchAttempts < 1
    || manifestFetchAttempts > 24
    || !Number.isInteger(manifestRetryDelayMs)
    || manifestRetryDelayMs < 0
    || manifestRetryDelayMs > 10_000
  ) {
    throw new Error('Pages manifest retry settings are invalid');
  }

  const local = buildPagesArtifactManifest(rootDir, expectedAdminHash);
  const remoteManifestBytes = await fetchBytes(
    artifactUrl(deploymentUrl, MANIFEST_PATH),
    fetchImpl,
    manifestFetchAttempts,
    manifestRetryDelayMs,
  );
  let remote: PagesArtifactManifest;
  try {
    remote = parseManifest(JSON.parse(Buffer.from(remoteManifestBytes).toString('utf8')));
  } catch {
    throw new Error('Pages integrity manifest could not be verified');
  }
  if (remote.adminHash !== expectedAdminHash) {
    throw new Error('Pages deployment Admin hash does not match the Worker');
  }
  if (JSON.stringify(remote.files) !== JSON.stringify(local.files)) {
    throw new Error('Pages integrity manifest does not match the local artifact');
  }

  const entries = Object.entries(remote.files);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, entries.length) }, async () => {
    while (cursor < entries.length) {
      const index = cursor;
      cursor += 1;
      const [path, expected] = entries[index];
      const bytes = await fetchBytes(artifactUrl(deploymentUrl, path), fetchImpl);
      if (bytes.byteLength !== expected.size || sha256(bytes) !== expected.sha256) {
        throw new Error(`Pages deployed file failed integrity verification: ${path}`);
      }
    }
  });
  await Promise.all(workers);
  return { fileCount: entries.length };
}

function cliArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const rootDir = cliArg('--dir');
  const expectedAdminHash = cliArg('--admin-hash');
  if (!rootDir || !expectedAdminHash) {
    throw new Error('Usage: pages-artifact-integrity.ts <create|verify> --dir <path> --admin-hash <hash> [--url <url>]');
  }
  if (command === 'create') {
    const manifest = writePagesArtifactManifest(rootDir, expectedAdminHash);
    process.stdout.write(`${JSON.stringify({ fileCount: Object.keys(manifest.files).length })}\n`);
    return;
  }
  if (command === 'verify') {
    const deploymentUrl = cliArg('--url');
    if (!deploymentUrl) throw new Error('--url is required for verify');
    const result = await verifyPagesArtifact({ rootDir, deploymentUrl, expectedAdminHash });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  throw new Error('Unknown Pages artifact integrity command');
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : 'Pages artifact integrity check failed';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}

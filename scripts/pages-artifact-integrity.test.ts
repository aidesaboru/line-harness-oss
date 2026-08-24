import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildPagesArtifactManifest,
  verifyPagesArtifact,
  writePagesArtifactManifest,
} from './pages-artifact-integrity';

const ADMIN_HASH = `sha256:${'a'.repeat(64)}`;
const roots: string[] = [];

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'pages-integrity-'));
  roots.push(root);
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'index.html'), '<h1>ok</h1>');
  writeFileSync(join(root, 'assets', 'app.js'), 'console.log("ok")');
  writeFileSync(join(root, '_worker.js'), 'export default {}');
  writeFileSync(join(root, '_redirects'), '/old /new 301');
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Pages artifact integrity', () => {
  it('writes a non-circular manifest for every ordinary static file', () => {
    const root = fixture();
    const manifest = writePagesArtifactManifest(root, ADMIN_HASH);

    expect(Object.keys(manifest.files)).toEqual(['assets/app.js', 'index.html']);
    expect(manifest.files['_worker.js']).toBeUndefined();
    expect(manifest.files['_redirects']).toBeUndefined();
    const written = JSON.parse(readFileSync(join(root, '.well-known/l-link-build.json'), 'utf8'));
    expect(written).toEqual(manifest);
    expect(buildPagesArtifactManifest(root, ADMIN_HASH)).toEqual(manifest);
  });

  it('fetches the deployed manifest and verifies every published byte', async () => {
    const root = fixture();
    const manifest = writePagesArtifactManifest(root, ADMIN_HASH);
    const responses = new Map<string, Uint8Array>([
      ['/.well-known/l-link-build.json', readFileSync(join(root, '.well-known/l-link-build.json'))],
      ['/assets/app.js', readFileSync(join(root, 'assets/app.js'))],
      ['/index.html', readFileSync(join(root, 'index.html'))],
    ]);
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      const bytes = responses.get(path);
      return new Response(bytes ?? 'missing', { status: bytes ? 200 : 404 });
    }) as unknown as typeof fetch;

    await expect(verifyPagesArtifact({
      rootDir: root,
      deploymentUrl: 'https://deployment.example.pages.dev',
      expectedAdminHash: ADMIN_HASH,
      fetchImpl,
      concurrency: 2,
    })).resolves.toEqual({ fileCount: Object.keys(manifest.files).length });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('fails closed when a deployed static file differs', async () => {
    const root = fixture();
    writePagesArtifactManifest(root, ADMIN_HASH);
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === '/.well-known/l-link-build.json') {
        return new Response(readFileSync(join(root, '.well-known/l-link-build.json')));
      }
      if (path === '/assets/app.js') return new Response('tampered');
      return new Response(readFileSync(join(root, 'index.html')));
    }) as unknown as typeof fetch;

    await expect(verifyPagesArtifact({
      rootDir: root,
      deploymentUrl: 'https://deployment.example.pages.dev',
      expectedAdminHash: ADMIN_HASH,
      fetchImpl,
      concurrency: 1,
    })).rejects.toThrow(/failed integrity verification/);
  });
});

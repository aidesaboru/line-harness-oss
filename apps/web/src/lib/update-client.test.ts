import { afterEach, describe, expect, it, vi } from 'vitest'

async function loadUpdateClient() {
  vi.resetModules()
  return import('./update-client')
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('update-client manifest URL', () => {
  it('always uses the Worker manifest proxy even when a public GitHub URL is configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://example-worker.workers.dev')
    vi.stubEnv(
      'NEXT_PUBLIC_MANIFEST_URL',
      'https://github.com/Shudesu/line-harness-oss/releases/latest/download/release-manifest.json',
    )

    const { getManifestUrl } = await loadUpdateClient()

    expect(getManifestUrl()).toBe('https://example-worker.workers.dev/admin/manifest')
  })

  it('fetches the manifest from the Worker proxy', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://example-worker.workers.dev')
    const manifest = { schema_version: 1, latest: '0.14.1', releases: [] }
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(manifest)))

    const { getManifest } = await loadUpdateClient()

    await expect(getManifest()).resolves.toEqual(manifest)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example-worker.workers.dev/admin/manifest',
      { cache: 'no-store' },
    )
  })

  it('starts rollback through the Worker API with the admin key', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://example-worker.workers.dev')
    vi.stubEnv('NEXT_PUBLIC_ADMIN_API_KEY', 'admin-key')
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ updateId: 'ROLLBACK_ID', rollbackOf: 'UPDATE_ID' })))

    const { startRollback } = await loadUpdateClient()

    await expect(startRollback('UPDATE_ID')).resolves.toEqual({
      updateId: 'ROLLBACK_ID',
      rollbackOf: 'UPDATE_ID',
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example-worker.workers.dev/admin/update/rollback/UPDATE_ID',
      {
        method: 'POST',
        headers: { 'x-admin-api-key': 'admin-key' },
      },
    )
  })
})

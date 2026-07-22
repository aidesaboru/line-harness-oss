import { describe, expect, it } from 'vitest'
import { resolveBrowserApiOrigin } from './api-origin'

describe('resolveBrowserApiOrigin', () => {
  const worker = 'https://l-link-api.example.workers.dev/'

  it('uses the admin origin on deployed HTTPS pages', () => {
    expect(resolveBrowserApiOrigin(worker, {
      origin: 'https://l-link-admin.example.pages.dev',
      protocol: 'https:',
    })).toBe('https://l-link-admin.example.pages.dev')
  })

  it('uses the configured Worker during local HTTP development', () => {
    expect(resolveBrowserApiOrigin(worker, {
      origin: 'http://localhost:3001',
      protocol: 'http:',
    })).toBe('https://l-link-api.example.workers.dev')
  })

  it('uses the configured Worker during server rendering', () => {
    expect(resolveBrowserApiOrigin(worker, null)).toBe(
      'https://l-link-api.example.workers.dev',
    )
  })
})

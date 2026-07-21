import { afterEach, describe, expect, it, vi } from 'vitest'
import { isStaleChat } from './chat-staleness'

const NOW = '2026-07-21T12:00:00+09:00'

afterEach(() => {
  vi.useRealTimers()
})

describe('chat staleness', () => {
  it('marks an unanswered customer message older than 24 hours as stale', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW))

    expect(isStaleChat({
      lastMessageAt: '2026-07-20T11:59:59+09:00',
      lastMessageDirection: 'incoming',
      status: 'unread',
    })).toBe(true)
  })

  it('clears the stale state after an operator reply', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW))

    expect(isStaleChat({
      lastMessageAt: '2026-07-20T10:00:00+09:00',
      lastMessageDirection: 'outgoing',
      status: 'in_progress',
    })).toBe(false)
  })

  it('does not mark recent or excluded conversations as stale', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW))

    expect(isStaleChat({
      lastMessageAt: '2026-07-21T11:00:00+09:00',
      lastMessageDirection: 'incoming',
      status: 'unread',
    })).toBe(false)
    expect(isStaleChat({
      lastMessageAt: '2026-07-19T11:00:00+09:00',
      lastMessageDirection: 'incoming',
      status: 'resolved',
    })).toBe(false)
    expect(isStaleChat({
      lastMessageAt: '2026-07-19T11:00:00+09:00',
      lastMessageDirection: 'incoming',
      status: 'long_term',
    })).toBe(false)
  })
})

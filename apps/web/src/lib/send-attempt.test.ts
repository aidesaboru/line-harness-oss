import { describe, expect, it, vi } from 'vitest'
import { chatSendFingerprint, createSendAttemptRegistry } from './send-attempt'

describe('send attempt registry', () => {
  it('reuses the same key until a matching send succeeds', () => {
    const createKey = vi.fn()
      .mockReturnValueOnce('key-1')
      .mockReturnValueOnce('key-2')
    const registry = createSendAttemptRegistry(createKey)
    const fingerprint = chatSendFingerprint({
      chatId: 'friend-1',
      messageType: 'text',
      content: '確認しました',
    })

    expect(registry.keyFor(fingerprint)).toBe('key-1')
    expect(registry.keyFor(fingerprint)).toBe('key-1')
    registry.complete(fingerprint)
    expect(registry.keyFor(fingerprint)).toBe('key-2')
  })

  it('uses separate keys for separate messages', () => {
    const createKey = vi.fn()
      .mockReturnValueOnce('text-key')
      .mockReturnValueOnce('image-key')
    const registry = createSendAttemptRegistry(createKey)

    expect(registry.keyFor(chatSendFingerprint({
      chatId: 'friend-1', messageType: 'text', content: '回答',
    }))).toBe('text-key')
    expect(registry.keyFor(chatSendFingerprint({
      chatId: 'friend-1', messageType: 'image', content: '{}',
    }))).toBe('image-key')
  })
})

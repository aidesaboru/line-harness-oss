export interface SendAttemptRegistry {
  keyFor(fingerprint: string): string
  complete(fingerprint: string): void
  clear(): void
}

const MAX_RETAINED_ATTEMPTS = 50

export function createSendAttemptRegistry(
  createKey: () => string = () => crypto.randomUUID(),
): SendAttemptRegistry {
  const keys = new Map<string, string>()

  return {
    keyFor(fingerprint) {
      const existing = keys.get(fingerprint)
      if (existing) return existing
      if (keys.size >= MAX_RETAINED_ATTEMPTS) {
        const oldest = keys.keys().next().value
        if (typeof oldest === 'string') keys.delete(oldest)
      }
      const key = createKey()
      keys.set(fingerprint, key)
      return key
    },
    complete(fingerprint) {
      keys.delete(fingerprint)
    },
    clear() {
      keys.clear()
    },
  }
}

export function chatSendFingerprint(input: {
  chatId: string
  messageType: 'text' | 'flex' | 'image'
  content: string
  supportCaseId?: string
  quoteMessageId?: string
}): string {
  return JSON.stringify(input)
}

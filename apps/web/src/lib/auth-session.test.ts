import { describe, expect, it } from 'vitest'
import {
  CSRF_STORAGE_KEY,
  LEGACY_API_KEY_STORAGE_KEY,
  STAFF_NAME_STORAGE_KEY,
  STAFF_ROLE_STORAGE_KEY,
  cacheStaffSession,
  clearAuthSessionCache,
  clearStaffIdentityCache,
  getCsrfToken,
  readStaffIdentityCache,
  setCsrfToken,
} from './auth-session'

class MemoryStorage {
  private values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

describe('auth session cache', () => {
  it('caches trimmed staff identity and csrf while removing the legacy API key', () => {
    const storage = new MemoryStorage()
    storage.setItem(LEGACY_API_KEY_STORAGE_KEY, 'old-key')

    cacheStaffSession({
      name: '  田島  ',
      role: ' staff ',
      csrfToken: ' csrf-token ',
    }, storage)

    expect(storage.getItem(LEGACY_API_KEY_STORAGE_KEY)).toBeNull()
    expect(readStaffIdentityCache(storage)).toEqual({ name: '田島', role: 'staff' })
    expect(getCsrfToken(storage)).toBe('csrf-token')
  })

  it('removes empty staff identity values', () => {
    const storage = new MemoryStorage()
    storage.setItem(STAFF_NAME_STORAGE_KEY, '古い名前')
    storage.setItem(STAFF_ROLE_STORAGE_KEY, 'staff')

    cacheStaffSession({ name: ' ', role: null }, storage)

    expect(readStaffIdentityCache(storage)).toEqual({ name: '', role: '' })
  })

  it('clears only staff identity when requested', () => {
    const storage = new MemoryStorage()
    storage.setItem(STAFF_NAME_STORAGE_KEY, '田島')
    storage.setItem(STAFF_ROLE_STORAGE_KEY, 'staff')
    storage.setItem(CSRF_STORAGE_KEY, 'csrf-token')

    clearStaffIdentityCache(storage)

    expect(readStaffIdentityCache(storage)).toEqual({ name: '', role: '' })
    expect(getCsrfToken(storage)).toBe('csrf-token')
  })

  it('clears the whole auth session cache on logout or session failure', () => {
    const storage = new MemoryStorage()
    storage.setItem(LEGACY_API_KEY_STORAGE_KEY, 'old-key')
    storage.setItem(STAFF_NAME_STORAGE_KEY, '田島')
    storage.setItem(STAFF_ROLE_STORAGE_KEY, 'staff')
    storage.setItem(CSRF_STORAGE_KEY, 'csrf-token')

    clearAuthSessionCache(storage)

    expect(storage.getItem(LEGACY_API_KEY_STORAGE_KEY)).toBeNull()
    expect(readStaffIdentityCache(storage)).toEqual({ name: '', role: '' })
    expect(getCsrfToken(storage)).toBe('')
  })

  it('updates or removes csrf tokens through the shared helper', () => {
    const storage = new MemoryStorage()

    setCsrfToken(' csrf-token ', storage)
    expect(getCsrfToken(storage)).toBe('csrf-token')

    setCsrfToken('', storage)
    expect(getCsrfToken(storage)).toBe('')
  })
})

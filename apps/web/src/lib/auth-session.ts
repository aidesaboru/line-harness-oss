export const LEGACY_API_KEY_STORAGE_KEY = 'lh_api_key'
export const CSRF_STORAGE_KEY = 'lh_csrf'
export const STAFF_NAME_STORAGE_KEY = 'lh_staff_name'
export const STAFF_ROLE_STORAGE_KEY = 'lh_staff_role'

export type StaffIdentityCache = {
  name: string
  role: string
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function getBrowserStorage(): StorageLike | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function normalizeStorageValue(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}

function setOrRemove(storage: StorageLike, key: string, value: string | null | undefined): void {
  const normalized = normalizeStorageValue(value)
  if (normalized) storage.setItem(key, normalized)
  else storage.removeItem(key)
}

export function isUsableStaffIdentity(input: {
  name?: string | null
  role?: string | null
}): boolean {
  const role = normalizeStorageValue(input.role)
  if (!role) return false
  if (role === 'staff') return Boolean(normalizeStorageValue(input.name))
  return true
}

export function readStaffIdentityCache(storage: StorageLike | null = getBrowserStorage()): StaffIdentityCache {
  if (!storage) return { name: '', role: '' }
  return {
    name: normalizeStorageValue(storage.getItem(STAFF_NAME_STORAGE_KEY)),
    role: normalizeStorageValue(storage.getItem(STAFF_ROLE_STORAGE_KEY)),
  }
}

export function cacheStaffSession(
  input: {
    name?: string | null
    role?: string | null
    csrfToken?: string | null
  },
  storage: StorageLike | null = getBrowserStorage(),
): void {
  if (!storage) return
  storage.removeItem(LEGACY_API_KEY_STORAGE_KEY)
  setOrRemove(storage, STAFF_NAME_STORAGE_KEY, input.name)
  setOrRemove(storage, STAFF_ROLE_STORAGE_KEY, input.role)
  if ('csrfToken' in input) setOrRemove(storage, CSRF_STORAGE_KEY, input.csrfToken)
}

export function clearStaffIdentityCache(storage: StorageLike | null = getBrowserStorage()): void {
  if (!storage) return
  storage.removeItem(STAFF_NAME_STORAGE_KEY)
  storage.removeItem(STAFF_ROLE_STORAGE_KEY)
}

export function clearAuthSessionCache(storage: StorageLike | null = getBrowserStorage()): void {
  if (!storage) return
  storage.removeItem(LEGACY_API_KEY_STORAGE_KEY)
  storage.removeItem(CSRF_STORAGE_KEY)
  clearStaffIdentityCache(storage)
}

export function getCsrfToken(storage: StorageLike | null = getBrowserStorage()): string {
  if (!storage) return ''
  return normalizeStorageValue(storage.getItem(CSRF_STORAGE_KEY))
}

export function setCsrfToken(token: string | undefined | null, storage: StorageLike | null = getBrowserStorage()): void {
  if (!storage) return
  setOrRemove(storage, CSRF_STORAGE_KEY, token)
}

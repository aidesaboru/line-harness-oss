import { describe, expect, it } from 'vitest'
import { canAccessSidebarRoute, canShowSidebarItem } from './sidebar-access'

describe('sidebar role access', () => {
  it('keeps staff focused on support work only', () => {
    expect(canShowSidebarItem('/support', 'staff')).toBe(true)
    expect(canShowSidebarItem('/chats', 'staff')).toBe(true)
    expect(canShowSidebarItem('/friends', 'staff')).toBe(true)
    expect(canShowSidebarItem('/notifications', 'staff')).toBe(true)

    expect(canShowSidebarItem('/', 'staff')).toBe(false)
    expect(canShowSidebarItem('/broadcasts', 'staff')).toBe(false)
    expect(canShowSidebarItem('/templates', 'staff')).toBe(false)
    expect(canShowSidebarItem('/automations', 'staff')).toBe(false)
    expect(canShowSidebarItem('/form-submissions', 'staff')).toBe(false)
    expect(canShowSidebarItem('/accounts', 'staff')).toBe(false)
    expect(canShowSidebarItem('/staff', 'staff')).toBe(false)
  })

  it('keeps staff management owner-only while preserving admin operations', () => {
    expect(canShowSidebarItem('/staff', 'owner')).toBe(true)
    expect(canShowSidebarItem('/staff', 'admin')).toBe(false)
    expect(canShowSidebarItem('/accounts', 'admin')).toBe(true)
    expect(canShowSidebarItem('/broadcasts', 'admin')).toBe(true)
  })

  it('does not hide owner/admin menus before the cached role is loaded', () => {
    expect(canShowSidebarItem('/accounts', null)).toBe(true)
    expect(canShowSidebarItem('/broadcasts', undefined)).toBe(true)
    expect(canShowSidebarItem('/staff', '')).toBe(false)
  })

  it('redirects staff away from management routes while allowing support routes', () => {
    expect(canAccessSidebarRoute('/support', 'staff')).toBe(true)
    expect(canAccessSidebarRoute('/support/case-1', 'staff')).toBe(true)
    expect(canAccessSidebarRoute('/chats', 'staff')).toBe(true)
    expect(canAccessSidebarRoute('/notifications', 'staff')).toBe(true)

    expect(canAccessSidebarRoute('/', 'staff')).toBe(false)
    expect(canAccessSidebarRoute('/broadcasts', 'staff')).toBe(false)
    expect(canAccessSidebarRoute('/accounts', 'staff')).toBe(false)
    expect(canAccessSidebarRoute('/staff', 'staff')).toBe(false)

    expect(canAccessSidebarRoute('/broadcasts', 'owner')).toBe(true)
    expect(canAccessSidebarRoute('/broadcasts', 'admin')).toBe(true)
    expect(canAccessSidebarRoute('/broadcasts', null)).toBe(true)
  })

  it('keeps staff management routes owner-only even when opened directly', () => {
    expect(canAccessSidebarRoute('/staff', 'owner')).toBe(true)
    expect(canAccessSidebarRoute('/staff', 'admin')).toBe(false)
    expect(canAccessSidebarRoute('/staff', 'staff')).toBe(false)
    expect(canAccessSidebarRoute('/staff/member-1', 'admin')).toBe(false)
    expect(canAccessSidebarRoute('/staff/member-1', 'owner')).toBe(true)
  })
})

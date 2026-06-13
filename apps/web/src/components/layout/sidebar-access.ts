export type SidebarRole = string | null | undefined

const STAFF_VISIBLE_HREFS = new Set([
  '/friends',
  '/chats',
  '/support',
  '/notifications',
])

export function canShowSidebarItem(href: string, role: SidebarRole): boolean {
  const normalizedRole = typeof role === 'string' ? role.trim() : ''

  if (normalizedRole === 'staff') {
    return STAFF_VISIBLE_HREFS.has(href)
  }

  if (href === '/staff') {
    return normalizedRole === 'owner'
  }

  return true
}

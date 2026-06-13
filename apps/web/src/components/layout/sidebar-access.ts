export type SidebarRole = string | null | undefined

const STAFF_VISIBLE_HREFS = new Set([
  '/friends',
  '/chats',
  '/support',
  '/notifications',
])

function normalizeRole(role: SidebarRole): string {
  return typeof role === 'string' ? role.trim() : ''
}

function isStaffRole(role: SidebarRole): boolean {
  return normalizeRole(role) === 'staff'
}

function matchesPath(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`)
}

export function canShowSidebarItem(href: string, role: SidebarRole): boolean {
  const normalizedRole = normalizeRole(role)

  if (normalizedRole === 'staff') {
    return STAFF_VISIBLE_HREFS.has(href)
  }

  if (href === '/staff') {
    return normalizedRole === 'owner'
  }

  return true
}

export function canAccessSidebarRoute(pathname: string, role: SidebarRole): boolean {
  const normalizedRole = normalizeRole(role)

  if (matchesPath(pathname, '/staff')) {
    return normalizedRole === 'owner'
  }

  if (!isStaffRole(normalizedRole)) return true

  return Array.from(STAFF_VISIBLE_HREFS).some((href) => matchesPath(pathname, href))
}

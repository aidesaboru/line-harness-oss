export type SidebarRole = string | null | undefined
export type SidebarVisibilityContext = {
  staffName?: string | null
}

const SUPPORT_WORK_HREFS = new Set([
  '/chats',
  '/internal-chat',
  '/notifications',
  '/support',
  '/escalations',
  '/friends',
  '/manuals',
])

const STAFF_VISIBLE_HREFS = SUPPORT_WORK_HREFS
const SECONDARY_VISIBLE_HREFS = new Set([
  '/escalations',
  '/internal-chat',
  '/notifications',
  '/manuals',
])

const OPERATION_DISABLED_HREFS = new Set([
  '/broadcasts',
  '/scenarios',
  '/auto-replies',
  '/friend-add-settings',
])

const OWNER_ONLY_HREFS = new Set([
  '/staff',
  '/accounts',
  '/emergency',
])

function normalizeRole(role: SidebarRole): string {
  return typeof role === 'string' ? role.trim() : ''
}

function isStaffRole(role: SidebarRole): boolean {
  return normalizeRole(role) === 'staff'
}

function isSecondaryRole(role: SidebarRole): boolean {
  return normalizeRole(role) === 'secondary'
}

function matchesPath(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`)
}

export function canShowSidebarItem(href: string, role: SidebarRole, context: SidebarVisibilityContext = {}): boolean {
  const normalizedRole = normalizeRole(role)

  if (OPERATION_DISABLED_HREFS.has(href)) {
    return false
  }

  if (OWNER_ONLY_HREFS.has(href)) {
    return normalizedRole === 'owner'
  }

  if (href === '/escalations') {
    if (normalizedRole === 'owner' || normalizedRole === 'admin') return true
    return normalizedRole === 'staff' || normalizedRole === 'secondary'
  }

  if (normalizedRole === 'secondary') {
    return SECONDARY_VISIBLE_HREFS.has(href)
  }

  if (normalizedRole === 'staff') {
    return STAFF_VISIBLE_HREFS.has(href)
  }

  return true
}

export function canAccessSidebarRoute(pathname: string, role: SidebarRole): boolean {
  const normalizedRole = normalizeRole(role)

  if (Array.from(OPERATION_DISABLED_HREFS).some((href) => matchesPath(pathname, href))) {
    return false
  }

  if (Array.from(OWNER_ONLY_HREFS).some((href) => matchesPath(pathname, href))) {
    return normalizedRole === 'owner'
  }

  if (isSecondaryRole(normalizedRole)) {
    return Array.from(SECONDARY_VISIBLE_HREFS).some((href) => matchesPath(pathname, href))
  }

  if (!isStaffRole(normalizedRole)) return true

  return Array.from(STAFF_VISIBLE_HREFS).some((href) => matchesPath(pathname, href))
}

export function defaultSidebarHrefForRole(role: SidebarRole): string {
  const normalizedRole = normalizeRole(role)
  if (normalizedRole === 'secondary') return '/escalations'
  if (normalizedRole === 'staff') return '/support'
  return '/support'
}

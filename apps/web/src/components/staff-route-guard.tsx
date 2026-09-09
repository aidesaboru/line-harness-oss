'use client'

import { useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { readStaffIdentityCache } from '@/lib/auth-session'
import { canAccessSidebarRoute, defaultSidebarHrefForRole } from './layout/sidebar-access'

export default function StaffRouteGuard({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const [staffName, setStaffName] = useState<string | null>(null)
  const [role, setRole] = useState<string | null>(null)
  const [salesOnly, setSalesOnly] = useState(false)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const cached = readStaffIdentityCache()
    setStaffName(cached.name || null)
    setRole(cached.role || null)
    setSalesOnly(cached.salesOnly)
    setReady(true)
  }, [pathname])

  const allowed = useMemo(
    () => ready && canAccessSidebarRoute(pathname, role, { staffName, salesOnly }),
    [pathname, ready, role, salesOnly, staffName],
  )

  useEffect(() => {
    if (!ready || allowed) return
    router.replace(pathname.startsWith('/notifications') && !salesOnly
      ? '/notification-settings'
      : defaultSidebarHrefForRole(role, { salesOnly }))
  }, [allowed, pathname, ready, role, router, salesOnly])

  if (!ready || !allowed) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin w-8 h-8 border-[3px] border-gray-200 border-t-green-500 rounded-full" />
      </div>
    )
  }

  return <>{children}</>
}

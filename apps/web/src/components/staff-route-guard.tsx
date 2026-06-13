'use client'

import { useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { readStaffIdentityCache } from '@/lib/auth-session'
import { canAccessStaffRoute } from './layout/sidebar-access'

export default function StaffRouteGuard({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const [role, setRole] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const cached = readStaffIdentityCache()
    setRole(cached.role || null)
    setReady(true)
  }, [pathname])

  const allowed = useMemo(
    () => ready && canAccessStaffRoute(pathname, role),
    [pathname, ready, role],
  )

  useEffect(() => {
    if (!ready || allowed) return
    router.replace('/support')
  }, [allowed, ready, router])

  if (!ready || !allowed) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin w-8 h-8 border-[3px] border-gray-200 border-t-green-500 rounded-full" />
      </div>
    )
  }

  return <>{children}</>
}

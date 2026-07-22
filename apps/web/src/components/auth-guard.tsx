'use client'
import { useEffect, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { cacheStaffSession, clearAuthSessionCache } from '@/lib/auth-session'
import { buildApiRequestUrl } from '@/lib/api-origin'

export default function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const [checked, setChecked] = useState(false)

  useEffect(() => {
    let cancelled = false

    if (pathname === '/login') {
      setChecked(true)
      return () => { cancelled = true }
    }

    // Verify the session via the HttpOnly cookie. /api/auth/session returns the
    // staff identity and refreshes the CSRF token if it was lost (e.g. reload).
    const checkSession = async () => {
      try {
        const res = await fetch(buildApiRequestUrl('/api/auth/session'), { credentials: 'include' })
        if (!res.ok) throw new Error('unauthenticated')
        const data = await res.json()
        if (!data?.success || !data?.data) throw new Error('unauthenticated')
        cacheStaffSession({
          name: data.data.name,
          role: data.data.role,
          csrfToken: data.csrfToken,
        })
        if (!cancelled) setChecked(true)
      } catch {
        clearAuthSessionCache()
        if (!cancelled) router.replace('/login')
      }
    }

    checkSession()
    return () => { cancelled = true }
  }, [pathname, router])

  if (!checked) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin w-8 h-8 border-[3px] border-gray-200 border-t-green-500 rounded-full" />
      </div>
    )
  }

  return <>{children}</>
}

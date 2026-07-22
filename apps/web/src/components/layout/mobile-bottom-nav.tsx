'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { readStaffIdentityCache } from '@/lib/auth-session'
import { canShowSidebarItem } from './sidebar-access'

const mobileItems = [
  {
    href: '/chats',
    label: '個別',
    icon: 'M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 0 1-4.255-.949L3 20l1.395-3.72A7.4 7.4 0 0 1 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8Z',
  },
  {
    href: '/internal-chat',
    label: '社内',
    icon: 'M17 8h2a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-5l-4 4v-4H7a2 2 0 0 1-2-2v-1m12-7V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2v4l4-4h4a2 2 0 0 0 2-2V8Z',
  },
  {
    href: '/notifications',
    label: '通知',
    icon: 'M15 17h5l-1.405-1.405A2 2 0 0 1 18 14.158V11a6 6 0 0 0-4-5.659V5a2 2 0 1 0-4 0v.341A6 6 0 0 0 6 11v3.159a2 2 0 0 1-.595 1.436L4 17h5m6 0v1a3 3 0 1 1-6 0v-1m6 0H9',
  },
  {
    href: '/support',
    label: 'チケット',
    icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l5 5v11a2 2 0 0 1-2 2Z',
  },
] as const

export default function MobileBottomNav() {
  const pathname = usePathname()
  const [staffIdentity, setStaffIdentity] = useState<{ ready: boolean; role: string; name: string }>({
    ready: false,
    role: '',
    name: '',
  })

  useEffect(() => {
    const identity = readStaffIdentityCache()
    setStaffIdentity({ ready: true, role: identity.role, name: identity.name })
  }, [])

  if (!staffIdentity.ready) return null

  const visibleItems = mobileItems.filter((item) => (
    canShowSidebarItem(item.href, staffIdentity.role, { staffName: staffIdentity.name })
  ))

  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white/95 pb-[env(safe-area-inset-bottom)] shadow-[0_-2px_12px_rgba(15,23,42,0.06)] backdrop-blur lg:hidden" aria-label="主要メニュー">
      <div className="grid h-16" style={{ gridTemplateColumns: `repeat(${visibleItems.length}, minmax(0, 1fr))` }}>
        {visibleItems.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`)
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={`flex min-w-0 flex-col items-center justify-center gap-1 px-1 text-[11px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-green-500 ${
                active ? 'text-green-700' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-800'
              }`}
            >
              <span className={`flex h-7 w-11 items-center justify-center rounded-full ${active ? 'bg-green-50' : ''}`}>
                <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d={item.icon} />
                </svg>
              </span>
              <span className="truncate">{item.label}</span>
            </Link>
          )
        })}
      </div>
    </nav>
  )
}

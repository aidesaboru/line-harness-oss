'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import { api, type AppNotificationItem } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'

const POLL_MS = 12_000
const TOAST_MS = 12_000

function BellIcon({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  )
}

function XIcon({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}

function notificationTone(item: AppNotificationItem): string {
  if (item.kind === 'urgent_case') return 'border-red-200 bg-white text-red-950'
  if (item.kind === 'secondary_answered') return 'border-emerald-200 bg-white text-emerald-950'
  if (item.kind === 'secondary_assigned') return 'border-indigo-200 bg-white text-indigo-950'
  return 'border-sky-200 bg-white text-sky-950'
}

export default function AppNotifier() {
  const pathname = usePathname()
  const { selectedAccountId } = useAccount()
  const [items, setItems] = useState<AppNotificationItem[]>([])
  const cursorRef = useRef<string | null>(null)
  const seenRef = useRef<Set<string>>(new Set())
  const timerRef = useRef<number | null>(null)

  const dismiss = useCallback((id: string) => {
    setItems((prev) => prev.filter((item) => item.id !== id))
  }, [])

  const pushItems = useCallback((nextItems: AppNotificationItem[]) => {
    const fresh = nextItems.filter((item) => {
      if (seenRef.current.has(item.id)) return false
      seenRef.current.add(item.id)
      return true
    })
    if (fresh.length === 0) return
    setItems((prev) => [...prev, ...fresh].slice(-5))
    for (const item of fresh) {
      window.setTimeout(() => dismiss(item.id), TOAST_MS)
    }
  }, [dismiss])

  const poll = useCallback(async () => {
    if (document.hidden) return
    try {
      const res = await api.appNotifications.recent({
        after: cursorRef.current ?? undefined,
        accountId: selectedAccountId ?? undefined,
      })
      if (!res.success) return
      cursorRef.current = res.data.cursor
      pushItems(res.data.items)
    } catch {
      // 通知は作業補助なので、通信失敗時は画面を邪魔しない。
    }
  }, [pushItems, selectedAccountId])

  useEffect(() => {
    cursorRef.current = null
    seenRef.current = new Set()
    setItems([])
  }, [selectedAccountId])

  useEffect(() => {
    if (pathname === '/login') return
    let cancelled = false
    const run = async () => {
      if (!cancelled) await poll()
    }
    void run()
    timerRef.current = window.setInterval(() => { void run() }, POLL_MS)
    const onVisible = () => {
      if (!document.hidden) void run()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      if (timerRef.current) window.clearInterval(timerRef.current)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [pathname, poll])

  if (items.length === 0) return null

  return (
    <div className="pointer-events-none fixed right-4 top-4 z-[70] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2 lg:right-5 lg:top-5" role="status" aria-live="polite">
      {items.map((item) => (
        <div
          key={item.id}
          className={`pointer-events-auto relative overflow-hidden rounded-xl border shadow-xl ${notificationTone(item)}`}
        >
          <button
            type="button"
            onClick={() => window.location.assign(item.href)}
            className="block w-full px-4 py-3 text-left transition-colors hover:bg-slate-50"
          >
            <div className="flex items-start gap-3">
              <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-900 text-white">
                <BellIcon className="h-3.5 w-3.5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-bold">{item.title}</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-slate-600">{item.body}</span>
              </span>
            </div>
          </button>
          <button
            type="button"
            onClick={() => dismiss(item.id)}
            className="absolute right-2 top-2 rounded-full p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
            aria-label="通知を閉じる"
          >
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  )
}

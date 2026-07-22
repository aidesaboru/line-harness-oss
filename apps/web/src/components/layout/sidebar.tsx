'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useAccount } from '@/contexts/account-context'
import type { AccountWithStats } from '@/contexts/account-context'
import { clearAuthSessionCache, readStaffIdentityCache } from '@/lib/auth-session'
import { countryFlag } from '@/lib/country-flag'
import BrandMark, { BrandWordmark } from '@/components/brand-mark'
import { canShowSidebarItem } from './sidebar-access'
import PwaInstallButton from '@/components/pwa/pwa-install-button'

const appVersion = process.env.APP_VERSION || '0.0.0'
const appCommitSha = process.env.APP_COMMIT_SHA || 'local'
const appBuildTime = process.env.APP_BUILD_TIME || ''
const appBuildDate = appBuildTime ? appBuildTime.replace('T', ' ').replace(/\.\d{3}Z$/, 'Z') : ''
const envOwnerDisplayName = '宮本 森一'

function staffRoleLabel(role: string | null): string {
  if (role === 'owner') return 'オーナー'
  if (role === 'admin') return '管理者'
  if (role === 'secondary') return '二次対応のみ'
  return '一次対応'
}

// ─── メニュー定義（ユーザー目線のカテゴリ） ───

const menuSections = [
  {
    label: null, // セクションラベルなし（よく使う機能）
    items: [
      { href: '/chats', label: '個別チャット', icon: 'M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z' },
      { href: '/internal-chat', label: '社内チャット', icon: 'M17 8h2a2 2 0 012 2v6a2 2 0 01-2 2h-5l-4 4v-4H7a2 2 0 01-2-2v-1m12-7V6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2v4l4-4h4a2 2 0 002-2V8z' },
      { href: '/notifications', label: '通知センター', icon: 'M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9' },
      { href: '/support', label: 'チケット管理', icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5l5 5v11a2 2 0 01-2 2z' },
      { href: '/escalations', label: '二次対応', icon: 'M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-4 4v-4z' },
      { href: '/friends', label: '顧客管理', icon: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z' },
      { href: '/manuals', label: 'マニュアル', icon: 'M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.746 0 3.332.477 4.5 1.253v13C19.832 18.477 18.246 18 16.5 18c-1.746 0-3.332.477-4.5 1.253' },
    ],
  },
  {
    label: '拡張用',
    items: [
      { href: '/templates', label: 'テンプレート', icon: 'M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z' },
      { href: '/automations', label: 'オートメーション', icon: 'M13 10V3L4 14h7v7l9-11h-7z' },
      { href: '/rich-menus', label: 'リッチメニュー', icon: 'M4 4h6v6H4V4zm0 10h6v6H4v-6zm10-10h6v6h-6V4zm0 10h6v6h-6v-6z' },
      { href: '/reminders', label: 'リマインダ', icon: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z' },
      { href: '/webhooks', label: 'Webhook', icon: 'M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z' },
    ],
  },
  {
    label: '管理・設定',
    items: [
      { href: '/staff', label: 'スタッフ管理', icon: 'M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z' },
      { href: '/accounts', label: 'LINEアカウント', icon: 'M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4' },
      { href: '/notification-settings', label: '通知設定', icon: 'M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9' },
      { href: '/pools', label: 'プール管理', icon: 'M3 7h18M3 12h18M3 17h18' },
      { href: '/users', label: 'ユーザー一覧', icon: 'M10 6H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V8a2 2 0 00-2-2h-5m-4 0V5a2 2 0 114 0v1m-4 0a2 2 0 104 0m-5 8a2 2 0 100-4 2 2 0 000 4zm0 0c1.306 0 2.417.835 2.83 2M9 14a3.001 3.001 0 00-2.83 2M15 11h3m-3 4h2' },
      { href: '/health', label: 'BAN検知', icon: 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z' },
      { href: '/updates', label: 'アップデート履歴', icon: 'M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15' },
      { href: '/emergency', label: '緊急コントロール', icon: 'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.072 16.5c-.77.833.192 2.5 1.732 2.5z', danger: true },
    ],
  },
]

function AccountAvatar({ account, size = 32 }: { account: AccountWithStats; size?: number }) {
  const displayName = account.displayName || account.name
  if (account.pictureUrl) {
    return (
      <img
        src={account.pictureUrl}
        alt={displayName}
        className="rounded-full object-cover shrink-0"
        style={{ width: size, height: size }}
      />
    )
  }
  return (
    <div
      className="rounded-full flex items-center justify-center text-white font-bold shrink-0"
      style={{ width: size, height: size, backgroundColor: '#06C755', fontSize: size * 0.4 }}
    >
      {displayName.charAt(0)}
    </div>
  )
}

function AccountSwitcher() {
  const { accounts, selectedAccount, setSelectedAccountId, loading } = useAccount()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  if (loading || accounts.length === 0) return null

  const displayName = selectedAccount?.displayName || selectedAccount?.name || ''

  return (
    <div ref={ref} className="px-3 py-3 border-b border-gray-200">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-gray-50 transition-colors"
      >
        {selectedAccount && <AccountAvatar account={selectedAccount} size={28} />}
        <div className="flex-1 text-left min-w-0">
          <p className="text-sm font-medium text-gray-900 truncate">
            <span className="flex items-center gap-1.5">
              {countryFlag(selectedAccount?.country) && (
                <span className="text-base leading-none">{countryFlag(selectedAccount?.country)}</span>
              )}
              <span>{displayName}</span>
            </span>
          </p>
        </div>
        <svg
          className={`w-4 h-4 text-gray-400 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="mt-1 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden">
          {accounts.map((account) => {
            const isSelected = account.id === selectedAccount?.id
            const name = account.displayName || account.name
            return (
              <button
                key={account.id}
                onClick={() => {
                  setSelectedAccountId(account.id)
                  setOpen(false)
                }}
                className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-left transition-colors ${
                  isSelected ? 'bg-green-50' : 'hover:bg-gray-50'
                }`}
              >
                <AccountAvatar account={account} size={24} />
                <div className="flex-1 min-w-0">
                  <p className={`text-sm truncate ${isSelected ? 'font-semibold text-green-700' : 'text-gray-700'}`}>
                    <span className="flex items-center gap-1.5">
                      {countryFlag(account.country) && (
                        <span className="text-base leading-none">{countryFlag(account.country)}</span>
                      )}
                      <span>{name}</span>
                    </span>
                  </p>
                  {account.basicId && (
                    <p className="text-xs text-gray-400 truncate">{account.basicId}</p>
                  )}
                </div>
                {isSelected && (
                  <svg className="w-4 h-4 text-green-600 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function NavIcon({ d }: { d: string }) {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={d} />
    </svg>
  )
}

export default function Sidebar() {
  const pathname = usePathname()
  const [isOpen, setIsOpen] = useState(false)
  const [staffName, setStaffName] = useState<string | null>(null)
  const [staffRole, setStaffRole] = useState<string | null>(null)

  useEffect(() => {
    const cached = readStaffIdentityCache()
    setStaffName(cached.name || null)
    setStaffRole(cached.role || null)
  }, [])

  useEffect(() => { setIsOpen(false) }, [pathname])
  useEffect(() => {
    document.body.style.overflow = isOpen ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [isOpen])

  const isActive = (href: string) => href === '/' ? pathname === '/' : pathname.startsWith(href)
  const displayStaffName = staffRole === 'owner' && staffName === 'Owner' ? envOwnerDisplayName : staffName
  const visibleMenuSections = menuSections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => canShowSidebarItem(item.href, staffRole, { staffName })),
    }))
    .filter((section) => section.items.length > 0)

  const sidebarContent = (
    <>
      {/* ロゴ */}
      <div className="px-6 py-5 border-b border-gray-200">
        <div className="flex items-center gap-3">
          <BrandMark size="lg" />
          <BrandWordmark size="sm" className="h-7 w-[138px]" />
        </div>
      </div>

      {/* アカウント切替 */}
      <AccountSwitcher />

      {/* ナビゲーション */}
      <nav className="min-h-0 flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        {visibleMenuSections.map((section, si) => (
          <div key={si}>
            {section.label && (
              <div className="pt-5 pb-2 px-3">
                <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">{section.label}</p>
              </div>
            )}
            {section.items.map((item) => {
              const active = isActive(item.href)
              const isDanger = 'danger' in item && item.danger
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                    active
                      ? 'text-white'
                      : isDanger
                        ? 'text-red-500 hover:bg-red-50'
                        : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                  }`}
                  style={active ? { backgroundColor: isDanger ? '#EF4444' : '#06C755' } : {}}
                >
                  <NavIcon d={item.icon} />
                  <span className="flex-1">{item.label}</span>
                </Link>
              )
            })}
          </div>
        ))}
      </nav>

      {/* フッター */}
      <div className="shrink-0 border-t border-gray-200 bg-white">
        {displayStaffName && (
          <div className="px-3 py-2 text-xs text-gray-500 border-t border-gray-100">
            <div className="font-medium text-gray-700">{displayStaffName}</div>
            <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium mt-0.5 ${
              staffRole === 'owner' ? 'bg-yellow-100 text-yellow-800' :
              staffRole === 'admin' ? 'bg-blue-100 text-blue-800' :
              staffRole === 'secondary' ? 'bg-indigo-100 text-indigo-800' :
              'bg-gray-100 text-gray-600'
            }`}>
              {staffRoleLabel(staffRole)}
            </span>
          </div>
        )}
        <div className="px-6 py-4 space-y-3">
        <div className="space-y-0.5">
          <BrandWordmark size="sm" className="h-6 w-[120px] opacity-70" />
          <p className="text-xs text-gray-400">v{appVersion}</p>
          <p className="text-[10px] text-gray-400 font-mono break-all">
            build {appCommitSha}{appBuildDate ? ` · ${appBuildDate}` : ''}
          </p>
        </div>
        <button
          onClick={async () => {
            try {
              const apiUrl = process.env.NEXT_PUBLIC_API_URL
              if (apiUrl) {
                await fetch(`${apiUrl}/api/auth/logout`, {
                  method: 'POST',
                  credentials: 'include',
                })
              }
            } catch {
              // Local cleanup still logs the browser out if the network call fails.
            }
            clearAuthSessionCache()
            window.location.href = '/login'
          }}
          className="flex items-center gap-2 text-xs text-gray-400 hover:text-red-500 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
          </svg>
          ログアウト
        </button>
        </div>
      </div>
    </>
  )

  return (
    <>
      {/* モバイル: ハンバーガーヘッダー */}
      <div className="fixed inset-x-0 top-0 z-40 border-b border-gray-200 bg-white pt-[env(safe-area-inset-top)] lg:hidden">
        <div className="flex h-16 items-center gap-2 px-3">
          <button
            onClick={() => setIsOpen(!isOpen)}
            className="flex min-h-11 min-w-11 items-center justify-center rounded-lg transition-colors hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500"
            aria-label="メニュー"
          >
            <svg className="h-6 w-6 text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              {isOpen
                ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                : <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              }
            </svg>
          </button>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <BrandMark size="md" />
            <BrandWordmark size="sm" className="h-7 w-[112px] max-w-full" />
          </div>
          <PwaInstallButton />
        </div>
      </div>

      {/* モバイル: オーバーレイ */}
      {isOpen && <div className="fixed inset-0 z-[45] bg-black/50 lg:hidden" onClick={() => setIsOpen(false)} />}

      {/* モバイル: スライドインサイドバー */}
      <aside className={`fixed left-0 top-0 z-50 flex h-[100dvh] w-72 flex-col bg-white pt-[env(safe-area-inset-top)] transition-transform duration-300 ease-in-out lg:hidden ${isOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="absolute right-4 top-[calc(1rem_+_env(safe-area-inset-top))]">
          <button onClick={() => setIsOpen(false)} className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-lg hover:bg-gray-100" aria-label="閉じる">
            <svg className="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        {sidebarContent}
      </aside>

      {/* デスクトップ: 常時表示 */}
      <aside className="hidden lg:flex w-64 bg-white border-r border-gray-200 flex-col h-screen sticky top-0">
        {sidebarContent}
      </aside>
    </>
  )
}

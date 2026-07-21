'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import Header from '@/components/layout/header'
import { useAccount } from '@/contexts/account-context'
import { api, type AppNotificationItem, type InternalChatFeedItem, type SupportCase, type SupportSummary } from '@/lib/api'

function formatDateTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('ja-JP', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function notificationTone(kind: AppNotificationItem['kind']): string {
  switch (kind) {
    case 'urgent_case':
      return 'border-red-200 bg-red-50 text-red-800'
    case 'secondary_answered':
      return 'border-emerald-200 bg-emerald-50 text-emerald-800'
    case 'secondary_assigned':
      return 'border-indigo-200 bg-indigo-50 text-indigo-800'
    case 'support_mention':
    case 'chat_mention':
      return 'border-sky-200 bg-sky-50 text-sky-800'
    default:
      return 'border-slate-200 bg-slate-50 text-slate-700'
  }
}

function notificationKindLabel(kind: AppNotificationItem['kind']): string {
  switch (kind) {
    case 'urgent_case':
      return '大至急'
    case 'secondary_assigned':
      return '二次対応'
    case 'secondary_answered':
      return '二次回答'
    case 'support_mention':
    case 'chat_mention':
      return 'メンション'
    default:
      return '通知'
  }
}

function caseHref(item: SupportCase): string {
  return `/support?case=${encodeURIComponent(item.id)}`
}

function isMentionForMe(item: InternalChatFeedItem, staffName: string): boolean {
  const name = staffName.trim()
  if (!name) return false
  if (item.mentions.includes(name)) return true
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`@${escaped}(?=$|[\\s、。，.!！?？])`, 'u').test(item.body)
}

function compact(text: string | null | undefined, fallback: string): string {
  const value = (text ?? '').replace(/\s+/g, ' ').trim()
  return value ? value.slice(0, 90) : fallback
}

export default function NotificationsPage() {
  const { selectedAccountId, selectedAccount } = useAccount()
  const [summary, setSummary] = useState<SupportSummary | null>(null)
  const [notifications, setNotifications] = useState<AppNotificationItem[]>([])
  const [feedItems, setFeedItems] = useState<InternalChatFeedItem[]>([])
  const [secondaryAnsweredCases, setSecondaryAnsweredCases] = useState<SupportCase[]>([])
  const [urgentCases, setUrgentCases] = useState<SupportCase[]>([])
  const [staffName, setStaffName] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const requestIdRef = useRef(0)

  const accountName = selectedAccount?.displayName || selectedAccount?.name || '選択中アカウント'

  const load = useCallback(async () => {
    if (!selectedAccountId) return
    const requestId = ++requestIdRef.current
    setLoading(true)
    setError('')
    setSummary(null)
    setNotifications([])
    setFeedItems([])
    setSecondaryAnsweredCases([])
    setUrgentCases([])
    setStaffName('')
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const results = await Promise.allSettled([
      api.staff.me(),
      api.support.summary({ accountId: selectedAccountId }),
      api.appNotifications.recent({ after: since, accountId: selectedAccountId }),
      api.appNotifications.internalChatFeed({ accountId: selectedAccountId, limit: 80 }),
      api.support.cases.list({ accountId: selectedAccountId, queue: 'secondary_answered', limit: 20 }),
      api.support.cases.list({ accountId: selectedAccountId, queue: 'unresolved', limit: 100 }),
    ] as const)
    if (requestId !== requestIdRef.current) return

    let failures = 0
    const [meResult, summaryResult, recentResult, feedResult, secondaryResult, unresolvedResult] = results
    if (meResult.status === 'fulfilled' && meResult.value.success) setStaffName(meResult.value.data.name || '')
    else failures += 1
    if (summaryResult.status === 'fulfilled' && summaryResult.value.success) setSummary(summaryResult.value.data)
    else failures += 1
    if (recentResult.status === 'fulfilled' && recentResult.value.success) setNotifications(recentResult.value.data.items)
    else failures += 1
    if (feedResult.status === 'fulfilled' && feedResult.value.success) setFeedItems(feedResult.value.data.items)
    else failures += 1
    if (secondaryResult.status === 'fulfilled' && secondaryResult.value.success) setSecondaryAnsweredCases(secondaryResult.value.data)
    else failures += 1
    if (unresolvedResult.status === 'fulfilled' && unresolvedResult.value.success) {
      setUrgentCases(unresolvedResult.value.data.filter((item) => item.priority === 'urgent').slice(0, 10))
    } else failures += 1

    if (failures === results.length) setError('通知情報の取得に失敗しました。時間を置いて更新してください。')
    else if (failures > 0) setError('一部の通知情報を取得できませんでした。取得できた情報を表示しています。')
    setLoading(false)
  }, [selectedAccountId])

  useEffect(() => {
    void load()
  }, [load])

  const myMentions = useMemo(
    () => feedItems.filter((item) => isMentionForMe(item, staffName)).slice(0, 10),
    [feedItems, staffName],
  )

  const cards = [
    { label: '二次回答済み', value: summary?.totals.secondaryAnswered ?? 0, tone: 'text-emerald-700 bg-emerald-50 border-emerald-200' },
    { label: '大至急', value: summary?.totals.urgent ?? 0, tone: 'text-red-700 bg-red-50 border-red-200' },
    { label: '自分宛メンション', value: myMentions.length, tone: 'text-sky-700 bg-sky-50 border-sky-200' },
    { label: '24時間以内の通知', value: notifications.length, tone: 'text-slate-700 bg-slate-50 border-slate-200' },
  ]

  return (
    <div className="space-y-4">
      <Header
        title="通知センター"
        description={`${accountName} の見落としやすい通知をまとめて確認`}
        action={
          <div className="flex items-center gap-2">
            <Link
              href="/notification-settings"
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              通知設定
            </Link>
            <button
              type="button"
              onClick={() => void load()}
              className="rounded-md bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-700"
            >
              更新
            </button>
          </div>
        }
      />

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
          {error}
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-4">
        {cards.map((card) => (
          <div key={card.label} className={`rounded-xl border px-4 py-3 ${card.tone}`}>
            <p className="text-xs font-medium opacity-80">{card.label}</p>
            <p className="mt-1 text-3xl font-semibold tabular-nums">{loading ? '...' : card.value}</p>
          </div>
        ))}
      </div>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-4">
          <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-200 px-4 py-3">
              <h2 className="text-sm font-semibold text-slate-900">今見るもの</h2>
              <p className="mt-0.5 text-xs text-slate-500">二次回答済みと大至急を優先して表示します。</p>
            </div>
            <div className="divide-y divide-slate-100">
              {loading ? (
                <div className="p-4 text-sm text-slate-500">読み込み中...</div>
              ) : secondaryAnsweredCases.length === 0 && urgentCases.length === 0 ? (
                <div className="p-6 text-sm font-medium text-slate-500">優先して確認するチケットはありません</div>
              ) : (
                <>
                  {secondaryAnsweredCases.map((item) => (
                    <Link key={`secondary-${item.id}`} href={caseHref(item)} className="block px-4 py-3 hover:bg-slate-50">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700">二次回答済み</span>
                        <span className="text-xs text-slate-400">更新 {formatDateTime(item.updatedAt)}</span>
                      </div>
                      <p className="mt-2 text-sm font-semibold text-slate-900">{item.title}</p>
                      <p className="mt-1 text-xs text-slate-500">{compact(item.friendName || item.companyName || item.contactName, '顧客未紐付け')}</p>
                    </Link>
                  ))}
                  {urgentCases.map((item) => (
                    <Link key={`urgent-${item.id}`} href={caseHref(item)} className="block px-4 py-3 hover:bg-slate-50">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs font-semibold text-red-700">大至急</span>
                        <span className="text-xs text-slate-400">更新 {formatDateTime(item.updatedAt)}</span>
                      </div>
                      <p className="mt-2 text-sm font-semibold text-slate-900">{item.title}</p>
                      <p className="mt-1 text-xs text-slate-500">{compact(item.friendName || item.companyName || item.contactName, '顧客未紐付け')}</p>
                    </Link>
                  ))}
                </>
              )}
            </div>
          </section>

          <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-200 px-4 py-3">
              <h2 className="text-sm font-semibold text-slate-900">最近の通知</h2>
              <p className="mt-0.5 text-xs text-slate-500">直近24時間の通知です。</p>
            </div>
            <div className="divide-y divide-slate-100">
              {loading ? (
                <div className="p-4 text-sm text-slate-500">読み込み中...</div>
              ) : notifications.length === 0 ? (
                <div className="p-6 text-sm font-medium text-slate-500">最近の通知はありません</div>
              ) : notifications.slice().reverse().map((item) => (
                <Link key={item.id} href={item.href} className="block px-4 py-3 hover:bg-slate-50">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded-md border px-2 py-1 text-xs font-semibold ${notificationTone(item.kind)}`}>
                      {notificationKindLabel(item.kind)}
                    </span>
                    <span className="text-xs text-slate-400">{formatDateTime(item.createdAt)}</span>
                  </div>
                  <p className="mt-2 text-sm font-semibold text-slate-900">{item.title}</p>
                  <p className="mt-1 text-xs leading-5 text-slate-500">{item.body}</p>
                </Link>
              ))}
            </div>
          </section>
        </div>

        <aside className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 px-4 py-3">
            <h2 className="text-sm font-semibold text-slate-900">自分宛メンション</h2>
            <p className="mt-0.5 text-xs text-slate-500">社内チャットで呼ばれている相談です。</p>
          </div>
          <div className="divide-y divide-slate-100">
            {loading ? (
              <div className="p-4 text-sm text-slate-500">読み込み中...</div>
            ) : myMentions.length === 0 ? (
              <div className="p-6 text-sm font-medium text-slate-500">自分宛のメンションはありません</div>
            ) : myMentions.map((item) => (
              <Link key={item.id} href={item.href} className="block px-4 py-3 hover:bg-slate-50">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-md border border-sky-200 bg-sky-50 px-2 py-1 text-xs font-semibold text-sky-700">
                    {item.source === 'support' ? 'チケット' : '個別チャット'}
                  </span>
                  <span className="text-xs text-slate-400">{formatDateTime(item.createdAt)}</span>
                </div>
                <p className="mt-2 text-sm font-semibold text-slate-900">{item.ticketTitle || item.customerName || item.sourceTitle}</p>
                <p className="mt-1 text-xs leading-5 text-slate-500">{compact(item.body, '社内チャットを確認してください')}</p>
              </Link>
            ))}
          </div>
        </aside>
      </section>
    </div>
  )
}

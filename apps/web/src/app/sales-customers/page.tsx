'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Header from '@/components/layout/header'
import { useAccount } from '@/contexts/account-context'
import {
  ApiRequestError,
  api,
  type SalesCustomer,
  type SalesCustomerActivity,
  type SalesCustomerDetail,
  type SalesCustomerOverviewBatchResult,
  type SalesCustomerStatus,
  type SalesCustomerStoredStatus,
} from '@/lib/api'
import {
  SALES_CUSTOMER_STATUS_META,
  SALES_CUSTOMER_STORED_STATUSES,
  formatSalesCustomerDate,
  salesActionRequiredCount,
  salesCustomerDraftStatus,
  salesCustomerIdentity,
  salesCustomerName,
  salesCustomerSourceLabel,
} from '@/lib/sales-customer-status'

const PAGE_SIZE = 50
const OVERVIEW_BATCH_SIZE = 5
type StatusFilter = SalesCustomerStatus | 'action_required' | 'all'

type OverviewBatchSummary = {
  total: number
  processed: number
  create: number
  update: number
  unchanged: number
  written: number
  aiRequests: number
  noText: number
  inputChars: number
  inputTokens: number
  aiGenerated: number
  noTextWritten: number
  aiAttempts: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  failed: number
  aiUnavailable: number
  invalidAiResponse: number
  statusRowsTouched: number
}

const EMPTY_COUNTS: Record<SalesCustomerStatus, number> = {
  unreviewed: 0,
  normal: 0,
  attention: 0,
  complaint: 0,
  exit_pending: 0,
  exited: 0,
}

const FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'action_required', label: '要確認' },
  { value: 'all', label: 'すべて' },
  { value: 'unreviewed', label: '確認前' },
  { value: 'normal', label: '通常運用' },
  { value: 'attention', label: '要注意' },
  { value: 'complaint', label: 'クレーム' },
  { value: 'exit_pending', label: '退会手続き中' },
  { value: 'exited', label: '退会済み' },
]

function customerKey(customer: Pick<SalesCustomer, 'subjectKind' | 'subjectId'>): string {
  return `${customer.subjectKind}:${customer.subjectId}`
}

function StatusBadge({ status }: { status: SalesCustomerStatus }) {
  const meta = SALES_CUSTOMER_STATUS_META[status]
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${meta.badgeClass}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${meta.dotClass}`} aria-hidden="true" />
      {meta.label}
    </span>
  )
}

function SummaryButton({
  label,
  count,
  active,
  tone,
  onClick,
}: {
  label: string
  count: number
  active: boolean
  tone: 'risk' | 'complaint' | 'exit' | 'normal'
  onClick: () => void
}) {
  const tones = {
    risk: 'border-amber-200 bg-amber-50/60 text-amber-950',
    complaint: 'border-red-200 bg-red-50/60 text-red-950',
    exit: 'border-rose-200 bg-rose-50/60 text-rose-950',
    normal: 'border-emerald-200 bg-emerald-50/60 text-emerald-950',
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`min-h-20 rounded-xl border p-3 text-left transition-colors hover:border-gray-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 ${tones[tone]} ${active ? 'ring-2 ring-gray-800 ring-offset-2' : ''}`}
    >
      <span className="block text-xs font-semibold">{label}</span>
      <span className="mt-1 block text-2xl font-bold tabular-nums">{count.toLocaleString('ja-JP')}</span>
    </button>
  )
}

const CHAT_STATUS_LABELS: Record<NonNullable<SalesCustomer['chatStatus']>, string> = {
  unread: '未対応',
  in_progress: '対応中',
  resolved: '解決済み',
  long_term: '中長期対応',
}

function RecentActivityPanel({
  activity,
  chatStatus,
  isFollowing,
  subjectKind,
}: {
  activity: SalesCustomerActivity
  chatStatus: SalesCustomer['chatStatus']
  isFollowing: SalesCustomer['isFollowing']
  subjectKind: SalesCustomer['subjectKind']
}) {
  const [months, setMonths] = useState<1 | 2 | 3>(3)
  const window = months === 1
    ? activity.windows.oneMonth
    : months === 2
      ? activity.windows.twoMonths
      : activity.windows.threeMonths

  const metrics = [
    { label: 'メッセージ合計', value: window.totalMessages, suffix: '件' },
    { label: '顧客から', value: window.customerMessages, suffix: '件' },
    { label: '担当者返信', value: window.staffReplies, suffix: '件' },
    { label: '自動配信', value: window.automatedMessages, suffix: '件' },
    { label: 'やり取り日数', value: window.activeDays, suffix: '日' },
    { label: '画像・添付', value: window.mediaMessages, suffix: '件' },
  ]

  return (
    <section className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-gray-900">最近の{subjectKind === 'friend' ? '個別' : 'グループ'}チャット概要</h3>
          <p className="mt-1 text-[11px] leading-5 text-gray-500">会話本文・氏名・連絡先を出さず、活動量だけを集計しています。</p>
        </div>
        <div className="inline-flex rounded-lg border border-gray-200 bg-gray-50 p-0.5" aria-label="集計期間">
          {([1, 2, 3] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setMonths(value)}
              aria-pressed={months === value}
              className={`min-h-8 rounded-md px-2.5 text-[11px] font-semibold ${months === value ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-800'}`}
            >
              {value}か月
            </button>
          ))}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {activity.needsHumanReply && (
          <span className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-800">顧客からの最終連絡後、担当者返信なし</span>
        )}
        {activity.support.activeCases > 0 && (
          <span className="rounded-full border border-blue-200 bg-blue-50 px-2.5 py-1 text-[11px] font-semibold text-blue-800">対応中チケット {activity.support.activeCases}件</span>
        )}
        {chatStatus && (
          <span className="rounded-full border border-gray-200 bg-gray-50 px-2.5 py-1 text-[11px] font-semibold text-gray-700">チャット: {CHAT_STATUS_LABELS[chatStatus]}</span>
        )}
        {isFollowing === false && (
          <span className="rounded-full border border-gray-300 bg-gray-100 px-2.5 py-1 text-[11px] font-semibold text-gray-700">ブロック済み</span>
        )}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {metrics.map((metric) => (
          <div key={metric.label} className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2.5">
            <p className="text-[10px] font-medium text-gray-500">{metric.label}</p>
            <p className="mt-0.5 text-base font-bold tabular-nums text-gray-900">{metric.value.toLocaleString('ja-JP')}<span className="ml-0.5 text-[10px] font-medium text-gray-500">{metric.suffix}</span></p>
          </div>
        ))}
      </div>

      <dl className="mt-3 grid gap-2 text-[11px] text-gray-600 sm:grid-cols-2">
        <div className="flex justify-between gap-3 rounded-lg border border-gray-100 px-3 py-2">
          <dt>最終接触</dt>
          <dd className="font-medium text-gray-800">{formatSalesCustomerDate(activity.lastContactAt)}</dd>
        </div>
        <div className="flex justify-between gap-3 rounded-lg border border-gray-100 px-3 py-2">
          <dt>顧客の最終連絡</dt>
          <dd className="font-medium text-gray-800">{formatSalesCustomerDate(activity.lastCustomerMessageAt)}</dd>
        </div>
        <div className="flex justify-between gap-3 rounded-lg border border-gray-100 px-3 py-2">
          <dt>担当者の最終返信</dt>
          <dd className="font-medium text-gray-800">{formatSalesCustomerDate(activity.lastStaffReplyAt)}</dd>
        </div>
        <div className="flex justify-between gap-3 rounded-lg border border-gray-100 px-3 py-2">
          <dt>関連チケット（3か月）</dt>
          <dd className="font-medium text-gray-800">{activity.support.casesInThreeMonths.toLocaleString('ja-JP')}件</dd>
        </div>
      </dl>
    </section>
  )
}

function RecentOverviewPanel({ detail }: { detail: SalesCustomerDetail }) {
  const overview = detail.recentOverview
  return (
    <section className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-gray-900">最近の状況</h3>
          <p className="mt-1 text-[11px] leading-5 text-gray-500">
            直近の人同士のやり取りをAIで「相談・対応・現在地・次の対応」に整理。営業ステータスは判定しません。
          </p>
        </div>
        <span className="rounded-full border border-gray-200 bg-gray-50 px-2.5 py-1 text-[10px] font-semibold text-gray-600">
          ステータスとは別管理
        </span>
      </div>
      <p className="mt-3 whitespace-pre-wrap break-words rounded-xl border border-gray-200 bg-gray-50 p-4 text-sm leading-6 text-gray-800">
        {overview.text}
      </p>
      <p className="mt-2 text-[10px] text-gray-400">
        {overview.stored && overview.updatedAt
          ? `${formatSalesCustomerDate(overview.updatedAt)} 更新 · 対象${overview.sourceMessageCount}件${overview.sourceToAt ? ` · 最終記録 ${formatSalesCustomerDate(overview.sourceToAt)}` : ''}${overview.updatedByName ? ` · ${overview.updatedByName}` : ''}`
          : '会話要約はまだ生成されていません。'}
      </p>
      {detail.overviewHistory.length > 0 && (
        <details className="group mt-3 rounded-lg border border-gray-200 bg-white">
          <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-2 px-3 text-xs font-semibold text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-green-500">
            <span>概要の更新履歴 {detail.overviewHistory.length}件</span>
            <svg className="h-4 w-4 text-gray-400 transition-transform group-open:rotate-180" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="m6 9 6 6 6-6" /></svg>
          </summary>
          <ol className="max-h-72 space-y-3 overflow-y-auto border-t border-gray-100 p-3">
            {detail.overviewHistory.map((event) => (
              <li key={event.id} className="border-l-2 border-gray-200 pl-3">
                <p className="whitespace-pre-wrap break-words text-[11px] leading-5 text-gray-700">{event.text}</p>
                <p className="mt-1 text-[10px] text-gray-400">
                  {formatSalesCustomerDate(event.createdAt)}{event.actorName ? ` · ${event.actorName}` : ''}
                </p>
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  )
}

function addOverviewBatchPage(
  summary: OverviewBatchSummary,
  page: SalesCustomerOverviewBatchResult,
): OverviewBatchSummary {
  return {
    total: page.total,
    processed: summary.processed + page.processed,
    create: summary.create + page.changes.create,
    update: summary.update + page.changes.update,
    unchanged: summary.unchanged + page.changes.unchanged,
    written: summary.written + page.written,
    aiRequests: summary.aiRequests + page.estimate.aiRequests,
    noText: summary.noText + page.estimate.noText,
    inputChars: summary.inputChars + page.estimate.inputChars,
    inputTokens: summary.inputTokens + page.estimate.inputTokens,
    aiGenerated: summary.aiGenerated + page.aiGenerated,
    noTextWritten: summary.noTextWritten + page.noTextWritten,
    aiAttempts: summary.aiAttempts + page.aiAttempts,
    promptTokens: summary.promptTokens + page.usage.promptTokens,
    completionTokens: summary.completionTokens + page.usage.completionTokens,
    totalTokens: summary.totalTokens + page.usage.totalTokens,
    failed: summary.failed + page.failed,
    aiUnavailable: summary.aiUnavailable + page.failures.aiUnavailable,
    invalidAiResponse: summary.invalidAiResponse + page.failures.invalidAiResponse,
    statusRowsTouched: summary.statusRowsTouched + page.statusRowsTouched,
  }
}

function DetailContent({
  detail,
  loading,
  editStatus,
  editSummary,
  saving,
  saveMessage,
  onStatusChange,
  onSummaryChange,
  onSave,
}: {
  detail: SalesCustomerDetail | null
  loading: boolean
  editStatus: SalesCustomerStoredStatus | ''
  editSummary: string
  saving: boolean
  saveMessage: string
  onStatusChange: (status: SalesCustomerStoredStatus | '') => void
  onSummaryChange: (summary: string) => void
  onSave: () => void
}) {
  if (loading) {
    return (
      <div className="space-y-4 p-5" aria-label="顧客詳細を読み込み中">
        <div className="h-5 w-32 animate-pulse rounded bg-gray-200" />
        <div className="h-24 animate-pulse rounded-xl bg-gray-100" />
        <div className="h-40 animate-pulse rounded-xl bg-gray-100" />
      </div>
    )
  }
  if (!detail) {
    return (
      <div className="flex min-h-[420px] items-center justify-center p-8 text-center">
        <div>
          <svg className="mx-auto h-9 w-9 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 19a6 6 0 00-12 0m6-8a4 4 0 100-8 4 4 0 000 8zm6 2a5 5 0 014 4.9M16 3.1a4 4 0 010 7.8" />
          </svg>
          <p className="mt-3 text-sm font-medium text-gray-700">顧客を選択してください</p>
          <p className="mt-1 text-xs leading-5 text-gray-500">営業連絡の可否と状況履歴を確認できます。</p>
        </div>
      </div>
    )
  }

  const meta = SALES_CUSTOMER_STATUS_META[detail.status]
  const changed = editStatus !== '' && (editStatus !== detail.status || editSummary.trim() !== detail.summary)
  const canSave = detail.canEditStatus && !saving && changed && editSummary.trim().length > 0

  return (
    <div className="divide-y divide-gray-100">
      <section className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-gray-500">{salesCustomerSourceLabel(detail)}</p>
            <h2 className="mt-1 break-words text-lg font-bold text-gray-950">{salesCustomerName(detail)}</h2>
            {salesCustomerIdentity(detail) && (
              <p className="mt-1 break-words text-xs leading-5 text-gray-500">{salesCustomerIdentity(detail)}</p>
            )}
          </div>
          <StatusBadge status={detail.status} />
        </div>
      </section>

      <section className="p-5">
        <div className={`rounded-xl border p-4 ${meta.panelClass}`}>
          <p className="text-xs font-semibold text-gray-600">営業アクション</p>
          <p className="mt-1 text-base font-bold text-gray-950">{meta.actionLabel}</p>
          <p className="mt-3 text-[11px] text-gray-500">
            {detail.updatedAt
              ? `${formatSalesCustomerDate(detail.updatedAt)} 更新${detail.updatedByName ? ` · ${detail.updatedByName}` : ''}`
              : '更新履歴なし'}
          </p>
        </div>
      </section>

      <RecentOverviewPanel detail={detail} />

      <RecentActivityPanel
        activity={detail.activity}
        chatStatus={detail.chatStatus}
        isFollowing={detail.isFollowing}
        subjectKind={detail.subjectKind}
      />

      <section className="p-5">
        <h3 className="text-sm font-bold text-gray-900">ステータス判断メモ</h3>
        <p className="mt-1 text-[11px] leading-5 text-gray-500">運営担当者が会話を確認し、ステータスを選んだ理由と引き継ぎ事項を記録します。</p>
        <p className="mt-3 whitespace-pre-wrap break-words rounded-xl border border-gray-200 bg-gray-50 p-4 text-sm leading-6 text-gray-800">
          {detail.summary || 'ステータスは未確認です。人が会話を確認して入力します。'}
        </p>
      </section>

      {detail.canEditStatus ? (
        <section className="p-5">
          <h3 className="text-sm font-bold text-gray-900">運営側の状況更新</h3>
          <p className="mt-1 text-xs leading-5 text-gray-500">
            ステータスは人が選び、判断理由だけを書きます。会話本文や個人情報は転記しないでください。
          </p>
          <div className="mt-4 space-y-3">
            <div>
              <label htmlFor="sales-customer-status" className="mb-1 block text-xs font-semibold text-gray-700">状況</label>
              <select
                id="sales-customer-status"
                value={editStatus}
                onChange={(event) => onStatusChange(event.target.value as SalesCustomerStoredStatus | '')}
                disabled={saving}
                className="min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 outline-none focus:border-green-500 focus:ring-2 focus:ring-green-100 disabled:bg-gray-100"
              >
                <option value="" disabled>状況を選択</option>
                {SALES_CUSTOMER_STORED_STATUSES.map((status) => (
                  <option key={status} value={status}>{SALES_CUSTOMER_STATUS_META[status].label}</option>
                ))}
              </select>
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between gap-2">
                <label htmlFor="sales-customer-summary" className="text-xs font-semibold text-gray-700">ステータス判断メモ</label>
                <span className="text-[11px] tabular-nums text-gray-400">{editSummary.length}/1000</span>
              </div>
              <textarea
                id="sales-customer-summary"
                value={editSummary}
                onChange={(event) => onSummaryChange(event.target.value.slice(0, 1000))}
                disabled={saving}
                rows={4}
                maxLength={1000}
                placeholder="例: 契約内容の認識差を確認中。解決連絡があるまで営業提案は停止。"
                className="w-full resize-y rounded-lg border border-gray-300 px-3 py-2.5 text-sm leading-6 text-gray-900 outline-none placeholder:text-gray-400 focus:border-green-500 focus:ring-2 focus:ring-green-100 disabled:bg-gray-100"
              />
            </div>
            {saveMessage && (
              <p className={`text-xs ${saveMessage.includes('更新しました') ? 'text-green-700' : 'text-red-600'}`} role="status">
                {saveMessage}
              </p>
            )}
            <button
              type="button"
              onClick={onSave}
              disabled={!canSave}
              className="min-h-11 w-full rounded-lg bg-[#06C755] px-4 text-sm font-bold text-white transition-colors hover:bg-[#05b94f] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-gray-200 disabled:text-gray-500"
            >
              {saving ? '保存中...' : '状況と判断メモを保存'}
            </button>
          </div>
        </section>
      ) : (
        <section className="p-5">
          <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-3 text-xs leading-5 text-gray-600">
            このアカウントは閲覧専用です。会話本文や運営画面は表示されません。
          </div>
        </section>
      )}

      <section className="p-5">
        <h3 className="text-sm font-bold text-gray-900">ステータス変更履歴</h3>
        {detail.history.length === 0 ? (
          <p className="mt-3 rounded-lg bg-gray-50 px-3 py-4 text-xs text-gray-500">まだ更新履歴はありません。</p>
        ) : (
          <ol className="mt-4 space-y-4">
            {detail.history.map((event, index) => (
              <li key={event.id} className="relative pl-5">
                {index < detail.history.length - 1 && <span className="absolute left-[5px] top-3 h-[calc(100%+12px)] w-px bg-gray-200" aria-hidden="true" />}
                <span className={`absolute left-0 top-1.5 h-2.5 w-2.5 rounded-full ${SALES_CUSTOMER_STATUS_META[event.toStatus].dotClass}`} aria-hidden="true" />
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  <span className="font-semibold text-gray-900">{SALES_CUSTOMER_STATUS_META[event.toStatus].label}</span>
                  <span className="text-gray-400">へ更新</span>
                </div>
                <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-5 text-gray-700">{event.summary}</p>
                <p className="mt-1 text-[11px] text-gray-400">
                  {formatSalesCustomerDate(event.createdAt)}{event.actorName ? ` · ${event.actorName}` : ''}
                </p>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  )
}

export default function SalesCustomersPage() {
  const { selectedAccountId, selectedAccount, loading: accountLoading } = useAccount()
  const [items, setItems] = useState<SalesCustomer[]>([])
  const [counts, setCounts] = useState<Record<SalesCustomerStatus, number>>(EMPTY_COUNTS)
  const [total, setTotal] = useState(0)
  const [hasNextPage, setHasNextPage] = useState(false)
  const [canEditStatus, setCanEditStatus] = useState(false)
  const [filter, setFilter] = useState<StatusFilter>('action_required')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [detail, setDetail] = useState<SalesCustomerDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false)
  const [editStatus, setEditStatus] = useState<SalesCustomerStoredStatus | ''>('')
  const [editSummary, setEditSummary] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveMessage, setSaveMessage] = useState('')
  const [overviewBatchRunning, setOverviewBatchRunning] = useState(false)
  const [overviewBatchPreview, setOverviewBatchPreview] = useState<{
    accountId: string
    summary: OverviewBatchSummary
  } | null>(null)
  const [overviewBatchMessage, setOverviewBatchMessage] = useState('')
  const listRequestRef = useRef(0)
  const detailRequestRef = useRef(0)
  const saveRequestRef = useRef(0)
  const overviewBatchRequestRef = useRef(0)

  const loadCustomers = useCallback(async () => {
    const requestId = ++listRequestRef.current
    if (!selectedAccountId) {
      setItems([])
      setCounts(EMPTY_COUNTS)
      setTotal(0)
      setHasNextPage(false)
      setLoading(false)
      return
    }
    setLoading(true)
    setError('')
    try {
      const response = await api.salesCustomers.list({
        lineAccountId: selectedAccountId,
        q: search || undefined,
        status: filter === 'all' ? undefined : filter,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      })
      if (requestId !== listRequestRef.current) return
      if (!response.success) throw new Error(response.error)
      setItems(response.data.items)
      setCounts(response.data.counts)
      setTotal(response.data.total)
      setHasNextPage(response.data.hasNextPage)
      setCanEditStatus(response.data.canEditStatus)
    } catch {
      if (requestId !== listRequestRef.current) return
      setError('顧客状況の読み込みに失敗しました。もう一度お試しください。')
      setItems([])
    } finally {
      if (requestId === listRequestRef.current) setLoading(false)
    }
  }, [filter, page, search, selectedAccountId])

  const loadDetail = useCallback(async (customer: Pick<SalesCustomer, 'subjectKind' | 'subjectId'>) => {
    const requestId = ++detailRequestRef.current
    setSelectedKey(customerKey(customer))
    setDetailLoading(true)
    setDetail(null)
    setSaveMessage('')
    try {
      const response = await api.salesCustomers.get(customer.subjectKind, customer.subjectId)
      if (requestId !== detailRequestRef.current) return
      if (!response.success) throw new Error(response.error)
      setDetail(response.data)
      setEditStatus(salesCustomerDraftStatus(response.data.status))
      setEditSummary(response.data.summary)
    } catch {
      if (requestId !== detailRequestRef.current) return
      setSaveMessage('顧客詳細の読み込みに失敗しました。')
    } finally {
      if (requestId === detailRequestRef.current) setDetailLoading(false)
    }
  }, [])

  useEffect(() => {
    listRequestRef.current += 1
    detailRequestRef.current += 1
    saveRequestRef.current += 1
    setPage(0)
    setSelectedKey(null)
    setDetail(null)
    setMobileDetailOpen(false)
    setEditStatus('')
    setEditSummary('')
    setSaving(false)
    setSaveMessage('')
    overviewBatchRequestRef.current += 1
    setOverviewBatchRunning(false)
    setOverviewBatchPreview(null)
    setOverviewBatchMessage('')
  }, [selectedAccountId])

  useEffect(() => {
    void loadCustomers()
  }, [loadCustomers])

  const actionRequired = useMemo(() => salesActionRequiredCount(counts), [counts])
  const filteredOut = detail !== null && !items.some((item) => customerKey(item) === customerKey(detail))

  const changeFilter = (nextFilter: StatusFilter) => {
    setFilter(nextFilter)
    setPage(0)
  }

  const handleSearch = (event: React.FormEvent) => {
    event.preventDefault()
    setSearch(searchInput.trim())
    setPage(0)
  }

  const openDetail = (customer: SalesCustomer) => {
    saveRequestRef.current += 1
    setSaving(false)
    setMobileDetailOpen(true)
    void loadDetail(customer)
  }

  const saveStatus = async () => {
    if (!detail || !detail.canEditStatus || saving || !editStatus || !editSummary.trim()) return
    const requestId = ++saveRequestRef.current
    const targetDetail = detail
    setSaving(true)
    setSaveMessage('')
    try {
      const response = await api.salesCustomers.updateStatus(targetDetail.subjectKind, targetDetail.subjectId, {
        status: editStatus,
        summary: editSummary.trim(),
        expectedVersion: targetDetail.version,
      })
      if (requestId !== saveRequestRef.current) return
      if (!response.success) throw new Error(response.error)
      await Promise.all([loadCustomers(), loadDetail(targetDetail)])
      if (requestId !== saveRequestRef.current) return
      setSaveMessage('状況を更新しました。')
    } catch (caught) {
      if (requestId !== saveRequestRef.current) return
      if (caught instanceof ApiRequestError && caught.status === 409) {
        await Promise.all([loadCustomers(), loadDetail(targetDetail)])
        if (requestId !== saveRequestRef.current) return
        setSaveMessage('他の担当者が先に更新しました。最新状況を読み直しました。')
      } else {
        setSaveMessage('状況の保存に失敗しました。もう一度お試しください。')
      }
    } finally {
      if (requestId === saveRequestRef.current) setSaving(false)
    }
  }

  const runOverviewBatch = async (lineAccountId: string, dryRun: boolean): Promise<OverviewBatchSummary> => {
    let offset = 0
    let summary: OverviewBatchSummary = {
      total: 0,
      processed: 0,
      create: 0,
      update: 0,
      unchanged: 0,
      written: 0,
      aiRequests: 0,
      noText: 0,
      inputChars: 0,
      inputTokens: 0,
      aiGenerated: 0,
      noTextWritten: 0,
      aiAttempts: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      failed: 0,
      aiUnavailable: 0,
      invalidAiResponse: 0,
      statusRowsTouched: 0,
    }
    for (;;) {
      const response = await api.salesCustomers.generateOverviews({
        lineAccountId,
        dryRun,
        limit: OVERVIEW_BATCH_SIZE,
        offset,
        confirm: dryRun ? undefined : 'generate_sales_customer_overviews',
      })
      if (!response.success) throw new Error(response.error)
      summary = addOverviewBatchPage(summary, response.data)
      if (response.data.statusRowsTouched !== 0) throw new Error('unexpected_status_mutation')
      if (!response.data.hasNextPage || response.data.nextOffset == null) break
      if (response.data.nextOffset <= offset) throw new Error('invalid_next_offset')
      offset = response.data.nextOffset
    }
    return summary
  }

  const previewOverviewBatch = async () => {
    if (!selectedAccountId || overviewBatchRunning) return
    const requestId = ++overviewBatchRequestRef.current
    const targetAccountId = selectedAccountId
    setOverviewBatchRunning(true)
    setOverviewBatchPreview(null)
    setOverviewBatchMessage('対象件数を確認しています...')
    try {
      const summary = await runOverviewBatch(targetAccountId, true)
      if (requestId !== overviewBatchRequestRef.current) return
      setOverviewBatchPreview({ accountId: targetAccountId, summary })
      setOverviewBatchMessage(
        `${summary.total.toLocaleString('ja-JP')}件を確認しました。新規${summary.create.toLocaleString('ja-JP')}件、更新${summary.update.toLocaleString('ja-JP')}件、変更なし${summary.unchanged.toLocaleString('ja-JP')}件。AI要約予定${summary.aiRequests.toLocaleString('ja-JP')}件、要約対象テキストなし${summary.noText.toLocaleString('ja-JP')}件、推定入力${summary.inputTokens.toLocaleString('ja-JP')}トークンです。`,
      )
    } catch {
      if (requestId === overviewBatchRequestRef.current) {
        setOverviewBatchMessage('更新対象の確認に失敗しました。もう一度お試しください。')
      }
    } finally {
      if (requestId === overviewBatchRequestRef.current) setOverviewBatchRunning(false)
    }
  }

  const generateOverviewBatch = async () => {
    if (!selectedAccountId || overviewBatchRunning || !overviewBatchPreview) return
    if (overviewBatchPreview.accountId !== selectedAccountId) return
    const changeCount = overviewBatchPreview.summary.create + overviewBatchPreview.summary.update
    if (changeCount === 0) return
    const confirmed = window.confirm(
      `${accountName}の最近の状況を${changeCount.toLocaleString('ja-JP')}件更新します。うち${overviewBatchPreview.summary.aiRequests.toLocaleString('ja-JP')}件は、識別情報を伏せた会話をCloudflare Workers AIで処理します。推定入力は${overviewBatchPreview.summary.inputTokens.toLocaleString('ja-JP')}トークンです。営業ステータスは変更しません。続けますか？`,
    )
    if (!confirmed) return

    const requestId = ++overviewBatchRequestRef.current
    const targetAccountId = selectedAccountId
    setOverviewBatchRunning(true)
    setOverviewBatchMessage('最近の状況を更新しています。この画面を閉じずにお待ちください...')
    try {
      const summary = await runOverviewBatch(targetAccountId, false)
      if (requestId !== overviewBatchRequestRef.current) return
      if (summary.statusRowsTouched !== 0) throw new Error('unexpected_status_mutation')
      setOverviewBatchPreview(null)
      setOverviewBatchMessage(summary.failed > 0
        ? `${summary.written.toLocaleString('ja-JP')}件を保存し、${summary.failed.toLocaleString('ja-JP')}件はAI要約に失敗しました。営業ステータスは変更していません。更新対象を再確認してください。`
        : `${summary.written.toLocaleString('ja-JP')}件の会話要約と更新履歴を保存しました。営業ステータスは変更していません。`)
      await loadCustomers()
      if (detail) await loadDetail(detail)
    } catch {
      if (requestId === overviewBatchRequestRef.current) {
        setOverviewBatchMessage('一括更新に失敗しました。再度対象件数を確認してからお試しください。')
        setOverviewBatchPreview(null)
      }
    } finally {
      if (requestId === overviewBatchRequestRef.current) setOverviewBatchRunning(false)
    }
  }

  const accountName = selectedAccount?.displayName || selectedAccount?.name || 'LINEアカウント'
  const overviewChangeCount = overviewBatchPreview
    ? overviewBatchPreview.summary.create + overviewBatchPreview.summary.update
    : 0

  return (
    <div>
      <Header
        title="顧客状況"
        description={`${accountName} · 連絡前にクレーム・退会リスクを確認`}
      />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(340px,420px)] lg:items-start">
        <div className="min-w-0 space-y-4">
          <section className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="顧客状況の集計">
            <SummaryButton label="要確認" count={actionRequired} tone="risk" active={filter === 'action_required'} onClick={() => changeFilter('action_required')} />
            <SummaryButton label="クレーム" count={counts.complaint} tone="complaint" active={filter === 'complaint'} onClick={() => changeFilter('complaint')} />
            <SummaryButton label="退会手続き中" count={counts.exit_pending} tone="exit" active={filter === 'exit_pending'} onClick={() => changeFilter('exit_pending')} />
            <SummaryButton label="通常運用" count={counts.normal} tone="normal" active={filter === 'normal'} onClick={() => changeFilter('normal')} />
          </section>

          {canEditStatus && (
            <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm" aria-label="最近の状況の一括更新">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <h2 className="text-sm font-bold text-gray-900">最近の状況を全件更新</h2>
                  <p className="mt-1 text-xs leading-5 text-gray-500">
                    直近の人同士のテキストから、相談内容・対応経緯・現在地・次の対応をAIで要約します。識別情報は送信前に伏せ、原文は保存しません。営業ステータスは変更しません。
                  </p>
                  {overviewBatchMessage && (
                    <p className={`mt-2 text-xs leading-5 ${overviewBatchMessage.includes('失敗') ? 'text-red-600' : 'text-gray-700'}`} role="status">
                      {overviewBatchMessage}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void previewOverviewBatch()}
                    disabled={overviewBatchRunning}
                    className="min-h-10 rounded-lg border border-gray-300 bg-white px-3 text-xs font-semibold text-gray-700 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {overviewBatchRunning && !overviewBatchPreview ? '確認中...' : '更新対象を確認'}
                  </button>
                  {overviewBatchPreview && overviewChangeCount > 0 && (
                    <button
                      type="button"
                      onClick={() => void generateOverviewBatch()}
                      disabled={overviewBatchRunning}
                      className="min-h-10 rounded-lg bg-[#06C755] px-3 text-xs font-bold text-white hover:bg-[#05b94f] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-gray-200"
                    >
                      {overviewBatchRunning ? 'AIで要約中...' : `${overviewChangeCount.toLocaleString('ja-JP')}件を要約`}
                    </button>
                  )}
                </div>
              </div>
            </section>
          )}

          <details className="group rounded-xl border border-gray-200 bg-white shadow-sm">
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-semibold text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-green-500">
              <span>状況の判定基準を見る</span>
              <svg className="h-4 w-4 text-gray-400 transition-transform group-open:rotate-180" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="m6 9 6 6 6-6" />
              </svg>
            </summary>
            <div className="grid gap-2 border-t border-gray-100 p-4 sm:grid-cols-2">
              {(Object.keys(SALES_CUSTOMER_STATUS_META) as SalesCustomerStatus[]).map((status) => (
                <div key={status} className="rounded-lg bg-gray-50 px-3 py-3">
                  <StatusBadge status={status} />
                  <p className="mt-2 text-xs leading-5 text-gray-600">{SALES_CUSTOMER_STATUS_META[status].definition}</p>
                </div>
              ))}
            </div>
          </details>

          <section className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
            <div className="border-b border-gray-200 p-3 sm:p-4">
              <form onSubmit={handleSearch} className="flex gap-2">
                <label className="relative min-w-0 flex-1">
                  <span className="sr-only">顧客を検索</span>
                  <svg className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="m21 21-4.35-4.35m2.35-5.65a8 8 0 11-16 0 8 8 0 0116 0Z" />
                  </svg>
                  <input
                    type="search"
                    value={searchInput}
                    onChange={(event) => {
                      setSearchInput(event.target.value)
                      if (!event.target.value && search) {
                        setSearch('')
                        setPage(0)
                      }
                    }}
                    placeholder="会社名・担当者・顧客番号で検索"
                    className="min-h-11 w-full rounded-lg border border-gray-300 py-2 pl-9 pr-3 text-sm outline-none focus:border-green-500 focus:ring-2 focus:ring-green-100"
                  />
                </label>
                <button type="submit" className="min-h-11 shrink-0 rounded-lg border border-gray-300 bg-white px-4 text-sm font-semibold text-gray-700 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500">検索</button>
              </form>
              <div className="mt-3 flex gap-2 overflow-x-auto pb-1" aria-label="状況で絞り込み">
                {FILTERS.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => changeFilter(item.value)}
                    aria-pressed={filter === item.value}
                    className={`min-h-9 shrink-0 rounded-full border px-3 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 ${filter === item.value ? 'border-gray-900 bg-gray-900 text-white' : 'border-gray-200 bg-white text-gray-600 hover:border-gray-400'}`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex min-h-11 items-center justify-between gap-3 border-b border-gray-100 bg-gray-50 px-4 py-2 text-xs text-gray-500">
              <span>{loading ? '読み込み中...' : `${total.toLocaleString('ja-JP')}件`}</span>
              {canEditStatus && <span>行を開いて運営状況を更新</span>}
            </div>

            {error ? (
              <div className="p-8 text-center">
                <p className="text-sm text-red-700">{error}</p>
                <button type="button" onClick={() => void loadCustomers()} className="mt-3 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50">再読み込み</button>
              </div>
            ) : loading ? (
              <div className="divide-y divide-gray-100" aria-label="顧客一覧を読み込み中">
                {Array.from({ length: 6 }, (_, index) => (
                  <div key={index} className="grid grid-cols-[1fr_auto] gap-3 p-4">
                    <div className="space-y-2"><div className="h-4 w-40 animate-pulse rounded bg-gray-200" /><div className="h-3 w-64 max-w-full animate-pulse rounded bg-gray-100" /></div>
                    <div className="h-7 w-24 animate-pulse rounded-full bg-gray-100" />
                  </div>
                ))}
              </div>
            ) : items.length === 0 ? (
              <div className="p-10 text-center">
                <p className="text-sm font-semibold text-gray-700">条件に合う顧客はいません</p>
                <p className="mt-1 text-xs text-gray-500">絞り込みまたは検索条件を変えてください。</p>
              </div>
            ) : (
              <div className="divide-y divide-gray-100">
                {items.map((customer) => {
                  const active = selectedKey === customerKey(customer)
                  return (
                    <button
                      key={customerKey(customer)}
                      type="button"
                      onClick={() => openDetail(customer)}
                      className={`grid w-full gap-3 px-4 py-4 text-left transition-colors focus-visible:relative focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-green-500 sm:grid-cols-[minmax(180px,1.1fr)_auto_minmax(180px,1fr)_90px] sm:items-center ${active ? 'bg-green-50/70' : 'hover:bg-gray-50'}`}
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-bold text-gray-950">{salesCustomerName(customer)}</p>
                        <p className="mt-1 truncate text-xs text-gray-500">{salesCustomerIdentity(customer) || salesCustomerSourceLabel(customer)}</p>
                      </div>
                      <div><StatusBadge status={customer.status} /></div>
                      <div className="min-w-0">
                        <p className="line-clamp-2 text-xs leading-5 text-gray-600">
                          {customer.recentOverview.text}
                        </p>
                        <p className="mt-1 truncate text-[10px] text-gray-400">
                          直近3か月: 顧客 {customer.activity.windows.threeMonths.customerMessages}件 · 担当返信 {customer.activity.windows.threeMonths.staffReplies}件
                        </p>
                      </div>
                      <div className="flex items-center justify-between gap-2 text-[11px] text-gray-400 sm:justify-end">
                        <span>{formatSalesCustomerDate(customer.activity.lastContactAt)}</span>
                        <svg className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="m9 18 6-6-6-6" /></svg>
                      </div>
                    </button>
                  )
                })}
              </div>
            )}

            {(page > 0 || hasNextPage) && (
              <div className="flex items-center justify-between border-t border-gray-200 px-4 py-3">
                <button type="button" disabled={page === 0 || loading} onClick={() => setPage((value) => Math.max(0, value - 1))} className="min-h-10 rounded-lg border border-gray-300 bg-white px-3 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40">前へ</button>
                <span className="text-xs text-gray-500">{page + 1}ページ</span>
                <button type="button" disabled={!hasNextPage || loading} onClick={() => setPage((value) => value + 1)} className="min-h-10 rounded-lg border border-gray-300 bg-white px-3 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40">次へ</button>
              </div>
            )}
          </section>
        </div>

        <aside className={`${mobileDetailOpen ? 'fixed inset-0 z-50 flex flex-col bg-white pt-[env(safe-area-inset-top)]' : 'hidden'} lg:sticky lg:top-8 lg:flex lg:max-h-[calc(100dvh-4rem)] lg:flex-col lg:overflow-hidden lg:rounded-xl lg:border lg:border-gray-200 lg:bg-white lg:pt-0 lg:shadow-sm`} aria-label="顧客状況の詳細">
          <div className="flex min-h-14 shrink-0 items-center justify-between border-b border-gray-200 px-4 lg:hidden">
            <p className="text-sm font-bold text-gray-900">顧客詳細</p>
            <button type="button" onClick={() => setMobileDetailOpen(false)} className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100" aria-label="顧客詳細を閉じる">
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18 18 6M6 6l12 12" /></svg>
            </button>
          </div>
          {filteredOut && detail && (
            <p className="shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">更新後の状況は、現在の絞り込み対象外です。</p>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto">
            <DetailContent
              detail={detail}
              loading={detailLoading}
              editStatus={editStatus}
              editSummary={editSummary}
              saving={saving}
              saveMessage={saveMessage}
              onStatusChange={setEditStatus}
              onSummaryChange={setEditSummary}
              onSave={() => void saveStatus()}
            />
          </div>
        </aside>
      </div>

      {!accountLoading && !selectedAccountId && (
        <div className="mt-4 rounded-xl border border-gray-200 bg-white p-8 text-center text-sm text-gray-600">表示できるLINEアカウントがありません。</div>
      )}
    </div>
  )
}

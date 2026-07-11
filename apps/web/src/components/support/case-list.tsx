'use client'

import type { SupportCase } from '@/lib/api'
import {
  caseSortOptions,
  categoryLabel,
  formatElapsed,
  formatRelativeDue,
  dueUrgency,
  isOverdueCase,
  isStaleCase,
  priorityClass,
  priorityLabel,
  statusClass,
  statusLabel,
  statusOptions,
  type CaseSortMode,
  type SupportEmptyState,
} from './support-meta'
import { SearchIcon, XIcon, inputCls, selectCls } from './support-ui'

interface CaseListProps {
  cases: SupportCase[]
  loading: boolean
  selectedCaseId: string | null
  statusFilter: string
  sortMode: CaseSortMode
  search: string
  emptyState: SupportEmptyState
  disabled?: boolean
  onSelect: (id: string) => void
  onStatusFilterChange: (value: string) => void
  onSortChange: (value: CaseSortMode) => void
  onSearchChange: (value: string) => void
  onResetFilters: () => void
}

function CaseListSkeleton() {
  return (
    <div className="space-y-2 p-2" aria-hidden="true">
      {[...Array(4)].map((_, i) => (
        <div
          key={i}
          className="animate-pulse rounded-lg border border-slate-200 bg-white px-3 py-3"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="h-4 w-36 rounded bg-gray-200" />
            <div className="h-5 w-16 rounded-full bg-gray-100" />
          </div>
          <div className="mt-2 h-3 w-28 rounded bg-gray-100" />
          <div className="mt-2 h-3 w-48 rounded bg-gray-100" />
        </div>
      ))}
    </div>
  )
}

function ticketShortId(id: string): string {
  const normalized = id.replace(/-/g, '').trim()
  return normalized ? normalized.slice(0, 6).toUpperCase() : 'NEW'
}

function CaseRow({
  item,
  selected,
  disabled,
  onSelect,
}: {
  item: SupportCase
  selected: boolean
  disabled: boolean
  onSelect: (id: string) => void
}) {
  const overdue = isOverdueCase(item)
  const stale = isStaleCase(item)
  const urgency = dueUrgency(item.dueAt)
  const customerName = item.friendName || item.companyName || item.contactName || '顧客未紐付け'
  const primaryAssigneeName = item.primaryAssignee || '一次未設定'
  const secondaryAssigneeName = item.escalationAssignee?.trim() || '二次未設定'
  const hasSecondaryAssignee = Boolean(item.escalationAssignee?.trim())
  const hasSecondaryAnswer = item.status === 'secondary_answered'
  const showPriority = item.priority === 'urgent' || item.priority === 'high'
  const dueTone =
    item.status === 'resolved'
      ? 'text-gray-400'
      : urgency === 'overdue'
        ? 'font-medium text-red-700'
        : urgency === 'soon'
          ? 'font-medium text-amber-700'
          : 'text-gray-500'
  const accentTone =
    item.priority === 'urgent' || overdue
      ? 'bg-red-500'
      : item.priority === 'high'
        ? 'bg-orange-500'
        : hasSecondaryAnswer
          ? 'bg-emerald-500'
          : item.status === 'escalated'
            ? 'bg-indigo-500'
            : item.status === 'resolved'
              ? 'bg-gray-300'
              : 'bg-slate-400'
  const rowTone = selected
    ? 'border-slate-400 bg-white ring-2 ring-slate-200'
    : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50/60'
  const displayId = item.customerNumber || ticketShortId(item.id)

  return (
    <button
      onClick={() => onSelect(item.id)}
      disabled={disabled}
      aria-current={selected ? 'true' : undefined}
      className={`group relative block w-full overflow-hidden rounded-md border px-3 py-3 text-left shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 ${rowTone} disabled:cursor-not-allowed disabled:opacity-60`}
    >
      <span aria-hidden="true" className={`absolute inset-y-0 left-0 w-1 ${accentTone}`} />

      <div className="min-w-0 pl-2.5">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-[15px] font-semibold leading-5 text-slate-900">{item.title || '件名未設定'}</p>
            <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-slate-500">
              <span className="shrink-0 font-medium">#{displayId}</span>
              <span className="h-3 w-px bg-slate-200" aria-hidden="true" />
              <span className="truncate">{categoryLabel[item.category] || item.category}</span>
            </div>
          </div>
          <p className="shrink-0 text-right text-[11px] font-medium text-slate-400">{formatElapsed(item.updatedAt)}</p>
        </div>

        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5">
          <span className={`inline-flex max-w-full items-center rounded-md border px-2 py-1 text-[11px] font-medium leading-none ${statusClass[item.status]}`}>
            <span className="truncate">{statusLabel[item.status]}</span>
          </span>
          {showPriority && (
            <span className={`inline-flex max-w-full items-center rounded-md border px-1.5 py-1 text-[11px] font-medium leading-none ${priorityClass[item.priority]}`}>
              <span className="truncate">{priorityLabel[item.priority]}</span>
            </span>
          )}
          {hasSecondaryAnswer && (
            <span className="shrink-0 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-[11px] font-medium leading-none text-emerald-800">
              一次確認へ
            </span>
          )}
        </div>

        <div className="mt-2 grid gap-1.5 text-[11px] leading-4 text-slate-500">
          <div className="grid min-w-0 grid-cols-[42px_minmax(0,1fr)] items-center gap-1">
            <span className="text-slate-400">顧客</span>
            <span className="truncate font-medium text-slate-800">{customerName}</span>
          </div>
          <div className="grid min-w-0 grid-cols-[42px_minmax(0,1fr)] items-center gap-1">
            <span className="text-slate-400">一次</span>
            <span className="truncate font-medium text-slate-700">{primaryAssigneeName}</span>
          </div>
          <div className="grid min-w-0 grid-cols-[42px_minmax(0,1fr)] items-center gap-1">
            <span className="text-slate-400">二次</span>
            <span className={`truncate font-medium ${hasSecondaryAssignee ? 'text-indigo-700' : 'text-slate-500'}`}>
              {secondaryAssigneeName}
            </span>
          </div>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
          {item.dueAt && (
            <span className={`rounded-md bg-slate-50 px-2 py-0.5 ${dueTone}`}>期限 {formatRelativeDue(item.dueAt)}</span>
          )}
          {overdue && <span className="rounded-md bg-red-50 px-2 py-0.5 font-medium text-red-700">期限超過</span>}
          {stale && !overdue && <span className="rounded-md bg-amber-50 px-2 py-0.5 font-medium text-amber-700">24h滞留</span>}
        </div>
      </div>
    </button>
  )
}

/**
 * チケット一覧。検索は入力後に自動適用 (デバウンスは親側)。
 * ↑↓ / j k キーでも選択を移動できる (親でハンドリング)。
 */
export default function CaseList({
  cases,
  loading,
  selectedCaseId,
  statusFilter,
  sortMode,
  search,
  emptyState,
  disabled = false,
  onSelect,
  onStatusFilterChange,
  onSortChange,
  onSearchChange,
  onResetFilters,
}: CaseListProps) {
  const quickTabs = [
    { value: 'all', label: 'すべて', count: cases.length },
    { value: 'in_progress', label: '対応中', count: cases.filter((item) => item.status === 'in_progress').length },
    { value: 'resolved', label: '完了', count: cases.filter((item) => item.status === 'resolved').length },
  ]

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white" aria-label="チケット一覧">
      <div className="border-b border-slate-200 bg-white p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-gray-900">チケット一覧</h2>
            <p className="mt-0.5 text-[11px] text-slate-500">選択して右側で詳細確認</p>
          </div>
          <span className="rounded-md bg-white px-2.5 py-1 text-xs font-medium text-gray-700 shadow-sm ring-1 ring-gray-200">
            {loading ? '更新中' : `${cases.length}件`}
          </span>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {quickTabs.map((item) => (
            <button
              key={item.value}
              type="button"
              onClick={() => onStatusFilterChange(item.value)}
              disabled={disabled}
              className={`rounded-md px-2 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                statusFilter === item.value
                  ? 'bg-blue-50 text-blue-700 shadow-sm ring-1 ring-blue-200'
                  : 'text-slate-500 hover:bg-slate-50 hover:text-slate-800'
              }`}
              aria-pressed={statusFilter === item.value}
            >
              {item.label} <span className="ml-1 text-xs font-medium">{item.count}</span>
            </button>
          ))}
        </div>

        <div className="mt-2 grid gap-2">
          <div className="relative">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            disabled={disabled}
            className={`${inputCls} pl-9 ${search ? 'pr-8' : ''}`}
            placeholder="チケット名・顧客名・顧客番号・法人名で検索"
            aria-label="チケットを検索"
          />
          {search && (
            <button
              type="button"
              onClick={() => onSearchChange('')}
              disabled={disabled}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
              aria-label="検索をクリア"
            >
              <XIcon className="h-3.5 w-3.5" />
            </button>
          )}
          </div>
          <select
            value={statusFilter}
            onChange={(e) => onStatusFilterChange(e.target.value)}
            disabled={disabled}
            className={selectCls}
            aria-label="ステータスで絞り込み"
          >
            <option value="all">未完了すべて</option>
            {statusOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
          <select
            value={sortMode}
            onChange={(e) => onSortChange(e.target.value as CaseSortMode)}
            disabled={disabled}
            className={selectCls}
            aria-label="並び替え"
          >
            {caseSortOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </div>
      </div>

      <div className="min-h-[420px] flex-1 overflow-y-auto overscroll-contain bg-slate-50/50 p-2.5 lg:min-h-0">
        {loading && cases.length === 0 ? (
          <CaseListSkeleton />
        ) : cases.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <p className="text-sm font-medium text-gray-600">{emptyState.title}</p>
            <p className="mt-1 text-xs leading-relaxed text-gray-400">{emptyState.description}</p>
            {emptyState.actionLabel && (
              <button
                type="button"
                onClick={onResetFilters}
                disabled={disabled}
                className="mt-3 rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {emptyState.actionLabel}
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-2.5">
            {cases.map((item) => (
              <CaseRow key={item.id} item={item} selected={selectedCaseId === item.id} disabled={disabled} onSelect={onSelect} />
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

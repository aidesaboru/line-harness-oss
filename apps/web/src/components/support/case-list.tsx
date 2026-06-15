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
import { FlameIcon, Pill, SearchIcon, XIcon, inputCls, selectCls } from './support-ui'

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
    <div aria-hidden="true">
      {[...Array(4)].map((_, i) => (
        <div key={i} className="animate-pulse border-b border-gray-100 px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <div className="h-3.5 w-40 rounded bg-gray-200" />
            <div className="h-4 w-10 rounded bg-gray-100" />
          </div>
          <div className="mt-2 flex gap-1.5">
            <div className="h-4 w-14 rounded bg-gray-100" />
            <div className="h-4 w-16 rounded bg-gray-100" />
          </div>
          <div className="mt-2 h-3 w-32 rounded bg-gray-100" />
        </div>
      ))}
    </div>
  )
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
  const assigneeName = item.primaryAssignee || '担当者なし'
  const summary = item.customerSummary?.trim() || item.internalNote?.trim() || item.customerReplyDraft?.trim()
  const dueTone =
    item.status === 'resolved'
      ? 'text-gray-400'
      : urgency === 'overdue'
        ? 'font-semibold text-red-700'
        : urgency === 'soon'
          ? 'font-semibold text-amber-700'
          : 'text-gray-500'

  return (
    <button
      onClick={() => onSelect(item.id)}
      disabled={disabled}
      aria-current={selected ? 'true' : undefined}
      className={`block w-full border-b border-l-4 border-gray-100 px-3 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-green-500 ${
        overdue
          ? 'border-l-red-500 bg-red-50/70 hover:bg-red-50'
          : stale
            ? 'border-l-orange-500 bg-orange-50/70 hover:bg-orange-50'
            : 'border-l-transparent hover:bg-gray-50'
      } ${selected ? 'border-l-green-600 bg-green-50 ring-1 ring-inset ring-green-300' : ''} disabled:cursor-not-allowed disabled:opacity-60`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Pill className={statusClass[item.status]}>{statusLabel[item.status]}</Pill>
          <Pill className={priorityClass[item.priority]}>{priorityLabel[item.priority]}</Pill>
        </div>
        <span className="shrink-0 text-[11px] text-gray-400">更新 {formatElapsed(item.updatedAt)}</span>
      </div>

      <p className="mt-2 break-words text-sm font-semibold leading-5 text-gray-900">{item.title}</p>

      {summary && (
        <p className="mt-1 max-h-10 overflow-hidden break-words text-xs leading-5 text-gray-500">
          {summary}
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {overdue && <Pill className="border-red-200 bg-red-100 text-red-700">期限超過</Pill>}
        {stale && !overdue && (
          <Pill className="border-orange-200 bg-white text-orange-700">
            <FlameIcon className="mr-1 h-3 w-3" />
            24h滞留 {formatElapsed(item.updatedAt)}
          </Pill>
        )}
        {!item.primaryAssignee && item.status !== 'resolved' && (
          <Pill className="border-amber-200 bg-amber-50 text-amber-700">担当者なし</Pill>
        )}
        <Pill className="border-gray-200 bg-gray-50 text-gray-600">{categoryLabel[item.category] || item.category}</Pill>
      </div>

      <div className="mt-2 grid gap-1.5 text-xs text-gray-500 sm:grid-cols-2">
        <span className="min-w-0 rounded-md bg-white/70 px-2 py-1">
          <span className="mr-1 text-gray-400">顧客</span>
          <span className="font-medium text-gray-700">{customerName}</span>
        </span>
        <span className="min-w-0 rounded-md bg-white/70 px-2 py-1">
          <span className="mr-1 text-gray-400">担当</span>
          <span className={`font-medium ${item.primaryAssignee ? 'text-gray-700' : 'text-amber-700'}`}>{assigneeName}</span>
        </span>
      </div>

      <div className="mt-2 flex items-center justify-between gap-2 text-xs text-gray-500">
        <span className="min-w-0 truncate">{item.storeName || item.contractType || ''}</span>
        {item.dueAt && (
          <span className={`shrink-0 rounded-md bg-white/80 px-2 py-1 ${dueTone}`}>期限 {formatRelativeDue(item.dueAt)}</span>
        )}
      </div>
    </button>
  )
}

/**
 * 案件一覧。検索は入力後に自動適用 (デバウンスは親側)。
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
  return (
    <section className="flex min-h-0 flex-col rounded-lg border border-gray-200 bg-white shadow-sm" aria-label="案件一覧">
      <div className="border-b border-gray-200 p-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-gray-900">案件一覧</h2>
          <span className="rounded-md bg-gray-100 px-2 py-1 text-xs font-semibold text-gray-600">
            {loading ? '更新中' : `${cases.length}件`}
          </span>
        </div>
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            disabled={disabled}
            className={`${inputCls} pl-9 ${search ? 'pr-8' : ''}`}
            placeholder="件名・要約・メモ・顧客名で検索"
            aria-label="案件を検索"
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
        <div className="mt-2 grid grid-cols-2 gap-2">
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
        <div className="mt-2 flex items-center justify-between text-[11px] text-gray-400">
          <span>{loading ? '読み込み中…' : '未完了を優先表示'}</span>
          <span className="hidden xl:inline">↑↓キーで移動</span>
        </div>
      </div>

      <div className="max-h-[520px] overflow-y-auto overscroll-contain lg:max-h-[calc(100vh-360px)] lg:min-h-[380px]">
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
          cases.map((item) => (
            <CaseRow key={item.id} item={item} selected={selectedCaseId === item.id} disabled={disabled} onSelect={onSelect} />
          ))
        )}
      </div>
    </section>
  )
}

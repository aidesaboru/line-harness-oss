'use client'

import type { SupportSummary } from '@/lib/api'

export type QueueKey =
  | 'all'
  | 'escalated'
  | 'secondary_answered'
  | 'primary_action'
  | 'waiting_customer'
  | 'resolved'

interface QueueChip {
  key: QueueKey
  label: string
  /** count > 0 のときに数字へ付ける強調色 */
  countCls: string
  activeCls: string
  /** 件数が0でも常時グレー表示にする (完了など参考値) */
  muted?: boolean
}

const chips: QueueChip[] = [
  { key: 'all', label: '未完了', countCls: 'text-slate-700', activeCls: 'border-slate-300 bg-slate-100 text-slate-900' },
  { key: 'escalated', label: '二次対応中', countCls: 'text-indigo-600', activeCls: 'border-indigo-200 bg-indigo-50 text-indigo-800' },
  { key: 'secondary_answered', label: '二次回答済み', countCls: 'text-emerald-600', activeCls: 'border-emerald-200 bg-emerald-50 text-emerald-800' },
  { key: 'primary_action', label: '対応中', countCls: 'text-amber-600', activeCls: 'border-amber-200 bg-amber-50 text-amber-800' },
  { key: 'waiting_customer', label: '顧客返信待ち', countCls: 'text-blue-600', activeCls: 'border-blue-200 bg-blue-50 text-blue-800' },
  { key: 'resolved', label: '完了済みチケット', countCls: 'text-gray-400', activeCls: 'border-slate-200 bg-slate-50 text-slate-600', muted: true },
]

interface QueueStripProps {
  summary: SupportSummary | null
  activeKey: QueueKey | null
  staffName: string
  staffRole: string
  disabled?: boolean
  onSelect: (key: QueueKey) => void
}

function chipCount(key: QueueKey, summary: SupportSummary | null): number {
  if (!summary) return 0
  switch (key) {
    case 'all': return summary.totals.open
    case 'escalated': return summary.totals.escalated
    case 'secondary_answered': return summary.totals.secondaryAnswered
    case 'primary_action': return summary.totals.primaryAction
    case 'waiting_customer': return summary.totals.waitingCustomer
    case 'resolved': return summary.totals.resolved
  }
}

/**
 * 作業状態の数字チップ。クリックで絞り込み、もう一度クリックで解除。
 * 日次確認の起点: 二次対応 → 二次回答済み → 対応中 → 顧客返信待ち。
 */
export default function QueueStrip({
  summary,
  activeKey,
  staffName,
  staffRole,
  disabled = false,
  onSelect,
}: QueueStripProps) {
  const canViewAllEscalations = staffRole === 'owner' || staffRole === 'admin'

  return (
    <div className="scrollbar-none -mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0" role="group" aria-label="チケットの状態">
      {chips.map((chip) => {
        const count = chipCount(chip.key, summary)
        const isActive = activeKey === chip.key
        const hasItems = count > 0 && !chip.muted
        return (
          <button
            key={chip.key}
            type="button"
            onClick={() => onSelect(chip.key)}
            disabled={disabled}
            aria-pressed={isActive}
            title={
              chip.key === 'escalated'
                ? canViewAllEscalations
                  ? '管理者に見えている二次対応中チケット'
                  : staffName
                    ? `${staffName} さんに見えている二次対応中のチケット`
                    : undefined
                : undefined
            }
            className={`group flex min-h-11 shrink-0 items-center justify-between gap-2 rounded-full border px-3 py-2 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 sm:min-w-[150px] sm:flex-1 sm:rounded-lg sm:px-4 sm:py-3 ${
              isActive
                ? `${chip.activeCls} shadow-sm ring-1 ring-inset ring-white/60`
                : 'border-slate-200 bg-white shadow-sm hover:border-slate-300 hover:bg-slate-50'
            } disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:shadow-none`}
          >
            <span className="flex flex-col">
              <span className={`flex items-center gap-1 text-xs font-medium sm:text-sm ${isActive ? '' : 'text-gray-700'}`}>
                {chip.label}
              </span>
            </span>
            <span
              className={`text-base font-semibold tabular-nums leading-none sm:text-2xl ${
                isActive ? '' : hasItems ? chip.countCls : 'text-gray-300'
              }`}
            >
              {count}
            </span>
          </button>
        )
      })}
    </div>
  )
}

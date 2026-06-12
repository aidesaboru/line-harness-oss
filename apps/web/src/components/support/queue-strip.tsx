'use client'

import type { SupportSummary } from '@/lib/api'
import { FlameIcon } from './support-ui'

export type QueueKey =
  | 'all'
  | 'escalated'
  | 'my_escalations'
  | 'overdue'
  | 'unassigned'
  | 'waiting_customer'
  | 'stale'
  | 'resolved'

interface QueueChip {
  key: QueueKey
  label: string
  /** count > 0 のときに数字へ付ける強調色 */
  countCls: string
  activeCls: string
  icon?: 'flame'
  /** 件数が0でも常時グレー表示にする (完了など参考値) */
  muted?: boolean
}

const chips: QueueChip[] = [
  { key: 'all', label: '未完了', countCls: 'text-gray-900', activeCls: 'border-gray-900 bg-gray-900 text-white' },
  { key: 'overdue', label: '期限超過', countCls: 'text-red-600', activeCls: 'border-red-600 bg-red-600 text-white' },
  { key: 'stale', label: '24h滞留', countCls: 'text-orange-600', activeCls: 'border-orange-500 bg-orange-500 text-white', icon: 'flame' },
  { key: 'unassigned', label: '担当者なし', countCls: 'text-amber-600', activeCls: 'border-amber-500 bg-amber-500 text-white' },
  { key: 'escalated', label: 'エスカレ', countCls: 'text-purple-600', activeCls: 'border-purple-600 bg-purple-600 text-white' },
  { key: 'my_escalations', label: '自分宛', countCls: 'text-green-600', activeCls: 'border-green-600 bg-green-600 text-white' },
  { key: 'waiting_customer', label: '顧客返信待ち', countCls: 'text-blue-600', activeCls: 'border-blue-600 bg-blue-600 text-white' },
  { key: 'resolved', label: '完了', countCls: 'text-gray-400', activeCls: 'border-gray-500 bg-gray-500 text-white', muted: true },
]

interface QueueStripProps {
  summary: SupportSummary | null
  staleCount: number
  activeKey: QueueKey | null
  staffName: string
  onSelect: (key: QueueKey) => void
}

function chipCount(key: QueueKey, summary: SupportSummary | null, staleCount: number): number {
  if (!summary) return 0
  switch (key) {
    case 'all': return summary.totals.open
    case 'escalated': return summary.totals.escalated
    case 'my_escalations': return summary.totals.myEscalations
    case 'overdue': return summary.totals.overdue
    case 'unassigned': return summary.totals.unassigned
    case 'waiting_customer': return summary.totals.waitingCustomer
    case 'stale': return staleCount
    case 'resolved': return summary.totals.resolved
  }
}

/**
 * 優先キューの数字チップ。クリックで絞り込み、もう一度クリックで解除。
 * 日次確認の起点: 期限超過 → 24h滞留 → 担当者なし → エスカレ → 自分宛。
 */
export default function QueueStrip({ summary, staleCount, activeKey, staffName, onSelect }: QueueStripProps) {
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="優先キュー">
      {chips.map((chip) => {
        const count = chipCount(chip.key, summary, staleCount)
        const isActive = activeKey === chip.key
        const hasItems = count > 0 && !chip.muted
        return (
          <button
            key={chip.key}
            type="button"
            onClick={() => onSelect(chip.key)}
            aria-pressed={isActive}
            title={chip.key === 'my_escalations' && staffName ? `${staffName} 宛の未完了エスカレ` : undefined}
            className={`group flex min-w-[96px] flex-1 items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 sm:flex-none ${
              isActive
                ? `${chip.activeCls} shadow-sm`
                : 'border-gray-200 bg-white hover:border-gray-300 hover:shadow-sm'
            }`}
          >
            <span className="flex flex-col">
              <span className={`flex items-center gap-1 text-[11px] font-semibold ${isActive ? 'text-white/90' : 'text-gray-500'}`}>
                {chip.icon === 'flame' && <FlameIcon className="h-3 w-3" />}
                {chip.label}
              </span>
              {chip.key === 'my_escalations' && staffName && (
                <span className={`max-w-[88px] truncate text-[10px] ${isActive ? 'text-white/70' : 'text-gray-400'}`}>
                  {staffName}
                </span>
              )}
            </span>
            <span
              className={`text-xl font-bold tabular-nums leading-none ${
                isActive ? 'text-white' : hasItems ? chip.countCls : 'text-gray-300'
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

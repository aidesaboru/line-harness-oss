'use client'

import { useState } from 'react'
import type { SupportManual } from '@/lib/api'
import { categoryLabel, categoryOptions } from './support-meta'
import { Pill, SearchIcon, XIcon, inputCls, selectCls } from './support-ui'

interface ManualPanelProps {
  manuals: SupportManual[]
  linkedManuals: SupportManual[]
  linkedIds: string[]
  canLink: boolean
  saving: boolean
  search: string
  category: string
  onSearchChange: (value: string) => void
  onCategoryChange: (value: string) => void
  onLink: (manual: SupportManual) => void
  onUnlink: (manual: SupportManual) => void
}

function ManualBody({ body }: { body: string }) {
  const [expanded, setExpanded] = useState(false)
  const isLong = body.length > 140
  return (
    <div>
      <p className={`mt-2 whitespace-pre-wrap break-words text-sm text-gray-600 ${expanded ? '' : 'line-clamp-3'}`}>
        {body}
      </p>
      {isLong && (
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          className="mt-1 text-xs font-medium text-gray-400 transition-colors hover:text-gray-600"
        >
          {expanded ? '閉じる' : 'もっと見る'}
        </button>
      )}
    </div>
  )
}

/**
 * 対応マニュアル欄。検索は入力で自動適用。
 * 選択中の案件に紐付け済みのマニュアルを上部に表示し、ワンクリックで解除できる。
 */
export default function ManualPanel({
  manuals,
  linkedManuals,
  linkedIds,
  canLink,
  saving,
  search,
  category,
  onSearchChange,
  onCategoryChange,
  onLink,
  onUnlink,
}: ManualPanelProps) {
  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4" aria-label="対応マニュアル">
      <h3 className="text-sm font-semibold text-gray-900">マニュアル</h3>

      {canLink && linkedManuals.length > 0 && (
        <div className="mt-3 rounded-lg border border-green-200 bg-green-50/50 p-2.5">
          <p className="text-[11px] font-semibold text-green-800">この案件に紐付け済み</p>
          <ul className="mt-1.5 space-y-1">
            {linkedManuals.map((manual) => (
              <li key={manual.id} className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-xs font-medium text-gray-700">{manual.title}</span>
                <button
                  type="button"
                  onClick={() => onUnlink(manual)}
                  disabled={saving}
                  className="inline-flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-[11px] font-medium text-gray-400 transition-colors hover:bg-white hover:text-red-600 disabled:opacity-50"
                  aria-label={`${manual.title} の紐付けを解除`}
                >
                  <XIcon className="h-3 w-3" />
                  解除
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="relative mt-3">
        <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
        <input
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          className={`${inputCls} pl-9 ${search ? 'pr-8' : ''}`}
          placeholder="タイトル・本文・キーワードで検索"
          aria-label="マニュアルを検索"
        />
        {search && (
          <button
            type="button"
            onClick={() => onSearchChange('')}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
            aria-label="検索をクリア"
          >
            <XIcon className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <select
        value={category}
        onChange={(e) => onCategoryChange(e.target.value)}
        className={`mt-2 ${selectCls}`}
        aria-label="マニュアルのカテゴリ"
      >
        <option value="all">全カテゴリ</option>
        {categoryOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
      </select>

      <div className="mt-3 max-h-[480px] space-y-3 overflow-y-auto overscroll-contain">
        {manuals.length === 0 ? (
          <p className="py-4 text-center text-sm text-gray-400">該当するマニュアルはありません</p>
        ) : manuals.map((manual) => {
          const linked = linkedIds.includes(manual.id)
          return (
            <div key={manual.id} className="rounded-lg border border-gray-200 p-3 transition-colors hover:border-gray-300">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="break-words text-sm font-semibold text-gray-900">{manual.title}</p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-gray-500">
                    <Pill className="border-gray-200 bg-gray-50 text-gray-600">
                      {categoryLabel[manual.category] || manual.category}
                    </Pill>
                    {manual.owner || '担当未設定'}
                  </p>
                </div>
                <button
                  onClick={() => onLink(manual)}
                  disabled={!canLink || saving || linked}
                  title={!canLink ? '案件を選択すると紐付けできます' : undefined}
                  className={`shrink-0 rounded-md px-2 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed ${
                    linked
                      ? 'border border-green-200 bg-green-50 text-green-700'
                      : 'border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50'
                  }`}
                >
                  {linked ? '紐付済' : '紐付け'}
                </button>
              </div>
              <ManualBody body={manual.body} />
              {manual.url && (
                <a
                  href={manual.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 inline-block text-sm text-blue-600 underline-offset-2 hover:underline"
                >
                  リンクを開く
                </a>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}

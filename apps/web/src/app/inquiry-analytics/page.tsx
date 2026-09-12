'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Header from '@/components/layout/header'
import { useAccount } from '@/contexts/account-context'
import { api, type InquiryAnalyticsCase, type InquiryAnalyticsResponse } from '@/lib/api'
import {
  createInquiryTrendScale,
  formatInquiryTrendAverage,
  formatInquiryTrendPeriod,
  INQUIRY_TREND_GRANULARITY_LABELS,
  INQUIRY_TREND_RECENT_LABELS,
  selectRecentInquiryTrends,
  type InquiryTrendGranularity,
} from '@/lib/inquiry-analytics'

const PAGE_SIZE = 50
const EMPTY: InquiryAnalyticsResponse = {
  totals: { total: 0, customers: 0, resolved: 0, needs_review: 0 },
  categories: [], genres: [], trends: [], cases: [], filtered_total: 0,
  trend_granularity: 'month', limit: PAGE_SIZE, offset: 0,
}

const STATUS_LABEL = { open: '未回答', answered: '回答あり', resolved: '解決', unknown: '要確認' } as const

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: 'short', day: 'numeric' }).format(date)
}

function formatDateTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat('ja-JP', {
        year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
      }).format(date)
}

function TrendChart({
  trends,
  granularity,
}: {
  trends: InquiryAnalyticsResponse['trends']
  granularity: InquiryTrendGranularity
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const width = Math.max(760, 80 + Math.max(0, trends.length - 1) * 58)
  const height = 300
  const left = 58
  const right = 22
  const top = 52
  const bottom = 54
  const chartWidth = width - left - right
  const chartHeight = height - top - bottom
  const maxValue = Math.max(0, ...trends.map((item) => Number(item.count)))
  const scale = createInquiryTrendScale(maxValue)
  const points = trends.map((item, index) => ({
    ...item,
    x: trends.length <= 1 ? left + chartWidth / 2 : left + (index / (trends.length - 1)) * chartWidth,
    y: top + chartHeight - (Number(item.count) / scale.maximum) * chartHeight,
  }))
  const baseline = top + chartHeight
  const areaPoints = points.length
    ? [`${points[0].x},${baseline}`, ...points.map((point) => `${point.x},${point.y}`), `${points.at(-1)?.x ?? left},${baseline}`].join(' ')
    : ''
  const lastPeriod = trends.at(-1)?.period

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollLeft = scrollRef.current.scrollWidth
    })
    return () => window.cancelAnimationFrame(frame)
  }, [granularity, lastPeriod, trends.length, width])

  if (trends.length === 0) {
    return <div className="flex h-64 items-center justify-center rounded-lg border border-dashed border-slate-200 text-sm text-slate-500">推移を表示するデータがありません</div>
  }

  return (
    <div className="relative overflow-hidden rounded-lg border border-slate-200 bg-slate-50/70">
      <div ref={scrollRef} className="overflow-x-auto" tabIndex={0} aria-label="問い合わせ推移グラフ。全期間表示では横にスクロールできます">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="h-[300px] max-w-none"
          style={{ width, minWidth: '100%' }}
          role="img"
          aria-label={`${INQUIRY_TREND_GRANULARITY_LABELS[granularity]}の問い合わせ件数`}
        >
          <rect x={left} y={top} width={chartWidth} height={chartHeight} rx="8" fill="#ffffff" />
          {scale.ticks.map((value) => {
            const y = top + chartHeight - (value / scale.maximum) * chartHeight
            return <line key={value} x1={left} y1={y} x2={width - right} y2={y} stroke="#dfe6e3" strokeWidth="1" />
          })}
          {points.map((point) => (
            <line key={`guide-${point.period}`} x1={point.x} y1={top} x2={point.x} y2={baseline} stroke="#eef2f1" strokeWidth="1" />
          ))}
          <line x1={left} y1={baseline} x2={width - right} y2={baseline} stroke="#94a3b8" strokeWidth="1.25" />
          {points.length > 1 && <polygon points={areaPoints} fill="#06C755" opacity="0.08" />}
          {points.length > 1 && (
            <polyline
              points={points.map((point) => `${point.x},${point.y}`).join(' ')}
              fill="none"
              stroke="#049b46"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}
          {points.map((point, index) => {
            const latest = index === points.length - 1
            const labelWidth = Math.max(34, String(point.count).length * 8 + 16)
            const labelY = Math.max(6, point.y - 31)
            return (
              <g key={point.period}>
                <rect
                  x={point.x - labelWidth / 2}
                  y={labelY}
                  width={labelWidth}
                  height="22"
                  rx="6"
                  fill={latest ? '#ecfdf3' : '#ffffff'}
                  stroke={latest ? '#06C755' : '#d7dfdc'}
                />
                <text x={point.x} y={labelY + 15} textAnchor="middle" fill={latest ? '#04783f' : '#334155'} fontSize="12" fontWeight="600">
                  {Number(point.count).toLocaleString('ja-JP')}
                </text>
                {latest && <circle cx={point.x} cy={point.y} r="9" fill="#dcfce7" stroke="#06C755" strokeWidth="1" />}
                <circle cx={point.x} cy={point.y} r={latest ? 5 : 4.5} fill={latest ? '#06C755' : 'white'} stroke="#049b46" strokeWidth="2.5">
                  <title>{formatInquiryTrendPeriod(point.period, granularity)}：{point.count}件</title>
                </circle>
                <text x={point.x} y={height - 20} textAnchor="middle" fill={latest ? '#04783f' : '#475569'} fontSize="12" fontWeight={latest ? '600' : '500'}>
                  {formatInquiryTrendPeriod(point.period, granularity, true)}
                </text>
              </g>
            )
          })}
        </svg>
      </div>
      <svg viewBox={`0 0 ${left} ${height}`} className="pointer-events-none absolute inset-y-0 left-0 h-[300px] w-[58px] border-r border-slate-200 bg-slate-50" aria-hidden="true">
        {scale.ticks.map((value) => {
          const y = top + chartHeight - (value / scale.maximum) * chartHeight
          return (
            <g key={value}>
              <line x1={left - 6} y1={y} x2={left} y2={y} stroke="#94a3b8" strokeWidth="1.25" />
              <text x={left - 10} y={y + 4} textAnchor="end" fill="#475569" fontSize="12" fontWeight="500">{value.toLocaleString('ja-JP')}</text>
            </g>
          )
        })}
        <line x1={left - 1} y1={top} x2={left - 1} y2={baseline} stroke="#94a3b8" strokeWidth="1.25" />
      </svg>
      <div className="pointer-events-none absolute left-[70px] top-3 z-10 flex items-center gap-2 rounded-md bg-white px-2 py-1 text-xs font-medium text-slate-600 shadow-sm">
        <span className="h-0.5 w-6 rounded-full bg-emerald-600" />
        問い合わせ
      </div>
    </div>
  )
}

function InquiryCaseDrawer({ item, onClose }: { item: InquiryAnalyticsCase; onClose: () => void }) {
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    window.requestAnimationFrame(() => closeButtonRef.current?.focus())
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-labelledby="inquiry-detail-title">
      <button type="button" className="absolute inset-0 h-full w-full cursor-default bg-slate-950/35" onClick={onClose} aria-label="問い合わせ詳細を閉じる" />
      <aside className="absolute inset-y-0 right-0 flex w-full flex-col border-l border-slate-200 bg-white shadow-xl sm:max-w-[420px]">
        <header className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-slate-500">問い合わせ詳細</p>
            <h2 id="inquiry-detail-title" className="mt-0.5 truncate text-base font-semibold text-slate-900">
              顧客番号 {item.customer_number || '不明'}
            </h2>
          </div>
          <button ref={closeButtonRef} type="button" onClick={onClose} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-2xl font-light text-slate-500 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500" aria-label="閉じる">×</button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-5">
          <div className="flex flex-wrap gap-2">
            <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-800">{item.primary_category}</span>
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700">{item.genre}</span>
            <span className="rounded-full border border-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-600">{STATUS_LABEL[item.resolution_status]}</span>
            {item.confidence < 0.6 && <span className="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-800">分類要レビュー</span>}
          </div>

          <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl bg-slate-50 p-4 text-sm">
            <div><dt className="text-xs text-slate-500">受付日時</dt><dd className="mt-1 font-medium text-slate-800">{formatDateTime(item.opened_at)}</dd></div>
            <div><dt className="text-xs text-slate-500">最終更新</dt><dd className="mt-1 font-medium text-slate-800">{formatDateTime(item.last_activity_at)}</dd></div>
            <div><dt className="text-xs text-slate-500">データ種別</dt><dd className="mt-1 font-medium text-slate-800">{item.source_kind === 'csv' ? '過去履歴' : '自動集計'}</dd></div>
            <div><dt className="text-xs text-slate-500">分類確信度</dt><dd className="mt-1 font-medium tabular-nums text-slate-800">{Math.round(item.confidence * 100)}%</dd></div>
          </dl>

          <section className="mt-6">
            <h3 className="text-xs font-semibold text-slate-500">問い合わせ内容</h3>
            <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-7 text-slate-800">{item.inquiry_summary}</p>
          </section>
          <section className="mt-6 border-t border-slate-100 pt-6">
            <h3 className="text-xs font-semibold text-slate-500">回答・解決内容</h3>
            <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-7 text-slate-800">{item.resolution_summary || '回答・解決内容は確認できません'}</p>
          </section>
          {item.labels.length > 1 && (
            <section className="mt-6 border-t border-slate-100 pt-6">
              <h3 className="text-xs font-semibold text-slate-500">関連カテゴリー</h3>
              <div className="mt-2 flex flex-wrap gap-2">{item.labels.map((label) => <span key={label} className="rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-600">{label}</span>)}</div>
            </section>
          )}
          <p className="mt-8 rounded-lg bg-slate-50 px-3 py-2 text-[11px] leading-5 text-slate-500">表示内容は、連絡先や口座情報などを伏せた分析用の要約です。</p>
        </div>
      </aside>
    </div>
  )
}

export default function InquiryAnalyticsPage() {
  const { selectedAccount } = useAccount()
  const [data, setData] = useState(EMPTY)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [category, setCategory] = useState('')
  const [genre, setGenre] = useState('')
  const [granularity, setGranularity] = useState<InquiryTrendGranularity>('month')
  const [trendRange, setTrendRange] = useState<'recent' | 'all'>('recent')
  const [resolution, setResolution] = useState('')
  const [queryInput, setQueryInput] = useState('')
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [selectedCase, setSelectedCase] = useState<InquiryAnalyticsCase | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const response = await api.inquiryAnalytics.list({
        lineAccountId: selectedAccount?.id,
        category: category || undefined,
        genre: genre || undefined,
        granularity,
        resolution: resolution || undefined,
        q: query || undefined,
        limit: PAGE_SIZE,
        offset,
      })
      if (!response.success) throw new Error(response.error || '読み込みに失敗しました')
      setData(response.data)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [selectedAccount?.id, category, genre, granularity, resolution, query, offset])

  useEffect(() => { void load() }, [load])
  useEffect(() => { setOffset(0) }, [selectedAccount?.id, category, genre, resolution, query])
  useEffect(() => { setTrendRange('recent') }, [selectedAccount?.id, category, genre, granularity])

  const maxCategory = Math.max(1, ...data.categories.map((item) => Number(item.count)))
  const maxGenre = Math.max(1, ...data.genres.map((item) => Number(item.count)))
  const selectedCategoryCount = Number(data.categories.find((item) => item.category === category)?.count ?? 0)
  const visibleTrends = trendRange === 'all' ? data.trends : selectRecentInquiryTrends(data.trends, granularity)
  const exactTrends = visibleTrends.slice(-6)
  const latestTrend = visibleTrends.at(-1)
  const maxTrend = visibleTrends.reduce<InquiryAnalyticsResponse['trends'][number] | null>((current, item) => (
    !current || Number(item.count) > Number(current.count) ? item : current
  ), null)
  const averageTrend = visibleTrends.length
    ? visibleTrends.reduce((sum, item) => sum + Number(item.count), 0) / visibleTrends.length
    : 0
  const trendScope = genre ? `${category} › ${genre}` : category || '全カテゴリー'
  const trendRangeLabel = trendRange === 'recent' ? INQUIRY_TREND_RECENT_LABELS[granularity] : '全期間'
  const firstVisible = data.filtered_total === 0 ? 0 : offset + 1
  const lastVisible = Math.min(offset + data.cases.length, data.filtered_total)

  const selectCategory = (nextCategory: string) => {
    setCategory(nextCategory)
    setGenre('')
    setSelectedCase(null)
  }

  const selectGenre = (nextGenre: string) => {
    setGenre(nextGenre)
    setSelectedCase(null)
  }

  const clearDrilldown = () => {
    setCategory('')
    setGenre('')
    setSelectedCase(null)
  }

  return (
    <>
      <Header title="問い合わせ分析" />
      <main className="min-h-screen bg-[#f6f8f7] px-4 py-5 pb-24 sm:px-6 lg:px-8 lg:pb-8">
        <div className="mx-auto max-w-7xl space-y-5">
          <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="主要指標">
            {[
              { label: '問い合わせ案件', value: data.totals.total, note: '連続したやり取りを1案件として集計' },
              { label: '顧客数', value: data.totals.customers, note: '顧客番号の重複を除いた人数' },
              { label: '解決確認', value: data.totals.resolved, note: data.totals.total ? `全案件の ${Math.round((data.totals.resolved / data.totals.total) * 100)}%` : '解決を確認できた案件' },
              { label: '要レビュー', value: data.totals.needs_review, note: '分類確信度が60%未満' },
            ].map((metric) => (
              <article key={metric.label} className="rounded-xl border border-slate-200 bg-white p-4">
                <p className="text-xs font-semibold text-slate-500">{metric.label}</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums tracking-tight text-slate-900 sm:text-3xl">{Number(metric.value).toLocaleString('ja-JP')}</p>
                <p className="mt-2 text-[11px] leading-5 text-slate-500">{metric.note}</p>
              </article>
            ))}
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5" aria-labelledby="trend-heading">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h1 id="trend-heading" className="text-base font-semibold text-slate-900">問い合わせ推移</h1>
                <p className="mt-1 text-xs text-slate-500">{trendScope}の受付件数を{INQUIRY_TREND_GRANULARITY_LABELS[granularity]}・{trendRangeLabel}で表示</p>
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-1" aria-label="集計単位">
                  {(Object.keys(INQUIRY_TREND_GRANULARITY_LABELS) as InquiryTrendGranularity[]).map((value) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setGranularity(value)}
                      aria-pressed={granularity === value}
                      className={`min-h-9 rounded-md px-3 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${granularity === value ? 'bg-white text-emerald-800 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
                    >
                      {INQUIRY_TREND_GRANULARITY_LABELS[value]}
                    </button>
                  ))}
                </div>
                <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-1" aria-label="表示範囲">
                  <button type="button" onClick={() => setTrendRange('recent')} aria-pressed={trendRange === 'recent'} className={`min-h-9 rounded-md px-3 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${trendRange === 'recent' ? 'bg-white text-emerald-800 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>直近</button>
                  <button type="button" onClick={() => setTrendRange('all')} aria-pressed={trendRange === 'all'} className={`min-h-9 rounded-md px-3 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${trendRange === 'all' ? 'bg-white text-emerald-800 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>全期間</button>
                </div>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-3 gap-2 border-y border-slate-100 py-3 sm:max-w-xl sm:gap-5">
              <div><p className="text-[11px] text-slate-500">最新</p><p className="mt-0.5 text-lg font-semibold tabular-nums text-slate-900">{latestTrend ? `${latestTrend.count}件` : '—'}</p><p className="truncate text-[10px] text-slate-400">{latestTrend ? formatInquiryTrendPeriod(latestTrend.period, granularity) : 'データなし'}</p></div>
              <div><p className="text-[11px] text-slate-500">最多</p><p className="mt-0.5 text-lg font-semibold tabular-nums text-slate-900">{maxTrend ? `${maxTrend.count}件` : '—'}</p><p className="truncate text-[10px] text-slate-400">{maxTrend ? formatInquiryTrendPeriod(maxTrend.period, granularity) : 'データなし'}</p></div>
              <div><p className="text-[11px] text-slate-500">期間平均</p><p className="mt-0.5 text-lg font-semibold tabular-nums text-slate-900">{visibleTrends.length ? `${formatInquiryTrendAverage(averageTrend)}件` : '—'}</p><p className="text-[10px] text-slate-400">{trendRangeLabel}</p></div>
            </div>

            <div className="mt-3">
              <TrendChart trends={visibleTrends} granularity={granularity} />
            </div>
            <p className={`mt-2 text-right text-[11px] tracking-[0.01em] text-slate-500 ${trendRange === 'all' ? '' : 'sm:hidden'}`}>
              最新側から表示しています。左右にスクロールして確認できます。
            </p>
            {exactTrends.length > 0 && (
              <div className="mt-3 border-t border-slate-100 pt-3">
                <p className="text-[11px] font-semibold tracking-[0.01em] text-slate-600">直近6期間の件数</p>
                <div className="mt-2 grid grid-cols-2 overflow-hidden rounded-lg border border-slate-200 bg-slate-50 sm:grid-cols-3 xl:grid-cols-6">
                  {exactTrends.map((item) => (
                    <div key={item.period} className="border-b border-r border-slate-200 px-3 py-2.5 last:border-r-0 sm:[&:nth-last-child(-n+3)]:border-b-0 xl:border-b-0">
                      <p className="text-[11px] tracking-[0.01em] text-slate-500">{formatInquiryTrendPeriod(item.period, granularity)}</p>
                      <p className="mt-1 text-base font-semibold tabular-nums text-slate-900">{item.count.toLocaleString('ja-JP')}件</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>

          <section aria-labelledby="drilldown-heading">
            <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
              <div>
                <h2 id="drilldown-heading" className="text-base font-semibold text-slate-900">問い合わせ内容を絞り込む</h2>
                <p className="mt-1 text-xs text-slate-500">カテゴリーから内容ジャンルへ順に選択します。</p>
              </div>
              {(category || genre) && <button type="button" onClick={clearDrilldown} className="min-h-10 rounded-lg px-3 text-xs font-semibold text-emerald-700 hover:bg-emerald-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">選択をすべて解除</button>}
            </div>

            <div className="grid items-start gap-4 lg:grid-cols-2">
              <article className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
                <div className="flex items-center gap-2">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-700 text-xs font-semibold text-white">1</span>
                  <div><h3 className="text-sm font-semibold text-slate-900">カテゴリーを選ぶ</h3><p className="text-[11px] text-slate-500">どの問い合わせが多いかを確認</p></div>
                </div>
                <div className="mt-4 space-y-2">
                  {data.categories.map((item) => {
                    const count = Number(item.count)
                    const share = data.totals.total ? (count / data.totals.total) * 100 : 0
                    const selected = category === item.category
                    return (
                      <button
                        key={item.category}
                        type="button"
                        onClick={() => selectCategory(item.category)}
                        aria-pressed={selected}
                        className={`block min-h-14 w-full rounded-lg border px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${selected ? 'border-emerald-600 bg-emerald-50' : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'}`}
                      >
                        <span className="flex items-center justify-between gap-3 text-xs">
                          <span className={`font-semibold ${selected ? 'text-emerald-900' : 'text-slate-700'}`}>{item.category}</span>
                          <span className="shrink-0 tabular-nums text-slate-500">{count.toLocaleString('ja-JP')}件 · {share.toFixed(1)}%</span>
                        </span>
                        <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-slate-100"><span className="block h-full rounded-full bg-emerald-600" style={{ width: `${Math.max(2, (count / maxCategory) * 100)}%` }} /></span>
                      </button>
                    )
                  })}
                  {!loading && data.categories.length === 0 && <p className="py-8 text-center text-sm text-slate-500">集計できる問い合わせがありません。</p>}
                </div>
              </article>

              <article className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
                <div className="flex items-center gap-2">
                  <span className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${category ? 'bg-emerald-700 text-white' : 'bg-slate-200 text-slate-500'}`}>2</span>
                  <div><h3 className="text-sm font-semibold text-slate-900">内容ジャンルを選ぶ</h3><p className="text-[11px] text-slate-500">カテゴリー内で多い内容を確認</p></div>
                </div>
                {!category ? (
                  <div className="mt-4 flex min-h-64 items-center justify-center rounded-lg border border-dashed border-slate-200 px-6 text-center text-sm leading-6 text-slate-500">左のカテゴリーを選ぶと、内容ジャンルと件数が表示されます。</div>
                ) : (
                  <div className="mt-4 space-y-2">
                    <button type="button" onClick={() => selectGenre('')} aria-pressed={!genre} className={`flex min-h-12 w-full items-center justify-between rounded-lg border px-3 text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${!genre ? 'border-emerald-600 bg-emerald-50 text-emerald-900' : 'border-slate-200 text-slate-700 hover:bg-slate-50'}`}>
                      <span className="font-semibold">{category}のすべて</span><span className="tabular-nums text-slate-500">{selectedCategoryCount.toLocaleString('ja-JP')}件</span>
                    </button>
                    {data.genres.map((item) => {
                      const count = Number(item.count)
                      const share = selectedCategoryCount ? (count / selectedCategoryCount) * 100 : 0
                      const selected = genre === item.genre
                      return (
                        <button key={item.genre} type="button" onClick={() => selectGenre(item.genre)} aria-pressed={selected} className={`block min-h-14 w-full rounded-lg border px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${selected ? 'border-emerald-600 bg-emerald-50' : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'}`}>
                          <span className="flex items-center justify-between gap-3 text-xs"><span className={`font-semibold ${selected ? 'text-emerald-900' : 'text-slate-700'}`}>{item.genre}</span><span className="shrink-0 tabular-nums text-slate-500">{count.toLocaleString('ja-JP')}件 · {share.toFixed(1)}%</span></span>
                          <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-slate-100"><span className="block h-full rounded-full bg-emerald-600" style={{ width: `${Math.max(2, (count / maxGenre) * 100)}%` }} /></span>
                        </button>
                      )
                    })}
                    {!loading && data.genres.length === 0 && <p className="py-8 text-center text-sm text-slate-500">このカテゴリーのジャンルはありません。</p>}
                  </div>
                )}
              </article>
            </div>
          </section>

          <section className="overflow-hidden rounded-xl border border-slate-200 bg-white" aria-labelledby="case-list-heading">
            <div className="border-b border-slate-200 p-4 sm:p-5">
              <div className="flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-700 text-xs font-semibold text-white">3</span>
                <div><h2 id="case-list-heading" className="text-sm font-semibold text-slate-900">個別の問い合わせを確認</h2><p className="text-[11px] text-slate-500">内容を選ぶと、お客さんごとの詳細を確認できます。</p></div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                <button type="button" onClick={clearDrilldown} className="min-h-9 rounded-lg border border-slate-200 bg-slate-50 px-3 font-semibold text-slate-600 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">全カテゴリー</button>
                {category && <><span className="text-slate-400">›</span><button type="button" onClick={() => selectGenre('')} className="min-h-9 rounded-lg border border-emerald-200 bg-emerald-50 px-3 font-semibold text-emerald-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">{category}</button></>}
                {genre && <><span className="text-slate-400">›</span><span className="inline-flex min-h-9 items-center rounded-lg bg-emerald-700 px-3 font-semibold text-white">{genre}</span></>}
              </div>
              <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs text-slate-500"><span className="font-semibold tabular-nums text-slate-800">{data.filtered_total.toLocaleString('ja-JP')}件</span> が該当</p>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <form className="flex" onSubmit={(event) => { event.preventDefault(); setQuery(queryInput.trim()); setOffset(0) }}>
                    <input value={queryInput} onChange={(event) => setQueryInput(event.target.value)} placeholder="顧客番号・内容で検索" aria-label="顧客番号・内容で検索" className="h-11 min-w-0 flex-1 rounded-l-lg border border-r-0 border-slate-300 px-3 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100 sm:w-56" />
                    <button type="submit" className="h-11 rounded-r-lg bg-slate-800 px-3 text-xs font-semibold text-white hover:bg-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">検索</button>
                  </form>
                  <select value={resolution} onChange={(event) => setResolution(event.target.value)} aria-label="解決状況" className="h-11 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-700 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100">
                    <option value="">解決状況：すべて</option><option value="open">未回答</option><option value="answered">回答あり</option><option value="resolved">解決</option><option value="unknown">要確認</option>
                  </select>
                </div>
              </div>
              {query && <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">検索中：<span className="font-semibold text-slate-700">{query}</span><button type="button" onClick={() => { setQueryInput(''); setQuery('') }} className="min-h-9 px-2 font-semibold text-emerald-700">解除</button></div>}
            </div>

            {error && <div className="m-4 flex items-center justify-between gap-3 rounded-lg bg-red-50 p-3 text-sm text-red-700"><span>{error}</span><button type="button" onClick={() => void load()} className="shrink-0 font-semibold underline">再読み込み</button></div>}
            <div className={`divide-y divide-slate-100 transition-opacity ${loading ? 'opacity-55' : 'opacity-100'}`} aria-busy={loading}>
              {data.cases.map((item) => (
                <button key={item.id} type="button" onClick={() => setSelectedCase(item)} className="grid min-h-24 w-full gap-2 p-4 text-left hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500 sm:p-5 lg:grid-cols-[135px_220px_1fr_110px] lg:items-start">
                  <span className="block"><span className="block text-[10px] font-semibold text-slate-400">顧客番号</span><span className="mt-1 block font-semibold text-slate-900">{item.customer_number || '不明'}</span><span className="mt-1 block text-[11px] text-slate-500">{formatDate(item.opened_at)}</span></span>
                  <span className="block"><span className="inline-flex rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-800">{item.primary_category}</span><span className="mt-1.5 block text-xs font-medium text-slate-600">{item.genre}</span>{item.confidence < 0.6 && <span className="mt-1 block text-[10px] font-semibold text-amber-700">分類要レビュー</span>}</span>
                  <span className="block min-w-0"><span className="block text-[10px] font-semibold text-slate-400">問い合わせ内容</span><span className="mt-1 line-clamp-2 block break-words text-sm leading-6 text-slate-700">{item.inquiry_summary}</span></span>
                  <span className="flex items-center justify-between gap-2 lg:block"><span className="text-xs font-semibold text-slate-600">{STATUS_LABEL[item.resolution_status]}</span><span className="text-xs font-semibold text-emerald-700 lg:mt-2 lg:block">詳細を見る →</span></span>
                </button>
              ))}
              {!loading && data.cases.length === 0 && <p className="p-10 text-center text-sm text-slate-500">条件に合う問い合わせはありません。カテゴリーや検索条件を変更してください。</p>}
              {loading && data.cases.length === 0 && <p className="p-10 text-center text-sm text-slate-500">問い合わせを読み込んでいます…</p>}
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-slate-200 p-4">
              <button type="button" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} className="min-h-10 rounded-lg border border-slate-300 px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40">前へ</button>
              <span className="text-xs tabular-nums text-slate-500">{firstVisible}〜{lastVisible} / {data.filtered_total.toLocaleString('ja-JP')}件</span>
              <button type="button" disabled={lastVisible >= data.filtered_total || loading} onClick={() => setOffset(offset + PAGE_SIZE)} className="min-h-10 rounded-lg border border-slate-300 px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40">次へ</button>
            </div>
          </section>
        </div>
      </main>
      {selectedCase && <InquiryCaseDrawer item={selectedCase} onClose={() => setSelectedCase(null)} />}
    </>
  )
}

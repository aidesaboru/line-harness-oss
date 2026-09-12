'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Header from '@/components/layout/header'
import { useAccount } from '@/contexts/account-context'
import { api, type InquiryAnalyticsResponse } from '@/lib/api'
import { readStaffIdentityCache } from '@/lib/auth-session'
import { parseInquiryImportJsonl, type HistoricalInquiryImportCase } from '@/lib/inquiry-import'

const EMPTY: InquiryAnalyticsResponse = {
  totals: { total: 0, customers: 0, resolved: 0, needs_review: 0 },
  categories: [], trends: [], cases: [], limit: 50, offset: 0,
}

const STATUS_LABEL = { open: '未回答', answered: '回答あり', resolved: '解決', unknown: '要確認' } as const

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: 'short', day: 'numeric' }).format(date)
}

export default function InquiryAnalyticsPage() {
  const { selectedAccount } = useAccount()
  const [data, setData] = useState(EMPTY)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [category, setCategory] = useState('')
  const [resolution, setResolution] = useState('')
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [preparedImport, setPreparedImport] = useState<{ name: string; cases: HistoricalInquiryImportCase[] } | null>(null)
  const [importing, setImporting] = useState(false)
  const [importMessage, setImportMessage] = useState('')
  const canImport = useMemo(() => ['owner', 'admin'].includes(readStaffIdentityCache().role), [])

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const response = await api.inquiryAnalytics.list({
        lineAccountId: selectedAccount?.id, category: category || undefined,
        resolution: resolution || undefined, q: query || undefined, limit: 50, offset,
      })
      if (!response.success) throw new Error(response.error || '読み込みに失敗しました')
      setData(response.data)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '読み込みに失敗しました')
    } finally { setLoading(false) }
  }, [selectedAccount?.id, category, resolution, query, offset])

  useEffect(() => { void load() }, [load])
  useEffect(() => { setOffset(0) }, [selectedAccount?.id, category, resolution, query])

  const maxCategory = Math.max(1, ...data.categories.map((item) => item.count))
  const maxTrend = Math.max(1, ...data.trends.map((item) => item.count))
  const trendPoints = useMemo(() => data.trends.map((item, index) => {
    const x = data.trends.length <= 1 ? 50 : (index / (data.trends.length - 1)) * 100
    const y = 92 - (item.count / maxTrend) * 78
    return `${x},${y}`
  }).join(' '), [data.trends, maxTrend])
  const resolutionRate = data.totals.total ? Math.round((data.totals.resolved / data.totals.total) * 100) : 0

  const prepareImport = useCallback(async (file: File | undefined) => {
    setPreparedImport(null); setImportMessage('')
    if (!file) return
    if (file.size > 20 * 1024 * 1024) { setImportMessage('投入ファイルは20MB以下にしてください'); return }
    try {
      const cases = parseInquiryImportJsonl(await file.text())
      setPreparedImport({ name: file.name, cases })
      setImportMessage(`${cases.length.toLocaleString('ja-JP')}件を確認しました。まだ本番には投入していません。`)
    } catch (reason) {
      setImportMessage(reason instanceof Error ? reason.message : '投入ファイルを読み取れませんでした')
    }
  }, [])

  const runImport = useCallback(async () => {
    if (!selectedAccount?.id || !preparedImport || importing) return
    setImporting(true); setImportMessage('')
    let imported = 0
    try {
      for (let index = 0; index < preparedImport.cases.length; index += 100) {
        const batch = preparedImport.cases.slice(index, index + 100)
        const response = await api.inquiryAnalytics.importCases({ lineAccountId: selectedAccount.id, cases: batch })
        if (!response.success) throw new Error(response.error || '投入に失敗しました')
        imported += response.data.imported
        setImportMessage(`${preparedImport.cases.length.toLocaleString('ja-JP')}件中 ${imported.toLocaleString('ja-JP')}件を投入中`)
      }
      setImportMessage(`${imported.toLocaleString('ja-JP')}件の本番投入が完了しました`)
      setPreparedImport(null); setOffset(0)
      await load()
    } catch (reason) {
      setImportMessage(`${imported.toLocaleString('ja-JP')}件まで投入済み。${reason instanceof Error ? reason.message : '投入に失敗しました'}。同じファイルで安全に再開できます。`)
    } finally { setImporting(false) }
  }, [importing, load, preparedImport, selectedAccount?.id])

  return (
    <>
      <Header title="問い合わせ分析" />
      <main className="min-h-screen bg-[#f6f8f7] px-4 py-6 pb-24 sm:px-6 lg:px-8 lg:pb-8">
        <div className="mx-auto max-w-7xl space-y-5">
          <section className="overflow-hidden rounded-2xl bg-[#102b25] p-5 text-white shadow-sm sm:p-7">
            <p className="text-xs font-bold tracking-[0.18em] text-emerald-300">INQUIRY INSIGHTS</p>
            <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
              <div><h1 className="text-2xl font-bold sm:text-3xl">問い合わせの全体像</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-emerald-50/75">過去CSVと今後のLINE履歴を同じ基準で自動集計。割合は問い合わせ案件数を分母にしています。</p></div>
              <div className="rounded-xl border border-white/15 bg-white/10 px-4 py-3"><span className="block text-xs text-emerald-100">解決確認率</span><span className="text-3xl font-bold tabular-nums">{resolutionRate}%</span></div>
            </div>
          </section>

          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="主要指標">
            {[
              ['問い合わせ案件', data.totals.total, '同一顧客の連続したやり取りを1件化'],
              ['顧客数', data.totals.customers, '顧客番号の重複を除外'],
              ['解決確認', data.totals.resolved, '会話上で解決を確認できた案件'],
              ['要レビュー', data.totals.needs_review, '分類の確信度が60%未満'],
            ].map(([label, value, note]) => <article key={String(label)} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"><p className="text-xs font-bold text-slate-500">{label}</p><p className="mt-1 text-3xl font-black tabular-nums text-slate-900">{Number(value).toLocaleString('ja-JP')}</p><p className="mt-2 text-[11px] leading-5 text-slate-500">{note}</p></article>)}
          </section>

          {canImport && <details className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
            <summary className="cursor-pointer text-sm font-bold text-slate-800">初回・復旧用の履歴投入</summary>
            <div className="mt-4 flex flex-wrap items-end gap-3">
              <label className="block text-xs font-bold text-slate-600">分析済みJSONL
                <input type="file" accept=".jsonl,application/json" aria-label="問い合わせ分析データを選択" disabled={importing} onChange={(event) => void prepareImport(event.target.files?.[0])} className="mt-1 block max-w-full text-sm" />
              </label>
              <button type="button" disabled={!preparedImport || importing || !selectedAccount?.id} onClick={() => void runImport()} className="h-10 rounded-lg bg-emerald-700 px-4 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-40">{importing ? '本番投入中…' : preparedImport ? `${preparedImport.cases.length.toLocaleString('ja-JP')}件を本番投入` : '本番投入'}</button>
            </div>
            <p className="mt-3 text-xs leading-5 text-slate-500">{preparedImport ? `${preparedImport.name} · ` : ''}{importMessage || '同じ参照IDは上書きされるため、再実行しても重複しません。'}</p>
          </details>}

          <section className="grid gap-5 lg:grid-cols-[1.15fr_0.85fr]">
            <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex items-baseline justify-between gap-3"><div><h2 className="font-bold text-slate-900">問い合わせ分類</h2><p className="mt-1 text-xs text-slate-500">主分類は1案件につき1つ。構成比の合計は100%です。</p></div><button onClick={() => setCategory('')} className="text-xs font-bold text-emerald-700">全件表示</button></div>
              <div className="mt-5 space-y-3">
                {data.categories.map((item) => {
                  const share = data.totals.total ? (item.count / data.totals.total) * 100 : 0
                  return <button key={item.category} onClick={() => setCategory(item.category)} className="block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"><span className="flex justify-between gap-3 text-xs"><span className="font-semibold text-slate-700">{item.category}</span><span className="tabular-nums text-slate-500">{item.count.toLocaleString('ja-JP')}件 · {share.toFixed(1)}%</span></span><span className="mt-1 block h-2 overflow-hidden rounded-full bg-slate-100"><span className="block h-full rounded-full bg-gradient-to-r from-emerald-600 to-lime-400" style={{ width: `${Math.max(2, (item.count / maxCategory) * 100)}%` }} /></span></button>
                })}
                {!loading && data.categories.length === 0 && <p className="py-8 text-center text-sm text-slate-500">該当データはありません。</p>}
              </div>
            </article>

            <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <h2 className="font-bold text-slate-900">月別の推移</h2><p className="mt-1 text-xs text-slate-500">問い合わせ開始月で集計</p>
              <div className="mt-5 h-52 rounded-xl bg-gradient-to-b from-emerald-50 to-white p-3">
                {data.trends.length > 1 ? <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full" role="img" aria-label="月別問い合わせ件数の折れ線グラフ"><polyline points={trendPoints} fill="none" stroke="#059669" strokeWidth="2.4" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" /></svg> : <div className="flex h-full items-center justify-center text-sm text-slate-400">推移を表示するデータがありません</div>}
              </div>
              {data.trends.length > 0 && <div className="mt-2 flex justify-between text-[10px] text-slate-500"><span>{data.trends[0]?.month}</span><span>{data.trends.at(-1)?.month}</span></div>}
            </article>
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-200 p-4 sm:p-5"><div className="flex flex-wrap items-end justify-between gap-3"><div><h2 className="font-bold text-slate-900">全問い合わせ</h2><p className="mt-1 text-xs text-slate-500">顧客番号・分類・問い合わせ概要・解決内容を確認できます。</p></div><div className="flex flex-wrap gap-2"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="顧客番号・内容で検索" className="h-10 rounded-lg border border-slate-300 px-3 text-sm" /><select value={resolution} onChange={(event) => setResolution(event.target.value)} className="h-10 rounded-lg border border-slate-300 px-3 text-sm"><option value="">解決状況：すべて</option><option value="open">未回答</option><option value="answered">回答あり</option><option value="resolved">解決</option><option value="unknown">要確認</option></select></div></div></div>
            {error && <div className="m-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}
            <div className="divide-y divide-slate-100">
              {data.cases.map((item) => <article key={item.id} className="grid gap-3 p-4 sm:p-5 lg:grid-cols-[130px_170px_1fr_1fr]"><div><p className="text-[10px] font-bold text-slate-400">顧客番号</p><p className="mt-1 font-bold text-slate-900">{item.customer_number || '不明'}</p><p className="mt-1 text-[11px] text-slate-500">{formatDate(item.opened_at)}</p></div><div><span className="inline-flex rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-bold text-emerald-800">{item.primary_category}</span><p className="mt-2 text-xs font-semibold text-slate-600">{STATUS_LABEL[item.resolution_status]}</p>{item.confidence < 0.6 && <p className="mt-1 text-[10px] font-bold text-amber-700">分類要レビュー</p>}</div><div><p className="text-[10px] font-bold text-slate-400">問い合わせ内容</p><p className="mt-1 break-words text-sm leading-6 text-slate-700">{item.inquiry_summary}</p></div><div><p className="text-[10px] font-bold text-slate-400">解決内容</p><p className="mt-1 break-words text-sm leading-6 text-slate-700">{item.resolution_summary || '回答・解決内容は確認できません'}</p></div></article>)}
              {!loading && data.cases.length === 0 && <p className="p-10 text-center text-sm text-slate-500">該当する問い合わせはありません。</p>}
            </div>
            <div className="flex justify-between border-t border-slate-200 p-4"><button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))} className="rounded-lg border px-3 py-2 text-sm font-semibold disabled:opacity-40">前へ</button><span className="self-center text-xs text-slate-500">{offset + 1}〜{Math.min(offset + data.cases.length, data.totals.total)}件</span><button disabled={data.cases.length < 50} onClick={() => setOffset(offset + 50)} className="rounded-lg border px-3 py-2 text-sm font-semibold disabled:opacity-40">次へ</button></div>
          </section>
        </div>
      </main>
    </>
  )
}

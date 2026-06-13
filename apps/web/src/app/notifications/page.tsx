'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Header from '@/components/layout/header'
import InboxFilters from '@/components/inbox/inbox-filters'
import InboxList from '@/components/inbox/inbox-list'
import InboxSummaryBar from '@/components/inbox/inbox-summary-bar'
import { api } from '@/lib/api'
import { buildUnansweredInboxListOptions, getInboxTotalPages } from '@/lib/inbox-pagination'
import type { InboxRowData } from '@/components/inbox/inbox-row'

const PAGE_SIZE = 50
const POLL_INTERVAL_MS = 30_000

interface AccountOption {
  id: string
  name: string
}

interface InboxSummary {
  total: number
  byAccount: Array<{ accountId: string; accountName: string; count: number }>
  oldestWaitMinutes: number | null
}

export default function InboxPage() {
  const [rows, setRows] = useState<InboxRowData[]>([])
  const [serverTotal, setServerTotal] = useState(0)
  const [summary, setSummary] = useState<InboxSummary>({
    total: 0,
    byAccount: [],
    oldestWaitMinutes: null,
  })
  const [page, setPage] = useState(1)
  const [q, setQ] = useState('')
  const [account, setAccount] = useState('')
  const [overdueOnly, setOverdueOnly] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [accountOptions, setAccountOptions] = useState<AccountOption[]>([])

  // 重複 polling で古いレスポンスが新しいデータを上書きしないように世代管理
  // (Codex Round 1 指摘: race condition)。
  const requestSeqRef = useRef(0)

  // 検索/account/overdue を変えたらページを1に戻す
  useEffect(() => {
    setPage(1)
  }, [q, account, overdueOnly])

  // Active なアカウントを候補に出す
  useEffect(() => {
    api.lineAccounts.list().then((res) => {
      if (res.success) {
        setAccountOptions(
          res.data
            .filter((a) => a.isActive)
            .map((a) => ({ id: a.id, name: a.name }))
            .sort((x, y) => x.name.localeCompare(y.name)),
        )
      }
    })
  }, [])

  const loadPage = useCallback(async () => {
    const seq = ++requestSeqRef.current
    setLoading(true)
    setError('')
    try {
      const [listRes, summaryRes] = await Promise.all([
        api.inbox.unanswered.list(buildUnansweredInboxListOptions({
          q,
          account,
          overdueOnly,
          page,
          pageSize: PAGE_SIZE,
        })),
        api.inbox.unanswered.count(),
      ])
      // 古いリクエストが新しいリクエストの後に到着したら破棄
      if (seq !== requestSeqRef.current) return
      if (summaryRes.success) {
        setSummary(summaryRes.data)
      }
      if (listRes.success) {
        const totalPages = getInboxTotalPages(listRes.data.total, PAGE_SIZE)
        if (page > totalPages) {
          setPage(totalPages)
          return
        }
        setRows(listRes.data.rows)
        setServerTotal(listRes.data.total)
      } else {
        setError('取得に失敗しました')
        // rows は前回値を保持して stale-while-error
      }
    } catch {
      if (seq !== requestSeqRef.current) return
      setError('取得に失敗しました')
    } finally {
      if (seq === requestSeqRef.current) setLoading(false)
    }
  }, [account, overdueOnly, page, q])

  useEffect(() => {
    loadPage()
    const id = setInterval(loadPage, POLL_INTERVAL_MS)
    return () => clearInterval(id)
  }, [loadPage])

  return (
    <div className="space-y-6">
      <Header
        title="未対応インボックス"
        description="人間が返事してない LINE 会話の triage。auto_reply は人間の返事に数えない。"
      />

      <InboxSummaryBar
        total={summary.total}
        byAccount={summary.byAccount}
        oldestWaitMinutes={summary.oldestWaitMinutes}
      />

      <InboxFilters
        q={q}
        account={account}
        overdueOnly={overdueOnly}
        accountOptions={accountOptions}
        onChange={(next) => {
          if (next.q !== undefined) setQ(next.q)
          if (next.account !== undefined) setAccount(next.account)
          if (next.overdueOnly !== undefined) setOverdueOnly(next.overdueOnly)
        }}
      />

      {error && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          {error}
        </div>
      )}

      <InboxList
        rows={rows}
        total={serverTotal}
        page={page}
        pageSize={PAGE_SIZE}
        loading={loading}
        onPageChange={setPage}
      />
    </div>
  )
}

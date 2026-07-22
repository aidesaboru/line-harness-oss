'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import type { Tag } from '@line-crm/shared'
import { api } from '@/lib/api'
import type { FriendListItem } from '@/lib/api'
import { parseCustomerProfileBulkText } from '@/lib/customer-profile-bulk'
import Header from '@/components/layout/header'
import FriendListTable from '@/components/friends/friend-list-table'
import { useAccount } from '@/contexts/account-context'

const PAGE_SIZE = 20
const FRIENDS_LOAD_ERROR_MESSAGE = '顧客一覧の読み込みに失敗しました。もう一度お試しください。'

type SortMode = 'recent' | 'oldest' | 'customer_number'

export default function FriendsPage() {
  const { selectedAccountId } = useAccount()
  const [friends, setFriends] = useState<FriendListItem[]>([])
  const [tags, setTags] = useState<Tag[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [hasNextPage, setHasNextPage] = useState(false)
  const [searchInput, setSearchInput] = useState('')
  const [searchSubmitted, setSearchSubmitted] = useState('')
  const [sortMode, setSortMode] = useState<SortMode>('recent')
  const [closingMonth, setClosingMonth] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkText, setBulkText] = useState('')
  const [bulkSaving, setBulkSaving] = useState(false)
  const [bulkMessage, setBulkMessage] = useState('')
  const [bulkError, setBulkError] = useState('')

  const bulkParsed = useMemo(() => parseCustomerProfileBulkText(bulkText), [bulkText])

  const loadFriends = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.friends.list({
        offset: String((page - 1) * PAGE_SIZE),
        limit: PAGE_SIZE,
        accountId: selectedAccountId || undefined,
        search: searchSubmitted || undefined,
        includeTags: true,
        includeChatStatus: false,
        sort: sortMode,
        closingMonth: closingMonth ?? undefined,
      })
      if (res.success) {
        setFriends(res.data.items)
        setTotal(res.data.total)
        setHasNextPage(res.data.hasNextPage)
      } else {
        setError(FRIENDS_LOAD_ERROR_MESSAGE)
      }
    } catch {
      setError(FRIENDS_LOAD_ERROR_MESSAGE)
    } finally {
      setLoading(false)
    }
  }, [page, selectedAccountId, searchSubmitted, sortMode, closingMonth])

  const loadTags = useCallback(async () => {
    try {
      const res = await api.tags.list()
      if (res.success) setTags(res.data)
    } catch {
      setTags([])
    }
  }, [])

  // Reset the URL-style account context to page 1 in a separate effect.
  // For user-driven filter changes (search/sort/handled) we reset
  // page synchronously inside the handlers below — that avoids the
  // double-fetch race where the old `page` request resolves after the
  // new `page=1` request and overwrites the correct page-1 rows.
  useEffect(() => {
    setPage(1)
  }, [selectedAccountId])

  useEffect(() => {
    loadFriends()
  }, [loadFriends])

  useEffect(() => {
    loadTags()
  }, [loadTags])

  // Fan-out helpers: changing a filter also resets pagination synchronously,
  // so React batches both state updates into one re-render and `loadFriends`
  // fires exactly once with the new filter + page=1.
  const updateAndResetPage = (cb: () => void) => {
    cb()
    setPage(1)
  }
  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    updateAndResetPage(() => setSearchSubmitted(searchInput.trim()))
  }
  // Clearing the input clears the active search even if the user doesn't
  // press 検索 again. Without this, "search Alice → clear input → change
  // another filter change would keep filtering by Alice while the input box looks empty —
  // see codex feedback. Keeping a non-empty input that doesn't match
  // searchSubmitted is fine: the user is mid-edit, hasn't applied yet.
  const handleSearchInputChange = (v: string) => {
    setSearchInput(v)
    if (v.trim() === '' && searchSubmitted !== '') {
      updateAndResetPage(() => setSearchSubmitted(''))
    }
  }
  const handleSortChange = (v: SortMode) => updateAndResetPage(() => setSortMode(v))
  const handleClosingMonthChange = (v: string) => {
    updateAndResetPage(() => setClosingMonth(v ? Number(v) : null))
  }
  const handleBulkSubmit = async () => {
    if (bulkParsed.rows.length === 0 || bulkParsed.issues.length > 0 || bulkSaving) return
    setBulkSaving(true)
    setBulkError('')
    setBulkMessage('')
    try {
      const res = await api.friends.bulkUpdateMetadata({
        lineAccountId: selectedAccountId || undefined,
        rows: bulkParsed.rows,
      })
      if (!res.success) {
        setBulkError('顧客情報の一括更新に失敗しました。入力内容を確認してください。')
        return
      }
      const notFoundCount = res.data.notFound.length
      setBulkMessage(
        notFoundCount > 0
          ? `${res.data.updated}件を更新しました。${notFoundCount}件は対象の顧客が見つかりませんでした。`
          : `${res.data.updated}件を更新しました。`,
      )
      setBulkText('')
      await loadFriends()
    } catch {
      setBulkError('顧客情報の一括更新に失敗しました。もう一度お試しください。')
    } finally {
      setBulkSaving(false)
    }
  }

  return (
    <div>
      <Header
        title="顧客管理"
        description="顧客情報と基本情報を管理します。"
      />

      <div className="mb-4 rounded-lg border border-slate-200 bg-white p-3 shadow-sm sm:rounded-2xl sm:p-4">
        <form onSubmit={handleSearchSubmit} className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <input
            type="text"
            value={searchInput}
            onChange={(e) => handleSearchInputChange(e.target.value)}
            placeholder="顧客名を検索"
            className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
          />
          <select
            value={sortMode}
            onChange={(e) => handleSortChange(e.target.value as SortMode)}
            aria-label="並び順"
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
          >
            <option value="recent">追加日の新しい順</option>
            <option value="oldest">追加日の古い順</option>
            <option value="customer_number">顧客番号順</option>
          </select>
          <select
            value={closingMonth ?? ''}
            onChange={(e) => handleClosingMonthChange(e.target.value)}
            aria-label="決算月で絞り込み"
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
          >
            <option value="">決算月: すべて</option>
            {Array.from({ length: 12 }, (_, index) => index + 1).map((month) => (
              <option key={month} value={month}>{month}月</option>
            ))}
          </select>
          <button
            type="submit"
            className="px-4 py-2 rounded-lg text-white text-sm font-medium"
            style={{ backgroundColor: '#06C755' }}
          >
            検索
          </button>
        </form>

        <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-3">
          <span className="text-xs text-gray-500">
            {loading ? '読み込み中...' : `${total.toLocaleString('ja-JP')} 件`}
          </span>
          <button
            type="button"
            onClick={() => {
              setBulkOpen((value) => !value)
              setBulkError('')
              setBulkMessage('')
            }}
            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
          >
            顧客情報一括更新
          </button>
        </div>
      </div>

      {bulkOpen && (
        <div className="mb-4 rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h2 className="text-sm font-semibold text-gray-900">顧客情報一括更新</h2>
              <p className="mt-1 text-xs leading-5 text-gray-500">
                1行目に見出し、2行目以降に更新内容を貼り付けます。friendId または lineUserId の列が必要です。
              </p>
              <p className="mt-1 text-xs text-gray-400">
                例: friendId,customerNumber,companyName,contactName,storeName
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setBulkOpen(false)
                setBulkError('')
                setBulkMessage('')
              }}
              className="self-start rounded-md bg-gray-100 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-200"
            >
              閉じる
            </button>
          </div>
          <textarea
            value={bulkText}
            onChange={(e) => {
              setBulkText(e.target.value)
              setBulkError('')
              setBulkMessage('')
            }}
            rows={6}
            placeholder={'friendId,customerNumber,companyName,contactName,storeName\nfriend-xxxx,C-001,株式会社テスト,山田,渋谷店'}
            className="mt-3 w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-xs leading-5 focus:outline-none focus:ring-2 focus:ring-green-500"
          />
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-xs text-gray-500">
              更新予定: {bulkParsed.rows.length}件
              {bulkParsed.issues.length > 0 && (
                <span className="ml-2 text-amber-700">確認が必要: {bulkParsed.issues.length}件</span>
              )}
            </div>
            <button
              type="button"
              onClick={handleBulkSubmit}
              disabled={bulkSaving || bulkParsed.rows.length === 0 || bulkParsed.issues.length > 0}
              className="rounded-lg px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
              style={{ backgroundColor: '#06C755' }}
            >
              {bulkSaving ? '更新中...' : '一括更新する'}
            </button>
          </div>
          {bulkParsed.issues.length > 0 && (
            <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {bulkParsed.issues.slice(0, 5).map((issue) => (
                <p key={issue}>{issue}</p>
              ))}
              {bulkParsed.issues.length > 5 && <p>ほか {bulkParsed.issues.length - 5}件</p>}
            </div>
          )}
          {bulkError && (
            <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {bulkError}
            </div>
          )}
          {bulkMessage && (
            <div className="mt-3 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-700">
              {bulkMessage}
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="grid animate-pulse gap-3 border-b border-slate-100 px-4 py-4 lg:grid-cols-[260px_1fr_160px]">
              <div className="flex items-center gap-2">
                <div className="w-9 h-9 rounded-full bg-gray-200" />
                <div className="h-3 bg-gray-200 rounded w-24" />
              </div>
              <div className="space-y-2">
                <div className="h-3 bg-gray-100 rounded w-3/4" />
                <div className="h-2 bg-gray-100 rounded w-20" />
              </div>
              <div className="h-8 bg-gray-100 rounded w-20" />
            </div>
          ))}
        </div>
      ) : (
        <FriendListTable friends={friends} allTags={tags} onRefresh={loadFriends} />
      )}

      {!loading && total > 0 && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between mt-4">
          <p className="text-sm text-gray-500">
            {((page - 1) * PAGE_SIZE) + 1}〜{Math.min(page * PAGE_SIZE, total)} 件 / 全{total.toLocaleString('ja-JP')}件
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="px-3 py-2 min-h-[44px] text-sm border border-gray-300 rounded-lg bg-white hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              前へ
            </button>
            <span className="text-sm text-gray-600 px-1">{page} ページ</span>
            <button
              onClick={() => setPage((p) => p + 1)}
              disabled={!hasNextPage}
              className="px-3 py-2 min-h-[44px] text-sm border border-gray-300 rounded-lg bg-white hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              次へ
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

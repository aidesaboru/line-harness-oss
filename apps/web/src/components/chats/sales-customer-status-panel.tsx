'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ApiRequestError,
  api,
  type SalesCustomerDetail,
  type SalesCustomerStoredStatus,
} from '@/lib/api'
import {
  SALES_CUSTOMER_STATUS_META,
  SALES_CUSTOMER_STORED_STATUSES,
  formatSalesCustomerDate,
  salesCustomerDraftStatus,
} from '@/lib/sales-customer-status'

const LOAD_ERROR = '営業状況を読み込めませんでした。'

export default function SalesCustomerStatusPanel({ friendId }: { friendId: string }) {
  const [detail, setDetail] = useState<SalesCustomerDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(false)
  const [draftStatus, setDraftStatus] = useState<SalesCustomerStoredStatus | ''>('')
  const [draftSummary, setDraftSummary] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const activeFriendRef = useRef(friendId)

  const applyDetail = useCallback((next: SalesCustomerDetail) => {
    setDetail(next)
    setDraftStatus(salesCustomerDraftStatus(next.status))
    setDraftSummary(next.summary)
  }, [])

  const load = useCallback(async (targetFriendId: string) => {
    setLoading(true)
    setMessage('')
    try {
      const response = await api.salesCustomers.get('friend', targetFriendId)
      if (activeFriendRef.current !== targetFriendId) return
      if (!response.success) throw new Error(response.error)
      applyDetail(response.data)
    } catch {
      if (activeFriendRef.current === targetFriendId) {
        setDetail(null)
        setMessage(LOAD_ERROR)
      }
    } finally {
      if (activeFriendRef.current === targetFriendId) setLoading(false)
    }
  }, [applyDetail])

  useEffect(() => {
    activeFriendRef.current = friendId
    setDetail(null)
    setEditing(false)
    setDraftStatus('')
    setDraftSummary('')
    setSaving(false)
    void load(friendId)
  }, [friendId, load])

  const save = async () => {
    if (!detail || !detail.canEditStatus || !draftStatus || !draftSummary.trim() || saving) return
    const targetFriendId = friendId
    setSaving(true)
    setMessage('')
    try {
      const response = await api.salesCustomers.updateStatus('friend', targetFriendId, {
        status: draftStatus,
        summary: draftSummary.trim(),
        expectedVersion: detail.version,
      })
      if (activeFriendRef.current !== targetFriendId) return
      if (!response.success) throw new Error(response.error)
      await load(targetFriendId)
      if (activeFriendRef.current !== targetFriendId) return
      setEditing(false)
      setMessage('営業状況を更新しました。')
    } catch (caught) {
      if (activeFriendRef.current !== targetFriendId) return
      if (caught instanceof ApiRequestError && caught.status === 409) {
        await load(targetFriendId)
        if (activeFriendRef.current !== targetFriendId) return
        setMessage('他の担当者が先に更新しました。最新内容を読み直しました。')
      } else {
        setMessage('保存できませんでした。もう一度お試しください。')
      }
    } finally {
      if (activeFriendRef.current === targetFriendId) setSaving(false)
    }
  }

  if (loading) {
    return (
      <section className="space-y-2 p-4" aria-label="営業状況を読み込み中">
        <div className="h-3 w-20 animate-pulse rounded bg-gray-200" />
        <div className="h-16 animate-pulse rounded-lg bg-gray-100" />
      </section>
    )
  }

  if (!detail) {
    return (
      <section className="p-4">
        <div className="rounded-lg border border-red-100 bg-red-50 p-3">
          <p className="text-[11px] text-red-700">{message || LOAD_ERROR}</p>
          <button
            type="button"
            onClick={() => void load(friendId)}
            className="mt-2 text-[11px] font-semibold text-red-700 underline underline-offset-2"
          >
            再読み込み
          </button>
        </div>
      </section>
    )
  }

  const meta = SALES_CUSTOMER_STATUS_META[detail.status]
  const changed = draftStatus !== ''
    && (draftStatus !== detail.status || draftSummary.trim() !== detail.summary)
  const canSave = detail.canEditStatus && changed && draftSummary.trim().length > 0 && !saving

  return (
    <section className="min-w-0 space-y-3 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 className="text-sm font-bold text-gray-900">営業状況</h4>
          <p className="mt-0.5 text-[10px] leading-4 text-gray-500">会話を確認し、人が選択します</p>
        </div>
        <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-1 text-[10px] font-semibold ${meta.badgeClass}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${meta.dotClass}`} aria-hidden="true" />
          {meta.label}
        </span>
      </div>

      {!editing && (
        <div className={`rounded-lg border p-3 ${meta.panelClass}`}>
          <p className="text-[11px] font-semibold text-gray-800">{meta.actionLabel}</p>
          <p className="mt-1 whitespace-pre-wrap break-words text-[11px] leading-5 text-gray-700">
            {detail.summary || '営業向け概要はまだありません。'}
          </p>
          <p className="mt-1.5 text-[10px] text-gray-500">
            {detail.updatedAt ? `${formatSalesCustomerDate(detail.updatedAt)} 更新` : '確認前'}
          </p>
        </div>
      )}

      {message && (
        <p className={`rounded-md px-2.5 py-2 text-[11px] ${message.includes('更新しました') ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-800'}`} role="status">
          {message}
        </p>
      )}

      {editing ? (
        <div className="space-y-3 rounded-lg border border-gray-200 bg-gray-50/70 p-3">
          <label className="block">
            <span className="mb-1 block text-[10px] font-semibold text-gray-600">営業状況</span>
            <select
              value={draftStatus}
              onChange={(event) => {
                setDraftStatus(event.target.value as SalesCustomerStoredStatus | '')
                setMessage('')
              }}
              disabled={saving}
              className="min-h-10 w-full rounded-md border border-gray-300 bg-white px-2 text-xs text-gray-900 outline-none focus:border-green-500 focus:ring-1 focus:ring-green-500"
            >
              <option value="" disabled>状況を選択</option>
              {SALES_CUSTOMER_STORED_STATUSES.map((status) => (
                <option key={status} value={status}>{SALES_CUSTOMER_STATUS_META[status].label}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 flex items-center justify-between gap-2 text-[10px] font-semibold text-gray-600">
              <span>営業向け概要</span>
              <span className="font-normal tabular-nums text-gray-400">{draftSummary.length}/1000</span>
            </span>
            <textarea
              value={draftSummary}
              onChange={(event) => {
                setDraftSummary(event.target.value.slice(0, 1000))
                setMessage('')
              }}
              disabled={saving}
              rows={4}
              maxLength={1000}
              placeholder="例: 契約内容を確認中。解決連絡まで営業提案は停止。"
              className="w-full resize-y rounded-md border border-gray-300 bg-white px-2 py-2 text-xs leading-5 text-gray-900 outline-none placeholder:text-gray-400 focus:border-green-500 focus:ring-1 focus:ring-green-500"
            />
          </label>
          <p className="text-[10px] leading-4 text-gray-500">
            氏名・電話・メール・URL・会話本文は転記しないでください。明らかな連絡先は保存時にも伏せられます。
          </p>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => {
                setEditing(false)
                setDraftStatus(salesCustomerDraftStatus(detail.status))
                setDraftSummary(detail.summary)
                setMessage('')
              }}
              disabled={saving}
              className="min-h-10 rounded-md border border-gray-300 bg-white text-xs font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-50"
            >
              キャンセル
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={!canSave}
              className="min-h-10 rounded-md bg-[#06C755] text-xs font-bold text-white hover:bg-[#05b94f] disabled:cursor-not-allowed disabled:bg-gray-200 disabled:text-gray-500"
            >
              {saving ? '保存中...' : '保存'}
            </button>
          </div>
        </div>
      ) : detail.canEditStatus ? (
        <button
          type="button"
          onClick={() => {
            setEditing(true)
            setMessage('')
          }}
          className="min-h-10 w-full rounded-lg border border-gray-300 bg-white text-xs font-semibold text-gray-700 hover:border-gray-400 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500"
        >
          営業状況を変更
        </button>
      ) : null}
    </section>
  )
}

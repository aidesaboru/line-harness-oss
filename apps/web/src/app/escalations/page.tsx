'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import Header from '@/components/layout/header'
import {
  ToastStack,
  btnSecondaryCls,
  useConfirmDialog,
  useToasts,
} from '@/components/support/support-ui'
import {
  escalationStatusMeta,
  formatDateTime,
  formatRelativeDue,
  dueUrgency,
  formatSupportErrorMessage,
  categoryLabel,
  priorityClass,
  priorityLabel,
  statusClass,
  statusLabel,
  supportApiErrorMessage,
} from '@/components/support/support-meta'
import { useAccount } from '@/contexts/account-context'
import { api, type SupportCaseDetail, type SupportEscalation } from '@/lib/api'
import {
  cacheStaffSession,
  clearStaffIdentityCache,
  readStaffIdentityCache,
} from '@/lib/auth-session'

type FilterMode = 'active' | 'answered' | 'all'

const ESCALATION_REALTIME_POLL_MS = 8 * 1000

function isActiveEscalation(item: SupportEscalation): boolean {
  return item.status === 'pending' || item.status === 'needs_info' || item.status === 'transferred' || item.status === 'expert_check'
}

function isCompletedEscalation(item: SupportEscalation): boolean {
  return item.status === 'answered' || item.status === 'closed'
}

export default function EscalationsPage() {
  const { selectedAccountId, selectedAccount, loading: accountLoading } = useAccount()
  const { toasts, notify, dismissToast } = useToasts()
  const { requestConfirm, confirmDialog } = useConfirmDialog()
  const [items, setItems] = useState<SupportEscalation[]>([])
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [filter, setFilter] = useState<FilterMode>('active')
  const [selectedAssignee, setSelectedAssignee] = useState('')
  const [staffOptions, setStaffOptions] = useState<string[]>([])
  const [staffName, setStaffName] = useState('')
  const [staffRole, setStaffRole] = useState('')
  const [staffReady, setStaffReady] = useState(false)
  const [loading, setLoading] = useState(false)
  const [savingId, setSavingId] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [casePreview, setCasePreview] = useState<{
    item: SupportEscalation
    detail: SupportCaseDetail | null
    loading: boolean
    error: string | null
  } | null>(null)

  const accountName = selectedAccount?.displayName || selectedAccount?.name || 'LINEアカウント'
  const isSecondaryOnly = staffRole === 'secondary'

  useEffect(() => {
    const cached = readStaffIdentityCache()
    setStaffName(cached.name || '')
    setStaffRole(cached.role || '')
    setSelectedAssignee((prev) => prev || cached.name || '')
  }, [])

  useEffect(() => {
    let active = true
    api.staff.me()
      .then((res) => {
        if (!active) return
        if (!res.success) {
          setStaffName('')
          setStaffRole('')
          setStaffReady(true)
          clearStaffIdentityCache()
          return
        }
        const nextName = res.data.name || ''
        setStaffName(nextName)
        setStaffRole(res.data.role || '')
        setSelectedAssignee((prev) => prev || nextName)
        setStaffReady(true)
        cacheStaffSession({ name: nextName, role: res.data.role || '' })
      })
      .catch(() => {
        if (!active) return
        setStaffName('')
        setStaffRole('')
        setStaffReady(true)
        clearStaffIdentityCache()
      })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!staffReady) return
    if (isSecondaryOnly) {
      setStaffOptions([])
      if (staffName) setSelectedAssignee(staffName)
      return
    }
    let active = true
    api.staff.assigneeOptions()
      .then((res) => {
        if (!active || !res.success) return
        const names = Array.from(new Set(
          res.data
            .filter((member) => member.isActive)
            .map((member) => member.name)
            .filter(Boolean),
        )).sort((a, b) => a.localeCompare(b, 'ja'))
        setStaffOptions(names)
        setSelectedAssignee((prev) => prev || staffName || names[0] || '')
      })
      .catch(() => {
        if (active) setStaffOptions(staffName ? [staffName] : [])
      })
    return () => { active = false }
  }, [isSecondaryOnly, staffName, staffReady])

  const assigneeOptions = useMemo(() => {
    const names = new Set<string>()
    if (staffName) names.add(staffName)
    if (isSecondaryOnly) return Array.from(names)
    staffOptions.forEach((name) => names.add(name))
    items.forEach((item) => {
      if (item.assignee) names.add(item.assignee)
    })
    return Array.from(names).sort((a, b) => {
      if (a === staffName) return -1
      if (b === staffName) return 1
      return a.localeCompare(b, 'ja')
    })
  }, [isSecondaryOnly, items, staffName, staffOptions])

  const loadEscalations = useCallback(async (options: { silent?: boolean } = {}) => {
    if (!selectedAccountId || !staffReady) return
    if (!options.silent) {
      setLoading(true)
      setLoadError(null)
    }
    try {
      const res = await api.support.escalations.list({
        accountId: selectedAccountId,
        assignee: isSecondaryOnly ? staffName || undefined : selectedAssignee || undefined,
        scope: isSecondaryOnly ? 'my_escalations' : undefined,
      })
      if (!res.success) {
        if (!options.silent) setLoadError(supportApiErrorMessage(res, '二次対応の読み込みに失敗しました'))
        return
      }
      setItems(res.data)
      setLoadError(null)
      setAnswers((prev) => {
        const next = { ...prev }
        res.data.forEach((item) => {
          if (!(item.id in next)) next[item.id] = item.answer || ''
        })
        return next
      })
    } catch (err) {
      if (!options.silent) setLoadError(formatSupportErrorMessage(err, '二次対応の読み込みに失敗しました'))
    } finally {
      if (!options.silent) setLoading(false)
    }
  }, [isSecondaryOnly, selectedAccountId, selectedAssignee, staffName, staffReady])

  useEffect(() => {
    void loadEscalations()
  }, [loadEscalations])

  const refreshEscalations = useCallback(() => {
    if (!selectedAccountId || !staffReady || document.hidden || savingId) return
    void loadEscalations({ silent: true })
  }, [loadEscalations, savingId, selectedAccountId, staffReady])

  useEffect(() => {
    if (!selectedAccountId || !staffReady) return
    const timer = window.setInterval(refreshEscalations, ESCALATION_REALTIME_POLL_MS)
    return () => window.clearInterval(timer)
  }, [refreshEscalations, selectedAccountId, staffReady])

  useEffect(() => {
    if (!selectedAccountId || !staffReady) return
    const handleVisibleRefresh = () => {
      if (!document.hidden) refreshEscalations()
    }
    window.addEventListener('focus', handleVisibleRefresh)
    window.addEventListener('online', handleVisibleRefresh)
    document.addEventListener('visibilitychange', handleVisibleRefresh)
    return () => {
      window.removeEventListener('focus', handleVisibleRefresh)
      window.removeEventListener('online', handleVisibleRefresh)
      document.removeEventListener('visibilitychange', handleVisibleRefresh)
    }
  }, [refreshEscalations, selectedAccountId, staffReady])

  const counts = useMemo(() => ({
    active: items.filter(isActiveEscalation).length,
    answered: items.filter(isCompletedEscalation).length,
  }), [items])
  const visibleItems = useMemo(() => {
    if (filter === 'active') return items.filter(isActiveEscalation)
    if (filter === 'answered') return items.filter(isCompletedEscalation)
    return items
  }, [filter, items])
  const reopenedSourceIds = useMemo(
    () => new Set(items.flatMap((item) => item.reopenedFromId ? [item.reopenedFromId] : [])),
    [items],
  )

  const handleUpdate = useCallback(async (item: SupportEscalation, status: 'answered' | 'needs_info') => {
    if (!selectedAccountId || savingId) return
    const answer = answers[item.id]?.trim() ?? ''
    if (status === 'answered' && !answer) {
      notify('error', '回答要点を入力してください')
      return
    }
    setSavingId(item.id)
    try {
      const res = await api.support.escalations.update(item.id, selectedAccountId, {
        status,
        answer,
        eventBody: status === 'answered' ? '二次対応画面から回答しました' : '二次対応画面から差し戻しました',
      })
      if (!res.success) {
        notify('error', supportApiErrorMessage(res, '二次対応の更新に失敗しました'))
        return
      }
      notify('success', status === 'answered' ? '回答済みにしました' : '差し戻しました')
      await loadEscalations()
    } catch (err) {
      notify('error', formatSupportErrorMessage(err, '二次対応の更新に失敗しました'))
    } finally {
      setSavingId(null)
    }
  }, [answers, loadEscalations, notify, savingId, selectedAccountId])

  const handleReopen = useCallback(async (item: SupportEscalation) => {
    if (!selectedAccountId || savingId || !isCompletedEscalation(item) || reopenedSourceIds.has(item.id)) return
    const confirmed = await requestConfirm({
      title: '二次対応を再開します',
      message: '元の回答済み・クローズ済みデータは履歴として残したまま、新しい未回答の二次対応を作成します。再開しますか？',
      confirmLabel: '未回答として再開',
      cancelLabel: '戻る',
      tone: 'warning',
    })
    if (!confirmed) return
    setSavingId(item.id)
    try {
      const res = await api.support.escalations.reopen(item.id, selectedAccountId)
      if (!res.success) {
        notify('error', supportApiErrorMessage(res, '二次対応の再開に失敗しました'))
        return
      }
      notify('success', '元の履歴を残したまま未回答として再開しました')
      setFilter('active')
      await loadEscalations()
    } catch (err) {
      notify('error', formatSupportErrorMessage(err, '二次対応の再開に失敗しました'))
    } finally {
      setSavingId(null)
    }
  }, [loadEscalations, notify, reopenedSourceIds, requestConfirm, savingId, selectedAccountId])

  const openCasePreview = useCallback(async (item: SupportEscalation) => {
    if (!selectedAccountId) return
    setCasePreview({ item, detail: null, loading: true, error: null })
    try {
      const res = await api.support.cases.get(item.caseId, selectedAccountId)
      if (!res.success) {
        setCasePreview({
          item,
          detail: null,
          loading: false,
          error: supportApiErrorMessage(res, '案件詳細の読み込みに失敗しました'),
        })
        return
      }
      setCasePreview({ item, detail: res.data, loading: false, error: null })
    } catch (err) {
      setCasePreview({
        item,
        detail: null,
        loading: false,
        error: formatSupportErrorMessage(err, '案件詳細の読み込みに失敗しました'),
      })
    }
  }, [selectedAccountId])

  if (accountLoading) {
    return <div className="p-6 text-sm text-gray-500">読み込み中...</div>
  }

  return (
    <div className="space-y-4">
      <Header
        title="二次対応"
        description={isSecondaryOnly ? `${accountName} の自分宛の二次対応を確認` : `${accountName} の二次対応を担当者別に確認`}
        action={
          <button type="button" onClick={() => void loadEscalations()} disabled={loading || Boolean(savingId)} className={btnSecondaryCls}>
            {loading ? '更新中...' : '更新'}
          </button>
        }
      />

      {staffReady && !isSecondaryOnly && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-sm">
          <div>
            <p className="text-sm font-bold text-slate-900">表示する担当者</p>
            <p className="mt-0.5 text-xs text-slate-500">
              初期表示は自分宛です。必要な時は別の担当者を選んで確認・回答できます。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {staffName && (
              <button
                type="button"
                onClick={() => setSelectedAssignee(staffName)}
                disabled={loading || Boolean(savingId)}
                className={`rounded-md border px-3 py-2 text-sm font-bold transition-colors ${
                  selectedAssignee === staffName
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                } disabled:cursor-not-allowed disabled:opacity-50`}
              >
                自分宛
              </button>
            )}
            <label className="sr-only" htmlFor="escalation-assignee-filter">二次対応の担当者</label>
            <select
              id="escalation-assignee-filter"
              value={selectedAssignee}
              onChange={(event) => setSelectedAssignee(event.target.value)}
              disabled={loading || Boolean(savingId) || assigneeOptions.length === 0}
              className="min-h-10 min-w-[220px] rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
            >
              {assigneeOptions.length === 0 ? (
                <option value="">担当者を取得中</option>
              ) : assigneeOptions.map((name) => (
                <option key={name} value={name}>
                  {name}{name === staffName ? '（自分）' : ''}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {staffReady && isSecondaryOnly && (
        <div className="rounded-md border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-800">
          {staffName || '自分'} さん宛の二次対応のみ表示しています。顧客LINEチャットはこの権限では開けません。
        </div>
      )}

      {staffReady && !isSecondaryOnly && selectedAssignee && (
        <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          {selectedAssignee} さん宛の二次対応を表示しています。別担当者の案件でも、この画面から回答・差し戻しできます。
        </div>
      )}

      {loadError && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {loadError}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {[
          { key: 'active' as const, label: '未回答', count: counts.active },
          { key: 'answered' as const, label: '完了済み', count: counts.answered },
          { key: 'all' as const, label: 'すべて', count: items.length },
        ].map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setFilter(tab.key)}
            className={`min-h-11 rounded-lg border px-4 py-2 text-sm font-bold transition-colors ${
              filter === tab.key
                ? 'border-indigo-600 bg-indigo-600 text-white shadow-sm'
                : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
            }`}
          >
            {tab.label} {tab.count}
          </button>
        ))}
      </div>

      <div className="grid gap-3">
        {loading && visibleItems.length === 0 ? (
          <div className="rounded-lg border border-gray-200 bg-white p-8 text-center text-sm text-gray-400">
            読み込み中...
          </div>
        ) : visibleItems.length === 0 ? (
          <div className="rounded-lg border border-gray-200 bg-white p-8 text-center">
            <p className="text-sm font-semibold text-gray-600">二次対応はありません</p>
            <p className="mt-1 text-xs text-gray-400">
              選択した担当者にエスカレーションされると、ここに表示されます。
            </p>
          </div>
        ) : visibleItems.map((item) => {
          const meta = escalationStatusMeta[item.status]
          const urgency = dueUrgency(item.dueAt)
          const saving = savingId === item.id
          const completed = isCompletedEscalation(item)
          const alreadyReopened = reopenedSourceIds.has(item.id)
          return (
            <section key={item.id} className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded-md border px-2.5 py-1 text-xs font-bold ${meta.className}`}>
                      {meta.label}
                    </span>
                    <span className="rounded-md border border-gray-200 bg-gray-50 px-2.5 py-1 text-xs font-bold text-gray-600">
                      {item.level}
                    </span>
                    {item.dueAt && (
                      <span className={`text-xs ${urgency === 'overdue' ? 'font-bold text-red-700' : urgency === 'soon' ? 'font-bold text-amber-700' : 'text-gray-500'}`}>
                        期限 {formatDateTime(item.dueAt)}
                        {urgency !== 'none' && ` (${formatRelativeDue(item.dueAt)})`}
                      </span>
                    )}
                  </div>
                  <h2 className="mt-2 break-words text-base font-bold text-gray-900">
                    {item.caseTitle || 'チケット件名なし'}
                  </h2>
                  <p className="mt-1 text-xs text-gray-500">
                    {item.friendName || '顧客未紐付け'} / 依頼先: {item.assignee}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {isSecondaryOnly && (
                    <span className="rounded-md border border-indigo-100 bg-indigo-50 px-3 py-2 text-xs font-bold text-indigo-700">
                      二次対応専用
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => void openCasePreview(item)}
                    className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50"
                  >
                    案件詳細
                  </button>
                  {!isSecondaryOnly && (
                    <Link
                      href={`/support?case=${encodeURIComponent(item.caseId)}`}
                      className="rounded-md border border-gray-300 bg-white px-3 py-2 text-xs font-bold text-gray-700 hover:bg-gray-50"
                    >
                      チケットを開く
                    </Link>
                  )}
                </div>
              </div>

              <div className="mt-3 rounded-md border border-gray-200 bg-gray-50 px-3 py-2">
                <p className="text-[11px] font-bold text-gray-400">確認してほしい内容</p>
                <p className="mt-1 whitespace-pre-wrap break-words text-sm text-gray-800">{item.question}</p>
              </div>

              {completed ? (
                <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs font-bold text-slate-600">登録済みの回答</p>
                  <p className={`mt-1 whitespace-pre-wrap break-words text-sm leading-6 ${item.answer ? 'text-slate-900' : 'text-slate-500'}`}>
                    {item.answer || '回答内容は登録されていません'}
                  </p>
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-3">
                    <p className="text-xs text-slate-500">
                      {alreadyReopened ? 'この履歴から未回答の二次対応を再開済みです' : '完了済みの内容は閲覧専用です'}
                    </p>
                    <button
                      type="button"
                      onClick={() => void handleReopen(item)}
                      disabled={alreadyReopened || saving || Boolean(savingId)}
                      className="rounded-md border border-amber-300 bg-white px-4 py-2 text-sm font-bold text-amber-800 hover:bg-amber-50 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {alreadyReopened ? '再開済み' : saving ? '再開中...' : '未回答として再開'}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <label className="mt-3 block">
                    <span className="mb-1 block text-xs font-bold text-gray-600">回答要点</span>
                    <textarea
                      value={answers[item.id] ?? ''}
                      onChange={(e) => setAnswers((prev) => ({ ...prev, [item.id]: e.target.value }))}
                      rows={4}
                      className="w-full resize-y rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm leading-relaxed text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      placeholder="判断、根拠、一次対応者に伝えたいことを短く入力"
                    />
                  </label>

                  <div className="mt-3 flex flex-wrap justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => void handleUpdate(item, 'needs_info')}
                      disabled={saving || Boolean(savingId)}
                      className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-bold text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      差し戻し
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleUpdate(item, 'answered')}
                      disabled={saving || Boolean(savingId) || !(answers[item.id] ?? '').trim()}
                      className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-bold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {saving ? '保存中...' : '回答済みにする'}
                    </button>
                  </div>
                </>
              )}
            </section>
          )
        })}
      </div>

      {casePreview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="case-preview-title"
        >
          <div className="max-h-[88vh] w-full max-w-3xl overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl">
            <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
              <div className="min-w-0">
                <p className="text-xs font-bold text-slate-500">二次対応の案件詳細</p>
                <h2 id="case-preview-title" className="mt-1 break-words text-lg font-bold text-slate-950">
                  {casePreview.detail?.title || casePreview.item.caseTitle || 'チケット件名なし'}
                </h2>
                <p className="mt-1 text-sm text-slate-500">
                  {casePreview.detail?.friendName || casePreview.item.friendName || '顧客未紐付け'}
                  {' / '}
                  依頼先: {casePreview.item.assignee}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setCasePreview(null)}
                className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50"
              >
                閉じる
              </button>
            </div>

            <div className="max-h-[calc(88vh-92px)] overflow-y-auto px-5 py-4">
              {casePreview.loading ? (
                <div className="flex min-h-48 items-center justify-center text-sm text-slate-500">
                  読み込み中...
                </div>
              ) : casePreview.error ? (
                <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  {casePreview.error}
                </div>
              ) : casePreview.detail ? (
                <div className="space-y-4">
                  <div className="flex flex-wrap gap-2">
                    <span className={`rounded-md border px-2.5 py-1 text-xs font-bold ${statusClass[casePreview.detail.status]}`}>
                      {statusLabel[casePreview.detail.status]}
                    </span>
                    <span className={`rounded-md border px-2.5 py-1 text-xs font-bold ${priorityClass[casePreview.detail.priority]}`}>
                      {priorityLabel[casePreview.detail.priority]}
                    </span>
                    <span className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-bold text-slate-600">
                      {categoryLabel[casePreview.detail.category] ?? casePreview.detail.category}
                    </span>
                    {casePreview.detail.dueAt && (
                      <span className="rounded-md border border-red-100 bg-red-50 px-2.5 py-1 text-xs font-bold text-red-700">
                        期限 {formatDateTime(casePreview.detail.dueAt)}
                      </span>
                    )}
                  </div>

                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                      <p className="text-[11px] font-bold text-slate-500">顧客名</p>
                      <p className="mt-1 break-words text-sm font-semibold text-slate-900">
                        {casePreview.detail.friendName || casePreview.detail.contactName || '-'}
                      </p>
                    </div>
                    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                      <p className="text-[11px] font-bold text-slate-500">一次担当者</p>
                      <p className="mt-1 break-words text-sm font-semibold text-slate-900">
                        {casePreview.detail.primaryAssignee || '-'}
                      </p>
                    </div>
                  </div>

                  <section className="rounded-lg border border-slate-200 bg-white p-4">
                    <p className="text-xs font-bold text-slate-500">問い合わせ内容</p>
                    <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-slate-900">
                      {casePreview.detail.customerSummary || casePreview.item.question || '-'}
                    </p>
                  </section>

                  <section className="rounded-lg border border-indigo-100 bg-indigo-50 p-4">
                    <p className="text-xs font-bold text-indigo-700">二次対応への依頼内容</p>
                    <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-indigo-950">
                      {casePreview.item.question || '-'}
                    </p>
                  </section>

                  {casePreview.item.answer && (
                    <section className="rounded-lg border border-emerald-100 bg-emerald-50 p-4">
                      <p className="text-xs font-bold text-emerald-700">二次対応の回答</p>
                      <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-emerald-950">
                        {casePreview.item.answer}
                      </p>
                    </section>
                  )}

                  {casePreview.detail.internalNote && (
                    <section className="rounded-lg border border-slate-200 bg-white p-4">
                      <p className="text-xs font-bold text-slate-500">社内メモ</p>
                      <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-slate-900">
                        {casePreview.detail.internalNote}
                      </p>
                    </section>
                  )}

                  {casePreview.detail.recentMessages.length === 0 && isSecondaryOnly && (
                    <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-500">
                      この権限では顧客LINEのトーク履歴は表示しません。必要な判断材料は、問い合わせ内容と二次対応への依頼内容で確認します。
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      )}

      {confirmDialog}
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  )
}

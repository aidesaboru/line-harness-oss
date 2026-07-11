'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import type { LineSafetyMode } from '@/lib/api'
import Header from '@/components/layout/header'
import CcPromptButton from '@/components/cc-prompt-button'
import { useAccount } from '@/contexts/account-context'

type ActionStatus = 'idle' | 'confirming' | 'executing' | 'done' | 'error'

interface EmergencyAction {
  id: string
  label: string
  description: string
  status: ActionStatus
  errorMessage?: string
}

const emergencyPrompts = [
  {
    title: '緊急: 全配信を停止するプロンプト',
    prompt: `LINE CRM の全配信を即時停止してください。
1. 緊急コントロールの LINE送信セーフティ停止を ON にする
2. broadcasts の status が scheduled のものを全て draft に変更
3. scenarios の isActive を全て false に変更
4. automations の isActive を全て false に変更
完了後、停止した件数を報告してください。`,
  },
  {
    title: '緊急: アカウント移行プロンプト',
    prompt: `LINE CRM のアカウント移行を実行してください。
1. /health ページで現在のアカウント状態を確認
2. BAN リスクが高いアカウントを特定
3. 移行先アカウントを選択して移行を実行
各ステップの結果を報告してください。`,
  },
]

export default function EmergencyPage() {
  const { selectedAccountId, selectedAccount } = useAccount()
  const [actions, setActions] = useState<EmergencyAction[]>([
    {
      id: 'stop-broadcasts',
      label: '全配信停止',
      description: 'スケジュール済みの一斉配信を全て下書きに戻します',
      status: 'idle',
    },
    {
      id: 'stop-scenarios',
      label: 'シナリオ一括停止',
      description: '全てのアクティブなシナリオ配信を無効化します',
      status: 'idle',
    },
    {
      id: 'switch-account',
      label: 'アカウント切替',
      description: 'BAN検知時のアカウント移行ページへ移動します',
      status: 'idle',
    },
  ])
  const [lineSafety, setLineSafety] = useState<LineSafetyMode | null>(null)
  const [lineSafetyReason, setLineSafetyReason] = useState('BANリスク確認のため一時停止')
  const [lineSafetyLoading, setLineSafetyLoading] = useState(false)
  const [lineSafetySaving, setLineSafetySaving] = useState(false)
  const [lineSafetyError, setLineSafetyError] = useState<string | null>(null)

  const loadLineSafety = useCallback(async () => {
    if (!selectedAccountId) {
      setLineSafety(null)
      return
    }
    setLineSafetyLoading(true)
    setLineSafetyError(null)
    try {
      const res = await api.accountSettings.getLineSafety(selectedAccountId)
      if (res.success) {
        setLineSafety(res.data)
        if (res.data.reason) setLineSafetyReason(res.data.reason)
      } else {
        setLineSafetyError(res.error || '状態の取得に失敗しました')
      }
    } catch {
      setLineSafetyError('状態の取得に失敗しました')
    } finally {
      setLineSafetyLoading(false)
    }
  }, [selectedAccountId])

  useEffect(() => {
    void loadLineSafety()
  }, [loadLineSafety])

  const updateAction = (id: string, updates: Partial<EmergencyAction>) => {
    setActions((prev) =>
      prev.map((a) => (a.id === id ? { ...a, ...updates } : a))
    )
  }

  const handleAction = async (id: string) => {
    const action = actions.find((a) => a.id === id)
    if (!action) return

    if (action.status === 'idle' || action.status === 'done' || action.status === 'error') {
      updateAction(id, { status: 'confirming', errorMessage: undefined })
      return
    }

    if (action.status === 'confirming') {
      updateAction(id, { status: 'executing' })

      try {
        if (id === 'stop-broadcasts') {
          const res = await api.broadcasts.list()
          if (res.success) {
            const scheduled = res.data.filter((b) => b.status === 'scheduled')
            await Promise.allSettled(
              scheduled.map((b) => api.broadcasts.update(b.id, { scheduledAt: null }))
            )
          }
        } else if (id === 'stop-scenarios') {
          const res = await api.scenarios.list()
          if (res.success) {
            const active = res.data.filter((s) => s.isActive)
            await Promise.allSettled(
              active.map((s) => api.scenarios.update(s.id, { isActive: false }))
            )
          }
        } else if (id === 'switch-account') {
          window.location.href = '/health'
          return
        }
        updateAction(id, { status: 'done' })
      } catch {
        updateAction(id, { status: 'error', errorMessage: '実行に失敗しました。再度お試しください。' })
      }
    }
  }

  const handleCancel = (id: string) => {
    updateAction(id, { status: 'idle', errorMessage: undefined })
  }

  const handleLineSafetyUpdate = async (frozen: boolean) => {
    if (!selectedAccountId) {
      setLineSafetyError('LINE公式アカウントを選択してください')
      return
    }
    setLineSafetySaving(true)
    setLineSafetyError(null)
    try {
      const res = await api.accountSettings.updateLineSafety(
        selectedAccountId,
        frozen,
        frozen ? lineSafetyReason : null,
      )
      if (res.success && res.data) {
        setLineSafety(res.data)
        if (res.data.reason) setLineSafetyReason(res.data.reason)
      } else {
        setLineSafetyError(res.error || '更新に失敗しました')
      }
    } catch {
      setLineSafetyError('更新に失敗しました')
    } finally {
      setLineSafetySaving(false)
    }
  }

  const formatUpdatedAt = (value: string | null) => {
    if (!value) return '未更新'
    const parsed = new Date(value)
    if (Number.isNaN(parsed.getTime())) return value
    return parsed.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
  }

  const getStatusBadge = (status: ActionStatus) => {
    switch (status) {
      case 'done':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            完了
          </span>
        )
      case 'executing':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-700">
            実行中...
          </span>
        )
      case 'error':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">
            エラー
          </span>
        )
      default:
        return null
    }
  }

  return (
    <div>
      <Header title="緊急コントロール" />

      {/* Warning banner */}
      <div className="mb-6 p-4 bg-red-50 border-2 border-red-300 rounded-lg">
        <div className="flex items-start gap-3">
          <svg className="w-6 h-6 text-red-500 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.072 16.5c-.77.833.192 2.5 1.732 2.5z" />
          </svg>
          <div>
            <p className="text-sm font-bold text-red-800">注意: この操作は即時実行されます</p>
            <p className="text-xs text-red-600 mt-1">
              各ボタンをクリックすると確認ダイアログが表示されます。「実行」で操作が開始されます。
            </p>
          </div>
        </div>
      </div>

      {/* LINE send safety */}
      <div className={`mb-6 bg-white rounded-lg shadow-sm border-2 p-5 ${
        lineSafety?.frozen ? 'border-red-300' : 'border-emerald-200'
      }`}>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-bold text-gray-900">LINE送信セーフティ停止</h2>
              <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${
                lineSafety?.frozen ? 'bg-red-100 text-red-700' : 'bg-emerald-100 text-emerald-700'
              }`}>
                {lineSafetyLoading ? '確認中' : lineSafety?.frozen ? '停止中' : '送信可能'}
              </span>
            </div>
            <p className="mt-2 text-sm text-gray-600">
              対象: {selectedAccount?.name || selectedAccountId || '未選択'}
            </p>
            <p className="mt-2 text-xs leading-5 text-gray-500">
              ONの間、このアカウントからの個別返信・顧客詳細送信・一斉送信・自動返信・シナリオ/リマインド配信を止めます。
            </p>
            {lineSafety?.updatedAt && (
              <p className="mt-2 text-xs text-gray-500">
                最終更新: {formatUpdatedAt(lineSafety.updatedAt)}
                {lineSafety.updatedBy ? ` / ${lineSafety.updatedBy}` : ''}
              </p>
            )}
            {lineSafetyError && (
              <p className="mt-3 text-sm font-medium text-red-600">{lineSafetyError}</p>
            )}
          </div>

          <div className="w-full lg:w-[360px]">
            {!lineSafety?.frozen && (
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-gray-600">停止理由</span>
                <textarea
                  value={lineSafetyReason}
                  onChange={(event) => setLineSafetyReason(event.target.value)}
                  maxLength={500}
                  rows={3}
                  className="w-full resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none focus:border-red-400 focus:ring-2 focus:ring-red-100"
                />
              </label>
            )}
            {lineSafety?.frozen && lineSafety.reason && (
              <div className="mb-3 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-700">
                {lineSafety.reason}
              </div>
            )}
            <div className="mt-3 flex gap-2">
              {lineSafety?.frozen ? (
                <button
                  onClick={() => handleLineSafetyUpdate(false)}
                  disabled={lineSafetySaving || !selectedAccountId}
                  className="w-full min-h-[44px] rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-emerald-700 disabled:opacity-50"
                >
                  {lineSafetySaving ? '解除中...' : '送信停止を解除'}
                </button>
              ) : (
                <button
                  onClick={() => handleLineSafetyUpdate(true)}
                  disabled={lineSafetySaving || lineSafetyLoading || !selectedAccountId}
                  className="w-full min-h-[44px] rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-700 disabled:opacity-50"
                >
                  {lineSafetySaving ? '停止中...' : 'LINE送信を停止'}
                </button>
              )}
              <button
                onClick={() => void loadLineSafety()}
                disabled={lineSafetyLoading}
                className="min-h-[44px] rounded-lg bg-gray-100 px-4 py-2 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-200 disabled:opacity-50"
              >
                更新
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Action cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
        {actions.map((action) => (
          <div
            key={action.id}
            className="bg-white rounded-lg shadow-sm border-2 border-red-200 p-5 flex flex-col"
          >
            <div className="flex items-start justify-between mb-2">
              <h3 className="text-sm font-bold text-gray-900">{action.label}</h3>
              {getStatusBadge(action.status)}
            </div>
            <p className="text-xs text-gray-500 mb-4 flex-1">{action.description}</p>

            {action.errorMessage && (
              <p className="text-xs text-red-600 mb-3">{action.errorMessage}</p>
            )}

            {action.status === 'confirming' ? (
              <div className="space-y-2">
                <p className="text-xs font-medium text-red-700">本当に実行しますか？</p>
                <div className="flex gap-2">
                  <button
                    onClick={() => handleAction(action.id)}
                    className="flex-1 px-3 py-2 min-h-[44px] text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors"
                  >
                    実行
                  </button>
                  <button
                    onClick={() => handleCancel(action.id)}
                    className="flex-1 px-3 py-2 min-h-[44px] text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
                  >
                    キャンセル
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => handleAction(action.id)}
                disabled={action.status === 'executing'}
                className="w-full px-3 py-2 min-h-[44px] text-sm font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 rounded-lg transition-colors"
              >
                {action.status === 'executing' ? '実行中...' : action.label}
              </button>
            )}
          </div>
        ))}
      </div>

      {/* Current status section */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h2 className="text-sm font-semibold text-gray-800 mb-3">現在のステータス</h2>
        <div className="space-y-2">
          <div className="flex items-center justify-between py-2 border-b border-gray-100">
            <span className="text-sm text-gray-600">LINE送信セーフティ停止</span>
            <span className={`text-xs font-medium ${lineSafety?.frozen ? 'text-red-600' : 'text-emerald-600'}`}>
              {lineSafety?.frozen ? '停止中' : '送信可能'}
            </span>
          </div>
          {actions.map((action) => (
            <div key={action.id} className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
              <span className="text-sm text-gray-600">{action.label}</span>
              <span className={`text-xs font-medium ${
                action.status === 'done'
                  ? 'text-green-600'
                  : action.status === 'error'
                  ? 'text-red-600'
                  : action.status === 'executing'
                  ? 'text-yellow-600'
                  : 'text-gray-400'
              }`}>
                {action.status === 'idle' && '未実行'}
                {action.status === 'confirming' && '確認待ち'}
                {action.status === 'executing' && '実行中'}
                {action.status === 'done' && '実行済み'}
                {action.status === 'error' && 'エラー'}
              </span>
            </div>
          ))}
        </div>
      </div>

      <CcPromptButton prompts={emergencyPrompts} />
    </div>
  )
}

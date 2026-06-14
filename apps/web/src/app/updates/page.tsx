'use client'

import { useEffect, useState } from 'react'
import { useConfirmDialog } from '@/components/support/support-ui'
import { ProgressModal } from '@/components/update/progress-modal'
import { startRollback } from '@/lib/update-client'

const API_URL = process.env.NEXT_PUBLIC_API_URL!
const ADMIN_KEY = process.env.NEXT_PUBLIC_ADMIN_API_KEY!

interface Row {
  id: string
  started_at: number
  completed_at: number | null
  from_version: string
  to_version: string
  status: string
  error: string | null
  rollback_expires_at: number | null
  rollback_of: string | null
}

async function fetchHistory(): Promise<Row[]> {
  const r = await fetch(`${API_URL}/admin/update/history`, {
    headers: { 'x-admin-api-key': ADMIN_KEY },
  })
  if (!r.ok) throw new Error(`history_fetch_${r.status}`)
  const j = (await r.json()) as { history: Row[] }
  return j.history
}

export default function UpdatesPage() {
  const [rows, setRows] = useState<Row[]>([])
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [rollbackUpdateId, setRollbackUpdateId] = useState<string | null>(null)
  const [rollingBackId, setRollingBackId] = useState<string | null>(null)
  const { requestConfirm, confirmDialog } = useConfirmDialog()

  async function loadHistory() {
    try {
      setError(null)
      setRows(await fetchHistory())
    } catch {
      setError('履歴取得に失敗しました')
    }
  }

  useEffect(() => {
    void loadHistory()
  }, [])

  async function onRollback(row: Row) {
    const ok = await requestConfirm({
      title: 'ロールバックを開始しますか？',
      message: `v${row.to_version} から v${row.from_version} へ戻します。更新中は進捗モーダルを閉じずに確認してください。`,
      confirmLabel: 'ロールバック開始',
      tone: 'warning',
    })
    if (!ok) return
    setActionError(null)
    setRollingBackId(row.id)
    try {
      const result = await startRollback(row.id)
      setRollbackUpdateId(result.updateId)
    } catch {
      setActionError('ロールバックを開始できませんでした。時間をおいて再試行してください。')
    } finally {
      setRollingBackId(null)
    }
  }

  return (
    <div className="max-w-3xl mx-auto p-6">
      <h1 className="text-xl font-semibold mb-4">アップデート履歴</h1>
      {error && (
        <div className="text-red-700 bg-red-50 p-3 rounded mb-4 text-sm">
          {error}
        </div>
      )}
      {actionError && (
        <div className="text-red-700 bg-red-50 p-3 rounded mb-4 text-sm">
          {actionError}
        </div>
      )}
      {!error && rows.length === 0 && (
        <p className="text-gray-500 text-sm">履歴はまだありません。</p>
      )}
      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-gray-600 border-b">
              <tr>
                <th className="py-2 pr-4">開始</th>
                <th className="py-2 pr-4">更新前 → 更新後</th>
                <th className="py-2 pr-4">状態</th>
                <th className="py-2">ロールバック</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b last:border-0">
                  <td className="py-2 pr-4">
                    {new Date(r.started_at).toLocaleString('ja-JP', {
                      year: 'numeric',
                      month: '2-digit',
                      day: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </td>
                  <td className="py-2 pr-4 font-mono text-xs">
                    {r.from_version} → {r.to_version}
                  </td>
                  <td className="py-2 pr-4">
                    <span
                      className={`text-xs px-2 py-0.5 rounded ${statusClass(r.status)}`}
                    >
                      {statusLabel(r.status)}
                    </span>
                  </td>
                  <td className="py-2">
                    {r.status === 'success' &&
                    !r.rollback_of &&
                    r.rollback_expires_at &&
                    Date.now() < r.rollback_expires_at ? (
                      <button
                        type="button"
                        onClick={() => void onRollback(r)}
                        disabled={rollingBackId === r.id}
                        className="underline text-blue-600 text-xs disabled:text-gray-400 disabled:no-underline"
                      >
                        {rollingBackId === r.id ? '開始中...' : 'ロールバック'}
                      </button>
                    ) : (
                      <span className="text-gray-400 text-xs">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rollbackUpdateId && (
        <ProgressModal
          updateId={rollbackUpdateId}
          onClose={() => {
            setRollbackUpdateId(null)
            void loadHistory()
          }}
        />
      )}
      {confirmDialog}
    </div>
  )
}

function statusClass(s: string): string {
  if (s === 'success') return 'bg-green-100 text-green-800'
  if (s === 'rolled_back') return 'bg-amber-100 text-amber-800'
  if (s === 'failed') return 'bg-red-100 text-red-800'
  if (s === 'running') return 'bg-blue-100 text-blue-800'
  return 'bg-gray-100 text-gray-800'
}

function statusLabel(s: string): string {
  if (s === 'success') return '成功'
  if (s === 'rolled_back') return 'ロールバック済み'
  if (s === 'failed') return '失敗'
  if (s === 'running') return '進行中'
  return s
}

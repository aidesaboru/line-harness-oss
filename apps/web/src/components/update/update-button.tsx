'use client'

import { useState } from 'react'
import { startUpdate } from '@/lib/update-client'
import { ProgressModal } from './progress-modal'

const UPDATE_START_ERROR_MESSAGE = 'アップデート開始に失敗しました。管理者設定とWorker状態を確認してから再試行してください。'

/**
 * Kicks off an update via `POST /admin/update/start` and mounts a
 * ProgressModal bound to the returned updateId. The modal manages its own
 * SSE/polling lifecycle and calls `onClose` when the operator dismisses it.
 */
export function UpdateButton({ targetVersion }: { targetVersion: string }) {
  const [loading, setLoading] = useState(false)
  const [updateId, setUpdateId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function onClick() {
    setLoading(true)
    setError(null)
    try {
      const r = await startUpdate()
      setUpdateId(r.updateId)
    } catch {
      setError(UPDATE_START_ERROR_MESSAGE)
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={onClick}
        disabled={loading}
        className="text-sm px-3 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {loading ? '開始中...' : `v${targetVersion} にアップデート`}
      </button>
      {error && (
        <span className="block text-xs text-red-700 mt-1">
          {error}
        </span>
      )}
      {updateId && (
        <ProgressModal
          updateId={updateId}
          onClose={() => setUpdateId(null)}
        />
      )}
    </>
  )
}

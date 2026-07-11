'use client'

import { useEffect, useMemo, useState } from 'react'
import type { SupportNotificationSettings } from '@/lib/api'
import { btnSecondaryCls, Field, inputCls } from './support-ui'

type NotificationSettingsDraft = {
  enabled: boolean
  webhookUrl: string
  immediateUrgent: boolean
  digestEnabled: boolean
  digestHoursText: string
  dueSoonHours: string
}

interface NotificationSettingsPanelProps {
  settings: SupportNotificationSettings | null
  loading: boolean
  saving: boolean
  disabled: boolean
  onSave: (data: {
    enabled: boolean
    webhookUrl?: string | null
    immediateUrgent: boolean
    digestEnabled: boolean
    digestHours: number[]
    dueSoonHours: number
  }) => Promise<boolean>
  onRefresh: () => void
}

function draftFromSettings(settings: SupportNotificationSettings | null): NotificationSettingsDraft {
  return {
    enabled: settings?.enabled ?? false,
    webhookUrl: '',
    immediateUrgent: settings?.immediateUrgent ?? true,
    digestEnabled: settings?.digestEnabled ?? true,
    digestHoursText: (settings?.digestHours ?? [12, 14, 17]).join(','),
    dueSoonHours: String(settings?.dueSoonHours ?? 4),
  }
}

function parseDigestHours(value: string): number[] | null {
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  if (items.length === 0 || items.length > 8) return null
  const seen = new Set<number>()
  const hours: number[] = []
  for (const item of items) {
    const hour = Number(item)
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null
    if (!seen.has(hour)) {
      seen.add(hour)
      hours.push(hour)
    }
  }
  return hours.sort((a, b) => a - b)
}

export default function NotificationSettingsPanel({
  settings,
  loading,
  saving,
  disabled,
  onSave,
  onRefresh,
}: NotificationSettingsPanelProps) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<NotificationSettingsDraft>(() => draftFromSettings(settings))
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setDraft(draftFromSettings(settings))
    setError(null)
  }, [settings])

  const statusLabel = loading
    ? '確認中'
    : settings?.enabled && settings.webhookConfigured
      ? '有効'
      : settings?.enabled
        ? 'URL未設定'
        : '停止中'

  const digestHours = useMemo(() => parseDigestHours(draft.digestHoursText), [draft.digestHoursText])
  const dueSoonHours = Number(draft.dueSoonHours)
  const canSubmit =
    !disabled &&
    !saving &&
    !loading &&
    digestHours !== null &&
    Number.isInteger(dueSoonHours) &&
    dueSoonHours >= 1 &&
    dueSoonHours <= 72

  const handleSave = async () => {
    if (!digestHours || !Number.isInteger(dueSoonHours) || dueSoonHours < 1 || dueSoonHours > 72) {
      setError('通知時刻と期限間近の時間を確認してください')
      return
    }
    setError(null)
    const webhookUrl = draft.webhookUrl.trim()
    const ok = await onSave({
      enabled: draft.enabled,
      ...(webhookUrl ? { webhookUrl } : {}),
      immediateUrgent: draft.immediateUrgent,
      digestEnabled: draft.digestEnabled,
      digestHours,
      dueSoonHours,
    })
    if (ok) setOpen(false)
  }

  return (
    <section className="rounded-md border border-gray-200 bg-white px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-gray-900">Slack通知</h2>
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
              statusLabel === '有効'
                ? 'bg-green-100 text-green-700'
                : statusLabel === 'URL未設定'
                  ? 'bg-amber-100 text-amber-700'
                  : 'bg-gray-100 text-gray-500'
            }`}>
              {statusLabel}
            </span>
          </div>
          <p className="mt-1 text-xs text-gray-500">
            大至急は即時、通常案件は指定時刻にまとめて通知します
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onRefresh}
            disabled={disabled || loading}
            className="rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-gray-600 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            更新
          </button>
          <button
            type="button"
            onClick={() => setOpen((prev) => !prev)}
            disabled={disabled}
            className={btnSecondaryCls}
            aria-expanded={open}
          >
            {open ? '閉じる' : '設定'}
          </button>
        </div>
      </div>

      {open && (
        <div className="mt-4 grid gap-4 border-t border-gray-100 pt-4 md:grid-cols-2">
          <label className="flex items-center gap-2 text-sm font-medium text-gray-700">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) => setDraft((prev) => ({ ...prev, enabled: event.target.checked }))}
              disabled={disabled || saving}
              className="h-4 w-4 rounded border-gray-300 text-green-600 focus:ring-green-500"
            />
            Slack通知を有効にする
          </label>
          <label className="flex items-center gap-2 text-sm font-medium text-gray-700">
            <input
              type="checkbox"
              checked={draft.immediateUrgent}
              onChange={(event) => setDraft((prev) => ({ ...prev, immediateUrgent: event.target.checked }))}
              disabled={disabled || saving}
              className="h-4 w-4 rounded border-gray-300 text-green-600 focus:ring-green-500"
            />
            大至急をすぐ通知
          </label>

          <div className="md:col-span-2">
            <Field
              label="Slack Webhook URL"
              hint={settings?.webhookConfigured ? '設定済み。変更するときだけ新しいURLを貼り付け' : '未設定'}
            >
              <input
                value={draft.webhookUrl}
                onChange={(event) => setDraft((prev) => ({ ...prev, webhookUrl: event.target.value }))}
                disabled={disabled || saving}
                placeholder="https://hooks.slack.com/services/..."
                className={inputCls}
              />
            </Field>
          </div>

          <label className="flex items-center gap-2 text-sm font-medium text-gray-700">
            <input
              type="checkbox"
              checked={draft.digestEnabled}
              onChange={(event) => setDraft((prev) => ({ ...prev, digestEnabled: event.target.checked }))}
              disabled={disabled || saving}
              className="h-4 w-4 rounded border-gray-300 text-green-600 focus:ring-green-500"
            />
            定時まとめを送る
          </label>

          <Field label="通知時刻" hint="0から23の数字をカンマ区切り">
            <input
              value={draft.digestHoursText}
              onChange={(event) => setDraft((prev) => ({ ...prev, digestHoursText: event.target.value }))}
              disabled={disabled || saving}
              className={inputCls}
              inputMode="numeric"
            />
          </Field>

          <Field label="期限間近として見る時間" hint="1から72時間">
            <input
              value={draft.dueSoonHours}
              onChange={(event) => setDraft((prev) => ({ ...prev, dueSoonHours: event.target.value }))}
              disabled={disabled || saving}
              className={inputCls}
              inputMode="numeric"
            />
          </Field>

          {error && (
            <p className="md:col-span-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2 md:col-span-2">
            <button
              type="button"
              onClick={() => setDraft(draftFromSettings(settings))}
              disabled={disabled || saving}
              className={btnSecondaryCls}
            >
              戻す
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={!canSubmit}
              className="rounded-md bg-green-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

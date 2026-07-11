'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, type WebPushSettings as WebPushPreferenceSettings } from '@/lib/api'

type PushState = 'loading' | 'unsupported' | 'not_configured' | 'default' | 'denied' | 'enabled' | 'disabled'
type PreferenceKey = keyof WebPushPreferenceSettings

const defaultSettings: WebPushPreferenceSettings = {
  notifyUrgent: true,
  notifySecondary: true,
  notifyMentions: true,
}

function BellIcon({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  )
}

function base64UrlToArrayBuffer(value: string): ArrayBuffer {
  const padding = '='.repeat((4 - (value.length % 4)) % 4)
  const base64 = `${value}${padding}`.replace(/-/g, '+').replace(/_/g, '/')
  const raw = window.atob(base64)
  const output = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i)
  return output.buffer as ArrayBuffer
}

function isPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

async function showChromeTestNotification(): Promise<boolean> {
  if (!isPushSupported() || Notification.permission !== 'granted') return false
  const registration =
    await navigator.serviceWorker.getRegistration('/push-sw.js') ||
    await navigator.serviceWorker.register('/push-sw.js')
  await registration.showNotification('Lリンク 通知テスト', {
    body: 'Chrome通知の表示テストです。',
    tag: `line-harness-test-${Date.now()}`,
    data: {
      url: '/notification-settings',
    },
  })
  return true
}

function stateLabel(state: PushState): string {
  switch (state) {
    case 'loading':
      return '確認中'
    case 'unsupported':
      return '非対応'
    case 'not_configured':
      return '準備中'
    case 'denied':
      return '拒否中'
    case 'enabled':
      return '有効'
    case 'disabled':
      return '未登録'
    default:
      return '未許可'
  }
}

function Toggle({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean
  disabled?: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? 'bg-slate-900' : 'bg-slate-300'
      }`}
    >
      <span
        className={`absolute left-0 top-1 h-5 w-5 rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
    </button>
  )
}

export default function WebPushSettings() {
  const [state, setState] = useState<PushState>('loading')
  const [publicKey, setPublicKey] = useState('')
  const [endpoint, setEndpoint] = useState('')
  const [settings, setSettings] = useState<WebPushPreferenceSettings>(defaultSettings)
  const [busy, setBusy] = useState(false)
  const [savingPreference, setSavingPreference] = useState<PreferenceKey | null>(null)
  const [message, setMessage] = useState('')

  const canEnable = useMemo(() => (
    state === 'default' || state === 'disabled'
  ), [state])
  const canDisable = state === 'enabled'
  const canTest = state === 'enabled'

  const refresh = useCallback(async () => {
    setMessage('')
    if (!isPushSupported()) {
      setState('unsupported')
      return
    }
    try {
      const config = await api.appNotifications.webPushConfig()
      if (!config.success || !config.data.enabled || !config.data.publicKey) {
        setState('not_configured')
        return
      }
      setPublicKey(config.data.publicKey)
      if (Notification.permission === 'denied') {
        setState('denied')
        return
      }
      const registration = await navigator.serviceWorker.register('/push-sw.js')
      const subscription = await registration.pushManager.getSubscription()
      setEndpoint(subscription?.endpoint ?? '')
      if (subscription?.endpoint) {
        const status = await api.appNotifications.webPushStatus(subscription.endpoint)
        if (status.success && status.data.settings) {
          setSettings(status.data.settings)
        }
        setState(status.success && status.data.subscribed ? 'enabled' : 'disabled')
        return
      }
      setSettings(defaultSettings)
      setState(Notification.permission === 'granted' ? 'disabled' : 'default')
    } catch {
      setState('disabled')
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const enable = async () => {
    if (!isPushSupported() || !publicKey) return
    setBusy(true)
    setMessage('')
    try {
      const permission = await Notification.requestPermission()
      if (permission === 'denied') {
        setState('denied')
        setMessage('Chrome側で通知が拒否されています。')
        return
      }
      if (permission !== 'granted') {
        setState('default')
        return
      }
      const registration = await navigator.serviceWorker.register('/push-sw.js')
      const existing = await registration.pushManager.getSubscription()
      const subscription = existing ?? await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlToArrayBuffer(publicKey),
      })
      const json = subscription.toJSON()
      if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
        throw new Error('invalid_subscription')
      }
      await api.appNotifications.subscribeWebPush({
        ...json,
        userAgent: navigator.userAgent,
      })
      setEndpoint(json.endpoint)
      const status = await api.appNotifications.webPushStatus(json.endpoint)
      if (status.success && status.data.settings) setSettings(status.data.settings)
      setState('enabled')
      setMessage('PC通知を有効にしました。')
    } catch {
      setMessage('PC通知の登録に失敗しました。')
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const disable = async () => {
    if (!isPushSupported()) return
    setBusy(true)
    setMessage('')
    try {
      const registration = await navigator.serviceWorker.getRegistration('/push-sw.js')
      const subscription = await registration?.pushManager.getSubscription()
      if (subscription?.endpoint) {
        await api.appNotifications.unsubscribeWebPush(subscription.endpoint)
        await subscription.unsubscribe()
      }
      setEndpoint('')
      setSettings(defaultSettings)
      setState('disabled')
      setMessage('PC通知を停止しました。')
    } catch {
      setMessage('PC通知の停止に失敗しました。')
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const test = async () => {
    setBusy(true)
    setMessage('')
    try {
      const res = await api.appNotifications.testWebPush()
      if (res.success && res.data.sent > 0) {
        const displayed = await showChromeTestNotification().catch(() => false)
        setMessage(
          displayed
            ? 'テスト通知を送信し、Chromeにも表示しました。'
            : 'テスト通知を送信しました。表示されない場合はChromeまたはmacOS側の通知設定を確認してください。',
        )
      } else {
        setMessage('送信先が見つかりませんでした。')
      }
    } catch {
      setMessage('テスト通知に失敗しました。')
    } finally {
      setBusy(false)
    }
  }

  const updatePreference = async (key: PreferenceKey, value: boolean) => {
    if (!endpoint) return
    const previous = settings
    setSettings((current) => ({ ...current, [key]: value }))
    setSavingPreference(key)
    setMessage('')
    try {
      const res = await api.appNotifications.updateWebPushSettings(endpoint, { [key]: value })
      if (res.success && res.data.settings) {
        setSettings(res.data.settings)
      }
    } catch {
      setSettings(previous)
      setMessage('通知設定の更新に失敗しました。')
    } finally {
      setSavingPreference(null)
    }
  }

  const preferenceRows: Array<{
    key: PreferenceKey
    title: string
    description: string
  }> = [
    {
      key: 'notifyMentions',
      title: '社内チャットのメンション',
      description: '@名前 で呼ばれた時に通知',
    },
    {
      key: 'notifySecondary',
      title: '二次対応',
      description: '依頼・回答が入った時に通知',
    },
    {
      key: 'notifyUrgent',
      title: '大至急',
      description: '大至急チケットを通知',
    },
  ]

  return (
    <section className="rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="p-4">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-3">
          <span className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-slate-900 text-white">
            <BellIcon />
          </span>
          <div>
            <h2 className="text-base font-bold text-slate-900">Chrome PC通知</h2>
            <div className="mt-1 flex items-center gap-2 text-sm text-slate-500">
              <span>状態</span>
              <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${
                state === 'enabled'
                  ? 'bg-emerald-50 text-emerald-700'
                  : state === 'denied'
                    ? 'bg-red-50 text-red-700'
                    : 'bg-slate-100 text-slate-600'
              }`}>
                {stateLabel(state)}
              </span>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {canEnable && (
            <button
              type="button"
              onClick={enable}
              disabled={busy}
              className="min-h-10 rounded-md bg-slate-900 px-4 py-2 text-sm font-bold text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              通知を許可
            </button>
          )}
          {canTest && (
            <button
              type="button"
              onClick={test}
              disabled={busy}
              className="min-h-10 rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              テスト通知
            </button>
          )}
          {canDisable && (
            <button
              type="button"
              onClick={disable}
              disabled={busy}
              className="min-h-10 rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-bold text-slate-500 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              停止
            </button>
          )}
        </div>
      </div>
      {message && (
        <p className="mt-3 rounded-md bg-slate-50 px-3 py-2 text-sm font-medium text-slate-700">
          {message}
        </p>
      )}
      </div>
      {state === 'enabled' && (
        <div className="border-t border-slate-200 p-4">
          <h3 className="text-sm font-bold text-slate-900">通知メニュー</h3>
          <div className="mt-3 divide-y divide-slate-100 rounded-lg border border-slate-200">
            {preferenceRows.map((row) => (
              <div key={row.key} className="flex items-center justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-bold text-slate-900">{row.title}</p>
                  <p className="mt-0.5 text-xs text-slate-500">{row.description}</p>
                </div>
                <Toggle
                  checked={settings[row.key]}
                  disabled={Boolean(savingPreference)}
                  onChange={(next) => void updatePreference(row.key, next)}
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

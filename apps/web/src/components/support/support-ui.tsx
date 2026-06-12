'use client'

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { dueTimePresets, dueUrgency, formatDateTime, formatRelativeDue } from './support-meta'

// ─── 入力スタイル (画面全体で統一) ───

export const inputCls =
  'w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 transition-shadow focus:border-green-500 focus:outline-none focus:ring-2 focus:ring-green-500/30 disabled:bg-gray-50 disabled:text-gray-400'

export const selectCls = inputCls

export const textareaCls = `${inputCls} resize-y leading-relaxed`

export const btnPrimaryCls =
  'inline-flex items-center justify-center gap-1.5 rounded-md bg-gray-900 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-500 disabled:cursor-not-allowed disabled:opacity-50'

export const btnBrandCls =
  'inline-flex items-center justify-center gap-1.5 rounded-md bg-green-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-green-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 disabled:cursor-not-allowed disabled:opacity-50'

export const btnSecondaryCls =
  'inline-flex items-center justify-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 disabled:cursor-not-allowed disabled:opacity-50'

// ─── 汎用パーツ ───

export function Pill({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-medium ${className}`}>
      {children}
    </span>
  )
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <label className="block">
      <span className="mb-1 flex items-baseline justify-between gap-2">
        <span className="block text-xs font-medium text-gray-600">{label}</span>
        {hint && <span className="text-[11px] text-gray-400">{hint}</span>}
      </span>
      {children}
    </label>
  )
}

/** 期限の絶対時刻 + 相対表現 (色は緊急度で変化) */
export function DueBadge({ value, prefix = '期限' }: { value: string | null | undefined; prefix?: string }) {
  const urgency = dueUrgency(value)
  if (urgency === 'none') {
    return <span className="text-xs text-gray-400">{prefix}未設定</span>
  }
  const tone =
    urgency === 'overdue'
      ? 'text-red-700 font-semibold'
      : urgency === 'soon'
        ? 'text-amber-700 font-semibold'
        : 'text-gray-500'
  return (
    <span className={`inline-flex items-center gap-1 text-xs ${tone}`}>
      <ClockIcon className="h-3.5 w-3.5" />
      {prefix} {formatDateTime(value)}（{formatRelativeDue(value)}）
    </span>
  )
}

/** datetime-local 入力の下に出す時刻プリセット */
export function DueTimePresetRow({
  onApply,
  hasValue,
  disabled = false,
}: {
  onApply: (value: string) => void
  hasValue: boolean
  disabled?: boolean
}) {
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {dueTimePresets.map((preset) => (
        <button
          key={preset.label}
          type="button"
          onClick={() => onApply(preset.compute())}
          disabled={disabled}
          className="rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[11px] font-medium text-gray-600 transition-colors hover:border-green-300 hover:bg-green-50 hover:text-green-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {preset.label}
        </button>
      ))}
      {hasValue && (
        <button
          type="button"
          onClick={() => onApply('')}
          disabled={disabled}
          className="rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[11px] font-medium text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          クリア
        </button>
      )}
    </div>
  )
}

// ─── アイコン ───

interface IconProps {
  className?: string
}

export function FlameIcon({ className = 'h-3.5 w-3.5' }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8.5 14.5A4.5 4.5 0 0 0 13 19a5 5 0 0 0 5-5c0-4-4-5.5-4-9-2.5 1.5-4 3.5-4 6a4 4 0 0 1-2-3c-2 1.5-3 3.5-3 6a8 8 0 0 0 8 8" />
    </svg>
  )
}

export function ClockIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  )
}

export function CopyIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  )
}

export function CheckIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 13l4 4L19 7" />
    </svg>
  )
}

export function XIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
}

export function PlusIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

export function SearchIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  )
}

export function ChatIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 0 1-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
    </svg>
  )
}

// ─── 確認ダイアログ ───

export type ConfirmTone = 'default' | 'warning' | 'danger'

export interface ConfirmDialogOptions {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  tone?: ConfirmTone
}

function ConfirmDialog({
  options,
  onResolve,
}: {
  options: ConfirmDialogOptions
  onResolve: (confirmed: boolean) => void
}) {
  const titleId = useId()
  const messageId = useId()
  const tone = options.tone ?? 'default'
  const confirmToneCls =
    tone === 'danger'
      ? 'bg-red-600 text-white hover:bg-red-700 focus-visible:ring-red-500'
      : tone === 'warning'
        ? 'bg-amber-500 text-white hover:bg-amber-600 focus-visible:ring-amber-500'
        : 'bg-gray-900 text-white hover:bg-gray-700 focus-visible:ring-gray-500'

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onResolve(false)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onResolve])

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={messageId}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onResolve(false)
      }}
    >
      <div className="w-full max-w-sm rounded-lg border border-gray-200 bg-white p-4 shadow-xl">
        <h2 id={titleId} className="text-base font-semibold text-gray-900">{options.title}</h2>
        <p id={messageId} className="mt-2 whitespace-pre-wrap text-sm leading-6 text-gray-600">{options.message}</p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => onResolve(false)}
            autoFocus
            className={btnSecondaryCls}
          >
            {options.cancelLabel ?? 'キャンセル'}
          </button>
          <button
            type="button"
            onClick={() => onResolve(true)}
            className={`inline-flex items-center justify-center gap-1.5 rounded-md px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50 ${confirmToneCls}`}
          >
            {options.confirmLabel ?? '実行'}
          </button>
        </div>
      </div>
    </div>
  )
}

export function useConfirmDialog() {
  const [options, setOptions] = useState<ConfirmDialogOptions | null>(null)
  const resolverRef = useRef<((confirmed: boolean) => void) | null>(null)

  const close = useCallback((confirmed: boolean) => {
    resolverRef.current?.(confirmed)
    resolverRef.current = null
    setOptions(null)
  }, [])

  const requestConfirm = useCallback((nextOptions: ConfirmDialogOptions) => {
    resolverRef.current?.(false)
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve
      setOptions(nextOptions)
    })
  }, [])

  useEffect(() => () => resolverRef.current?.(false), [])

  const confirmDialog = options ? <ConfirmDialog options={options} onResolve={close} /> : null

  return { requestConfirm, confirmDialog }
}

// ─── トースト通知 ───

export type ToastKind = 'success' | 'error'

export interface ToastItem {
  id: number
  kind: ToastKind
  message: string
}

const TOAST_SUCCESS_MS = 2400
const TOAST_ERROR_MS = 8000

export function useToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const idRef = useRef(0)

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((item) => item.id !== id))
  }, [])

  const notify = useCallback((kind: ToastKind, message: string) => {
    idRef.current += 1
    const id = idRef.current
    setToasts((prev) => [...prev.slice(-3), { id, kind, message }])
    const ttl = kind === 'success' ? TOAST_SUCCESS_MS : TOAST_ERROR_MS
    setTimeout(() => dismissToast(id), ttl)
  }, [dismissToast])

  return { toasts, notify, dismissToast }
}

export function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[]
  onDismiss: (id: number) => void
}) {
  if (toasts.length === 0) return null
  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-50 flex w-[min(20rem,calc(100vw-2.5rem))] flex-col gap-2" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`pointer-events-auto flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm shadow-lg ${
            toast.kind === 'success'
              ? 'border-green-200 bg-white text-green-800'
              : 'border-red-200 bg-white text-red-800'
          }`}
        >
          <span className={`mt-0.5 shrink-0 rounded-full p-0.5 ${toast.kind === 'success' ? 'bg-green-100 text-green-600' : 'bg-red-100 text-red-600'}`}>
            {toast.kind === 'success' ? <CheckIcon className="h-3 w-3" /> : <XIcon className="h-3 w-3" />}
          </span>
          <span className="min-w-0 flex-1 break-words">{toast.message}</span>
          <button
            type="button"
            onClick={() => onDismiss(toast.id)}
            className="shrink-0 rounded p-0.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
            aria-label="通知を閉じる"
          >
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  )
}

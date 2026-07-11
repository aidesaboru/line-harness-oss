'use client'

import { useEffect, useMemo, useState } from 'react'
import type { SupportPriority } from '@/lib/api'
import { categoryOptions, getCreateCaseValidationIssues, priorityOptions } from './support-meta'
import { btnBrandCls, btnSecondaryCls, Field, inputCls, selectCls, textareaCls, DueTimePresetRow, XIcon } from './support-ui'

export interface ChatOption {
  id: string
  friendId: string
  friendName?: string
  friendPictureUrl?: string | null
  lastMessageAt?: string | null
  lastMessageContent?: string | null
}

export interface CreateCaseInput {
  friendId: string
  title: string
  category: string
  priority: SupportPriority
  primaryAssignee: string
  escalationAssignee: string
  dueAt: string
  customerSummary: string
}

interface CreateCasePanelProps {
  chats: ChatOption[]
  staffName: string
  staffOptions: string[]
  initialFriendId?: string | null
  saving: boolean
  onCreate: (input: CreateCaseInput) => Promise<boolean>
  onClose: () => void
}

type LinkMode = 'chat' | 'manual'

function emptyForm(staffName: string): CreateCaseInput {
  return {
    friendId: '',
    title: '',
    category: 'other',
    priority: 'medium',
    primaryAssignee: staffName,
    escalationAssignee: '',
    dueAt: '',
    customerSummary: '',
  }
}

function uniqueNames(names: Array<string | null | undefined>): string[] {
  return Array.from(new Set(names.map((name) => name?.trim()).filter(Boolean) as string[])).sort((a, b) => a.localeCompare(b, 'ja'))
}

export default function CreateCasePanel({
  chats,
  staffName,
  staffOptions,
  initialFriendId,
  saving,
  onCreate,
  onClose,
}: CreateCasePanelProps) {
  const [form, setForm] = useState<CreateCaseInput>(() => emptyForm(staffName))
  const [linkMode, setLinkMode] = useState<LinkMode>('chat')

  const selectedChat = chats.find((chat) => chat.friendId === form.friendId)
  const mergedStaffOptions = useMemo(() => uniqueNames([staffName, ...staffOptions]), [staffName, staffOptions])
  const validationIssues = getCreateCaseValidationIssues(form)
  const blockingValidationIssues = validationIssues.filter((issue) => issue.blocking)
  const submitDisabled = saving || blockingValidationIssues.length > 0

  const handleSelectChat = (friendId: string) => {
    setForm((prev) => {
      const chat = chats.find((item) => item.friendId === friendId)
      const next = { ...prev, friendId }
      if (!prev.customerSummary.trim() && chat?.lastMessageContent) {
        next.customerSummary = chat.lastMessageContent.slice(0, 500)
      }
      if (!prev.title.trim() && chat?.lastMessageContent) {
        next.title = chat.lastMessageContent.slice(0, 42)
      }
      return next
    })
  }

  useEffect(() => {
    if (!initialFriendId) return
    setLinkMode('chat')
    setForm((prev) => {
      const chat = chats.find((item) => item.friendId === initialFriendId)
      const next = { ...prev, friendId: initialFriendId }
      if (!prev.customerSummary.trim() && chat?.lastMessageContent) {
        next.customerSummary = chat.lastMessageContent.slice(0, 500)
      }
      if (!prev.title.trim() && chat?.lastMessageContent) {
        next.title = chat.lastMessageContent.slice(0, 42)
      }
      return next
    })
  }, [chats, initialFriendId])

  const handleLinkModeChange = (mode: LinkMode) => {
    setLinkMode(mode)
    if (mode === 'manual') setForm((prev) => ({ ...prev, friendId: '' }))
  }

  const handleSubmit = async () => {
    if (submitDisabled) return
    const ok = await onCreate(form)
    if (ok) {
      setForm(emptyForm(staffName))
      setLinkMode('chat')
      onClose()
    }
  }

  return (
    <section
      className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm ring-1 ring-black/[0.02]"
      aria-label="新規チケットの作成"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !saving) onClose()
      }}
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-4">
        <div>
          <p className="text-[11px] font-semibold uppercase text-slate-400">Create Ticket</p>
          <h2 className="mt-1 text-lg font-semibold text-slate-950">新規チケット</h2>
          <p className="mt-1 text-sm text-slate-500">LINE会話を紐付けるか、内容を手入力してチケットを作成します。</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          disabled={saving}
          className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50"
          aria-label="チケット作成フォームを閉じる"
        >
          <XIcon />
        </button>
      </div>

      <fieldset disabled={saving} className="mt-4 disabled:opacity-70">
        {validationIssues.length > 0 && (
          <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
            <p className="font-semibold">チケット化前に必要な入力があります</p>
            <ul className="mt-1 space-y-1">
              {validationIssues.map((issue) => (
                <li key={issue.key} className="flex items-start gap-2">
                  <span className="mt-0.5 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-700">
                    必須
                  </span>
                  <span>
                    <span className="font-medium">{issue.fieldLabel}: </span>
                    {issue.message}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)]">
          <div className="space-y-4">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
              <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="LINE会話の紐付け方法">
                {[
                  { key: 'chat' as const, label: 'LINE会話を紐付ける' },
                  { key: 'manual' as const, label: '手入力で作成' },
                ].map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => handleLinkModeChange(item.key)}
                    className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                      linkMode === item.key
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-800 ring-1 ring-emerald-100'
                        : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-900'
                    }`}
                    aria-pressed={linkMode === item.key}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              {linkMode === 'chat' && (
                <div className="mt-3">
                  <Field label="LINE会話">
                    <select
                      value={form.friendId}
                      onChange={(e) => handleSelectChat(e.target.value)}
                      className={selectCls}
                    >
                      <option value="">会話を選択</option>
                      {chats.map((chat) => (
                        <option key={chat.friendId} value={chat.friendId}>
                          {chat.friendName || chat.friendId} {chat.lastMessageContent ? `- ${chat.lastMessageContent.slice(0, 32)}` : ''}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {selectedChat?.lastMessageContent && (
                    <p className="mt-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs leading-5 text-slate-500">
                      {selectedChat.lastMessageContent}
                    </p>
                  )}
                </div>
              )}
            </div>

            <div className="grid gap-3 lg:grid-cols-[1fr_220px]">
              <Field label="件名" hint="空欄の場合は問い合わせ内容から自動補完">
                <input
                  value={form.title}
                  onChange={(e) => setForm((prev) => ({ ...prev, title: e.target.value }))}
                  placeholder="問い合わせ件名"
                  className={inputCls}
                />
              </Field>
              <Field label="種別">
                <select
                  value={form.category}
                  onChange={(e) => setForm((prev) => ({ ...prev, category: e.target.value }))}
                  className={selectCls}
                >
                  {categoryOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                </select>
              </Field>
            </div>

            <Field label="問い合わせ内容" hint="要約せず、顧客からの相談内容をそのまま残します">
              <textarea
                value={form.customerSummary}
                onChange={(e) => setForm((prev) => ({ ...prev, customerSummary: e.target.value }))}
                rows={7}
                placeholder="顧客の相談内容、確認したいこと、会話から拾った重要な文面"
                className={`${textareaCls} min-h-[180px]`}
              />
            </Field>
          </div>

          <div className="space-y-4 rounded-xl border border-slate-200 bg-slate-50 p-3">
            <div>
              <p className="text-xs font-semibold text-slate-500">緊急度</p>
              <div className="mt-2 grid grid-cols-3 gap-2">
                {priorityOptions.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => setForm((prev) => ({ ...prev, priority: item.value }))}
                    className={`rounded-lg border px-2 py-2 text-sm font-medium transition-colors ${
                      form.priority === item.value
                        ? item.value === 'urgent'
                          ? 'border-red-200 bg-red-100 text-red-700 ring-1 ring-red-100'
                          : item.value === 'high'
                            ? 'border-orange-200 bg-orange-100 text-orange-700 ring-1 ring-orange-100'
                            : 'border-emerald-200 bg-emerald-50 text-emerald-800 ring-1 ring-emerald-100'
                        : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-900'
                    }`}
                    aria-pressed={form.priority === item.value}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p className="text-xs font-semibold text-slate-500">一次担当者</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setForm((prev) => ({ ...prev, primaryAssignee: '' }))}
                  className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                    !form.primaryAssignee
                      ? 'border-amber-400 bg-amber-100 text-amber-800'
                      : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300'
                  }`}
                  aria-pressed={!form.primaryAssignee}
                >
                  未設定
                </button>
                {mergedStaffOptions.map((name) => (
                  <button
                    key={name}
                    type="button"
                    onClick={() => setForm((prev) => ({ ...prev, primaryAssignee: name }))}
                    className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                      form.primaryAssignee === name
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-800 ring-1 ring-emerald-100'
                        : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-900'
                    }`}
                    aria-pressed={form.primaryAssignee === name}
                  >
                    {name}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p className="text-xs font-semibold text-slate-500">二次対応の担当者</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setForm((prev) => ({ ...prev, escalationAssignee: '' }))}
                  className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                    !form.escalationAssignee
                      ? 'border-slate-300 bg-white text-slate-700'
                      : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300'
                  }`}
                  aria-pressed={!form.escalationAssignee}
                >
                  未設定
                </button>
                {mergedStaffOptions.map((name) => (
                  <button
                    key={name}
                    type="button"
                    onClick={() => setForm((prev) => ({ ...prev, escalationAssignee: name }))}
                    className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                      form.escalationAssignee === name
                        ? 'border-indigo-600 bg-indigo-600 text-white'
                        : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-900'
                    }`}
                    aria-pressed={form.escalationAssignee === name}
                  >
                    {name}
                  </button>
                ))}
              </div>
            </div>

            <Field label="期限">
              <input
                type="datetime-local"
                value={form.dueAt}
                onChange={(e) => setForm((prev) => ({ ...prev, dueAt: e.target.value }))}
                className={inputCls}
              />
              <DueTimePresetRow
                hasValue={Boolean(form.dueAt)}
                onApply={(value) => setForm((prev) => ({ ...prev, dueAt: value }))}
                disabled={saving}
              />
            </Field>

            <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
              <p className="text-xs font-semibold text-slate-700">作成後の表示</p>
              <p className="mt-1 text-xs leading-5 text-slate-500">
                二次担当者を選ぶと、二次対応タブにも回答依頼として自動で表示されます。
              </p>
            </div>
          </div>
        </div>
      </fieldset>

      <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 pt-4">
        <button type="button" onClick={onClose} disabled={saving} className={btnSecondaryCls}>
          キャンセル
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={submitDisabled}
          title={blockingValidationIssues[0]?.message}
          className={btnBrandCls}
        >
          {saving ? '作成中...' : 'チケットを作成'}
        </button>
      </div>
    </section>
  )
}

'use client'

import { useState } from 'react'
import type { SupportPriority } from '@/lib/api'
import { categoryOptions, priorityOptions } from './support-meta'
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
  dueAt: string
  customerSummary: string
}

interface CreateCasePanelProps {
  chats: ChatOption[]
  staffName: string
  saving: boolean
  onCreate: (input: CreateCaseInput) => Promise<boolean>
  onClose: () => void
}

function emptyForm(staffName: string): CreateCaseInput {
  return {
    friendId: '',
    title: '',
    category: 'other',
    priority: 'medium',
    primaryAssignee: staffName,
    dueAt: '',
    customerSummary: '',
  }
}

/**
 * チャットからの案件化フォーム。
 * 会話を選ぶと問い合わせ要約に最終メッセージを自動引用する (件名未入力時はサーバ側が要約から補完)。
 */
export default function CreateCasePanel({ chats, staffName, saving, onCreate, onClose }: CreateCasePanelProps) {
  const [form, setForm] = useState<CreateCaseInput>(() => emptyForm(staffName))

  const selectedChat = chats.find((chat) => chat.friendId === form.friendId)

  const handleSelectChat = (friendId: string) => {
    setForm((prev) => {
      const chat = chats.find((item) => item.friendId === friendId)
      const next = { ...prev, friendId }
      // 要約が空なら会話の最終メッセージを引用して二度打ちを防ぐ
      if (!prev.customerSummary.trim() && chat?.lastMessageContent) {
        next.customerSummary = chat.lastMessageContent.slice(0, 200)
      }
      return next
    })
  }

  const handleSubmit = async () => {
    const ok = await onCreate(form)
    if (ok) {
      setForm(emptyForm(staffName))
      onClose()
    }
  }

  return (
    <section
      className="rounded-lg border border-green-200 bg-green-50/40 p-4"
      aria-label="新規案件の作成"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose()
      }}
    >
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-900">チャットから案件化</h2>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-gray-400 transition-colors hover:bg-white hover:text-gray-600"
          aria-label="案件化フォームを閉じる"
        >
          <XIcon />
        </button>
      </div>

      <div className="grid gap-3 lg:grid-cols-[1.2fr_1fr_0.7fr_0.7fr]">
        <Field label="LINE会話" hint="選ぶと要約に最終メッセージを引用">
          <select
            value={form.friendId}
            onChange={(e) => handleSelectChat(e.target.value)}
            className={selectCls}
          >
            <option value="">会話に紐付けない（手入力）</option>
            {chats.map((chat) => (
              <option key={chat.friendId} value={chat.friendId}>
                {chat.friendName || chat.friendId} {chat.lastMessageContent ? `- ${chat.lastMessageContent.slice(0, 32)}` : ''}
              </option>
            ))}
          </select>
        </Field>
        <Field label="件名" hint="空欄なら要約から自動生成">
          <input
            value={form.title}
            onChange={(e) => setForm((prev) => ({ ...prev, title: e.target.value }))}
            placeholder={selectedChat?.lastMessageContent?.slice(0, 40) || '問い合わせ件名'}
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
        <Field label="優先度">
          <select
            value={form.priority}
            onChange={(e) => setForm((prev) => ({ ...prev, priority: e.target.value as SupportPriority }))}
            className={selectCls}
          >
            {priorityOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </Field>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-[0.7fr_0.8fr_1.5fr]">
        <Field label="一次担当">
          <input
            value={form.primaryAssignee}
            onChange={(e) => setForm((prev) => ({ ...prev, primaryAssignee: e.target.value }))}
            placeholder={staffName || '担当者名'}
            className={inputCls}
            list="support-staff-names"
          />
        </Field>
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
          />
        </Field>
        <Field label="問い合わせ要約">
          <textarea
            value={form.customerSummary}
            onChange={(e) => setForm((prev) => ({ ...prev, customerSummary: e.target.value }))}
            rows={2}
            placeholder="顧客の状況を短く"
            className={textareaCls}
          />
        </Field>
      </div>

      <div className="mt-3 flex items-center justify-end gap-2">
        <button type="button" onClick={onClose} className={btnSecondaryCls}>
          キャンセル
        </button>
        <button type="button" onClick={handleSubmit} disabled={saving} className={btnBrandCls}>
          {saving ? '作成中…' : '案件化する'}
        </button>
      </div>
    </section>
  )
}

'use client'

import { useState } from 'react'
import type { SupportKnowledgeImport } from '@/lib/api'
import { categoryLabel, categoryOptions, formatDateTime } from './support-meta'
import {
  CheckIcon,
  Field,
  Pill,
  btnBrandCls,
  btnSecondaryCls,
  inputCls,
  selectCls,
  textareaCls,
} from './support-ui'

type KnowledgeImportDraft = {
  title: string
  category: string
  question: string
  answer: string
  body: string
  keywords: string
}

export type SlackKnowledgeImportDraft = KnowledgeImportDraft

interface SlackKnowledgeImportPanelProps {
  items: SupportKnowledgeImport[]
  canManage: boolean
  saving: boolean
  syncing: boolean
  channelId: string
  channelName: string
  importLimit: number
  nextCursor: string | null
  statusFilter: 'draft' | 'published' | 'dismissed' | 'all'
  search: string
  onChannelIdChange: (value: string) => void
  onChannelNameChange: (value: string) => void
  onImportLimitChange: (value: number) => void
  onStatusFilterChange: (value: 'draft' | 'published' | 'dismissed' | 'all') => void
  onSearchChange: (value: string) => void
  onSync: (cursor?: string | null) => Promise<void>
  onUpdate: (item: SupportKnowledgeImport, input: KnowledgeImportDraft) => Promise<boolean>
  onPublish: (item: SupportKnowledgeImport) => Promise<boolean>
  onDismiss: (item: SupportKnowledgeImport) => Promise<boolean>
}

function draftFromItem(item: SupportKnowledgeImport): KnowledgeImportDraft {
  return {
    title: item.title,
    category: item.category,
    question: item.question,
    answer: item.answer,
    body: item.body,
    keywords: item.keywords,
  }
}

function statusTone(status: SupportKnowledgeImport['status']): string {
  if (status === 'published') return 'border-green-200 bg-green-50 text-green-700'
  if (status === 'dismissed') return 'border-slate-200 bg-slate-50 text-slate-500'
  return 'border-amber-200 bg-amber-50 text-amber-700'
}

function statusLabel(status: SupportKnowledgeImport['status']): string {
  if (status === 'published') return '公開済み'
  if (status === 'dismissed') return '却下'
  return '下書き'
}

export default function SlackKnowledgeImportPanel({
  items,
  canManage,
  saving,
  syncing,
  channelId,
  channelName,
  importLimit,
  nextCursor,
  statusFilter,
  search,
  onChannelIdChange,
  onChannelNameChange,
  onImportLimitChange,
  onStatusFilterChange,
  onSearchChange,
  onSync,
  onUpdate,
  onPublish,
  onDismiss,
}: SlackKnowledgeImportPanelProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<KnowledgeImportDraft | null>(null)
  const disabled = saving || syncing || !canManage
  const draftCount = items.filter((item) => item.status === 'draft').length
  const publishedCount = items.filter((item) => item.status === 'published').length

  const openEdit = (item: SupportKnowledgeImport) => {
    setEditingId(item.id)
    setDraft(draftFromItem(item))
  }

  const closeEdit = () => {
    setEditingId(null)
    setDraft(null)
  }

  const submitUpdate = async (item: SupportKnowledgeImport) => {
    if (!draft) return
    const ok = await onUpdate(item, draft)
    if (ok) closeEdit()
  }

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4" aria-label="Slack過去ログ移行">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Slack過去ログ移行</h2>
          <p className="mt-0.5 text-xs text-slate-500">使わなくなった通達チャンネルの過去スレッドをL-Linkの公開済みナレッジに移します。</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Pill className="border-green-200 bg-green-50 text-green-700">公開済み {publishedCount}</Pill>
          <Pill className="border-amber-200 bg-amber-50 text-amber-700">下書き {draftCount}</Pill>
          {nextCursor && <Pill className="border-blue-200 bg-blue-50 text-blue-700">続きあり</Pill>}
        </div>
      </div>

      {canManage && (
        <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(180px,1fr)_minmax(160px,0.8fr)_120px_auto_auto] lg:items-end">
          <Field label="チャンネルID">
            <input
              value={channelId}
              onChange={(event) => onChannelIdChange(event.target.value)}
              placeholder="C..."
              className={inputCls}
            />
          </Field>
          <Field label="表示名">
            <input
              value={channelName}
              onChange={(event) => onChannelNameChange(event.target.value)}
              placeholder="早急確認-ecオーナー通達"
              className={inputCls}
            />
          </Field>
          <Field label="件数">
            <select
              value={importLimit}
              onChange={(event) => onImportLimitChange(Number(event.target.value))}
              className={selectCls}
            >
              {[10, 20, 30, 50].map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </Field>
          <button
            type="button"
            onClick={() => void onSync(null)}
            disabled={disabled}
            className={btnBrandCls}
          >
            {syncing ? '移行中' : '全件移行'}
          </button>
          <button
            type="button"
            onClick={() => void onSync(nextCursor)}
            disabled={disabled || !nextCursor}
            className={btnSecondaryCls}
          >
            続きから移行
          </button>
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        {(['draft', 'published', 'dismissed', 'all'] as const).map((status) => (
          <button
            key={status}
            type="button"
            onClick={() => onStatusFilterChange(status)}
            disabled={saving || syncing}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              statusFilter === status
                ? 'bg-slate-900 text-white'
                : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
            }`}
          >
            {status === 'all' ? '全て' : statusLabel(status)}
          </button>
        ))}
        <input
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="移行済みナレッジを検索"
          className={`${inputCls} min-w-[220px] flex-1`}
        />
      </div>

      <div className="mt-4 space-y-3">
        {items.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-center">
            <p className="text-sm font-medium text-slate-600">移行済みのSlackナレッジはありません</p>
          </div>
        ) : items.map((item) => {
          const editing = editingId === item.id && draft
          return (
            <article key={item.id} className="rounded-lg border border-slate-200 p-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Pill className={statusTone(item.status)}>{statusLabel(item.status)}</Pill>
                    <Pill className="border-slate-200 bg-slate-50 text-slate-600">
                      {categoryLabel[item.category] || item.category}
                    </Pill>
                    {item.sourcePostedAt && <span className="text-xs text-slate-400">{formatDateTime(item.sourcePostedAt)}</span>}
                  </div>
                  <h3 className="mt-2 break-words text-sm font-semibold text-slate-900">{item.title}</h3>
                  {!editing && (
                    <p className="mt-1 line-clamp-2 whitespace-pre-wrap break-words text-sm text-slate-600">{item.question}</p>
                  )}
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  {item.status === 'draft' && (
                    <>
                      <button type="button" onClick={() => openEdit(item)} disabled={disabled} className={btnSecondaryCls}>
                        編集
                      </button>
                      <button type="button" onClick={() => void onPublish(item)} disabled={disabled} className={btnBrandCls}>
                        <CheckIcon className="h-4 w-4" />
                        公開
                      </button>
                      <button type="button" onClick={() => void onDismiss(item)} disabled={disabled} className={btnSecondaryCls}>
                        却下
                      </button>
                    </>
                  )}
                </div>
              </div>

              {editing && (
                <div className="mt-3 space-y-3 border-t border-slate-100 pt-3">
                  <Field label="タイトル">
                    <input
                      value={draft.title}
                      onChange={(event) => setDraft((prev) => prev ? { ...prev, title: event.target.value } : prev)}
                      className={inputCls}
                    />
                  </Field>
                  <div className="grid gap-3 md:grid-cols-2">
                    <Field label="カテゴリ">
                      <select
                        value={draft.category}
                        onChange={(event) => setDraft((prev) => prev ? { ...prev, category: event.target.value } : prev)}
                        className={selectCls}
                      >
                        {categoryOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                    </Field>
                    <Field label="キーワード">
                      <input
                        value={draft.keywords}
                        onChange={(event) => setDraft((prev) => prev ? { ...prev, keywords: event.target.value } : prev)}
                        className={inputCls}
                      />
                    </Field>
                  </div>
                  <Field label="一次対応の問い合わせ">
                    <textarea
                      value={draft.question}
                      onChange={(event) => setDraft((prev) => prev ? { ...prev, question: event.target.value } : prev)}
                      rows={4}
                      className={textareaCls}
                    />
                  </Field>
                  <Field label="二次対応の回答">
                    <textarea
                      value={draft.answer}
                      onChange={(event) => setDraft((prev) => prev ? { ...prev, answer: event.target.value } : prev)}
                      rows={4}
                      className={textareaCls}
                    />
                  </Field>
                  <Field label="公開本文">
                    <textarea
                      value={draft.body}
                      onChange={(event) => setDraft((prev) => prev ? { ...prev, body: event.target.value } : prev)}
                      rows={6}
                      className={textareaCls}
                    />
                  </Field>
                  <div className="flex flex-wrap justify-end gap-2">
                    <button type="button" onClick={closeEdit} disabled={saving || syncing} className={btnSecondaryCls}>
                      キャンセル
                    </button>
                    <button type="button" onClick={() => void submitUpdate(item)} disabled={disabled || !draft.title.trim() || !draft.body.trim()} className={btnBrandCls}>
                      更新
                    </button>
                  </div>
                </div>
              )}
            </article>
          )
        })}
      </div>
    </section>
  )
}

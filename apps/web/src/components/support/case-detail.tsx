'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { api, type SupportCaseAttachment, type SupportCaseDetail, type SupportCaseStatus, type SupportInternalMessage, type SupportMessage } from '@/lib/api'
import { messageSourceLabel } from '@/lib/message-source-label'
import { parseSupportMessagePreview } from '@/lib/support-message-preview'
import MentionText from '@/components/shared/mention-text'
import {
  categoryLabel,
  canOpenChatWithDraft,
  escalationStatusMeta,
  eventTypeLabel,
  formatDateTime,
  getCaseFormValidationIssues,
  isOverdueCase,
  priorityClass,
  priorityLabel,
  priorityOptions,
  resolveChecklist,
  statusClass,
  statusLabel,
  type CaseFormState,
  type SupportEmptyState,
} from './support-meta'
import {
  btnPrimaryCls,
  btnSecondaryCls,
  ChatIcon,
  CheckIcon,
  CopyIcon,
  DueBadge,
  DueTimePresetRow,
  Field,
  Pill,
  inputCls,
  textareaCls,
} from './support-ui'

interface CaseDetailProps {
  detail: SupportCaseDetail | null
  detailLoading: boolean
  caseForm: CaseFormState
  dirty: boolean
  saving: boolean
  canEditRouting: boolean
  staffOptions: string[]
  staffName: string
  onFormChange: (patch: Partial<CaseFormState>) => void
  onSave: () => void
  onDiscard: () => void
  onQuickStatus: (status: SupportCaseStatus, eventBody: string) => Promise<boolean>
  onInternalMessageCreate: (body: string, parentId: string | null, mentions: string[]) => Promise<boolean>
  onInternalMessageReaction: (messageId: string, emoji: string) => Promise<void>
  onOpenChatWithDraft: () => void
  onCopyReplyDraft: () => void
  emptyState?: Pick<SupportEmptyState, 'title' | 'description'>
  outsideCurrentList?: boolean
  outsideCurrentListActionLabel?: string
  onResetFilters?: () => void
}

function AttachmentPreview({ attachment }: { attachment: SupportCaseAttachment }) {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let active = true
    let objectUrl: string | null = null
    api.support.cases.attachmentBlob(attachment)
      .then((blob) => {
        if (!active) return
        objectUrl = URL.createObjectURL(blob)
        setUrl(objectUrl)
      })
      .catch(() => {
        if (active) setFailed(true)
      })
    return () => {
      active = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [attachment])

  if (failed) {
    return <div className="flex aspect-square items-center justify-center rounded-md border border-slate-200 bg-slate-50 px-2 text-center text-xs text-slate-500">画像を表示できません</div>
  }
  if (!url) return <div className="aspect-square animate-pulse rounded-md bg-slate-100" />
  return (
    <a href={url} target="_blank" rel="noreferrer" className="group block" title={attachment.fileName}>
      <img src={url} alt={attachment.fileName} className="aspect-square w-full rounded-md border border-slate-200 bg-slate-50 object-cover transition-opacity group-hover:opacity-90" />
      <span className="mt-1 block truncate text-[11px] font-medium text-slate-600">{attachment.fileName}</span>
    </a>
  )
}

const internalReactionEmojis = ['👍', '🙏', '✅', '👀', '❤️']

function DetailSkeleton() {
  return (
    <div className="animate-pulse space-y-4 p-4" aria-hidden="true">
      <div className="flex gap-2">
        <div className="h-5 w-16 rounded bg-gray-200" />
        <div className="h-5 w-12 rounded bg-gray-100" />
      </div>
      <div className="h-6 w-2/3 rounded bg-gray-200" />
      <div className="h-20 rounded-lg bg-gray-100" />
      <div className="grid gap-3 md:grid-cols-4">
        {[...Array(4)].map((_, i) => <div key={i} className="h-14 rounded bg-gray-100" />)}
      </div>
      <div className="h-32 rounded bg-gray-100" />
    </div>
  )
}

function EmptyDetail({ emptyState }: { emptyState?: Pick<SupportEmptyState, 'title' | 'description'> }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-24 text-center">
      <span className="rounded-full bg-gray-100 p-3 text-gray-400">
        <ChatIcon className="h-6 w-6" />
      </span>
      <p className="text-sm font-medium text-gray-600">{emptyState?.title ?? 'チケットを選択してください'}</p>
      <p className="max-w-sm text-xs leading-relaxed text-gray-400">
        {emptyState?.description ?? '左の一覧、または上部のキューから絞り込めます'}
      </p>
    </div>
  )
}

function ticketShortId(id: string): string {
  const normalized = id.replace(/-/g, '').trim()
  return normalized ? normalized.slice(0, 6).toUpperCase() : 'NEW'
}

function DetailInfoRow({ label, value, tone = 'default' }: { label: string; value: string; tone?: 'default' | 'muted' | 'accent' }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
      <dt className="text-[11px] font-medium text-slate-500">{label}</dt>
      <dd className={`mt-0.5 break-words text-sm font-semibold ${
        tone === 'accent' ? 'text-indigo-700' : tone === 'muted' ? 'text-slate-500' : 'text-slate-900'
      }`}>
        {value}
      </dd>
    </div>
  )
}

/** 完了確定パネル: 運用マニュアルの完了条件を確認しつつ対応結果メモを必須化 */
function CompletionPanel({
  resolutionNote,
  saving,
  onNoteChange,
  onConfirm,
  onCancel,
}: {
  resolutionNote: string
  saving: boolean
  onNoteChange: (value: string) => void
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="rounded-lg border border-green-300 bg-green-50/60 p-3" role="region" aria-label="完了前の確認">
      <p className="text-sm font-semibold text-green-900">完了前の確認</p>
      <ul className="mt-2 space-y-1">
        {resolveChecklist.map((item) => (
          <li key={item} className="flex items-start gap-1.5 text-xs text-green-800">
            <CheckIcon className="mt-0.5 h-3 w-3 shrink-0 text-green-600" />
            {item}
          </li>
        ))}
      </ul>
      <div className="mt-3">
        <Field label="対応結果メモ" hint="完了には必須">
          <textarea
            value={resolutionNote}
            onChange={(e) => onNoteChange(e.target.value)}
            rows={3}
            placeholder="対応内容と判断理由を残す"
            className={textareaCls}
            autoFocus
          />
        </Field>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className={btnSecondaryCls}>
          キャンセル
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={saving || !resolutionNote.trim()}
          className="inline-flex items-center gap-1.5 rounded-md bg-green-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <CheckIcon className="h-4 w-4" />
          完了を確定
        </button>
      </div>
    </div>
  )
}

function SupportMessageContent({ message }: { message: SupportMessage }) {
  const preview = parseSupportMessagePreview(message.messageType, message.content)

  if (preview.kind === 'text') {
    return <p className="whitespace-pre-wrap break-words">{preview.text}</p>
  }

  if (preview.kind === 'image') {
    return (
      <a
        href={preview.originalUrl}
        target="_blank"
        rel="noreferrer"
        className="inline-block max-w-full rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500"
      >
        <img
          src={preview.previewUrl}
          alt="LINE画像"
          className="max-h-48 max-w-full rounded-md border border-black/5 object-contain"
          loading="lazy"
        />
      </a>
    )
  }

  if (preview.kind === 'file') {
    const body = (
      <div className="flex min-w-0 items-center justify-between gap-3 rounded-md border border-gray-200 bg-white px-3 py-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-gray-800">{preview.label}</p>
          <p className="mt-0.5 text-[11px] text-gray-400">{preview.isPdf ? 'PDF' : 'ファイル'}</p>
        </div>
        {preview.url && <span className="shrink-0 text-xs font-semibold text-green-700">開く</span>}
      </div>
    )
    return preview.url ? (
      <a href={preview.url} target="_blank" rel="noreferrer" className="block max-w-sm">
        {body}
      </a>
    ) : body
  }

  return <p className="whitespace-pre-wrap break-words">{preview.label}</p>
}

function mentionNamesFromBody(body: string, staffOptions: string[]): string[] {
  const names = new Set<string>()
  staffOptions.forEach((name) => {
    const trimmed = name.trim()
    if (trimmed && body.includes(`@${trimmed}`)) names.add(trimmed)
  })
  return Array.from(names)
}

function insertMention(text: string, name: string): string {
  const prefix = text.trimEnd()
  return `${prefix}${prefix ? ' ' : ''}@${name} `
}

function insertEmoji(text: string, emoji: string): string {
  const prefix = text.trimEnd()
  return `${prefix}${prefix ? ' ' : ''}${emoji} `
}

function InternalReactionRow({
  message,
  saving,
  onReaction,
}: {
  message: SupportInternalMessage
  saving: boolean
  onReaction: (messageId: string, emoji: string) => Promise<void>
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const availableEmojis = internalReactionEmojis.filter((emoji) => (
    !message.reactions.some((reaction) => reaction.emoji === emoji)
  ))

  const pickReaction = (emoji: string) => {
    setPickerOpen(false)
    void onReaction(message.id, emoji)
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {message.reactions.map((reaction) => (
        <button
          key={reaction.emoji}
          type="button"
          onClick={() => void onReaction(message.id, reaction.emoji)}
          disabled={saving}
          title={reaction.names.join('、')}
          className={`rounded-full border px-2 py-0.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
            reaction.reactedByMe
              ? 'border-indigo-300 bg-indigo-50 text-indigo-700'
              : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
          }`}
        >
          <span aria-hidden="true">{reaction.emoji}</span>
          <span className="ml-1">{reaction.count}</span>
        </button>
      ))}
      {availableEmojis.length > 0 && (
        <span className="relative inline-flex">
          <button
            type="button"
            onClick={() => setPickerOpen((value) => !value)}
            disabled={saving}
            className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-xs font-medium text-slate-500 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="リアクションを追加"
          >
            ☺
          </button>
          {pickerOpen && (
            <div className="absolute left-0 top-full z-30 mt-1 flex gap-1 rounded-full border border-slate-200 bg-white p-1 shadow-lg">
              {availableEmojis.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => pickReaction(emoji)}
                  disabled={saving}
                  className="rounded-full px-2 py-1 text-sm transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                  aria-label={`${emoji}でリアクション`}
                >
                  {emoji}
                </button>
              ))}
            </div>
          )}
        </span>
      )}
    </div>
  )
}

function InternalMessageBubble({
  message,
  replies,
  staffOptions,
  saving,
  open,
  replyDraft,
  onToggle,
  onReplyDraftChange,
  onInsertMention,
  onSendReply,
  onReaction,
}: {
  message: SupportInternalMessage
  replies: SupportInternalMessage[]
  staffOptions: string[]
  saving: boolean
  open: boolean
  replyDraft: string
  onToggle: () => void
  onReplyDraftChange: (value: string) => void
  onInsertMention: (name: string) => void
  onSendReply: () => void
  onReaction: (messageId: string, emoji: string) => Promise<void>
}) {
  const author = message.createdByName || 'スタッフ'
  const initial = author.trim().charAt(0) || '社'

  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-3 shadow-sm">
      <div className="flex gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-700 ring-1 ring-slate-200">
          {initial}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-slate-900">{author}</p>
            <span className="text-xs text-slate-400">{formatDateTime(message.createdAt)}</span>
          </div>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-slate-800">
            <MentionText text={message.body} mentions={message.mentions} />
          </p>
          {message.mentions.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {message.mentions.map((name) => (
                <span key={name} className="rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-700">
                  @{name}
                </span>
              ))}
            </div>
          )}
          <InternalReactionRow message={message} saving={saving} onReaction={onReaction} />
          <button
            type="button"
            onClick={onToggle}
            className="mt-2 text-xs font-medium text-slate-500 underline-offset-2 hover:text-slate-900 hover:underline"
          >
            {open ? 'スレッドを閉じる' : replies.length > 0 ? `スレッド ${replies.length}件` : '返信'}
          </button>
        </div>
      </div>

      {open && (
        <div className="mt-3 border-l-2 border-slate-200 pl-4">
          <div className="space-y-2">
            {replies.map((reply) => (
              <div key={reply.id} className="rounded-md bg-slate-50 px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-xs font-semibold text-slate-800">{reply.createdByName || 'スタッフ'}</p>
                  <span className="text-[11px] text-slate-400">{formatDateTime(reply.createdAt)}</span>
                </div>
                <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-slate-700">
                  <MentionText text={reply.body} mentions={reply.mentions} />
                </p>
                <InternalReactionRow message={reply} saving={saving} onReaction={onReaction} />
              </div>
            ))}
          </div>
          <div className="mt-3 rounded-md border border-slate-200 bg-white p-2">
            {staffOptions.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {staffOptions.slice(0, 8).map((name) => (
                  <button
                    key={name}
                    type="button"
                    onClick={() => onInsertMention(name)}
                    disabled={saving}
                    className="rounded-full border border-sky-200 bg-sky-50 px-2 py-1 text-[11px] font-medium text-sky-700 hover:bg-sky-100 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    @{name}
                  </button>
                ))}
              </div>
            )}
            <div className="mb-2 flex flex-wrap gap-1.5">
              {internalReactionEmojis.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => onReplyDraftChange(insertEmoji(replyDraft, emoji))}
                  disabled={saving}
                  className="rounded-full border border-slate-200 bg-slate-50 px-2 py-1 text-xs hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {emoji}
                </button>
              ))}
            </div>
            <textarea
              value={replyDraft}
              onChange={(event) => onReplyDraftChange(event.target.value)}
              rows={2}
              placeholder="スレッドに返信"
              className="w-full resize-y rounded-md border border-slate-200 px-3 py-2 text-sm leading-6 text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <div className="mt-2 flex justify-end">
              <button
                type="button"
                onClick={onSendReply}
                disabled={saving || !replyDraft.trim()}
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                返信する
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function InternalChatPanel({
  messages,
  staffOptions,
  saving,
  onCreate,
  onReaction,
}: {
  messages: SupportInternalMessage[]
  staffOptions: string[]
  saving: boolean
  onCreate: (body: string, parentId: string | null, mentions: string[]) => Promise<boolean>
  onReaction: (messageId: string, emoji: string) => Promise<void>
}) {
  const [draft, setDraft] = useState('')
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({})
  const [openThreads, setOpenThreads] = useState<Record<string, boolean>>({})
  const roots = messages.filter((message) => !message.parentId)
  const repliesByParent = messages.reduce<Record<string, SupportInternalMessage[]>>((acc, message) => {
    if (!message.parentId) return acc
    if (!acc[message.parentId]) acc[message.parentId] = []
    acc[message.parentId].push(message)
    return acc
  }, {})

  const submitRoot = async () => {
    const body = draft.trim()
    if (!body) return
    const ok = await onCreate(body, null, mentionNamesFromBody(body, staffOptions))
    if (ok) setDraft('')
  }

  const submitReply = async (parentId: string) => {
    const body = replyDrafts[parentId]?.trim() ?? ''
    if (!body) return
    const ok = await onCreate(body, parentId, mentionNamesFromBody(body, staffOptions))
    if (ok) setReplyDrafts((prev) => ({ ...prev, [parentId]: '' }))
  }

  return (
    <section className="rounded-2xl border border-slate-200 bg-slate-50 shadow-sm" aria-label="社内チャット">
      <div className="border-b border-slate-200 px-4 py-3">
        <p className="text-sm font-semibold text-slate-900">社内チャット</p>
        <p className="mt-0.5 text-xs text-slate-500">顧客には送られない、一次対応者同士の相談欄です。</p>
      </div>

      <div className="max-h-[440px] space-y-3 overflow-y-auto p-3">
        {roots.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 bg-white px-4 py-6 text-center">
            <p className="text-sm font-medium text-slate-600">まだ社内チャットはありません</p>
            <p className="mt-1 text-xs text-slate-400">確認事項や引き継ぎをここに残せます。</p>
          </div>
        ) : roots.map((message) => (
          <InternalMessageBubble
            key={message.id}
            message={message}
            replies={repliesByParent[message.id] ?? []}
            staffOptions={staffOptions}
            saving={saving}
            open={Boolean(openThreads[message.id])}
            replyDraft={replyDrafts[message.id] ?? ''}
            onToggle={() => setOpenThreads((prev) => ({ ...prev, [message.id]: !prev[message.id] }))}
            onReplyDraftChange={(value) => setReplyDrafts((prev) => ({ ...prev, [message.id]: value }))}
            onInsertMention={(name) => setReplyDrafts((prev) => ({ ...prev, [message.id]: insertMention(prev[message.id] ?? '', name) }))}
            onSendReply={() => void submitReply(message.id)}
            onReaction={onReaction}
          />
        ))}
      </div>

      <div className="border-t border-slate-200 bg-white p-3">
        {staffOptions.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {staffOptions.slice(0, 10).map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => setDraft((prev) => insertMention(prev, name))}
                disabled={saving}
                className="rounded-full border border-sky-200 bg-sky-50 px-2 py-1 text-[11px] font-medium text-sky-700 hover:bg-sky-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                @{name}
              </button>
            ))}
          </div>
        )}
        <div className="mb-2 flex flex-wrap gap-1.5">
          {internalReactionEmojis.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => setDraft((prev) => insertEmoji(prev, emoji))}
              disabled={saving}
              className="rounded-full border border-slate-200 bg-slate-50 px-2 py-1 text-xs hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {emoji}
            </button>
          ))}
        </div>
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={3}
          placeholder="@担当者 を付けて相談内容を入力"
          className="w-full resize-y rounded-lg border border-slate-300 px-3 py-2 text-sm leading-6 text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            onClick={() => void submitRoot()}
            disabled={saving || !draft.trim()}
            className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            投稿する
          </button>
        </div>
      </div>
    </section>
  )
}

export default function CaseDetail({
  detail,
  detailLoading,
  caseForm,
  dirty,
  saving,
  canEditRouting,
  staffOptions,
  staffName,
  onFormChange,
  onSave,
  onDiscard,
  onQuickStatus,
  onInternalMessageCreate,
  onInternalMessageReaction,
  onOpenChatWithDraft,
  onCopyReplyDraft,
  emptyState,
  outsideCurrentList = false,
  outsideCurrentListActionLabel = '絞り込みをリセット',
  onResetFilters,
}: CaseDetailProps) {
  const [completing, setCompleting] = useState(false)

  if (detailLoading && !detail) {
    return (
      <section className="h-full min-h-[520px] rounded-lg border border-gray-200 bg-white">
        <DetailSkeleton />
      </section>
    )
  }

  if (!detail) {
    return (
      <section className="h-full min-h-[520px] rounded-lg border border-gray-200 bg-white">
        <EmptyDetail emptyState={emptyState} />
      </section>
    )
  }

  const overdue = isOverdueCase(detail)
  const primaryUnassigned = !caseForm.primaryAssignee.trim()
  const secondaryUnassigned = caseForm.escalationAssignees.length === 0
  const secondaryAssigneeLabel = caseForm.escalationAssignees.join('、') || '未設定'
  const primaryAssigneeLabel = caseForm.primaryAssignee.trim() || '未設定'
  const customerLabel = detail.friendName || detail.companyName || detail.contactName || '顧客未紐付け'
  const customerNumberLabel = detail.customerNumber || ticketShortId(detail.id)
  const canViewLineConversation = detail.canViewLineConversation !== false
  const chatHref = canViewLineConversation && detail.friendId ? `/chats?friend=${encodeURIComponent(detail.friendId)}` : null
  const lockedInputCls = `${inputCls} disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-500`
  const validationIssues = getCaseFormValidationIssues(caseForm, { hasChat: Boolean(chatHref) })
  const blockingValidationIssues = validationIssues.filter((issue) => issue.blocking)
  const canSave = dirty && blockingValidationIssues.length === 0
  const showChatReplyAction = canOpenChatWithDraft({
    status: caseForm.status,
    hasDraft: Boolean(caseForm.customerReplyDraft.trim()),
    hasChat: Boolean(chatHref),
  })
  const handleConfirmComplete = async () => {
    const ok = await onQuickStatus('resolved', '対応を完了しました')
    if (ok) setCompleting(false)
  }
  const answeredEscalations = detail.escalations.filter((item) => item.status === 'answered' && item.answer.trim())
  const latestAnsweredEscalation = answeredEscalations.length > 0
    ? answeredEscalations[answeredEscalations.length - 1]
    : null
  const assigneeChoices = Array.from(
    new Set([caseForm.primaryAssignee, ...caseForm.escalationAssignees, ...staffOptions].map((name) => name.trim()).filter(Boolean)),
  ).sort((a, b) => a.localeCompare(b, 'ja'))
  const chatStaffOptions = Array.from(
    new Set([staffName, ...staffOptions].map((name) => name.trim()).filter(Boolean)),
  ).sort((a, b) => {
    if (a === staffName) return -1
    if (b === staffName) return 1
    return a.localeCompare(b, 'ja')
  })

  return (
    <section className="relative flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm" aria-label="チケット詳細">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {/* ヘッダー: タイトル + 保存 */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap gap-1.5">
              <span className={`inline-flex items-center rounded-md border px-3 py-1.5 text-sm font-medium leading-none shadow-sm ${statusClass[caseForm.status]}`}>
                {statusLabel[caseForm.status]}
              </span>
              <span className={`inline-flex items-center rounded-md border px-3 py-1.5 text-sm font-medium leading-none ${priorityClass[caseForm.priority]}`}>
                {priorityLabel[caseForm.priority]}
              </span>
              <Pill className="border-gray-200 bg-gray-50 text-gray-600">
                {categoryLabel[caseForm.category] || caseForm.category}
              </Pill>
            </div>
            <h2 className="mt-2 break-words text-lg font-semibold leading-snug text-gray-900">
              {caseForm.title || detail.title}
              {dirty && <span className="ml-2 inline-block h-2 w-2 rounded-full bg-amber-500 align-middle" title="未保存の変更あり" />}
            </h2>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-gray-500">
              <span className="truncate">{detail.friendName || detail.companyName || '顧客未紐付け'}</span>
              {chatHref && (
                <Link
                  href={chatHref}
                  className="inline-flex items-center gap-1 text-xs font-medium text-green-700 underline-offset-2 hover:underline"
                >
                  <ChatIcon className="h-3.5 w-3.5" />
                  チャットを開く
                </Link>
              )}
              <span className="text-xs text-gray-400">更新 {formatDateTime(detail.updatedAt)}</span>
              <DueBadge value={caseForm.status === 'resolved' ? null : detail.dueAt} />
              <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
                secondaryUnassigned
                  ? 'bg-slate-100 text-slate-500'
                  : 'bg-indigo-50 text-indigo-700 ring-1 ring-indigo-100'
              }`}>
                二次対応先: {secondaryAssigneeLabel}
              </span>
            </div>
          </div>
          <button
            onClick={onSave}
            disabled={saving || !canSave}
            title={blockingValidationIssues[0]?.message ?? '⌘S / Ctrl+S でも保存できます'}
            className={btnPrimaryCls}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>

        {outsideCurrentList && (
          <div
            className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
            role="status"
          >
            <div>
              <p className="font-semibold">このチケットは現在の一覧条件外です</p>
              <p className="mt-0.5 text-xs leading-relaxed text-amber-800">
                保存中の作業を守るため詳細は残しています。左の一覧とそろえる場合は絞り込みを戻してください。
              </p>
            </div>
            {onResetFilters && (
              <button
                type="button"
                onClick={onResetFilters}
                disabled={saving}
                className="rounded-md border border-amber-300 bg-white px-3 py-1.5 text-xs font-semibold text-amber-800 transition-colors hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {outsideCurrentListActionLabel}
              </button>
            )}
          </div>
        )}

        {!canEditRouting && (
          <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-medium text-blue-800">
            staff権限では対応内容だけ編集できます。担当割り、期限、緊急度、顧客属性はowner/adminが管理します。
          </div>
        )}

        {validationIssues.length > 0 && (
          <div
            className={`rounded-lg border px-3 py-2 text-sm ${
              blockingValidationIssues.length > 0
                ? 'border-red-200 bg-red-50 text-red-800'
                : 'border-blue-200 bg-blue-50 text-blue-800'
            }`}
            role={blockingValidationIssues.length > 0 ? 'alert' : 'status'}
          >
            <p className="font-semibold">
              {blockingValidationIssues.length > 0 ? '保存前に必要な入力があります' : '返信前の確認'}
            </p>
            <ul className="mt-1 space-y-1">
              {validationIssues.map((issue) => (
                <li key={issue.key} className="flex items-start gap-2">
                  <span
                    className={`mt-0.5 rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                      issue.severity === 'error' ? 'bg-red-100 text-red-700' : 'bg-blue-100 text-blue-700'
                    }`}
                  >
                    {issue.blocking ? '必須' : '確認'}
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

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm" aria-label="問い合わせ">
            <div className="mb-3 flex items-center justify-between gap-3 border-b border-slate-100 pb-3">
              <div>
                <p className="text-sm font-semibold text-slate-900">問い合わせ</p>
                <p className="mt-0.5 text-xs text-slate-500">件名と相談内容をここで確認します。</p>
              </div>
              {overdue && caseForm.status !== 'resolved' && (
                <Pill className="border-red-200 bg-red-50 text-red-700">期限超過</Pill>
              )}
            </div>
            <div className="space-y-3">
              <label className="block">
                <span className="text-xs font-medium text-slate-500">件名</span>
                <input
                  value={caseForm.title}
                  onChange={(e) => onFormChange({ title: e.target.value })}
                  disabled={!canEditRouting}
                  className={`${lockedInputCls} mt-1 px-3 py-2 text-sm font-semibold`}
                />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-slate-500">問い合わせ内容</span>
                <textarea
                  value={caseForm.customerSummary}
                  onChange={(e) => onFormChange({ customerSummary: e.target.value })}
                  rows={8}
                  placeholder="顧客からの相談内容を、要約せずにそのまま残す"
                  className={`${textareaCls} mt-1 min-h-[220px] px-3 py-3 text-sm leading-6`}
                />
              </label>
              {(detail.attachments?.length ?? 0) > 0 && (
                <div>
                  <p className="text-xs font-medium text-slate-500">添付画像</p>
                  <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {detail.attachments?.map((attachment) => (
                      <AttachmentPreview key={attachment.id} attachment={attachment} />
                    ))}
                  </div>
                </div>
              )}
            </div>
          </section>

          <div className="space-y-4">
            <section className="rounded-xl border border-slate-200 bg-slate-50 p-4 shadow-sm" aria-label="確認情報">
              <div className="mb-3 border-b border-slate-200 pb-3">
                <p className="text-sm font-semibold text-slate-900">確認情報</p>
                <p className="mt-0.5 text-xs text-slate-500">このチケットの基本情報を確認できます。</p>
              </div>
              <dl className="grid gap-2">
                <DetailInfoRow label="顧客" value={customerLabel} />
                <DetailInfoRow label="顧客番号 / チケットID" value={customerNumberLabel} />
                <DetailInfoRow label="一次対応者" value={primaryAssigneeLabel} tone={primaryUnassigned ? 'muted' : 'default'} />
                <DetailInfoRow label="二次対応先" value={secondaryAssigneeLabel} tone={secondaryUnassigned ? 'muted' : 'accent'} />
                <DetailInfoRow label="最終更新" value={formatDateTime(detail.updatedAt)} />
              </dl>
            </section>

            <section className="rounded-xl border border-slate-200 bg-slate-50 p-4 shadow-sm" aria-label="対応設定">
              <div className="mb-3 border-b border-slate-200 pb-3">
                <p className="text-sm font-semibold text-slate-900">編集する情報</p>
                <p className="mt-0.5 text-xs text-slate-500">一次対応者、二次対応先、期限、緊急度をここで決めます。</p>
              </div>
              <div className="space-y-4">
              <div>
                <p className="text-xs font-medium text-slate-500">一次担当者</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => onFormChange({ primaryAssignee: '' })}
                    disabled={!canEditRouting}
                    className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                      primaryUnassigned
                        ? 'border-amber-400 bg-amber-100 text-amber-800'
                        : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300'
                    }`}
                    aria-pressed={primaryUnassigned}
                  >
                    未設定
                  </button>
                  {assigneeChoices.map((name) => (
                    <button
                      key={name}
                      type="button"
                      onClick={() => onFormChange({ primaryAssignee: name })}
                      disabled={!canEditRouting}
                      className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                        caseForm.primaryAssignee === name
                          ? 'border-emerald-200 bg-emerald-50 text-emerald-800 ring-1 ring-emerald-100'
                          : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-900'
                      }`}
                      aria-pressed={caseForm.primaryAssignee === name}
                    >
                      {name}
                    </button>
                  ))}
                </div>
              </div>

              <div className="rounded-lg border border-indigo-100 bg-white px-3 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-medium text-indigo-700">二次対応先</p>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">
                      このチケットを誰に二次対応として依頼しているか全員が確認できます。
                    </p>
                  </div>
                  {!secondaryUnassigned && (
                    <span className="shrink-0 rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-700">
                      指定中
                    </span>
                  )}
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => onFormChange({ escalationAssignee: '', escalationAssignees: [] })}
                    disabled={!canEditRouting}
                    className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                      secondaryUnassigned
                        ? 'border-slate-300 bg-slate-100 text-slate-600'
                        : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300'
                    }`}
                    aria-pressed={secondaryUnassigned}
                  >
                    未設定
                  </button>
                  {assigneeChoices.map((name) => (
                    <button
                      key={name}
                      type="button"
                      onClick={() => {
                        const next = caseForm.escalationAssignees.includes(name)
                          ? caseForm.escalationAssignees.filter((value) => value !== name)
                          : [...caseForm.escalationAssignees, name]
                        onFormChange({ escalationAssignee: next[0] ?? '', escalationAssignees: next })
                      }}
                      disabled={!canEditRouting}
                      className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                        caseForm.escalationAssignees.includes(name)
                          ? 'border-indigo-600 bg-indigo-600 text-white'
                          : 'border-indigo-100 bg-indigo-50 text-indigo-700 hover:border-indigo-200 hover:bg-indigo-100'
                      }`}
                      aria-pressed={caseForm.escalationAssignees.includes(name)}
                    >
                      {name}
                    </button>
                  ))}
                </div>
              </div>

              <label className="block">
                <span className="text-xs font-medium text-slate-500">期限</span>
                <input
                  type="datetime-local"
                  value={caseForm.dueAt}
                  onChange={(e) => onFormChange({ dueAt: e.target.value })}
                  disabled={!canEditRouting}
                  className={`${lockedInputCls} mt-1 px-3 py-2 text-sm`}
                />
                <DueTimePresetRow
                  hasValue={Boolean(caseForm.dueAt)}
                  onApply={(value) => onFormChange({ dueAt: value })}
                  disabled={!canEditRouting}
                />
              </label>

              <div>
                <p className="text-xs font-medium text-slate-500">緊急度</p>
                <div className="mt-2 grid grid-cols-3 gap-2">
                  {priorityOptions.map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      onClick={() => onFormChange({ priority: item.value })}
                      disabled={!canEditRouting}
                      className={`rounded-lg border px-2 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                        caseForm.priority === item.value
                          ? item.value === 'urgent'
                            ? 'border-red-200 bg-red-100 text-red-700 ring-1 ring-red-100'
                            : item.value === 'high'
                              ? 'border-orange-200 bg-orange-100 text-orange-700 ring-1 ring-orange-100'
                              : 'border-emerald-200 bg-emerald-50 text-emerald-800 ring-1 ring-emerald-100'
                          : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-900'
                      }`}
                      aria-pressed={caseForm.priority === item.value}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
              </div>
            </section>
          </div>
        </div>

        {/* クイックアクション */}
        {completing ? (
          <CompletionPanel
            resolutionNote={caseForm.resolutionNote}
            saving={saving}
            onNoteChange={(value) => onFormChange({ resolutionNote: value })}
            onConfirm={handleConfirmComplete}
            onCancel={() => setCompleting(false)}
          />
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {(caseForm.status === 'open' || caseForm.status === 'reopened') && (
              <button
                type="button"
                onClick={() => void onQuickStatus('in_progress', '対応を開始しました')}
                disabled={saving}
                className="rounded-md bg-amber-500 px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-amber-600 disabled:opacity-50"
              >
                対応開始
              </button>
            )}
            {(caseForm.status === 'secondary_answered' || caseForm.status === 'waiting_primary') && (
              <button
                type="button"
                onClick={() => void onQuickStatus('in_progress', '二次回答を確認し、一次対応を再開しました')}
                disabled={saving}
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-emerald-700 disabled:opacity-50"
              >
                対応中にする
              </button>
            )}
            {caseForm.status !== 'resolved' && (
              <button
                type="button"
                onClick={() => setCompleting(true)}
                disabled={saving}
                className="rounded-md border border-green-600 bg-white px-3 py-1.5 text-sm font-semibold text-green-700 transition-colors hover:bg-green-50 disabled:opacity-50"
              >
                完了にする…
              </button>
            )}
            {caseForm.status === 'resolved' && (
              <button
                type="button"
                onClick={() => void onQuickStatus('reopened', 'チケットを再オープンしました')}
                disabled={saving}
                className="rounded-md border border-pink-300 bg-white px-3 py-1.5 text-sm font-semibold text-pink-700 transition-colors hover:bg-pink-50 disabled:opacity-50"
                title="完了後の再連絡は未対応に戻さず再オープンで扱います"
              >
                再オープン
              </button>
            )}
            {caseForm.customerReplyDraft.trim() && (
              <>
                {showChatReplyAction && (
                  <button
                    type="button"
                    onClick={onOpenChatWithDraft}
                    disabled={saving}
                    className="inline-flex items-center gap-1 rounded-md bg-green-600 px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-green-700 disabled:opacity-50"
                  >
                    <ChatIcon className="h-3.5 w-3.5" />
                    チャットで返信
                  </button>
                )}
                <button
                  type="button"
                  onClick={onCopyReplyDraft}
                  className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
                >
                  <CopyIcon className="h-3.5 w-3.5" />
                  返信案をコピー
                </button>
              </>
            )}
          </div>
        )}

        {latestAnsweredEscalation && (
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-emerald-950" role="status">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white">二次対応回答済み</span>
              <span className="text-sm font-semibold">{latestAnsweredEscalation.assignee || '二次対応'}から回答が届いています</span>
              <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${escalationStatusMeta[latestAnsweredEscalation.status].className}`}>
                {escalationStatusMeta[latestAnsweredEscalation.status].label}
              </span>
            </div>
            <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-emerald-900">{latestAnsweredEscalation.answer}</p>
            {latestAnsweredEscalation.answeredAt && (
              <p className="mt-1 text-xs text-emerald-700">回答日時 {formatDateTime(latestAnsweredEscalation.answeredAt)}</p>
            )}
          </div>
        )}

        <InternalChatPanel
          key={detail.id}
          messages={detail.internalMessages ?? []}
          staffOptions={chatStaffOptions}
          saving={saving}
          onCreate={onInternalMessageCreate}
          onReaction={onInternalMessageReaction}
        />

        <div className="grid gap-3 lg:grid-cols-2">
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <div>
                <p className="text-sm font-semibold text-slate-900">会話ログ</p>
                <p className="mt-0.5 text-xs text-slate-500">チケットに紐づくLINE会話</p>
              </div>
              {chatHref && (
                <Link href={chatHref} className="inline-flex items-center gap-1 text-xs font-medium text-green-700 hover:underline">
                  <ChatIcon className="h-3.5 w-3.5" />
                  チャットを開く
                </Link>
              )}
            </div>
            {!canViewLineConversation ? (
              <div className="flex min-h-[220px] items-center justify-center bg-slate-50 p-4">
                <div className="max-w-sm rounded-xl border border-slate-200 bg-white px-4 py-5 text-center shadow-sm">
                  <p className="text-sm font-semibold text-slate-900">会話ログは権限制限中です</p>
                  <p className="mt-2 text-xs leading-6 text-slate-500">
                    二次対応のみの権限では、顧客LINEのトーク履歴を表示しません。問い合わせ内容と二次対応への依頼内容を確認してください。
                  </p>
                </div>
              </div>
            ) : (
              <div className="max-h-[460px] space-y-3 overflow-y-auto p-3" style={{ backgroundColor: '#7494C0' }}>
                {detail.recentMessages.length === 0 ? (
                  <p className="rounded-full bg-black/15 px-3 py-2 text-center text-sm text-white/80">会話ログはありません</p>
                ) : detail.recentMessages.map((message) => {
                  const isOutgoing = message.direction === 'outgoing'
                  return (
                    <div key={message.id} className={`flex ${isOutgoing ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-[82%] ${isOutgoing ? 'text-right' : 'text-left'}`}>
                        <div
                          className={`inline-block rounded-2xl px-3 py-2 text-left text-sm shadow-sm ${
                            isOutgoing
                              ? 'rounded-tr-md bg-[#06C755] text-white'
                              : 'rounded-tl-md bg-white text-gray-900'
                          }`}
                        >
                          <SupportMessageContent message={message} />
                        </div>
                        <div className="mt-1 flex items-center gap-1 px-1 text-[11px] text-white/70">
                          {messageSourceLabel(message.source) && isOutgoing && (
                            <span className="rounded bg-white/15 px-1.5 py-0.5 text-[10px] text-white/85">
                              {messageSourceLabel(message.source)}
                            </span>
                          )}
                          <span>{formatDateTime(message.createdAt)}</span>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-200 px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-slate-900">対応ログ</p>
                  <p className="mt-0.5 text-xs text-slate-500">作成、更新、二次回答などの記録</p>
                </div>
                <span className="rounded-md bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-600">
                  {detail.events.length}件
                </span>
              </div>
            </div>
            <div className="max-h-[460px] space-y-3 overflow-y-auto p-4">
              {detail.events.length === 0 ? (
                <p className="text-sm text-slate-500">履歴はありません</p>
              ) : detail.events.map((event) => (
                <div key={event.id} className="relative border-l-2 border-slate-200 pl-4">
                  <span className="absolute -left-[5px] top-1 h-2 w-2 rounded-full bg-slate-400 ring-2 ring-white" aria-hidden="true" />
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-700">
                      {eventTypeLabel[event.eventType] || event.eventType}
                    </span>
                    <span className="text-xs text-slate-500">
                      {formatDateTime(event.createdAt)}
                    </span>
                    <span className="text-xs text-slate-400">/ {event.actorName || 'system'}</span>
                  </div>
                  {event.body && <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-slate-600">{event.body}</p>}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* 未保存変更バー */}
      {dirty && (
        <div className="sticky bottom-0 flex items-center justify-between gap-3 rounded-b-lg border-t border-amber-200 bg-amber-50/95 px-4 py-2.5 backdrop-blur-sm">
          <span className="text-xs font-semibold text-amber-800">未保存の変更があります</span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onDiscard}
              disabled={saving}
              className="rounded-md border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-800 transition-colors hover:bg-amber-100 disabled:opacity-50"
            >
              変更を破棄
            </button>
            <button
              type="button"
              onClick={onSave}
              disabled={saving || !canSave}
              title={blockingValidationIssues[0]?.message}
              className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-700 disabled:opacity-50"
            >
              {saving ? '保存中…' : '保存 (⌘S)'}
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

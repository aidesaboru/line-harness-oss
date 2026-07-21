'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import Link from 'next/link'
import { parseStickerMessageContent, stickerFallback } from '@line-crm/shared'
import { ApiRequestError, api, buildApiUrl, fetchApi, type ChatActiveSupportCase, type ChatInternalMessage, type ChatMessageCursor, type ChatTypingParticipant, type ScheduledChatMessage } from '@/lib/api'
import { messageTypePreview } from '@/lib/message-type-label'
import { isStaleChat } from '@/lib/chat-staleness'
import {
  buildSupportChatRecoveryNotice,
  buildSupportChatSendCasePayload,
  buildSupportChatFallbackContext,
  consumeSupportChatDraft,
  mergeSupportChatDraftContext,
  planSupportChatSendAttachments,
  type SupportChatRecoveryNotice,
  type SupportChatDraftContext,
} from '@/lib/support-chat-draft'
import { useAccount } from '@/contexts/account-context'
import Header from '@/components/layout/header'
import FlexPreviewComponent from '@/components/flex-preview'
import FriendInfoSidebar from '@/components/chats/friend-info-sidebar'
import MentionText from '@/components/shared/mention-text'
import type { ImageUploaderValue } from '@/components/shared/image-uploader'

interface Chat {
  id: string
  friendId: string
  friendName: string
  friendPictureUrl: string | null
  operatorId: string | null
  status: 'unread' | 'in_progress' | 'resolved' | 'long_term'
  notes: string | null
  lastMessageAt: string | null
  lastMessageContent: string | null
  lastMessageDirection: 'incoming' | 'outgoing' | null
  lastMessageType: string | null
  createdAt: string
  updatedAt: string
  activeSupportCase?: ChatActiveSupportCase | null
}

interface ChatMessage {
  id: string
  direction: 'incoming' | 'outgoing'
  messageType: string
  content: string
  source?: string | null
  canQuote?: boolean
  quotedMessageId?: string | null
  markedAsReadAt?: string | null
  markedAsReadBy?: string | null
  deletedAt?: string | null
  deletedReason?: string | null
  sentByStaffId?: string | null
  sentByStaffName?: string | null
  createdAt: string
}

interface ChatDetail extends Chat {
  friendName: string
  friendPictureUrl: string | null
  messages?: ChatMessage[]
  hasMoreMessages?: boolean
  nextMessagesBefore?: ChatMessageCursor | null
  internalMessages?: ChatInternalMessage[]
  typingParticipants?: ChatTypingParticipant[]
  activeSupportCase?: ChatActiveSupportCase | null
  scheduledMessages?: ScheduledChatMessage[]
}

type StatusFilter = 'all' | 'unread' | 'in_progress' | 'long_term' | 'resolved'
type ChatSortMode = 'recent' | 'oldest' | 'stale' | 'unanswered'
type PendingChatAttachment = ImageUploaderValue | {
  mode: 'pdf-link'
  url: string
  fileName: string
  mimeType: string
  size: number
}

const CHAT_REALTIME_POLL_MS = 5 * 1000
const PDF_UPLOAD_MAX_BYTES = 25 * 1024 * 1024
const PDF_UPLOAD_MAX_LABEL = '25MB'
const FILE_UPLOAD_ERROR_MESSAGE = 'ファイルのアップロードに失敗しました。'
const internalReactionEmojis = ['👍', '🙏', '✅', '👀', '❤️']
const CHAT_SEARCH_DEBOUNCE_MS = 250

function fileUploadErrorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.apiError) return error.apiError
    if (error.status === 413) return `PDFは${PDF_UPLOAD_MAX_LABEL}以下にしてください。`
  }
  return FILE_UPLOAD_ERROR_MESSAGE
}

const statusConfig: Record<Chat['status'], { label: string; className: string }> = {
  unread: { label: '未読', className: 'bg-red-100 text-red-700' },
  in_progress: { label: '対応中', className: 'bg-yellow-100 text-yellow-700' },
  resolved: { label: '解決済', className: 'bg-green-100 text-green-700' },
  long_term: { label: '中長期対応', className: 'bg-blue-100 text-blue-700' },
}

function activeSupportCaseBadge(supportCase?: ChatActiveSupportCase | null): {
  label: string
  className: string
  description: string
} | null {
  if (!supportCase) return null
  if (supportCase.status === 'resolved') return null
  if (supportCase.status === 'customer_reply') {
    return {
      label: '顧客返信待ち',
      className: 'border-blue-200 bg-blue-50 text-blue-700',
      description: '顧客へ返信済みで、反応待ちのチケットがあります',
    }
  }
  if (supportCase.status === 'secondary_answered' || supportCase.latestEscalationStatus === 'answered') {
    return {
      label: '二次回答済み',
      className: 'border-emerald-200 bg-emerald-50 text-emerald-700',
      description: '二次対応者から回答が入っています',
    }
  }
  if (supportCase.status === 'waiting_primary') {
    return {
      label: '一次確認中',
      className: 'border-amber-200 bg-amber-50 text-amber-700',
      description: '一次対応者側で追加確認が必要です',
    }
  }
  if (supportCase.latestEscalationStatus === 'pending') {
    return {
      label: '二次対応待ち',
      className: 'border-purple-200 bg-purple-50 text-purple-700',
      description: '二次対応者の回答待ちです',
    }
  }
  return {
    label: '二次対応中',
    className: 'border-indigo-200 bg-indigo-50 text-indigo-700',
    description: '二次対応に上がっているチケットがあります',
  }
}

const statusFilters: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: '全て' },
  { key: 'unread', label: '未読' },
  { key: 'in_progress', label: '対応中' },
  { key: 'long_term', label: '中長期対応' },
  { key: 'resolved', label: '解決済' },
]

const sortOptions: { value: ChatSortMode; label: string }[] = [
  { value: 'recent', label: '新しい順' },
  { value: 'oldest', label: '古い順' },
  { value: 'stale', label: '24時間超過' },
  { value: 'unanswered', label: '未対応優先' },
]

function StickerMessageImage({ content }: { content: string }) {
  const [failed, setFailed] = useState(false)
  const sticker = parseStickerMessageContent(content)
  const fallback = stickerFallback(content)

  if (!sticker || failed) return <span>{fallback}</span>

  return (
    <img
      src={sticker.stickerUrl}
      alt={fallback}
      className="max-h-[140px] max-w-[140px] object-contain"
      loading="lazy"
      onError={() => setFailed(true)}
    />
  )
}

function formatDatetime(iso: string | null): string {
  if (!iso) return '-'
  return new Date(iso).toLocaleString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function toDatetimeLocalValue(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

function defaultScheduledAt(): string {
  const now = new Date()
  const next = new Date(now)
  next.setHours(9, 0, 0, 0)
  if (next.getTime() <= now.getTime() + 60_000) next.setDate(next.getDate() + 1)
  return toDatetimeLocalValue(next)
}

function scheduledMessagePreview(item: ScheduledChatMessage): string {
  return item.messages
    .map((message) => message.messageType === 'image' ? '画像' : message.content.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' / ')
    .slice(0, 90)
}

const scheduledStatusConfig: Record<
  ScheduledChatMessage['status'],
  { label: string; className: string }
> = {
  pending: { label: '予約中', className: 'bg-blue-50 text-blue-700' },
  processing: { label: '送信処理中', className: 'bg-amber-50 text-amber-700' },
  sent: { label: '送信済み', className: 'bg-emerald-50 text-emerald-700' },
  failed: { label: '再試行待ち', className: 'bg-red-50 text-red-700' },
  failed_permanent: { label: '送信失敗', className: 'bg-red-100 text-red-800' },
  cancelled: { label: '取消済み', className: 'bg-slate-100 text-slate-600' },
}

function getTime(iso: string | null): number {
  if (!iso) return 0
  const t = new Date(iso).getTime()
  return Number.isNaN(t) ? 0 : t
}

function chatMessagePreview(chat: Pick<Chat, 'lastMessageContent' | 'lastMessageType'>): string {
  const previewRaw = chat.lastMessageContent ?? ''
  if (chat.lastMessageType === 'image') return '画像'
  if (chat.lastMessageType === 'flex') return 'Flexメッセージ'
  if (chat.lastMessageType === 'sticker') return 'スタンプ'
  if (chat.lastMessageType === 'video') return '動画'
  if (chat.lastMessageType === 'audio') return '音声'
  if (chat.lastMessageType === 'file') return 'ファイル'
  if (chat.lastMessageType === 'location') return '位置情報'
  return previewRaw.replace(/\n+/g, ' ').slice(0, 70)
}

function chatWorkReason(chat: Chat): { label: string; className: string } {
  if (isStaleChat(chat)) {
    return {
      label: `24h超過 ${formatElapsed(chat.lastMessageAt)}`,
      className: 'border-orange-200 bg-orange-50 text-orange-700',
    }
  }
  if (chat.activeSupportCase?.status === 'secondary_answered' || chat.activeSupportCase?.latestEscalationStatus === 'answered') {
    return {
      label: '二次回答済み',
      className: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    }
  }
  if (chat.status === 'unread') {
    return {
      label: '未読',
      className: 'border-red-200 bg-red-50 text-red-700',
    }
  }
  if (chat.activeSupportCase?.latestEscalationStatus === 'pending') {
    return {
      label: '二次対応待ち',
      className: 'border-purple-200 bg-purple-50 text-purple-700',
    }
  }
  return {
    label: statusConfig[chat.status]?.label ?? '確認',
    className: 'border-slate-200 bg-slate-50 text-slate-600',
  }
}

function chatWorkRank(chat: Chat): number {
  if (isStaleChat(chat)) return 0
  if (chat.activeSupportCase?.status === 'secondary_answered' || chat.activeSupportCase?.latestEscalationStatus === 'answered') return 1
  if (chat.status === 'unread') return 2
  if (chat.activeSupportCase?.latestEscalationStatus === 'pending') return 3
  if (chat.status === 'in_progress') return 4
  if (chat.status === 'long_term') return 5
  return 6
}

function apiErrorStatus(err: unknown): number | null {
  const message = err instanceof Error ? err.message : ''
  const match = message.match(/^API error:\s*(\d{3})\b/)
  return match ? Number(match[1]) : null
}

type ChatFailureKind =
  | 'list'
  | 'detail'
  | 'older'
  | 'loading'
  | 'direct-send'
  | 'image-send'
  | 'text-send'
  | 'status'
  | 'internal-chat'

function chatFailureMessage(kind: ChatFailureKind): string {
  switch (kind) {
    case 'list':
      return 'チャットの読み込みに失敗しました。もう一度お試しください。'
    case 'detail':
      return 'チャット詳細の読み込みに失敗しました。もう一度お試しください。'
    case 'older':
      return '過去メッセージの読み込みに失敗しました。もう一度お試しください。'
    case 'loading':
      return 'ローディング表示の開始に失敗しました。'
    case 'direct-send':
      return 'メッセージの送信に失敗しました。もう一度お試しください。'
    case 'image-send':
      return '画像メッセージの送信に失敗しました。もう一度お試しください。'
    case 'text-send':
      return 'メッセージの送信に失敗しました。もう一度お試しください。'
    case 'status':
      return 'ステータスの更新に失敗しました。もう一度お試しください。'
    case 'internal-chat':
      return '社内チャットの投稿に失敗しました。もう一度お試しください。'
  }
}

function chatActionFailureMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiRequestError && err.apiError) return err.apiError
  return fallback
}

function buildEmptyChatDetailFromFriend(friend: {
  id: string
  displayName?: string | null
  pictureUrl?: string | null
  createdAt?: string | null
  updatedAt?: string | null
}): ChatDetail {
  const now = new Date().toISOString()
  return {
    id: friend.id,
    friendId: friend.id,
    friendName: friend.displayName || '名前なし',
    friendPictureUrl: friend.pictureUrl ?? null,
    operatorId: null,
    status: 'in_progress',
    notes: null,
    lastMessageAt: null,
    lastMessageContent: null,
    lastMessageDirection: null,
    lastMessageType: null,
    createdAt: friend.createdAt ?? now,
    updatedAt: friend.updatedAt ?? now,
    messages: [],
    hasMoreMessages: false,
    nextMessagesBefore: null,
    internalMessages: [],
    activeSupportCase: null,
  }
}

function formatElapsed(iso: string | null): string {
  const t = getTime(iso)
  if (!t) return ''
  const hours = Math.floor((Date.now() - t) / (60 * 60 * 1000))
  if (hours < 24) return `${hours}時間`
  return `${Math.floor(hours / 24)}日`
}

function FlameIcon({ className = 'h-3.5 w-3.5' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8.5 14.5A4.5 4.5 0 0 0 13 19a5 5 0 0 0 5-5c0-4-4-5.5-4-9-2.5 1.5-4 3.5-4 6a4 4 0 0 1-2-3c-2 1.5-3 3.5-3 6a8 8 0 0 0 8 8" />
    </svg>
  )
}

function PaperclipIcon({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  )
}

function XIcon({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}

function SearchIcon({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  )
}

function ArrowRightIcon({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  )
}

function TicketIcon({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z" />
      <path d="M13 5v2" />
      <path d="M13 17v2" />
      <path d="M13 11v2" />
    </svg>
  )
}

function InboxIcon({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z" />
    </svg>
  )
}

function markAsReadFailureMessage(result?: { requested: boolean; marked: boolean; reason: string | null }): string {
  if (!result?.requested || result.marked) return ''
  if (result.reason === 'no_token') {
    return '送信は完了しましたが、LINE公式側の既読化に必要なトークンがまだ保存されていません。次回以降の受信メッセージから既読化できます。'
  }
  return '送信は完了しましたが、LINE公式側の既読化に失敗しました。'
}

function markAsReadOnlyFailureMessage(result?: { requested: boolean; marked: boolean; reason: string | null }): string {
  if (!result?.requested || result.marked) return ''
  if (result.reason === 'no_token') {
    return '既読化に必要な情報がまだ保存されていません。次回以降の受信メッセージから既読化できます。'
  }
  return '既読化に失敗しました。時間を置いてもう一度お試しください。'
}

type ChatMediaPreview = {
  kind: 'image' | 'pdf' | 'file' | 'video' | 'audio'
  url: string
  previewUrl?: string
  label: string
  description?: string
}

function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.toString()
  } catch {
    return null
  }
}

function safeMediaUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('/api/') || trimmed.startsWith('/images/')) return buildApiUrl(trimmed)
  return safeHttpUrl(trimmed)
}

function contentString(parsed: Record<string, unknown> | null, keys: string[]): string | null {
  for (const key of keys) {
    const value = parsed?.[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function contentNumber(parsed: Record<string, unknown> | null, keys: string[]): number | null {
  for (const key of keys) {
    const value = parsed?.[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  }
  return null
}

function formatFileSize(size: number | null): string | null {
  if (size == null || size < 0) return null
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function lineMediaUrlFromLog(parsed: Record<string, unknown> | null, logId?: string): string | null {
  const explicitUrl =
    safeMediaUrl(parsed?.contentUrl) ??
    safeMediaUrl(parsed?.content_url) ??
    safeMediaUrl(parsed?.url) ??
    safeMediaUrl(parsed?.downloadUrl) ??
    safeMediaUrl(parsed?.download_url)
  if (explicitUrl) return explicitUrl

  const lineMessageId = contentString(parsed, ['lineMessageId', 'line_message_id', 'messageId', 'message_id'])
  if (!lineMessageId || !logId) return null
  return buildApiUrl(`/api/chats/messages/${encodeURIComponent(logId)}/media`)
}

function parseChatMediaPreview(messageType: string, content: string, logId?: string): ChatMediaPreview | null {
  let parsed: Record<string, unknown> | null = null
  try {
    parsed = JSON.parse(content) as Record<string, unknown>
  } catch {
    parsed = null
  }

  if (messageType === 'image') {
    const originalUrl =
      safeMediaUrl(parsed?.originalContentUrl) ??
      safeMediaUrl(parsed?.original_content_url) ??
      lineMediaUrlFromLog(parsed, logId)
    const previewUrl =
      safeMediaUrl(parsed?.previewImageUrl) ??
      safeMediaUrl(parsed?.preview_image_url) ??
      originalUrl
    const label = contentString(parsed, ['fileName', 'filename', 'name']) ?? 'LINE画像'
    if (!originalUrl) return null
    return { kind: 'image', url: originalUrl, previewUrl: previewUrl ?? originalUrl, label }
  }

  if (messageType === 'file' || messageType === 'video' || messageType === 'audio') {
    const url = lineMediaUrlFromLog(parsed, logId)
    const label =
      contentString(parsed, ['fileName', 'filename', 'name']) ??
      (messageType === 'video' ? '動画' : messageType === 'audio' ? '音声' : 'ファイル')
    if (!url) return null
    const mimeType = contentString(parsed, ['mimeType', 'mime_type', 'contentType', 'content_type'])
    const fileSize = formatFileSize(contentNumber(parsed, ['fileSize', 'file_size', 'size']))
    const isPdf = mimeType === 'application/pdf' || /\.pdf(?:$|[?#])/i.test(label) || /\.pdf(?:$|[?#])/i.test(url)
    const kind = isPdf ? 'pdf' : messageType === 'video' ? 'video' : messageType === 'audio' ? 'audio' : 'file'
    const description = [isPdf ? 'PDF' : messageType === 'video' ? '動画' : messageType === 'audio' ? '音声' : 'ファイル', fileSize]
      .filter(Boolean)
      .join(' / ')
    return { kind, url, label, description }
  }

  return null
}

function parseLocationPreview(content: string): { title: string; address: string; url: string | null } | null {
  let parsed: Record<string, unknown> | null = null
  try {
    const value = JSON.parse(content) as unknown
    parsed = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch {
    parsed = null
  }
  if (!parsed) return null
  const title = contentString(parsed, ['title']) ?? '位置情報'
  const address = contentString(parsed, ['address']) ?? ''
  const explicitUrl = safeMediaUrl(parsed.url)
  const lat = contentNumber(parsed, ['latitude'])
  const lng = contentNumber(parsed, ['longitude'])
  const url = explicitUrl ?? (lat != null && lng != null
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${lat},${lng}`)}`
    : null)
  return { title, address, url }
}

function trimUrlTrailingPunctuation(rawUrl: string): { url: string; suffix: string } {
  const match = rawUrl.match(/[)\],.。、「」』』）]+$/)
  if (!match) return { url: rawUrl, suffix: '' }
  return { url: rawUrl.slice(0, -match[0].length), suffix: match[0] }
}

function LinkifiedText({ text, isOutgoing }: { text: string; isOutgoing: boolean }) {
  const parts: React.ReactNode[] = []
  const urlPattern = /https?:\/\/[^\s<>"']+/g
  let lastIndex = 0
  for (const match of text.matchAll(urlPattern)) {
    const raw = match[0]
    const index = match.index ?? 0
    if (index > lastIndex) parts.push(text.slice(lastIndex, index))
    const { url, suffix } = trimUrlTrailingPunctuation(raw)
    parts.push(
      <a
        key={`${url}-${index}`}
        href={url}
        target="_blank"
        rel="noreferrer"
        className={`font-semibold underline underline-offset-2 ${isOutgoing ? 'text-white' : 'text-blue-700'}`}
      >
        {url}
      </a>,
    )
    if (suffix) parts.push(suffix)
    lastIndex = index + raw.length
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex))
  return <>{parts}</>
}

function chatMessageQuotePreview(message?: Pick<ChatMessage, 'messageType' | 'content'> | null): string {
  if (!message) return '元メッセージ'
  if (message.messageType === 'image') return '画像'
  if (message.messageType === 'file') return 'ファイル'
  if (message.messageType === 'video') return '動画'
  if (message.messageType === 'audio') return '音声'
  if (message.messageType === 'sticker') return 'スタンプ'
  if (message.messageType === 'location') return '位置情報'
  if (message.messageType === 'flex') return 'Flexメッセージ'
  return message.content.replace(/\s+/g, ' ').trim().slice(0, 90) || 'テキスト'
}

function sameYmd(aIso: string, bIso: string): boolean {
  const a = new Date(aIso)
  const b = new Date(bIso)
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

function formatYmdSlash(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

interface FriendItem {
  id: string
  displayName: string
  pictureUrl: string | null
  isFollowing: boolean
}

interface MessageLog {
  id: string
  direction: 'incoming' | 'outgoing'
  messageType: string
  content: string
  createdAt: string
}

function mentionNamesFromBody(body: string, staffOptions: string[]): string[] {
  const matchedKnown = staffOptions.filter((name) => body.includes(`@${name}`))
  if (matchedKnown.length > 0) return Array.from(new Set(matchedKnown))
  const names = new Set<string>()
  for (const match of body.matchAll(/@([^@\s　,、]+)/g)) {
    const value = match[1]?.trim()
    if (!value) continue
    names.add(value)
  }
  return Array.from(names)
}

function insertMention(text: string, name: string): string {
  const suffix = text.endsWith(' ') || text.endsWith('\n') || text.length === 0 ? '' : ' '
  return `${text}${suffix}@${name} `
}

function insertEmoji(text: string, emoji: string): string {
  const suffix = text.endsWith(' ') || text.endsWith('\n') || text.length === 0 ? '' : ' '
  return `${text}${suffix}${emoji} `
}

function ChatInternalComposer({
  value,
  onChange,
  onSubmit,
  staffOptions,
  saving,
  placeholder,
}: {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  staffOptions: string[]
  saving: boolean
  placeholder: string
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-2 shadow-sm">
      {staffOptions.length > 0 && (
        <div className="mb-2 flex gap-1 overflow-x-auto pb-0.5">
          {staffOptions.slice(0, 8).map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => onChange(insertMention(value, name))}
              className="shrink-0 rounded-full border border-sky-200 bg-sky-50 px-2 py-1 text-[11px] font-bold text-sky-700 hover:bg-sky-100"
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
            onClick={() => onChange(insertEmoji(value, emoji))}
            disabled={saving}
            className="rounded-full border border-slate-200 bg-slate-50 px-2 py-1 text-xs hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {emoji}
          </button>
        ))}
      </div>
      <div className="flex items-end gap-2">
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={2}
          placeholder={placeholder}
          className="min-h-12 flex-1 resize-none rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800 outline-none focus:border-slate-400 focus:bg-white focus:ring-2 focus:ring-slate-100"
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return
            if (e.key === 'Enter' && e.shiftKey) {
              e.preventDefault()
              onSubmit()
            }
          }}
        />
        <button
          type="button"
          onClick={onSubmit}
          disabled={saving || !value.trim()}
          className="h-10 rounded-md bg-slate-900 px-3 text-xs font-bold text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving ? '投稿中' : '投稿'}
        </button>
      </div>
    </div>
  )
}

function ChatInternalReactionRow({
  message,
  saving,
  onReaction,
}: {
  message: ChatInternalMessage
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
          className={`rounded-full border px-2 py-0.5 text-xs font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
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
            className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-xs font-bold text-slate-500 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
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

function ChatInternalBubble({
  message,
  replies,
  staffOptions,
  saving,
  onCreate,
  onReaction,
}: {
  message: ChatInternalMessage
  replies: ChatInternalMessage[]
  staffOptions: string[]
  saving: boolean
  onCreate: (body: string, parentId: string | null, mentions: string[]) => Promise<boolean>
  onReaction: (messageId: string, emoji: string) => Promise<void>
}) {
  const [openThread, setOpenThread] = useState(false)
  const [replyDraft, setReplyDraft] = useState('')
  const author = message.createdByName || 'スタッフ'
  const initial = author.charAt(0) || 'S'

  const submitReply = async () => {
    const body = replyDraft.trim()
    if (!body) return
    const ok = await onCreate(body, message.id, mentionNamesFromBody(body, staffOptions))
    if (ok) {
      setReplyDraft('')
      setOpenThread(true)
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
      <div className="flex items-start gap-2">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-900 text-xs font-bold text-white">
          {initial}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-bold text-slate-900">{author}</span>
            <span className="text-[11px] text-slate-400">{formatDatetime(message.createdAt)}</span>
            {message.createdByName === '過去メモ' && (
              <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-700">移行済み</span>
            )}
          </div>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-800">
            <MentionText text={message.body} mentions={message.mentions} />
          </p>
          {message.mentions.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {message.mentions.map((name) => (
                <span key={name} className="rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-bold text-blue-700">
                  @{name}
                </span>
              ))}
            </div>
          )}
          <ChatInternalReactionRow message={message} saving={saving} onReaction={onReaction} />
          <button
            type="button"
            onClick={() => setOpenThread((value) => !value)}
            className="mt-2 text-[11px] font-bold text-slate-500 hover:text-slate-900"
          >
            {openThread ? 'スレッドを閉じる' : replies.length > 0 ? `スレッド ${replies.length}件` : '返信'}
          </button>
        </div>
      </div>
      {openThread && (
        <div className="mt-3 space-y-2 border-l-2 border-slate-200 pl-4">
          {replies.map((reply) => (
            <div key={reply.id} className="rounded-lg bg-slate-50 px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] font-bold text-slate-700">{reply.createdByName || 'スタッフ'}</span>
                <span className="text-[10px] text-slate-400">{formatDatetime(reply.createdAt)}</span>
              </div>
              <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-slate-700">
                <MentionText text={reply.body} mentions={reply.mentions} />
              </p>
              <ChatInternalReactionRow message={reply} saving={saving} onReaction={onReaction} />
            </div>
          ))}
          <ChatInternalComposer
            value={replyDraft}
            onChange={setReplyDraft}
            onSubmit={submitReply}
            staffOptions={staffOptions}
            saving={saving}
            placeholder="この話題に返信"
          />
        </div>
      )}
    </div>
  )
}

function ChatInternalPanel({
  messages,
  staffOptions,
  saving,
  onCreate,
  onReaction,
  onClose,
}: {
  messages: ChatInternalMessage[]
  staffOptions: string[]
  saving: boolean
  onCreate: (body: string, parentId: string | null, mentions: string[]) => Promise<boolean>
  onReaction: (messageId: string, emoji: string) => Promise<void>
  onClose: () => void
}) {
  const [draft, setDraft] = useState('')
  const repliesByParent = useMemo(() => {
    const map = new Map<string, ChatInternalMessage[]>()
    for (const message of messages) {
      if (!message.parentId) continue
      const list = map.get(message.parentId) ?? []
      list.push(message)
      map.set(message.parentId, list)
    }
    return map
  }, [messages])
  const roots = useMemo(() => messages.filter((message) => !message.parentId), [messages])

  const submit = async () => {
    const body = draft.trim()
    if (!body) return
    const ok = await onCreate(body, null, mentionNamesFromBody(body, staffOptions))
    if (ok) setDraft('')
  }

  return (
    <div className="flex h-full flex-col bg-slate-50">
      <div className="shrink-0 border-b border-slate-200 bg-white px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-bold text-slate-900">社内チャット</p>
            <p className="mt-0.5 text-[11px] text-slate-500">一次対応者だけで相談できます。お客様には表示されません。</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-bold text-slate-600">
              {messages.length}件
            </span>
            <button
              type="button"
              onClick={onClose}
              className="rounded-full p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
              aria-label="社内チャットを閉じる"
            >
              <XIcon className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-3">
        {roots.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white px-3 py-4 text-center text-xs text-slate-400">
            まだ社内チャットはありません
          </div>
        ) : (
          roots.map((message) => (
            <ChatInternalBubble
              key={message.id}
              message={message}
              replies={repliesByParent.get(message.id) ?? []}
              staffOptions={staffOptions}
              saving={saving}
              onCreate={onCreate}
              onReaction={onReaction}
            />
          ))
        )}
      </div>
      <div className="shrink-0 border-t border-slate-200 bg-slate-50 p-3">
        <ChatInternalComposer
          value={draft}
          onChange={setDraft}
          onSubmit={submit}
          staffOptions={staffOptions}
          saving={saving}
          placeholder="引き継ぎ、確認事項、対応方針を投稿"
        />
      </div>
    </div>
  )
}

function ChatWorkDashboard({
  totalCount,
  staleChatCount,
  unreadChatCount,
  inProgressChatCount,
  supportLinkedCount,
  secondaryAnsweredCount,
  priorityChats,
  staleOnly,
  loading,
  onOpenStaleQueue,
  onOpenUnreadQueue,
  onOpenUnansweredQueue,
  onSelectChat,
  onClearQueue,
}: {
  totalCount: number
  staleChatCount: number
  unreadChatCount: number
  inProgressChatCount: number
  supportLinkedCount: number
  secondaryAnsweredCount: number
  priorityChats: Chat[]
  staleOnly: boolean
  loading: boolean
  onOpenStaleQueue: () => void
  onOpenUnreadQueue: () => void
  onOpenUnansweredQueue: () => void
  onSelectChat: (chatId: string) => void
  onClearQueue: () => void
}) {
  const statItems = [
    {
      label: '24h超過',
      value: staleChatCount,
      description: '古い順で確認',
      className: staleChatCount > 0 ? 'border-orange-200 bg-orange-50 text-orange-800' : 'border-slate-200 bg-white text-slate-600',
      icon: <FlameIcon className="h-4 w-4" />,
      onClick: onOpenStaleQueue,
    },
    {
      label: '未読',
      value: unreadChatCount,
      description: '顧客返信を優先',
      className: unreadChatCount > 0 ? 'border-red-200 bg-red-50 text-red-800' : 'border-slate-200 bg-white text-slate-600',
      icon: <InboxIcon className="h-4 w-4" />,
      onClick: onOpenUnreadQueue,
    },
    {
      label: '対応中',
      value: inProgressChatCount,
      description: '作業中の会話',
      className: 'border-amber-200 bg-amber-50 text-amber-800',
      icon: <ArrowRightIcon className="h-4 w-4" />,
      onClick: onOpenUnansweredQueue,
    },
    {
      label: 'チケット連携',
      value: supportLinkedCount,
      description: secondaryAnsweredCount > 0 ? `二次回答済み ${secondaryAnsweredCount}件` : '案件化済み',
      className: secondaryAnsweredCount > 0 ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-slate-200 bg-white text-slate-600',
      icon: <TicketIcon className="h-4 w-4" />,
      onClick: onOpenUnansweredQueue,
    },
  ]

  return (
    <div className="flex h-full flex-col bg-slate-50">
      <div className="shrink-0 border-b border-slate-200 bg-white px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-bold text-slate-400">オペレーション</p>
            <h2 className="mt-1 text-xl font-bold text-slate-950">今日の対応</h2>
            <p className="mt-1 text-sm text-slate-500">
              {loading ? 'チャット一覧を更新中です' : `${totalCount}件の会話から優先度順に処理できます`}
            </p>
          </div>
          {staleOnly && (
            <button
              type="button"
              onClick={onClearQueue}
              className="rounded-md border border-orange-200 bg-orange-50 px-3 py-2 text-xs font-bold text-orange-700 transition-colors hover:bg-orange-100"
            >
              24h超過のみを解除
            </button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <div className="grid gap-3 xl:grid-cols-4">
          {statItems.map((item) => (
            <button
              key={item.label}
              type="button"
              onClick={item.onClick}
              className={`rounded-lg border px-4 py-3 text-left shadow-sm transition hover:shadow-md ${item.className}`}
            >
              <span className="flex items-center justify-between gap-3">
                <span className="inline-flex items-center gap-2 text-sm font-bold">
                  {item.icon}
                  {item.label}
                </span>
                <span className="text-2xl font-black tabular-nums">{item.value}</span>
              </span>
              <span className="mt-1 block text-xs font-semibold opacity-70">{item.description}</span>
            </button>
          ))}
        </div>

        <div className="mt-5 grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(300px,0.65fr)]">
          <section className="rounded-lg border border-slate-200 bg-white shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
              <div>
                <h3 className="text-sm font-bold text-slate-950">次に見るチャット</h3>
                <p className="mt-0.5 text-xs text-slate-500">24h超過 二次回答 未読の順で並べています</p>
              </div>
              <button
                type="button"
                onClick={onOpenStaleQueue}
                className="rounded-md border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-bold text-slate-700 transition-colors hover:bg-white"
              >
                24h超過を開く
              </button>
            </div>
            <div className="divide-y divide-slate-100">
              {priorityChats.length === 0 ? (
                <div className="px-4 py-10 text-center">
                  <p className="text-sm font-bold text-slate-700">今すぐ対応が必要なチャットはありません</p>
                  <p className="mt-1 text-xs text-slate-400">新しい問い合わせが届くとここに表示されます</p>
                </div>
              ) : priorityChats.map((chat) => {
                const reason = chatWorkReason(chat)
                const preview = chatMessagePreview(chat)
                return (
                  <div key={chat.id} className="flex items-center gap-3 px-4 py-3">
                    <button
                      type="button"
                      onClick={() => onSelectChat(chat.id)}
                      className="min-w-0 flex-1 rounded-md px-1 py-1 text-left transition-colors hover:bg-slate-50"
                    >
                      <span className="flex items-start gap-3">
                        {chat.friendPictureUrl ? (
                          <img src={chat.friendPictureUrl} alt="" className="h-9 w-9 shrink-0 rounded-full object-cover" />
                        ) : (
                          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-200 text-sm font-bold text-slate-500">
                            {chat.friendName.charAt(0)}
                          </span>
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center justify-between gap-2">
                            <span className="truncate text-sm font-bold text-slate-900">{chat.friendName}</span>
                            <span className="shrink-0 text-[11px] text-slate-400">{formatDatetime(chat.lastMessageAt)}</span>
                          </span>
                          <span className={`mt-1 inline-flex max-w-full rounded-full border px-2 py-0.5 text-[11px] font-bold ${reason.className}`}>
                            <span className="truncate">{reason.label}</span>
                          </span>
                          <span className="mt-1 block truncate text-xs text-slate-500">
                            {chat.lastMessageDirection === 'outgoing' ? '送信済み ' : ''}
                            {preview || 'まだメッセージなし'}
                          </span>
                        </span>
                      </span>
                    </button>
                    <Link
                      href={`/support?create=1&friend=${encodeURIComponent(chat.friendId)}`}
                      className="hidden shrink-0 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-700 transition-colors hover:bg-emerald-100 sm:inline-flex"
                    >
                      チケット化
                    </Link>
                  </div>
                )
              })}
            </div>
          </section>

          <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <h3 className="text-sm font-bold text-slate-950">関連導線</h3>
            <div className="mt-3 rounded-lg border border-orange-100 bg-orange-50 px-3 py-3">
              <div className="flex items-center justify-between gap-3">
                <span className="inline-flex items-center gap-2 text-sm font-bold text-orange-800">
                  <FlameIcon className="h-4 w-4" />
                  24h超過
                </span>
                <span className="text-lg font-black tabular-nums text-orange-800">{staleChatCount}</span>
              </div>
              <button
                type="button"
                onClick={onOpenStaleQueue}
                className="mt-3 inline-flex w-full items-center justify-between rounded-md bg-white px-3 py-2 text-sm font-bold text-orange-700 ring-1 ring-orange-200 transition-colors hover:bg-orange-100"
              >
                古い順で開く
                <ArrowRightIcon />
              </button>
            </div>
            <div className="mt-4 grid gap-2">
              <Link
                href="/support"
                className="inline-flex items-center justify-between rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-bold text-slate-700 transition-colors hover:bg-white"
              >
                チケット管理を開く
                <ArrowRightIcon />
              </Link>
              <Link
                href="/notifications"
                className="inline-flex items-center justify-between rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-bold text-slate-700 transition-colors hover:bg-white"
              >
                通知センターを見る
                <ArrowRightIcon />
              </Link>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

function DirectMessagePanel({ friendId, friend, onBack, onSent }: {
  friendId: string
  friend: FriendItem | null
  onBack: () => void
  onSent: () => void
}) {
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [messages, setMessages] = useState<MessageLog[]>([])
  const [loadingMessages, setLoadingMessages] = useState(true)
  const [historyError, setHistoryError] = useState('')
  const [sendError, setSendError] = useState('')
  const isComposingRef = useRef(false)
  const sendLockRef = useRef(false)

  useEffect(() => {
    const loadMessages = async () => {
      setLoadingMessages(true)
      setHistoryError('')
      try {
        const res = await fetchApi<{ success: boolean; data: MessageLog[] }>(
          `/api/friends/${friendId}/messages`
        )
        if (res.success) {
          setMessages(res.data)
        } else {
          setHistoryError('メッセージ履歴の読み込みに失敗しました。')
        }
      } catch {
        setHistoryError('メッセージ履歴の読み込みに失敗しました。')
      }
      setLoadingMessages(false)
    }
    loadMessages()
  }, [friendId])

  const handleSend = async () => {
    if (!message.trim() || sending || sendLockRef.current) return
    const content = message.trim()
    sendLockRef.current = true
    setSending(true)
    setSendError('')
    try {
      const res = await fetchApi<{ success: boolean; data?: { messageId: string }; error?: string }>(`/api/friends/${friendId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content, messageType: 'text' }),
      })
      if (!res.success) {
        setSendError(chatFailureMessage('direct-send'))
        return
      }
      setMessages((prev) => [...prev, {
        id: res.data?.messageId ?? crypto.randomUUID(),
        direction: 'outgoing',
        messageType: 'text',
        content,
        createdAt: new Date().toISOString(),
      }])
      setMessage('')
    } catch (err) {
      setSendError(chatActionFailureMessage(err, chatFailureMessage('direct-send')))
    } finally {
      setSending(false)
      sendLockRef.current = false
    }
  }

  function renderContent(msg: MessageLog) {
    if (msg.messageType === 'text') return msg.content
    if (msg.messageType === 'flex') {
      try {
        const parsed = JSON.parse(msg.content)
        // Extract ALL text from flex (up to 200 chars)
        const texts: string[] = []
        const collectText = (obj: Record<string, unknown>) => {
          if (texts.join(' ').length > 200) return
          if (obj.type === 'text' && typeof obj.text === 'string') {
            const t = (obj.text as string).trim()
            if (t && !t.startsWith('{{')) texts.push(t)
          }
          for (const key of ['header', 'body', 'footer']) {
            if (obj[key]) collectText(obj[key] as Record<string, unknown>)
          }
          if (Array.isArray(obj.contents)) {
            for (const c of obj.contents) collectText(c as Record<string, unknown>)
          }
        }
        collectText(parsed)
        return texts.slice(0, 4).join('\n') || messageTypePreview('flex')
      } catch { return messageTypePreview('flex') }
    }
    if (msg.messageType === 'sticker') {
      return <StickerMessageImage content={msg.content} />
    }
    return messageTypePreview(msg.messageType)
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-4 border-b border-gray-200 flex items-center gap-3">
        <button onClick={onBack} className="lg:hidden text-gray-400 hover:text-gray-600">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        {friend?.pictureUrl ? (
          <img src={friend.pictureUrl} alt="" className="w-8 h-8 rounded-full" />
        ) : (
          <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center">
            <span className="text-gray-500 text-xs">{(friend?.displayName || '?').charAt(0)}</span>
          </div>
        )}
        <div>
          <p className="text-sm font-bold text-gray-900">{friend?.displayName || '不明'}</p>
          <p className="text-xs text-gray-400">メッセージ履歴</p>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {loadingMessages ? (
          <p className="text-center text-gray-400 text-sm">読み込み中...</p>
        ) : historyError ? (
          <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{historyError}</p>
        ) : messages.length === 0 ? (
          <p className="text-center text-gray-400 text-sm">メッセージ履歴がありません</p>
        ) : (
          messages.map((msg) => (
            <div key={msg.id} className={`flex ${msg.direction === 'outgoing' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[75%] rounded-2xl px-4 py-2 ${
                msg.direction === 'outgoing'
                  ? 'bg-green-500 text-white'
                  : 'bg-gray-100 text-gray-900'
              }`}>
                <div className="text-sm whitespace-pre-wrap break-words">{renderContent(msg)}</div>
                <p className={`text-xs mt-1 ${msg.direction === 'outgoing' ? 'text-green-200' : 'text-gray-400'}`}>
                  {new Date(msg.createdAt).toLocaleString('ja-JP', { hour: '2-digit', minute: '2-digit' })}
                </p>
              </div>
            </div>
          ))
        )}
      </div>
      <div className="px-4 py-3 border-t border-gray-200">
        {sendError && (
          <p className="mb-2 text-xs text-red-600">{sendError}</p>
        )}
        <div className="flex gap-2">
          <input
            type="text"
            value={message}
            onChange={(e) => {
              setMessage(e.target.value)
              if (sendError) setSendError('')
            }}
            onCompositionStart={() => { isComposingRef.current = true }}
            onCompositionEnd={() => { isComposingRef.current = false }}
            onKeyDown={(e) => {
              // IME変換確定のEnterでは送信しない
              if (e.nativeEvent.isComposing || isComposingRef.current || e.keyCode === 229) return
              if (e.key === 'Enter' && e.shiftKey) {
                e.preventDefault()
                handleSend()
              }
            }}
            placeholder="メッセージを入力..."
            className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
          />
          <button
            onClick={handleSend}
            disabled={!message.trim() || sending}
            className="px-4 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50"
            style={{ backgroundColor: '#06C755' }}
          >
            {sending ? '...' : '送信'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function ChatsPage() {
  const { selectedAccountId } = useAccount()
  const [chats, setChats] = useState<Chat[]>([])
  const [allFriends, setAllFriends] = useState<FriendItem[]>([])
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null)
  const [selectedFriendId, setSelectedFriendId] = useState<string | null>(null)
  const [chatDetail, setChatDetail] = useState<ChatDetail | null>(null)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [searchTerm, setSearchTerm] = useState('')
  const [debouncedSearchTerm, setDebouncedSearchTerm] = useState('')
  const [sortMode, setSortMode] = useState<ChatSortMode>(() => {
    if (typeof window === 'undefined') return 'recent'
    try {
      const saved = localStorage.getItem('chat.sortMode')
      return saved === 'oldest' || saved === 'stale' || saved === 'unanswered' ? saved : 'recent'
    } catch {
      return 'recent'
    }
  })
  const statusFilterRef = useRef<StatusFilter>('all')
  const unansweredOnlyRef = useRef(false)
  const [unansweredOnly, setUnansweredOnly] = useState(() => {
    if (typeof window === 'undefined') return false
    return new URLSearchParams(window.location.search).get('unanswered') === '1'
  })
  const [staleOnly, setStaleOnly] = useState(false)

  // unansweredOnly 変更時に URL を書き戻す
  useEffect(() => {
    if (typeof window === 'undefined') return
    const urlParams = new URLSearchParams(window.location.search)
    if (unansweredOnly) urlParams.set('unanswered', '1')
    else urlParams.delete('unanswered')
    const qs = urlParams.toString()
    const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname
    window.history.replaceState(null, '', url)
  }, [unansweredOnly])
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false)
  const [error, setError] = useState('')
  const [messageContent, setMessageContent] = useState('')
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const [scheduledAt, setScheduledAt] = useState('')
  const [scheduling, setScheduling] = useState(false)
  const [scheduledActionId, setScheduledActionId] = useState<string | null>(null)
  const [quoteTarget, setQuoteTarget] = useState<ChatMessage | null>(null)
  const [supportDraftContext, setSupportDraftContext] = useState<SupportChatDraftContext | null>(null)
  const [supportRecoveryNotice, setSupportRecoveryNotice] = useState<SupportChatRecoveryNotice | null>(null)
  const [pendingImage, setPendingImage] = useState<PendingChatAttachment | null>(null)
  const [uploadingImage, setUploadingImage] = useState(false)
  const [imageUploadError, setImageUploadError] = useState('')
  const [mediaPreview, setMediaPreview] = useState<ChatMediaPreview | null>(null)
  const [sending, setSending] = useState(false)
  const [markingAsRead, setMarkingAsRead] = useState(false)
  const [reflectingDeletedMessageId, setReflectingDeletedMessageId] = useState<string | null>(null)
  const sendLockRef = useRef(false)
  const [savingInternalChat, setSavingInternalChat] = useState(false)
  const [staffOptions, setStaffOptions] = useState<string[]>([])
  const [internalChatOpen, setInternalChatOpen] = useState(false)
  const isComposingRef = useRef(false)
  const messagesScrollRef = useRef<HTMLDivElement | null>(null)
  const preserveScrollOnNextMessagesChangeRef = useRef(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const typingStopTimeoutRef = useRef<number | null>(null)
  const lastTypingSentAtRef = useRef(0)
  const activeTypingChatIdRef = useRef<string | null>(null)

  useEffect(() => {
    try { localStorage.setItem('chat.sortMode', sortMode) } catch { /* ignore */ }
  }, [sortMode])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearchTerm(searchTerm.trim().replace(/\s+/g, ' '))
    }, CHAT_SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [searchTerm])

  const clearTypingStopTimer = useCallback(() => {
    if (typingStopTimeoutRef.current != null) {
      window.clearTimeout(typingStopTimeoutRef.current)
      typingStopTimeoutRef.current = null
    }
  }, [])

  const sendTypingStatus = useCallback(async (chatId: string, active: boolean) => {
    try {
      const res = await api.chats.typing(chatId, { active })
      if (!res.success || !res.data) return
      setChatDetail((prev) => (prev && prev.id === chatId) ? {
        ...prev,
        status: res.data.status,
        typingParticipants: res.data.typingParticipants,
      } : prev)
      setChats((prev) => prev.map((chat) => chat.id === chatId ? {
        ...chat,
        status: res.data.status,
      } : chat))
    } catch {
      // 入力中表示は補助機能なので、失敗しても顧客対応は止めない。
    }
  }, [])

  const stopTypingStatus = useCallback((chatId?: string | null) => {
    clearTypingStopTimer()
    const targetChatId = chatId ?? activeTypingChatIdRef.current
    lastTypingSentAtRef.current = 0
    if (!targetChatId) return
    if (activeTypingChatIdRef.current === targetChatId) {
      activeTypingChatIdRef.current = null
    }
    void sendTypingStatus(targetChatId, false)
  }, [clearTypingStopTimer, sendTypingStatus])

  const markTypingActive = useCallback((chatId: string) => {
    const previousChatId = activeTypingChatIdRef.current
    if (previousChatId && previousChatId !== chatId) {
      void sendTypingStatus(previousChatId, false)
      lastTypingSentAtRef.current = 0
    }
    activeTypingChatIdRef.current = chatId
    const now = Date.now()
    if (now - lastTypingSentAtRef.current >= 4_000) {
      lastTypingSentAtRef.current = now
      void sendTypingStatus(chatId, true)
    }
    clearTypingStopTimer()
    typingStopTimeoutRef.current = window.setTimeout(() => {
      stopTypingStatus(chatId)
    }, 8_000)
  }, [clearTypingStopTimer, sendTypingStatus, stopTypingStatus])

  useEffect(() => {
    return () => {
      clearTypingStopTimer()
      const activeChatId = activeTypingChatIdRef.current
      if (activeChatId) {
        activeTypingChatIdRef.current = null
        void api.chats.typing(activeChatId, { active: false }).catch(() => {})
      }
    }
  }, [clearTypingStopTimer])

  useEffect(() => {
    const activeChatId = activeTypingChatIdRef.current
    if (activeChatId && activeChatId !== selectedChatId) {
      stopTypingStatus(activeChatId)
    }
  }, [selectedChatId, stopTypingStatus])

  const loadChats = useCallback(async (options: { silent?: boolean } = {}) => {
    if (!options.silent) {
      setLoading(true)
      setError('')
    }
    try {
      const params: { status?: string; accountId?: string; unansweredOnly?: boolean; search?: string } = {}
      if (statusFilter !== 'all' && !unansweredOnly) params.status = statusFilter
      if (selectedAccountId) params.accountId = selectedAccountId
      if (unansweredOnly) params.unansweredOnly = true
      if (debouncedSearchTerm) params.search = debouncedSearchTerm
      const chatRes = await api.chats.list(params)
      if (chatRes.success) {
        setChats(chatRes.data as unknown as Chat[])
      } else {
        if (!options.silent) setError(chatFailureMessage('list'))
      }
    } catch {
      if (!options.silent) setError(chatFailureMessage('list'))
    } finally {
      if (!options.silent) setLoading(false)
    }
  }, [statusFilter, selectedAccountId, unansweredOnly, debouncedSearchTerm])

  // Friends list (for the "new direct message" modal) — loaded lazily in the background
  // Previously fetched 800 friends in parallel with chats, which blocked the initial render.
  const loadAllFriends = useCallback(async () => {
    try {
      const friendRes = await api.friends.list({ accountId: selectedAccountId || undefined, limit: '800' })
      if (friendRes.success) {
        setAllFriends((friendRes.data as unknown as { items: FriendItem[] }).items)
      }
    } catch { /* silent */ }
  }, [selectedAccountId])

  useEffect(() => { void loadAllFriends() }, [loadAllFriends])

  useEffect(() => {
    let cancelled = false
    api.staff.assigneeOptions()
      .then((res) => {
        if (cancelled || !res.success) return
        const names = Array.from(new Set(res.data.filter((staff) => staff.isActive).map((staff) => staff.name).filter(Boolean)))
        setStaffOptions(names)
      })
      .catch(() => {
        if (!cancelled) setStaffOptions([])
      })
    return () => { cancelled = true }
  }, [])

  // Keep refs in sync so setChats updater can read the latest filter without stale closure
  useEffect(() => { statusFilterRef.current = statusFilter }, [statusFilter])
  useEffect(() => { unansweredOnlyRef.current = unansweredOnly }, [unansweredOnly])

  const loadChatDetail = useCallback(async (chatId: string, options: { silent?: boolean } = {}) => {
    if (!options.silent) setDetailLoading(true)
    setLoadingOlderMessages(false)
    if (!options.silent) setError('')
    const loadFriendFallback = async (): Promise<boolean> => {
      try {
        const friendRes = await api.friends.get(chatId)
        if (!friendRes.success || !friendRes.data) return false
        setChatDetail(buildEmptyChatDetailFromFriend(friendRes.data))
        return true
      } catch {
        return false
      }
    }
    try {
      const res = await api.chats.get(chatId)
      if (res.success) {
        setChatDetail(res.data as unknown as ChatDetail)
      } else {
        if (await loadFriendFallback()) return
        if (!options.silent) setError(chatFailureMessage('detail'))
      }
    } catch (err) {
      if (apiErrorStatus(err) === 404 && await loadFriendFallback()) return
      if (!options.silent) setError(chatFailureMessage('detail'))
    } finally {
      if (!options.silent) setDetailLoading(false)
    }
  }, [])

  const handleFriendUpdated = useCallback((friend: { id: string; displayName: string | null; pictureUrl: string | null }) => {
    const nextName = friend.displayName || '名前なし'
    setChatDetail((prev) => {
      if (!prev || prev.friendId !== friend.id) return prev
      return {
        ...prev,
        friendName: nextName,
        friendPictureUrl: friend.pictureUrl,
      }
    })
    setChats((prev) => prev.map((chat) => chat.friendId === friend.id ? {
      ...chat,
      friendName: nextName,
      friendPictureUrl: friend.pictureUrl,
    } : chat))
    setAllFriends((prev) => prev.map((item) => item.id === friend.id ? {
      ...item,
      displayName: nextName,
      pictureUrl: friend.pictureUrl,
    } : item))
  }, [])

  const handleLoadOlderMessages = useCallback(async () => {
    if (!chatDetail?.id || !chatDetail.nextMessagesBefore || loadingOlderMessages) return
    const cursor = chatDetail.nextMessagesBefore
    const scrollEl = messagesScrollRef.current
    const previousScrollHeight = scrollEl?.scrollHeight ?? 0
    setLoadingOlderMessages(true)
    setError('')
    try {
      const res = await api.chats.get(chatDetail.id, {
        messageLimit: 1000,
        beforeCreatedAt: cursor.createdAt,
        beforeId: cursor.id,
      })
      if (!res.success) {
        setError(chatFailureMessage('older'))
        return
      }

      const olderDetail = res.data as ChatDetail
      preserveScrollOnNextMessagesChangeRef.current = true
      setChatDetail((prev) => {
        if (!prev || prev.id !== chatDetail.id) return prev
        return {
          ...prev,
          messages: [...(olderDetail.messages ?? []), ...(prev.messages ?? [])],
          hasMoreMessages: olderDetail.hasMoreMessages,
          nextMessagesBefore: olderDetail.nextMessagesBefore ?? null,
        }
      })

      window.setTimeout(() => {
        preserveScrollOnNextMessagesChangeRef.current = false
        const current = messagesScrollRef.current
        if (!current) return
        current.scrollTop = current.scrollHeight - previousScrollHeight + current.scrollTop
      }, 0)
    } catch {
      setError(chatFailureMessage('older'))
    } finally {
      setLoadingOlderMessages(false)
    }
  }, [chatDetail?.id, chatDetail?.nextMessagesBefore, loadingOlderMessages])

  useEffect(() => {
    loadChats()
  }, [loadChats])

  // Deep-link from other pages (e.g. /form-submissions): ?friend=<friendId>.
  // Chat list returns id = friend_id, and the send API can lazily create a chat
  // from that friend id, so selectedChatId === friendId is correct even before
  // the first manual reply.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const friendId = params.get('friend')
    const supportCaseId = params.get('supportCase')
    if (friendId) setSelectedChatId(friendId)
    if (!friendId || !supportCaseId) return
    let context: SupportChatDraftContext | null = null
    try {
      context = consumeSupportChatDraft(window.sessionStorage, window.location.search)
    } catch {
      context = null
    }
    context ??= buildSupportChatFallbackContext(window.location.search)
    if (context) {
      if (context.draft) setMessageContent((prev) => prev.trim() ? prev : context.draft)
      setSupportDraftContext((prev) => mergeSupportChatDraftContext(prev, context))
      setSupportRecoveryNotice(null)
    }
  }, [])

  useEffect(() => {
    if (selectedChatId) {
      loadChatDetail(selectedChatId)
    } else {
      setChatDetail(null)
    }
  }, [selectedChatId, loadChatDetail])

  const refreshVisibleChats = useCallback(() => {
    if (!selectedAccountId || document.hidden || sending || markingAsRead) return
    void loadChats({ silent: true })
    if (selectedChatId) {
      void loadChatDetail(selectedChatId, { silent: true })
    }
  }, [loadChatDetail, loadChats, markingAsRead, selectedAccountId, selectedChatId, sending])

  useEffect(() => {
    if (!selectedAccountId) return
    const timer = window.setInterval(refreshVisibleChats, CHAT_REALTIME_POLL_MS)
    return () => window.clearInterval(timer)
  }, [refreshVisibleChats, selectedAccountId])

  useEffect(() => {
    if (!selectedAccountId) return
    const handleVisibleRefresh = () => {
      if (!document.hidden) refreshVisibleChats()
    }
    window.addEventListener('focus', handleVisibleRefresh)
    window.addEventListener('online', handleVisibleRefresh)
    document.addEventListener('visibilitychange', handleVisibleRefresh)
    return () => {
      window.removeEventListener('focus', handleVisibleRefresh)
      window.removeEventListener('online', handleVisibleRefresh)
      document.removeEventListener('visibilitychange', handleVisibleRefresh)
    }
  }, [refreshVisibleChats, selectedAccountId])

  // Surface deep-linked chats in the sidebar even when the current account
  // filter or status filter would exclude them — otherwise the user replies
  // and the conversation stays invisible until they refresh.
  // Re-runs when `chats` changes (e.g. after loadChats refetches on filter
  // change) so the synthetic entry is re-injected if the next API result
  // does not include it. Returning `prev` unchanged when already present
  // avoids any update loop.
  useEffect(() => {
    if (!chatDetail) return
    setChats((prev) => {
      if (prev.some((c) => c.id === chatDetail.id)) return prev
      // /api/chats/:id may not populate the lastMessage* fields; derive
      // from the messages array as a fallback so the sidebar preview is
      // not stuck on "(まだメッセージなし)".
      const lastMsg = chatDetail.messages?.[chatDetail.messages.length - 1]
      const entry: Chat = {
        id: chatDetail.id,
        friendId: chatDetail.friendId,
        friendName: chatDetail.friendName,
        friendPictureUrl: chatDetail.friendPictureUrl,
        operatorId: chatDetail.operatorId ?? null,
        status: chatDetail.status,
        notes: chatDetail.notes ?? null,
        lastMessageAt: chatDetail.lastMessageAt ?? lastMsg?.createdAt ?? null,
        lastMessageContent: chatDetail.lastMessageContent ?? lastMsg?.content ?? null,
        lastMessageDirection: chatDetail.lastMessageDirection ?? lastMsg?.direction ?? null,
        lastMessageType: chatDetail.lastMessageType ?? lastMsg?.messageType ?? null,
        activeSupportCase: chatDetail.activeSupportCase ?? null,
        createdAt: chatDetail.createdAt,
        updatedAt: chatDetail.updatedAt,
      }
      return [entry, ...prev]
    })
  }, [chatDetail, chats])

  // 詳細が新しくロードされたら最下部（＝最新メッセージ）までスクロールする。
  // そこから上にスクロールすれば過去のメッセージを辿れる（LINE受信画面と同じUX）。
  // ユーザーが手動でスクロールしたら delayed auto-scroll は発動させない。
  useEffect(() => {
    if (!chatDetail?.messages || chatDetail.messages.length === 0) return
    if (preserveScrollOnNextMessagesChangeRef.current) {
      preserveScrollOnNextMessagesChangeRef.current = false
      return
    }
    const el = messagesScrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    let userScrolled = false
    const onScroll = () => {
      if (!messagesScrollRef.current) return
      const current = messagesScrollRef.current
      // 下端から一定以上離れたらユーザー操作とみなす
      if (current.scrollHeight - current.scrollTop - current.clientHeight > 20) {
        userScrolled = true
      }
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    // 画像/Flex の表示後に高さが増える場合に追従するフォロワー（ユーザーがスクロール済みなら発動させない）
    const id = window.setTimeout(() => {
      if (userScrolled || !messagesScrollRef.current) return
      messagesScrollRef.current.scrollTop = messagesScrollRef.current.scrollHeight
    }, 150)
    return () => {
      window.clearTimeout(id)
      el.removeEventListener('scroll', onScroll)
    }
  }, [chatDetail?.id, chatDetail?.messages?.length])

  // Auto-resize textarea as messageContent grows
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`
  }, [messageContent])

  const handleSelectChat = (chatId: string) => {
    setSelectedChatId(chatId)
    setMessageContent('')
    setScheduleOpen(false)
    setScheduledAt('')
    setQuoteTarget(null)
    setSupportDraftContext(null)
    setSupportRecoveryNotice(null)
    setPendingImage(null)
    setImageUploadError('')
    setInternalChatOpen(false)
  }

  const handleOpenWorkQueue = (
    mode: ChatSortMode,
    chatId?: string | null,
    options: { status?: StatusFilter; staleOnly?: boolean; unansweredOnly?: boolean } = {},
  ) => {
    setSelectedFriendId(null)
    setStatusFilter(options.status ?? 'all')
    setUnansweredOnly(options.unansweredOnly ?? false)
    setStaleOnly(options.staleOnly ?? false)
    setSortMode(mode)
    if (chatId) handleSelectChat(chatId)
  }

  const handleSelectQuoteTarget = (message: ChatMessage) => {
    setQuoteTarget(message)
    setError('')
    window.setTimeout(() => textareaRef.current?.focus(), 0)
  }

  const handleImageFiles = useCallback(async (files: FileList | null) => {
    const file = files?.[0]
    if (!file) return
    setImageUploadError('')
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
    const isLineImage = ['image/jpeg', 'image/png'].includes(file.type)
    if (!isLineImage && !isPdf) {
      setImageUploadError('送信できるファイルはPNG、JPEG、PDFです。')
      return
    }
    if (isLineImage && file.size > 1024 * 1024) {
      setImageUploadError('LINE画像は1MB以下にしてください。')
      return
    }
    if (isPdf && file.size > PDF_UPLOAD_MAX_BYTES) {
      setImageUploadError(`PDFは${PDF_UPLOAD_MAX_LABEL}以下にしてください。`)
      return
    }
    setUploadingImage(true)
    try {
      const res = isPdf ? await api.uploads.file(file) : await api.uploads.image(file)
      if (!res.success) {
        setImageUploadError('ファイルのアップロードに失敗しました。')
        return
      }
      if (isPdf) {
        setPendingImage({
          mode: 'pdf-link',
          url: res.data.url,
          fileName: 'filename' in res.data && typeof res.data.filename === 'string' ? res.data.filename : file.name,
          mimeType: res.data.mimeType,
          size: res.data.size,
        })
      } else {
        setPendingImage({
          mode: 'line-image',
          originalContentUrl: res.data.url,
          previewImageUrl: res.data.url,
        })
      }
    } catch (err) {
      setImageUploadError(fileUploadErrorMessage(err))
    } finally {
      setUploadingImage(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }, [])

  const handleSendMessage = async () => {
    if (!selectedChatId || sending || scheduling || sendLockRef.current) return
    if (!messageContent.trim() && !pendingImage) return
    if (quoteTarget && !messageContent.trim() && pendingImage?.mode !== 'pdf-link') {
      setError('返信機能を使うときは、返信文を入力して送信してください。')
      return
    }
    const sendingChatId = selectedChatId  // capture the chat id for this send
    const sendingQuoteTarget = quoteTarget
    const supportContext = supportDraftContext
    const pdfAttachment = pendingImage?.mode === 'pdf-link' ? pendingImage : null
    const pdfMessage = pdfAttachment
      ? `PDF: ${pdfAttachment.fileName}\n${pdfAttachment.url}`
      : ''
    const textContent = [messageContent.trim(), pdfMessage].filter(Boolean).join('\n\n')
    const { attachSupportToImage, attachSupportToText } = planSupportChatSendAttachments(supportContext, {
      hasLineImage: pendingImage?.mode === 'line-image',
      hasText: Boolean(textContent),
    })
    sendLockRef.current = true
    setSending(true)
    let sendFailureFallback = chatFailureMessage('text-send')
    if (supportContext) setSupportRecoveryNotice(null)
    try {
      const now = new Date().toISOString()
      // --- Image send path (runs first when image is present) ---
      if (pendingImage && pendingImage.mode === 'line-image') {
        sendFailureFallback = chatFailureMessage('image-send')
        const imgPayload = JSON.stringify({
          originalContentUrl: pendingImage.originalContentUrl,
          previewImageUrl: pendingImage.previewImageUrl,
        })
        const imageResult = await api.chats.send(sendingChatId, {
          messageType: 'image',
          content: imgPayload,
          markAsRead: true,
          ...buildSupportChatSendCasePayload(supportContext, attachSupportToImage),
        })
        if (!imageResult.success) {
          setError(chatFailureMessage('image-send'))
          return
        }
        if (attachSupportToImage) {
          const recoveryNotice = buildSupportChatRecoveryNotice(imageResult.data.supportCase, supportContext)
          if (recoveryNotice) {
            setSupportRecoveryNotice(recoveryNotice)
            setError('')
          }
          setSupportDraftContext(null)
        }
        const markAsReadNotice = markAsReadFailureMessage(imageResult.data.markAsRead)
        if (markAsReadNotice) setError(markAsReadNotice)
        setPendingImage(null)
        // Optimistic update for image
        setChatDetail((prev) => (prev && prev.id === sendingChatId) ? {
          ...prev,
          lastMessageAt: now,
          status: 'in_progress',
          messages: [
            ...(prev.messages ?? []),
            {
              id: imageResult.data.messageId,
              direction: 'outgoing',
              messageType: 'image',
              content: imgPayload,
              sentByStaffId: imageResult.data.sentByStaffId ?? null,
              sentByStaffName: imageResult.data.sentByStaffName ?? null,
              createdAt: now,
            },
          ],
        } : prev)
        setChats((prev) => {
          const exists = prev.some((c) => c.id === sendingChatId)
          if (!exists) return prev
          const currentFilter = statusFilterRef.current
          const currentUnansweredOnly = unansweredOnlyRef.current
          const updated = prev.map((c) => c.id === sendingChatId ? {
            ...c,
            lastMessageAt: now,
            status: 'in_progress' as const,
            lastMessageContent: '[画像]',
            lastMessageDirection: 'outgoing' as const,
            lastMessageType: 'image' as const,
          } : c)
          let filtered = currentFilter === 'all' ? updated : updated.filter((c) => c.status === currentFilter)
          if (currentUnansweredOnly) {
            // 未対応モードでは、自分が返信したばかりの chat はもう未対応ではないのでリストから除外
            filtered = filtered.filter((c) => c.id !== sendingChatId)
          }
          return [...filtered].sort((a, b) => {
            const at = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0
            const bt = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0
            return bt - at
          })
        })
      }
      // --- Text send path (runs independently — both paths execute when both image and text are present) ---
      if (textContent) {
        sendFailureFallback = chatFailureMessage('text-send')
        const content = textContent
        const sendResult = await api.chats.send(sendingChatId, {
          content,
          markAsRead: true,
          quoteMessageId: sendingQuoteTarget?.id ?? undefined,
          ...buildSupportChatSendCasePayload(supportContext, attachSupportToText),
        })
        if (!sendResult.success) {
          setError(chatFailureMessage('text-send'))
          return
        }
        const recoveryNotice = buildSupportChatRecoveryNotice(sendResult.data.supportCase, supportContext)
        if (recoveryNotice) {
          setSupportRecoveryNotice(recoveryNotice)
          setError('')
        }
        const markAsReadNotice = markAsReadFailureMessage(sendResult.data.markAsRead)
        if (markAsReadNotice) setError(markAsReadNotice)
        setMessageContent('')
        setQuoteTarget(null)
        if (pdfAttachment) setPendingImage(null)
        if (supportContext) setSupportDraftContext(null)
        // Optimistic update: append message locally instead of refetching (prevents scroll jump / full reload feel)
        // Only mutate chatDetail if it still corresponds to the chat we just sent to
        setChatDetail((prev) => (prev && prev.id === sendingChatId) ? {
          ...prev,
          lastMessageAt: now,
          status: 'in_progress',
          messages: [
            ...(prev.messages ?? []),
            {
              id: sendResult.data.messageId,
              direction: 'outgoing',
              messageType: 'text',
              content,
              quotedMessageId: sendResult.data.quotedMessageId ?? sendingQuoteTarget?.id ?? null,
              sentByStaffId: sendResult.data.sentByStaffId ?? null,
              sentByStaffName: sendResult.data.sentByStaffName ?? null,
              createdAt: now,
            },
          ],
        } : prev)
        setChats((prev) => {
          // Skip reconciliation if the list no longer contains this chat (e.g. tab changed mid-send)
          const exists = prev.some((c) => c.id === sendingChatId)
          if (!exists) return prev
          const currentFilter = statusFilterRef.current
          const currentUnansweredOnly = unansweredOnlyRef.current
          const updated = prev.map((c) => c.id === sendingChatId ? {
            ...c,
            lastMessageAt: now,
            status: 'in_progress' as const,
            // 一覧の preview も即時更新する。incoming 優先ロジックで上書きされ得るが、
            // 楽観 UI では「operator が今送った文面」が一瞬見えるのが期待動作。
            // 次回 loadChats() で server 側の真の最新 (incoming 優先) に reconcile される。
            lastMessageContent: content,
            lastMessageDirection: 'outgoing' as const,
            lastMessageType: 'text' as const,
          } : c)
          // Drop rows that no longer match the current tab (e.g. replying from 未読 moves chat to in_progress)
          let filtered = currentFilter === 'all' ? updated : updated.filter((c) => c.status === currentFilter)
          if (currentUnansweredOnly) {
            // 未対応モードでは、自分が返信したばかりの chat はもう未対応ではないのでリストから除外
            filtered = filtered.filter((c) => c.id !== sendingChatId)
          }
          return [...filtered].sort((a, b) => {
            const at = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0
            const bt = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0
            return bt - at
          })
        })
      }
    } catch (err) {
      setError(chatActionFailureMessage(err, sendFailureFallback))
    } finally {
      stopTypingStatus(sendingChatId)
      setSending(false)
      sendLockRef.current = false
    }
  }

  const handleScheduleMessage = async () => {
    if (!selectedChatId || scheduling || sending || !scheduledAt) return
    if (!messageContent.trim() && !pendingImage) return
    if (quoteTarget) {
      setError('返信指定中のメッセージは予約送信できません。返信指定を解除してから予約してください。')
      return
    }
    const scheduledTime = new Date(scheduledAt)
    if (Number.isNaN(scheduledTime.getTime()) || scheduledTime.getTime() < Date.now() + 60_000) {
      setError('予約日時は1分以上先を指定してください。')
      return
    }

    const targetChatId = selectedChatId
    const pdfAttachment = pendingImage?.mode === 'pdf-link' ? pendingImage : null
    const pdfMessage = pdfAttachment ? `PDF: ${pdfAttachment.fileName}\n${pdfAttachment.url}` : ''
    const textContent = [messageContent.trim(), pdfMessage].filter(Boolean).join('\n\n')
    const messages: Array<{ content: string; messageType?: 'text' | 'image' }> = []
    if (pendingImage?.mode === 'line-image') {
      messages.push({
        messageType: 'image',
        content: JSON.stringify({
          originalContentUrl: pendingImage.originalContentUrl,
          previewImageUrl: pendingImage.previewImageUrl,
        }),
      })
    }
    if (textContent) messages.push({ messageType: 'text', content: textContent })
    if (messages.length === 0) return

    setScheduling(true)
    setError('')
    try {
      const result = await api.chats.schedule(targetChatId, {
        scheduledAt: scheduledTime.toISOString(),
        messages,
        ...(supportDraftContext ? {
          supportCaseId: supportDraftContext.caseId,
          lineAccountId: supportDraftContext.lineAccountId,
        } : {}),
      })
      if (!result.success) {
        setError('予約送信を登録できませんでした。もう一度お試しください。')
        return
      }
      setChatDetail((prev) => (prev && prev.id === targetChatId) ? {
        ...prev,
        status: 'in_progress',
        scheduledMessages: [...(prev.scheduledMessages ?? []), result.data]
          .sort((a, b) => getTime(a.scheduledAt) - getTime(b.scheduledAt)),
      } : prev)
      setChats((prev) => prev.map((chat) => chat.id === targetChatId ? {
        ...chat,
        status: 'in_progress',
      } : chat))
      setMessageContent('')
      setPendingImage(null)
      setQuoteTarget(null)
      setSupportDraftContext(null)
      setScheduleOpen(false)
      setScheduledAt('')
      stopTypingStatus(targetChatId)
    } catch (err) {
      setError(chatActionFailureMessage(err, '予約送信を登録できませんでした。もう一度お試しください。'))
    } finally {
      setScheduling(false)
    }
  }

  const handleCancelScheduled = async (item: ScheduledChatMessage) => {
    if (!selectedChatId || scheduledActionId) return
    setScheduledActionId(item.id)
    setError('')
    try {
      await api.chats.cancelScheduled(selectedChatId, item.id)
      setChatDetail((prev) => prev ? {
        ...prev,
        scheduledMessages: (prev.scheduledMessages ?? []).filter((scheduled) => scheduled.id !== item.id),
      } : prev)
    } catch (err) {
      setError(chatActionFailureMessage(err, '予約送信を取り消せませんでした。もう一度お試しください。'))
    } finally {
      setScheduledActionId(null)
    }
  }

  const handleRetryScheduled = async (item: ScheduledChatMessage) => {
    if (!selectedChatId || scheduledActionId) return
    setScheduledActionId(item.id)
    setError('')
    try {
      await api.chats.retryScheduled(selectedChatId, item.id)
      setChatDetail((prev) => prev ? {
        ...prev,
        scheduledMessages: (prev.scheduledMessages ?? []).map((scheduled) => (
          scheduled.id === item.id
            ? { ...scheduled, status: 'pending', attempts: 0, lastError: null }
            : scheduled
        )),
      } : prev)
    } catch (err) {
      setError(chatActionFailureMessage(err, '予約送信を再試行できませんでした。もう一度お試しください。'))
    } finally {
      setScheduledActionId(null)
    }
  }

  const handleMarkLatestAsRead = async () => {
    if (!selectedChatId || sending || scheduling || markingAsRead || sendLockRef.current) return
    const targetChatId = selectedChatId
    const latestMessage = chatDetail?.messages?.slice().reverse().find((message) => !message.deletedAt)
    if (latestMessage?.direction !== 'incoming') return
    setMarkingAsRead(true)
    setError('')
    try {
      const result = await api.chats.markRead(targetChatId)
      if (!result.success) {
        setError('既読化に失敗しました。もう一度お試しください。')
        return
      }
      const notice = markAsReadOnlyFailureMessage(result.data.markAsRead)
      if (notice) {
        setError(notice)
        return
      }
      const markedMessageId = result.data.markedMessageId ?? result.data.markAsRead.messageId ?? latestMessage.id
      const markedAt = result.data.markedAt ?? result.data.markAsRead.markedAt ?? result.data.updatedAt
      setChatDetail((prev) => (prev && prev.id === targetChatId) ? {
        ...prev,
        status: result.data.status ?? 'in_progress',
        updatedAt: result.data.updatedAt,
        messages: prev.messages?.map((message) => (
          message.id === markedMessageId
            ? { ...message, markedAsReadAt: markedAt }
            : message
        )),
      } : prev)
      setChats((prev) => {
        const currentFilter = statusFilterRef.current
        const currentUnansweredOnly = unansweredOnlyRef.current
        const updated = prev.map((chat) => chat.id === targetChatId ? {
          ...chat,
          status: (result.data.status ?? 'in_progress') as Chat['status'],
          updatedAt: result.data.updatedAt,
        } : chat)
        let filtered = currentFilter === 'all' ? updated : updated.filter((chat) => chat.status === currentFilter)
        if (currentUnansweredOnly) {
          filtered = filtered.filter((chat) => chat.id !== targetChatId)
        }
        return [...filtered].sort((a, b) => {
          const at = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0
          const bt = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0
          return bt - at
        })
      })
      setError('')
    } catch (err) {
      setError(chatActionFailureMessage(err, '既読化に失敗しました。もう一度お試しください。'))
    } finally {
      setMarkingAsRead(false)
    }
  }

  const handleReflectMessageDeleted = async (message: ChatMessage) => {
    if (!selectedChatId || reflectingDeletedMessageId) return
    const targetChatId = selectedChatId
    const isOfficialSideRecord = message.source === 'line_official'
    const confirmed = window.confirm(
      isOfficialSideRecord
        ? 'LINE公式画面で送信取り消し済みの内容を、Lリンク上にも反映します。顧客側のLINEを操作する機能ではありません。続けますか？'
        : 'LINE APIの仕様上、Lリンクから送ったメッセージは顧客側のLINEから取り消せません。Lリンク上の表示だけ非表示にします。続けますか？',
    )
    if (!confirmed) return
    const messageId = message.id
    setReflectingDeletedMessageId(messageId)
    setError('')
    try {
      const result = await api.chats.markMessageDeleted(targetChatId, messageId)
      if (!result.success || !result.data) {
        setError('送信取り消しの反映に失敗しました。もう一度お試しください。')
        return
      }
      setChatDetail((prev) => (prev && prev.id === targetChatId) ? {
        ...prev,
        messages: prev.messages?.map((message) => (
          message.id === messageId
            ? {
                ...message,
                deletedAt: result.data.deletedAt,
                deletedReason: 'manual_unsend_reflection',
              }
            : message
        )),
      } : prev)
    } catch (err) {
      setError(chatActionFailureMessage(err, '送信取り消しの反映に失敗しました。もう一度お試しください。'))
    } finally {
      setReflectingDeletedMessageId(null)
    }
  }

  const handleStatusUpdate = async (newStatus: Chat['status']) => {
    if (!selectedChatId) return
    try {
      const res = await api.chats.update(selectedChatId, { status: newStatus })
      if (!res.success) {
        setError(chatFailureMessage('status'))
        return
      }
      setError('')
      loadChatDetail(selectedChatId)
      loadChats()
    } catch {
      setError(chatFailureMessage('status'))
    }
  }

  const handleCreateInternalMessage = async (body: string, parentId: string | null, mentions: string[]): Promise<boolean> => {
    if (!selectedChatId || savingInternalChat) return false
    const targetChatId = selectedChatId
    setSavingInternalChat(true)
    try {
      const res = await api.chats.addInternalMessage(targetChatId, {
        body,
        parentId,
        mentions,
      })
      if (!res.success || !res.data) {
        setError(chatFailureMessage('internal-chat'))
        return false
      }
      setError('')
      setChatDetail((prev) => {
        if (!prev || prev.id !== targetChatId) return prev
        return {
          ...prev,
          internalMessages: [...(prev.internalMessages ?? []), res.data],
        }
      })
      return true
    } catch (err) {
      setError(chatActionFailureMessage(err, chatFailureMessage('internal-chat')))
      return false
    } finally {
      setSavingInternalChat(false)
    }
  }

  const handleInternalMessageReaction = async (messageId: string, emoji: string): Promise<void> => {
    if (!selectedChatId || savingInternalChat) return
    const targetChatId = selectedChatId
    try {
      const res = await api.chats.toggleInternalReaction(targetChatId, messageId, emoji)
      if (!res.success || !res.data) {
        setError('リアクションの更新に失敗しました。')
        return
      }
      setError('')
      setChatDetail((prev) => {
        if (!prev || prev.id !== targetChatId) return prev
        return {
          ...prev,
          internalMessages: (prev.internalMessages ?? []).map((message) => (
            message.id === res.data.id ? res.data : message
          )),
        }
      })
    } catch (err) {
      setError(chatActionFailureMessage(err, 'リアクションの更新に失敗しました。'))
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    // IME変換確定のEnterでは送信しない
    if (e.nativeEvent.isComposing || isComposingRef.current || e.keyCode === 229) return
    if (e.key !== 'Enter') return
    if (e.shiftKey) {
      e.preventDefault()
      if (scheduleOpen) return
      handleSendMessage()
    }
  }

  const visibleChats = useMemo(() => {
    const filtered = staleOnly ? chats.filter(isStaleChat) : chats
    return [...filtered].sort((a, b) => {
      const at = getTime(a.lastMessageAt)
      const bt = getTime(b.lastMessageAt)

      if (sortMode === 'oldest') {
        const aOldest = at || Number.MAX_SAFE_INTEGER
        const bOldest = bt || Number.MAX_SAFE_INTEGER
        return aOldest - bOldest
      }
      if (sortMode === 'stale') {
        const aStale = isStaleChat(a) ? 1 : 0
        const bStale = isStaleChat(b) ? 1 : 0
        if (aStale !== bStale) return bStale - aStale
        return aStale && bStale ? at - bt : bt - at
      }
      if (sortMode === 'unanswered') {
        const rank = (chat: Chat) => {
          if (chat.status === 'unread') return 0
          if (isStaleChat(chat)) return 1
          if (chat.status === 'in_progress') return 2
          return 3
        }
        const ar = rank(a)
        const br = rank(b)
        if (ar !== br) return ar - br
      }
      return bt - at
    })
  }, [chats, sortMode, staleOnly])

  const staleChatCount = useMemo(() => chats.filter(isStaleChat).length, [chats])
  const unreadChatCount = useMemo(() => chats.filter((chat) => chat.status === 'unread').length, [chats])
  const inProgressChatCount = useMemo(() => chats.filter((chat) => chat.status === 'in_progress').length, [chats])
  const supportLinkedCount = useMemo(() => chats.filter((chat) => activeSupportCaseBadge(chat.activeSupportCase)).length, [chats])
  const secondaryAnsweredCount = useMemo(() => (
    chats.filter((chat) => chat.activeSupportCase?.status === 'secondary_answered' || chat.activeSupportCase?.latestEscalationStatus === 'answered').length
  ), [chats])
  const oldestStaleChat = useMemo(() => (
    chats
      .filter(isStaleChat)
      .sort((a, b) => getTime(a.lastMessageAt) - getTime(b.lastMessageAt))[0] ?? null
  ), [chats])
  const firstUnreadChat = useMemo(() => (
    chats
      .filter((chat) => chat.status === 'unread')
      .sort((a, b) => getTime(b.lastMessageAt) - getTime(a.lastMessageAt))[0] ?? null
  ), [chats])
  const firstActionableChat = useMemo(() => (
    chats
      .filter((chat) => (
        (chat.status !== 'resolved' && chat.status !== 'long_term') || Boolean(activeSupportCaseBadge(chat.activeSupportCase))
      ))
      .sort((a, b) => {
        const ar = chatWorkRank(a)
        const br = chatWorkRank(b)
        if (ar !== br) return ar - br
        if (isStaleChat(a) && isStaleChat(b)) return getTime(a.lastMessageAt) - getTime(b.lastMessageAt)
        return getTime(b.lastMessageAt) - getTime(a.lastMessageAt)
      })[0] ?? null
  ), [chats])
  const priorityChats = useMemo(() => (
    chats
      .filter((chat) => (
        (chat.status !== 'resolved' && chat.status !== 'long_term') || Boolean(activeSupportCaseBadge(chat.activeSupportCase))
      ))
      .sort((a, b) => {
        const ar = chatWorkRank(a)
        const br = chatWorkRank(b)
        if (ar !== br) return ar - br
        if (isStaleChat(a) && isStaleChat(b)) return getTime(a.lastMessageAt) - getTime(b.lastMessageAt)
        return getTime(b.lastMessageAt) - getTime(a.lastMessageAt)
      })
      .slice(0, 5)
  ), [chats])
  const selectedSupportBadge = activeSupportCaseBadge(chatDetail?.activeSupportCase)
  const chatMessagesById = useMemo(
    () => new Map((chatDetail?.messages ?? []).map((message) => [message.id, message] as const)),
    [chatDetail?.messages],
  )
  const latestChatMessage = chatDetail?.messages?.slice().reverse().find((message) => !message.deletedAt)
  const latestIncomingMarkedAsRead = latestChatMessage?.direction === 'incoming' && Boolean(latestChatMessage.markedAsReadAt)
  const canMarkLatestIncomingAsRead = latestChatMessage?.direction === 'incoming' && !latestIncomingMarkedAsRead
  const markReadButtonLabel = markingAsRead ? '既読中...' : latestIncomingMarkedAsRead ? '既読済み' : '既読にする'
  const markReadButtonTitle = latestIncomingMarkedAsRead
    ? '最後の顧客メッセージは既読済みです'
    : canMarkLatestIncomingAsRead
      ? '最後の顧客メッセージに既読を付けます'
      : '最後が顧客メッセージの時だけ使えます'

  return (
    <div>
      <Header title="オペレーターチャット" />

      {/* Error */}
      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      <div className="flex gap-4 h-[calc(100vh-120px)] lg:h-[calc(100vh-180px)]">
        {/* Left Panel: Chat List */}
        <div className={`w-full lg:w-96 lg:flex-shrink-0 bg-white rounded-lg shadow-sm border border-gray-200 flex-col overflow-hidden ${selectedChatId ? 'hidden lg:flex' : 'flex'}`}>
          {/* タブ (全て / 未読 / 対応中 / 解決済) は意図的に削除。直近メッセージが見やすい LINE 風一覧を優先。 */}

          {/* Filter row */}
          <div className="border-b border-gray-100 bg-white px-3 py-2">
            <div className="mb-2 flex items-center justify-between gap-2 text-xs text-gray-500">
              <span>{debouncedSearchTerm ? `検索結果 ${visibleChats.length}件` : `${chats.length}件中 ${visibleChats.length}件を表示`}</span>
              <button
                type="button"
                onClick={() => handleOpenWorkQueue('stale', oldestStaleChat?.id ?? null, { staleOnly: true })}
                className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-semibold transition-colors ${
                  staleOnly
                    ? 'bg-orange-600 text-white'
                    : staleChatCount > 0
                      ? 'bg-orange-50 text-orange-700 hover:bg-orange-100'
                      : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                }`}
                title="24時間超過のチャットだけを表示"
              >
                <FlameIcon className="h-3 w-3" />
                24h超過 {staleChatCount}
              </button>
            </div>
            <div className="relative mb-2">
              <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input
                type="search"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="顧客名・番号・本文で検索"
                aria-label="チャット検索"
                className="h-10 w-full rounded-lg border border-gray-300 bg-white pl-9 pr-10 text-sm font-medium text-gray-900 outline-none transition focus:border-green-500 focus:ring-2 focus:ring-green-100"
              />
              {searchTerm && (
                <button
                  type="button"
                  onClick={() => setSearchTerm('')}
                  className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-gray-400 transition hover:bg-gray-100 hover:text-gray-700"
                  aria-label="検索をクリア"
                  title="検索をクリア"
                >
                  <XIcon className="h-4 w-4" />
                </button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
            {statusFilters.map((f) => (
              <button
                key={f.key}
                onClick={() => {
                  setStatusFilter(f.key)
                  setStaleOnly(false)
                }}
                disabled={unansweredOnly}
                className={`min-h-10 rounded-full px-4 py-2 text-sm font-bold transition-colors ${
                  statusFilter === f.key
                    ? 'bg-green-500 text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                } ${unansweredOnly ? 'opacity-40 cursor-not-allowed' : ''}`}
              >
                {f.label}
              </button>
            ))}
            <select
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value as ChatSortMode)}
              className="ml-auto h-10 rounded-md border border-gray-300 bg-white px-3 text-sm font-bold text-gray-700"
              aria-label="チャットの並び順"
            >
              {sortOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <label className="flex min-h-10 items-center gap-2 rounded-md bg-gray-100 px-3 text-sm font-bold whitespace-nowrap cursor-pointer select-none">
              <input
                type="checkbox"
                checked={unansweredOnly}
                onChange={(e) => {
                  setUnansweredOnly(e.target.checked)
                  if (e.target.checked) setStaleOnly(false)
                }}
                className="h-4 w-4 rounded"
              />
              未対応のみ
            </label>
            </div>
          </div>

          {/* Chat List */}
          <div className="flex-1 overflow-y-auto">
            {loading ? (
              <div>
                {[...Array(5)].map((_, i) => (
                  <div key={i} className="px-4 py-3 border-b border-gray-100 animate-pulse">
                    <div className="flex items-center gap-3">
                      <div className="flex-1 space-y-2">
                        <div className="h-3 bg-gray-200 rounded w-32" />
                        <div className="h-2 bg-gray-100 rounded w-20" />
                      </div>
                      <div className="h-5 bg-gray-100 rounded-full w-12" />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <>
                {visibleChats.length === 0 ? (
                  <div className="px-4 py-10 text-center">
                    <p className="text-sm font-bold text-gray-700">
                      {debouncedSearchTerm ? '該当するチャットがありません' : 'チャットがありません'}
                    </p>
                    <p className="mt-1 text-xs text-gray-400">
                      {debouncedSearchTerm ? '顧客名・番号・本文を変えて検索してください。' : '新しいトークが届くとここに表示されます。'}
                    </p>
                  </div>
                ) : visibleChats.map((chat) => {
                  const isSelected = selectedChatId === chat.id
                  // 「真の自発（要対応）」= chat.status='unread'。webhook 側で auto_reply に
                  // マッチしなかった incoming のみ unread に設定される。auto_reply trigger
                  // (キーワード "コスト比較" 等) は matched 扱いで unread 化しない。
                  // bold / 🟥 の表示はこの status を使う。direction だけだと button 押下も
                  // 強調してしまって S/N 比が悪化する。
                  const needsAttention = chat.status === 'unread'
                  const stale = isStaleChat(chat)
                  const supportBadge = activeSupportCaseBadge(chat.activeSupportCase)
                  // 最新メッセージの本文 preview。flex/image は文字列で見せても意味が薄いので type 表記に置換。
                  const previewRaw = chat.lastMessageContent ?? ''
                  const preview = (() => {
                    if (chat.lastMessageType === 'image') return '📷 画像'
                    if (chat.lastMessageType === 'flex') return '📋 Flexメッセージ'
                    if (chat.lastMessageType === 'sticker') return '🎨 スタンプ'
                    if (chat.lastMessageType === 'video') return '🎥 動画'
                    if (chat.lastMessageType === 'audio') return '🎤 音声'
                    if (chat.lastMessageType === 'file') return '📎 ファイル'
                    if (chat.lastMessageType === 'location') return '📍 位置情報'
                    return previewRaw.replace(/\n+/g, ' ').slice(0, 60)
                  })()
                  return (
                    <button
                      key={chat.id}
                      onClick={() => { setSelectedFriendId(null); handleSelectChat(chat.id); }}
                      className={`w-full border-b border-l-4 border-gray-100 px-4 py-3 text-left transition-colors ${
                        stale ? 'border-l-orange-500 bg-orange-50/70 hover:bg-orange-50' : 'border-l-transparent'
                      } ${
                        isSelected && !selectedFriendId ? 'bg-green-50' : stale ? '' : 'hover:bg-gray-50'
                      }`}
                    >
                      <div className="flex items-start gap-3">
                        {chat.friendPictureUrl ? (
                          <img src={chat.friendPictureUrl} alt="" className="w-10 h-10 rounded-full flex-shrink-0" />
                        ) : (
                          <div className="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center flex-shrink-0">
                            <span className="text-gray-500 text-sm">{chat.friendName.charAt(0)}</span>
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-1.5 min-w-0 flex-1">
                              {chat.status === 'unread' && (
                                <span className="w-2 h-2 rounded-full bg-red-500 flex-shrink-0" aria-label="未読" />
                              )}
                              <p className="text-sm font-medium text-gray-900 truncate">{chat.friendName}</p>
                            </div>
                            <span className="text-[10px] text-gray-400 flex-shrink-0">{formatDatetime(chat.lastMessageAt)}</span>
                          </div>
                          {stale && (
                            <div className="mt-1 inline-flex items-center gap-1 rounded-full border border-orange-200 bg-white px-2 py-0.5 text-[10px] font-semibold text-orange-700">
                              <FlameIcon className="h-3 w-3" />
                              24h超過 {formatElapsed(chat.lastMessageAt)}
                            </div>
                          )}
                          {supportBadge && (
                            <div className={`mt-1 inline-flex max-w-full items-center rounded-full border px-2 py-0.5 text-[10px] font-bold ${supportBadge.className}`} title={chat.activeSupportCase?.title || supportBadge.description}>
                              <span className="truncate">{supportBadge.label}</span>
                            </div>
                          )}
                          <p
                            className={`text-xs mt-0.5 truncate ${
                              needsAttention
                                ? 'text-gray-900 font-medium'
                                : 'text-gray-400'
                            }`}
                            title={preview}
                          >
                            {chat.lastMessageDirection === 'outgoing' && (
                              <span className="text-gray-400 mr-1">↪</span>
                            )}
                            {preview || <span className="italic text-gray-300">(まだメッセージなし)</span>}
                          </p>
                        </div>
                      </div>
                    </button>
                  )
                })}
              </>
            )}
          </div>
        </div>

        {/* Right Panel: Chat Detail */}
        <div className={`relative flex-1 bg-white rounded-lg shadow-sm border border-gray-200 flex-col overflow-hidden ${selectedChatId || selectedFriendId ? 'flex' : 'hidden lg:flex'}`}>
          {selectedFriendId && !selectedChatId ? (
            /* Direct message to friend without existing chat */
            <DirectMessagePanel
              friendId={selectedFriendId}
              friend={allFriends.find((f) => f.id === selectedFriendId) || null}
              onBack={() => setSelectedFriendId(null)}
              onSent={() => { setSelectedFriendId(null); loadChats(); }}
            />
          ) : !selectedChatId ? (
            <ChatWorkDashboard
              totalCount={chats.length}
              staleChatCount={staleChatCount}
              unreadChatCount={unreadChatCount}
              inProgressChatCount={inProgressChatCount}
              supportLinkedCount={supportLinkedCount}
              secondaryAnsweredCount={secondaryAnsweredCount}
              priorityChats={priorityChats}
              staleOnly={staleOnly}
              loading={loading}
              onOpenStaleQueue={() => handleOpenWorkQueue('stale', oldestStaleChat?.id ?? null, { staleOnly: true })}
              onOpenUnreadQueue={() => handleOpenWorkQueue('unanswered', firstUnreadChat?.id ?? null, { status: 'unread' })}
              onOpenUnansweredQueue={() => handleOpenWorkQueue('unanswered', firstActionableChat?.id ?? null, { unansweredOnly: true })}
              onSelectChat={(chatId) => {
                setSelectedFriendId(null)
                handleSelectChat(chatId)
              }}
              onClearQueue={() => {
                setStaleOnly(false)
                setSortMode('recent')
              }}
            />
          ) : detailLoading ? (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-gray-400 text-sm">読み込み中...</p>
            </div>
          ) : chatDetail ? (
            <>
              {/* Chat Header */}
              <div className="border-b border-gray-200 bg-white px-4 py-3">
                <div className="flex min-w-0 flex-col gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <button
                    onClick={() => setSelectedChatId(null)}
                    className="lg:hidden flex-shrink-0 p-1 -ml-1 text-gray-500 hover:text-gray-700"
                    aria-label="戻る"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                    </svg>
                  </button>
                  {chatDetail.friendPictureUrl && (
                    <img src={chatDetail.friendPictureUrl} alt="" className="w-8 h-8 rounded-full flex-shrink-0" />
                  )}
                  <div className="min-w-0">
                    <p className="truncate text-base font-semibold text-gray-900">
                      {chatDetail.friendName}
                    </p>
                    <span
                      className={`mt-1 inline-flex items-center rounded-md px-2.5 py-1 text-xs font-semibold ${statusConfig[chatDetail.status].className}`}
                    >
                      {statusConfig[chatDetail.status].label}
                    </span>
                    {isStaleChat(chatDetail) && (
                      <span className="ml-1 mt-1 inline-flex items-center gap-1 rounded-md bg-orange-50 px-2 py-0.5 text-xs font-semibold text-orange-700">
                        <FlameIcon className="h-3 w-3" />
                        24h超過 {formatElapsed(chatDetail.lastMessageAt)}
                      </span>
                    )}
                    {selectedSupportBadge && chatDetail.activeSupportCase && (
                      <Link
                        href={`/support?case=${encodeURIComponent(chatDetail.activeSupportCase.id)}`}
                        className={`ml-1 mt-1 inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-bold transition-colors hover:bg-white ${selectedSupportBadge.className}`}
                        title={`${selectedSupportBadge.description}: ${chatDetail.activeSupportCase.title}`}
                      >
                        <span>{selectedSupportBadge.label}</span>
                        {chatDetail.activeSupportCase.escalationAssignee && (
                          <span className="max-w-[120px] truncate opacity-75">
                            {chatDetail.activeSupportCase.escalationAssignee}
                          </span>
                        )}
                      </Link>
                    )}
                  </div>
                </div>
                <div className="flex w-full flex-wrap items-center justify-end gap-1.5">
                  <Link
                    href={chatDetail.activeSupportCase
                      ? `/support?case=${encodeURIComponent(chatDetail.activeSupportCase.id)}`
                      : `/support?create=1&friend=${encodeURIComponent(chatDetail.friendId)}`}
                    className="inline-flex min-h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 transition-colors hover:bg-emerald-100"
                    title={chatDetail.activeSupportCase
                      ? `チケット「${chatDetail.activeSupportCase.title}」を開く`
                      : 'このチャットをチケット化'}
                  >
                    <TicketIcon className="h-3.5 w-3.5" />
                    {chatDetail.activeSupportCase ? 'チケットを開く' : 'チケット化'}
                  </Link>
                  <button
                    type="button"
                    onClick={() => setInternalChatOpen(true)}
                    className="min-h-9 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-50"
                  >
                    社内チャット
                    <span className="ml-2 rounded-full bg-slate-900 px-2 py-0.5 text-[11px] text-white">
                      {chatDetail.internalMessages?.length ?? 0}
                    </span>
                  </button>
                  {unansweredOnly && visibleChats.length > 1 && (
                    <button
                      type="button"
                      onClick={() => {
                        const idx = visibleChats.findIndex((c) => c.id === selectedChatId)
                        if (idx < 0) return
                        const next = visibleChats[(idx + 1) % visibleChats.length]
                        if (next && next.id !== selectedChatId) {
                          setSelectedChatId(next.id)
                        }
                      }}
                      className="min-h-9 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
                      title="次の未対応 friend に進む"
                    >
                      次の未対応 →
                    </button>
                  )}
                  {chatDetail.status !== 'unread' && (
                    <button
                      onClick={() => handleStatusUpdate('unread')}
                      className="min-h-9 rounded-md bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-600 transition-colors hover:bg-red-100"
                    >
                      未読に戻す
                    </button>
                  )}
                  {chatDetail.status !== 'in_progress' && (
                    <button
                      onClick={() => handleStatusUpdate('in_progress')}
                      className="min-h-9 rounded-md bg-yellow-50 px-3 py-1.5 text-xs font-semibold text-yellow-700 transition-colors hover:bg-yellow-100"
                    >
                      対応中にする
                    </button>
                  )}
                  {chatDetail.status !== 'long_term' && (
                    <button
                      onClick={() => handleStatusUpdate('long_term')}
                      className="min-h-9 rounded-md bg-blue-50 px-3 py-1.5 text-xs font-semibold text-blue-700 transition-colors hover:bg-blue-100"
                      title="24時間超過と未対応キューの対象から外します"
                    >
                      中長期対応にする
                    </button>
                  )}
                  {chatDetail.status !== 'resolved' && (
                    <button
                      onClick={() => handleStatusUpdate('resolved')}
                      className="min-h-9 rounded-md bg-green-50 px-3 py-1.5 text-xs font-semibold text-green-700 transition-colors hover:bg-green-100"
                    >
                      解決済にする
                    </button>
                  )}
                </div>
                </div>
              </div>

              {/* Messages — LINE-style chat bubbles */}
              <div ref={messagesScrollRef} className="flex-1 overflow-y-auto p-4 space-y-2" style={{ backgroundColor: '#7494C0' }}>
                {chatDetail.hasMoreMessages && (
                  <div className="flex justify-center pb-2">
                    <button
                      type="button"
                      onClick={handleLoadOlderMessages}
                      disabled={loadingOlderMessages}
                      className="rounded-full bg-white/90 px-3 py-1 text-xs font-medium text-gray-700 shadow-sm transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {loadingOlderMessages ? '読み込み中...' : '過去のメッセージを読み込む'}
                    </button>
                  </div>
                )}
                {(!chatDetail.messages || chatDetail.messages.length === 0) ? (
                  <div className="text-center py-8">
                    <p className="text-white/60 text-sm">メッセージはまだありません。</p>
                  </div>
                ) : (
                  (chatDetail.messages ?? []).map((msg, idx) => {
                    const prevMsg = idx > 0 ? (chatDetail.messages ?? [])[idx - 1] : null
                    const showDateSep = !prevMsg || !sameYmd(prevMsg.createdAt, msg.createdAt)
                    const isOutgoing = msg.direction === 'outgoing'
                    const senderLabel = isOutgoing
                      ? (msg.sentByStaffName?.trim() || (msg.source === 'line_official' ? 'LINE公式' : '送信者不明'))
                      : ''
                    const quotedMessage = msg.quotedMessageId ? chatMessagesById.get(msg.quotedMessageId) : null

                    if (msg.deletedAt) {
                      return (
                        <div key={msg.id}>
                          {showDateSep && (
                            <div className="flex justify-center my-3">
                              <span className="text-[11px] text-white/85 bg-black/20 px-2.5 py-0.5 rounded-full">
                                {formatYmdSlash(msg.createdAt)}
                              </span>
                            </div>
                          )}
                          <div className="flex justify-center py-1">
                            <span className="rounded-full bg-white/35 px-3 py-1 text-[11px] font-semibold text-white/90 shadow-sm">
                              メッセージの送信が取り消されました
                            </span>
                          </div>
                        </div>
                      )
                    }

                    // メッセージ表示の分岐
                    let bubbleContent: React.ReactNode
                    if (msg.messageType === 'flex') {
                      bubbleContent = (
                        <div className="max-w-[300px]">
                          <FlexPreviewComponent content={msg.content} maxWidth={280} />
                        </div>
                      )
                    } else if (msg.messageType === 'image') {
                      const media = parseChatMediaPreview(msg.messageType, msg.content, msg.id)
                      bubbleContent = media ? (
                        <button
                          type="button"
                          onClick={() => setMediaPreview(media)}
                          className="block max-w-[220px] rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                        >
                          <img src={media.previewUrl || media.url} alt="" className="max-h-[220px] max-w-[220px] rounded object-contain" />
                        </button>
                      ) : (
                        <span className="text-xs font-semibold opacity-80">画像を表示できません</span>
                      )
                    } else if (msg.messageType === 'file' || msg.messageType === 'video' || msg.messageType === 'audio') {
                      const media = parseChatMediaPreview(msg.messageType, msg.content, msg.id)
                      bubbleContent = media ? (
                        <button
                          type="button"
                          onClick={() => setMediaPreview(media)}
                          className={`flex min-w-[180px] max-w-[260px] items-center justify-between gap-3 rounded-lg px-3 py-2 text-left ${
                            isOutgoing ? 'bg-white/15 text-white' : 'bg-slate-50 text-slate-800'
                          }`}
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-semibold">{media.label}</span>
                            <span className={`mt-0.5 block text-[11px] ${isOutgoing ? 'text-white/70' : 'text-slate-500'}`}>
                              {media.description ?? (media.kind === 'pdf' ? 'PDF' : 'ファイル')}
                            </span>
                          </span>
                          <span className="shrink-0 text-xs font-bold">開く</span>
                        </button>
                      ) : (
                        <span className="text-xs font-semibold opacity-80">ファイルを表示できません</span>
                      )
                    } else if (msg.messageType === 'location') {
                      const location = parseLocationPreview(msg.content)
                      bubbleContent = location ? (
                        <a
                          href={location.url ?? undefined}
                          target="_blank"
                          rel="noreferrer"
                          className={`block min-w-[180px] max-w-[260px] rounded-lg px-3 py-2 ${
                            isOutgoing ? 'bg-white/15 text-white' : 'bg-slate-50 text-slate-800'
                          } ${location.url ? 'hover:underline' : 'pointer-events-none'}`}
                        >
                          <span className="block truncate text-sm font-semibold">{location.title}</span>
                          {location.address && (
                            <span className={`mt-0.5 block text-[11px] ${isOutgoing ? 'text-white/70' : 'text-slate-500'}`}>
                              {location.address}
                            </span>
                          )}
                        </a>
                      ) : (
                        <LinkifiedText text={msg.content} isOutgoing={isOutgoing} />
                      )
                    } else if (msg.messageType === 'sticker') {
                      bubbleContent = <StickerMessageImage content={msg.content} />
                    } else {
                      bubbleContent = <LinkifiedText text={msg.content} isOutgoing={isOutgoing} />
                    }

                    return (
                      <div key={msg.id}>
                        {showDateSep && (
                          <div className="flex justify-center my-3">
                            <span className="text-[11px] text-white/85 bg-black/20 px-2.5 py-0.5 rounded-full">
                              {formatYmdSlash(msg.createdAt)}
                            </span>
                          </div>
                        )}
                        <div
                          className={`flex items-end gap-2 ${isOutgoing ? 'justify-end' : 'justify-start'}`}
                        >
                          {/* 相手のアイコン（incoming のみ） */}
                          {!isOutgoing && (
                            chatDetail.friendPictureUrl ? (
                              <img src={chatDetail.friendPictureUrl} alt="" className="w-8 h-8 rounded-full flex-shrink-0 mb-1" />
                            ) : (
                              <div className="w-8 h-8 rounded-full bg-gray-300 flex-shrink-0 mb-1" />
                            )
                          )}

                          <div className={`flex flex-col ${isOutgoing ? 'items-end' : 'items-start'}`}>
                            {/* メッセージバブル */}
                            <div
                              className={`max-w-[320px] px-3 py-2 text-sm break-words whitespace-pre-wrap ${
                                isOutgoing
                                  ? 'rounded-tl-2xl rounded-tr-md rounded-bl-2xl rounded-br-2xl text-white'
                                  : 'rounded-tl-md rounded-tr-2xl rounded-bl-2xl rounded-br-2xl bg-white text-gray-900'
                              }`}
                              style={isOutgoing ? { backgroundColor: '#06C755' } : undefined}
                            >
                              {quotedMessage && (
                                <div
                                  className={`mb-2 rounded-md border-l-4 px-2 py-1.5 text-xs ${
                                    isOutgoing
                                      ? 'border-white/70 bg-white/15 text-white/90'
                                      : 'border-green-400 bg-green-50 text-slate-700'
                                  }`}
                                >
                                  <div className={`font-bold ${isOutgoing ? 'text-white' : 'text-green-700'}`}>
                                    {quotedMessage.direction === 'incoming' ? chatDetail.friendName : '担当者'}への返信
                                  </div>
                                  <div className="mt-0.5 line-clamp-2 opacity-90">
                                    {chatMessageQuotePreview(quotedMessage)}
                                  </div>
                                </div>
                              )}
                              {bubbleContent}
                            </div>
                            {!isOutgoing && msg.canQuote && (
                              <button
                                type="button"
                                onClick={() => handleSelectQuoteTarget(msg)}
                                className="mt-1 rounded-full bg-white/30 px-2 py-0.5 text-[11px] font-semibold text-white/90 transition-colors hover:bg-white/45 hover:text-white"
                              >
                                返信
                              </button>
                            )}
                            {/* 時刻 */}
                            <div className="mt-0.5 flex items-center gap-1 px-1 text-xs text-white/50">
                              {senderLabel && (
                                <span className="rounded bg-white/15 px-1.5 py-0.5 text-[10px] text-white/90">
                                  送信者: {senderLabel}
                                </span>
                              )}
                              {isOutgoing && (
                                <button
                                  type="button"
                                  onClick={() => void handleReflectMessageDeleted(msg)}
                                  disabled={reflectingDeletedMessageId === msg.id}
                                  className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-semibold text-white/70 transition-colors hover:bg-white/20 hover:text-white disabled:cursor-wait disabled:opacity-60"
                                  title={msg.source === 'line_official'
                                    ? 'LINE公式側で取り消し済みの送信をLリンクにも反映します'
                                    : 'LINE APIの仕様上、顧客側からは取り消せません。Lリンク上だけ非表示にします'}
                                >
                                  {reflectingDeletedMessageId === msg.id
                                    ? '反映中'
                                    : msg.source === 'line_official'
                                      ? '公式取消反映'
                                      : '非表示'}
                                </button>
                              )}
                              <span>{new Date(msg.createdAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    )
                  })
                )}
                {chatDetail.typingParticipants && chatDetail.typingParticipants.length > 0 && (
                  <div className="flex justify-end pr-2">
                    <div className="inline-flex max-w-[240px] items-center gap-2 rounded-2xl bg-white/80 px-3 py-2 text-xs font-semibold text-slate-600 shadow-sm">
                      <span className="inline-flex h-6 min-w-8 items-center justify-center rounded-full bg-blue-100 text-blue-400">
                        <span className="tracking-[2px]">•••</span>
                      </span>
                      <span className="truncate">
                        {chatDetail.typingParticipants.map((person) => person.staffName).join('、')}が入力中...
                      </span>
                    </div>
                  </div>
                )}
              </div>

              {/* Send Message Form */}
              <div
                className="border-t border-gray-200 px-4 py-2"
                onDragOver={(e) => {
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'copy'
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  void handleImageFiles(e.dataTransfer.files)
                }}
              >
                {chatDetail.scheduledMessages && chatDetail.scheduledMessages.length > 0 && (
                  <div className="mb-2 border-b border-slate-200 pb-2">
                    <div className="mb-1.5 flex items-center justify-between">
                      <p className="text-xs font-semibold text-slate-700">予約送信</p>
                      <span className="text-[11px] text-slate-500">最大5分以内に配信</span>
                    </div>
                    <div className="space-y-1.5">
                      {chatDetail.scheduledMessages.map((item) => {
                        const config = scheduledStatusConfig[item.status]
                        const canRetry = item.status === 'failed' || item.status === 'failed_permanent'
                        const canCancel = item.status !== 'processing'
                        return (
                          <div key={item.id} className="flex min-h-11 items-center gap-2 rounded-md bg-slate-50 px-2.5 py-2 text-xs">
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span className={`rounded px-1.5 py-0.5 font-semibold ${config.className}`}>{config.label}</span>
                                <span className="font-semibold text-slate-700">{formatDatetime(item.scheduledAt)}</span>
                                {item.createdByName && <span className="text-slate-400">{item.createdByName}</span>}
                              </div>
                              <p className="mt-1 truncate text-slate-600">{scheduledMessagePreview(item)}</p>
                            </div>
                            {canRetry && (
                              <button
                                type="button"
                                onClick={() => void handleRetryScheduled(item)}
                                disabled={scheduledActionId === item.id}
                                className="shrink-0 rounded border border-blue-200 bg-white px-2 py-1 font-semibold text-blue-700 hover:bg-blue-50 disabled:opacity-50"
                              >
                                再試行
                              </button>
                            )}
                            {canCancel && (
                              <button
                                type="button"
                                onClick={() => void handleCancelScheduled(item)}
                                disabled={scheduledActionId === item.id}
                                className="shrink-0 rounded border border-slate-300 bg-white px-2 py-1 font-semibold text-slate-600 hover:bg-slate-100 disabled:opacity-50"
                              >
                                取消
                              </button>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
                {supportDraftContext && (
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-800">
                    <span className="font-medium">
                      サポート案件「{supportDraftContext.caseTitle || supportDraftContext.caseId}」
                      {supportDraftContext.draft ? 'の返信案を入力中' : 'に紐づけ中'}
                    </span>
                    <button
                      type="button"
                      onClick={() => setSupportDraftContext(null)}
                      className="rounded border border-green-300 bg-white px-2 py-1 font-medium text-green-700 hover:bg-green-100"
                    >
                      紐付け解除
                    </button>
                  </div>
                )}
                {supportRecoveryNotice && (
                  <div className="mb-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900" role="alert">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold">{supportRecoveryNotice.title}</p>
                        <p className="mt-1 break-words">{supportRecoveryNotice.message}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setSupportRecoveryNotice(null)}
                        className="rounded border border-amber-300 bg-white px-2 py-1 font-medium text-amber-800 hover:bg-amber-100"
                      >
                        閉じる
                      </button>
                    </div>
                    <ol className="mt-2 list-decimal space-y-1 pl-4">
                      {supportRecoveryNotice.steps.map((step) => (
                        <li key={step}>{step}</li>
                      ))}
                    </ol>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <a
                        href={supportRecoveryNotice.supportHref}
                        className="rounded-md bg-amber-700 px-3 py-1.5 font-semibold text-white hover:bg-amber-800"
                      >
                        案件を開く
                      </a>
                      <button
                        type="button"
                        onClick={() => {
                          if (selectedChatId) void loadChatDetail(selectedChatId)
                          void loadChats()
                        }}
                        className="rounded-md border border-amber-300 bg-white px-3 py-1.5 font-semibold text-amber-800 hover:bg-amber-100"
                      >
                        チャットを再読み込み
                      </button>
                    </div>
                  </div>
                )}
                {quoteTarget && (
                  <div className="mb-2 flex items-start justify-between gap-3 rounded-lg border border-green-200 border-l-4 border-l-green-500 bg-white px-3 py-2 text-xs shadow-sm">
                    <div className="min-w-0">
                      <div className="font-bold text-green-700">
                        {chatDetail?.friendName ?? '顧客'}への返信
                      </div>
                      <div className="mt-0.5 truncate text-slate-600">
                        {chatMessageQuotePreview(quoteTarget)}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setQuoteTarget(null)}
                      className="shrink-0 rounded-full p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
                      aria-label="返信先を解除"
                    >
                      <XIcon className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,application/pdf,.pdf"
                  className="hidden"
                  onChange={(e) => void handleImageFiles(e.target.files)}
                />
                {(pendingImage || uploadingImage || imageUploadError) && (
                  <div className="mb-2 flex min-h-10 items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-xs text-slate-600">
                    {pendingImage?.mode === 'line-image' && (
                      <>
                        <img src={pendingImage.previewImageUrl} alt="" className="h-8 w-8 rounded object-cover" />
                        <span className="min-w-0 flex-1 truncate font-semibold text-slate-700">画像を添付中</span>
                        <button
                          type="button"
                          onClick={() => setPendingImage(null)}
                          className="rounded-full p-1 text-slate-400 transition-colors hover:bg-white hover:text-slate-700"
                          aria-label="添付画像を削除"
                        >
                          <XIcon className="h-3.5 w-3.5" />
                        </button>
                      </>
                    )}
                    {pendingImage?.mode === 'pdf-link' && (
                      <>
                        <span className="inline-flex h-8 w-8 items-center justify-center rounded bg-red-50 text-[10px] font-bold text-red-600 ring-1 ring-red-100">
                          PDF
                        </span>
                        <span className="min-w-0 flex-1 truncate font-semibold text-slate-700">
                          {pendingImage.fileName}
                          {formatFileSize(pendingImage.size) ? ` (${formatFileSize(pendingImage.size)})` : ''}
                        </span>
                        <button
                          type="button"
                          onClick={() => setPendingImage(null)}
                          className="rounded-full p-1 text-slate-400 transition-colors hover:bg-white hover:text-slate-700"
                          aria-label="添付PDFを削除"
                        >
                          <XIcon className="h-3.5 w-3.5" />
                        </button>
                      </>
                    )}
                    {uploadingImage && <span className="font-semibold text-slate-600">ファイルを準備中...</span>}
                    {imageUploadError && <span className="font-semibold text-red-600">{imageUploadError}</span>}
                  </div>
                )}
                {scheduleOpen && (
                  <div className="mb-2 flex flex-wrap items-end gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2">
                    <label className="min-w-[220px] flex-1 text-xs font-semibold text-blue-900">
                      送信日時
                      <input
                        type="datetime-local"
                        value={scheduledAt}
                        min={toDatetimeLocalValue(new Date(Date.now() + 60_000))}
                        onChange={(event) => setScheduledAt(event.target.value)}
                        className="mt-1 h-10 w-full rounded-md border border-blue-200 bg-white px-3 text-sm text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => setScheduledAt(defaultScheduledAt())}
                      className="h-10 rounded-md border border-blue-200 bg-white px-3 text-xs font-semibold text-blue-700 hover:bg-blue-100"
                    >
                      翌朝9:00
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleScheduleMessage()}
                      disabled={scheduling || !scheduledAt || (!messageContent.trim() && !pendingImage)}
                      className="h-10 rounded-md bg-blue-600 px-4 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {scheduling ? '予約中...' : '予約する'}
                    </button>
                  </div>
                )}
                <div className="flex items-end gap-2">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={sending || scheduling || markingAsRead || uploadingImage}
                    className="mb-0.5 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-gray-300 bg-white text-gray-600 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                    aria-label="画像またはPDFを添付"
                  >
                    <PaperclipIcon />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setScheduleOpen((open) => {
                        if (!open && !scheduledAt) setScheduledAt(defaultScheduledAt())
                        return !open
                      })
                      setError('')
                    }}
                    disabled={sending || scheduling || markingAsRead}
                    aria-expanded={scheduleOpen}
                    className={`mb-0.5 inline-flex h-10 shrink-0 items-center justify-center rounded-md border px-3 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                      scheduleOpen
                        ? 'border-blue-600 bg-blue-600 text-white'
                        : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
                    }`}
                    title="日時を指定して送信"
                  >
                    予約
                  </button>
                  <textarea
                    ref={textareaRef}
                    rows={1}
                    value={messageContent}
                    style={{ maxHeight: '120px', overflowY: 'auto' }}
                    onChange={(e) => {
                      const value = e.target.value
                      setMessageContent(value)
                      if (selectedChatId && value.trim()) markTypingActive(selectedChatId)
                    }}
                    onFocus={() => {
                      if (selectedChatId && messageContent.trim()) markTypingActive(selectedChatId)
                    }}
                    onBlur={() => stopTypingStatus(selectedChatId)}
                    onCompositionStart={() => { isComposingRef.current = true }}
                    onCompositionEnd={() => { isComposingRef.current = false }}
                    onKeyDown={handleKeyDown}
                    placeholder="メッセージを入力..."
                    className="min-h-10 flex-1 resize-none overflow-y-auto rounded-2xl border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                  />
                  <div className="flex w-36 flex-col gap-1">
                    <button
                      onClick={handleSendMessage}
                      disabled={sending || scheduling || markingAsRead || (!messageContent.trim() && !pendingImage)}
                      className="min-h-9 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                      style={{ backgroundColor: '#06C755' }}
                    >
                      {sending ? '送信中...' : '送信'}
                    </button>
                    <button
                      type="button"
                      onClick={handleMarkLatestAsRead}
                      disabled={sending || scheduling || markingAsRead || !canMarkLatestIncomingAsRead}
                      className={`min-h-8 whitespace-nowrap rounded-lg border px-2 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed ${
                        latestIncomingMarkedAsRead
                          ? 'border-emerald-200 bg-emerald-50 text-emerald-700 disabled:opacity-100'
                          : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50'
                      }`}
                      title={markReadButtonTitle}
                    >
                      {markReadButtonLabel}
                    </button>
                  </div>
                </div>
              </div>
              {internalChatOpen && (
                <div className="absolute inset-0 z-20 flex justify-end bg-slate-900/20">
                  <button
                    type="button"
                    className="absolute inset-0 cursor-default"
                    onClick={() => setInternalChatOpen(false)}
                    aria-label="社内チャットを閉じる"
                  />
                  <div className="relative h-full w-full max-w-[420px] border-l border-slate-200 bg-slate-50 shadow-2xl">
                    <ChatInternalPanel
                      messages={chatDetail.internalMessages ?? []}
                      staffOptions={staffOptions}
                      saving={savingInternalChat}
                      onCreate={handleCreateInternalMessage}
                      onReaction={handleInternalMessageReaction}
                      onClose={() => setInternalChatOpen(false)}
                    />
                  </div>
                </div>
              )}
            </>
          ) : null}
        </div>

        {/* Right-most Panel: 友だち詳細サイドバー — chat detail を開いている時のみ表示 */}
        {/*
          friendId は **現在の selection** を優先する。chatDetail の load 中は前の chat
          のデータが残ったままなので、それを参照するとサイドバーだけ前の友だちを
          表示し続けて pane 間の不整合になる。selection ID 自体が friend_id なので
          直接渡せる (chat list SQL が `id: f.id` で friend_id を返す)。
        */}
        {(selectedChatId || selectedFriendId) && (
          <div className="hidden w-80 min-w-0 shrink-0 xl:flex">
            <FriendInfoSidebar
              friendId={selectedFriendId || selectedChatId}
              chatStatus={
                chatDetail && chatDetail.id === (selectedFriendId || selectedChatId)
                  ? { status: chatDetail.status }
                  : undefined
              }
              onFriendUpdated={handleFriendUpdated}
            />
          </div>
        )}
      </div>
      {mediaPreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true">
          <div className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl">
            <div className="flex items-center justify-between gap-3 border-b border-gray-200 px-4 py-3">
              <p className="min-w-0 truncate text-sm font-bold text-gray-900">{mediaPreview.label}</p>
              <button
                type="button"
                onClick={() => setMediaPreview(null)}
                className="rounded-full p-2 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900"
                aria-label="プレビューを閉じる"
              >
                <XIcon />
              </button>
            </div>
            <div className="min-h-0 flex-1 bg-gray-100 p-3">
              {mediaPreview.kind === 'image' ? (
                <div className="flex h-full min-h-[60vh] items-center justify-center">
                  <img src={mediaPreview.url} alt="" className="max-h-[78vh] max-w-full rounded-lg object-contain shadow-sm" />
                </div>
              ) : mediaPreview.kind === 'pdf' ? (
                <iframe src={mediaPreview.url} title={mediaPreview.label} className="h-[78vh] w-full rounded-lg bg-white" />
              ) : mediaPreview.kind === 'video' ? (
                <div className="flex h-full min-h-[60vh] items-center justify-center">
                  <video src={mediaPreview.url} controls className="max-h-[78vh] max-w-full rounded-lg bg-black shadow-sm" />
                </div>
              ) : mediaPreview.kind === 'audio' ? (
                <div className="flex min-h-[50vh] items-center justify-center">
                  <audio src={mediaPreview.url} controls className="w-full max-w-xl" />
                </div>
              ) : (
                <div className="flex min-h-[50vh] items-center justify-center">
                  <a
                    href={mediaPreview.url}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-700"
                  >
                    ファイルを開く
                  </a>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

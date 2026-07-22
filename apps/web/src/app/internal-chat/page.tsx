'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import Header from '@/components/layout/header'
import MentionText from '@/components/shared/mention-text'
import { useAccount } from '@/contexts/account-context'
import { api, type InternalChatFeedItem, type InternalTask, type StaffPresenceItem } from '@/lib/api'

type SourceFilter = 'all' | 'support' | 'chat'
type AttentionFilter = 'all' | 'unread' | 'mentions'

const REFRESH_MS = 10_000
const PRESENCE_REFRESH_MS = 15_000
const INTERNAL_CHAT_PAGE_SIZE = 50
const reactionEmojis = ['👍', '🙏', '✅', '👀', '❤️']

function formatDateTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('ja-JP', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function sourceLabel(source: InternalChatFeedItem['source']): string {
  return source === 'support' ? 'チケット' : '個別チャット'
}

function sourceIcon(source: InternalChatFeedItem['source']): string {
  return source === 'support' ? '□' : '○'
}

function sourceTone(source: InternalChatFeedItem['source']): string {
  return source === 'support'
    ? 'border-indigo-100 bg-indigo-50 text-indigo-700'
    : 'border-emerald-100 bg-emerald-50 text-emerald-700'
}

function sourceAccent(source: InternalChatFeedItem['source']): string {
  return source === 'support' ? 'border-l-indigo-500' : 'border-l-emerald-500'
}

function contextKey(item: Pick<InternalChatFeedItem, 'source' | 'sourceId'>): string {
  return `${item.source}:${item.sourceId}`
}

function isUnreadInternalItem(item: InternalChatFeedItem): boolean {
  return item.isUnread
}

function isMentionedInternalItem(item: InternalChatFeedItem, staffId: string, staffName: string): boolean {
  if (staffId && item.mentionStaffIds.includes(staffId)) return true
  const name = staffName.trim()
  if (!name) return false
  return item.mentions.includes(name) || item.body.includes(`@${name}`)
}

function messageIdFromFeedId(item: InternalChatFeedItem): string {
  return item.id.replace(`${item.source}:`, '')
}

function avatarInitial(name: string | null): string {
  return (name || 'スタッフ').trim().charAt(0) || '社'
}

function roleLabel(role: StaffPresenceItem['role']): string {
  if (role === 'owner') return 'オーナー'
  if (role === 'admin') return '管理者'
  if (role === 'secondary') return '二次対応'
  return '一次対応'
}

function formatPresenceTime(value: string | null): string {
  if (!value) return '未記録'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('ja-JP', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function contextSubtitle(item: ContextItem): string {
  if (item.source === 'support') {
    return item.customerName ? `顧客 ${item.customerName}` : 'チケット相談'
  }
  if (item.ticketTitle) return `関連チケット ${item.ticketTitle}`
  return '個別チャット相談'
}

type MentionCandidate = {
  id: string
  name: string
}

function mentionsFromBody(body: string, candidates: MentionCandidate[]): {
  names: string[]
  staffIds: string[]
} {
  const names = new Set<string>()
  const staffIds = new Set<string>()
  candidates.forEach((candidate) => {
    const trimmed = candidate.name.trim()
    if (trimmed && body.includes(`@${trimmed}`)) {
      names.add(trimmed)
      staffIds.add(candidate.id)
    }
  })
  for (const match of body.matchAll(/@([^@\s　,、]+)/g)) {
    const value = match[1]?.trim()
    if (value) names.add(value)
  }
  return { names: Array.from(names), staffIds: Array.from(staffIds) }
}

function mergeFeedItems(current: InternalChatFeedItem[], incoming: InternalChatFeedItem[]): InternalChatFeedItem[] {
  const byId = new Map(current.map((item) => [item.id, item]))
  incoming.forEach((item) => byId.set(item.id, item))
  return Array.from(byId.values()).sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
  )
}

function insertEmoji(text: string, emoji: string): string {
  const suffix = text.endsWith(' ') || text.endsWith('\n') || text.length === 0 ? '' : ' '
  return `${text}${suffix}${emoji} `
}

type ContextItem = {
  key: string
  source: InternalChatFeedItem['source']
  sourceId: string
  href: string
  customerName: string | null
  ticketTitle: string | null
  title: string
  count: number
  latestAt: string
}

function buildContexts(items: InternalChatFeedItem[]): ContextItem[] {
  const map = new Map<string, ContextItem>()
  for (const item of items) {
    const key = contextKey(item)
    const existing = map.get(key)
    const title = item.ticketTitle || item.customerName || item.sourceTitle
    if (!existing) {
      map.set(key, {
        key,
        source: item.source,
        sourceId: item.sourceId,
        href: item.href,
        customerName: item.customerName,
        ticketTitle: item.ticketTitle,
        title,
        count: 1,
        latestAt: item.createdAt,
      })
      continue
    }
    existing.count += 1
    if (item.createdAt > existing.latestAt) existing.latestAt = item.createdAt
    if (!existing.customerName && item.customerName) existing.customerName = item.customerName
    if (!existing.ticketTitle && item.ticketTitle) existing.ticketTitle = item.ticketTitle
  }
  return Array.from(map.values()).sort((a, b) => b.latestAt.localeCompare(a.latestAt))
}

function ReactionStrip({
  item,
  disabled,
  onReaction,
}: {
  item: InternalChatFeedItem
  disabled: boolean
  onReaction: (item: InternalChatFeedItem, emoji: string) => Promise<void>
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const availableEmojis = reactionEmojis.filter((emoji) => (
    !item.reactions.some((reaction) => reaction.emoji === emoji)
  ))

  const pickReaction = (emoji: string) => {
    setPickerOpen(false)
    void onReaction(item, emoji)
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {item.reactions.map((reaction) => (
        <button
          key={reaction.emoji}
          type="button"
          onClick={() => void onReaction(item, reaction.emoji)}
          disabled={disabled}
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
            disabled={disabled}
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
                  disabled={disabled}
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

function PresencePanel({
  items,
  loading,
  onlineCount,
}: {
  items: StaffPresenceItem[]
  loading: boolean
  onlineCount: number
}) {
  return (
    <aside className="hidden min-h-0 min-w-0 flex-col border-l border-slate-200 bg-white 2xl:flex">
      <div className="border-b border-slate-200 px-4 py-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-slate-900">オンラインメンバー</p>
            <p className="mt-1 text-xs font-medium text-slate-500">ChromeでLリンクを開いている人</p>
          </div>
          <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-100">
            {onlineCount}人
          </span>
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {loading && items.length === 0 ? (
          [...Array(5)].map((_, index) => (
            <div key={index} className="flex animate-pulse gap-3 rounded-lg border border-slate-100 bg-slate-50 p-3">
              <div className="h-9 w-9 rounded-full bg-slate-200" />
              <div className="min-w-0 flex-1 space-y-2">
                <div className="h-3 w-24 rounded bg-slate-200" />
                <div className="h-3 w-32 rounded bg-slate-100" />
              </div>
            </div>
          ))
        ) : items.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-4 text-sm font-medium text-slate-500">
            表示できるメンバーがいません
          </div>
        ) : (
          items.map((member) => (
            <div
              key={member.id}
              className={`rounded-lg border p-3 transition-colors ${
                member.isOnline
                  ? 'border-emerald-200 bg-emerald-50/70'
                  : 'border-slate-200 bg-white'
              }`}
            >
              <div className="flex items-start gap-3">
                <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white text-sm font-semibold text-slate-700 ring-1 ring-slate-200">
                  {avatarInitial(member.name)}
                  <span
                    className={`absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-white ${
                      member.isOnline ? 'bg-emerald-500' : 'bg-slate-300'
                    }`}
                    aria-hidden="true"
                  />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <p className="truncate text-sm font-semibold text-slate-900">{member.name}</p>
                    <span className="shrink-0 rounded-full bg-white px-2 py-0.5 text-[10px] font-medium text-slate-500 ring-1 ring-slate-200">
                      {roleLabel(member.role)}
                    </span>
                  </div>
                  <p className={`mt-1 text-xs font-semibold ${member.isOnline ? 'text-emerald-700' : 'text-slate-500'}`}>
                    {member.isOnline ? 'オンライン' : 'オフライン'}
                  </p>
                  <p className="mt-1 text-[11px] font-medium text-slate-500">
                    最後に見た {formatPresenceTime(member.lastSeenAt)}
                  </p>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </aside>
  )
}

export default function InternalChatPage() {
  const { selectedAccountId, selectedAccount } = useAccount()
  const [items, setItems] = useState<InternalChatFeedItem[]>([])
  const [loading, setLoading] = useState(true)
  const [posting, setPosting] = useState(false)
  const [reactingId, setReactingId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState<SourceFilter>('all')
  const [attentionFilter, setAttentionFilter] = useState<AttentionFilter>('all')
  const [selectedContextKey, setSelectedContextKey] = useState<string | null>(null)
  const [mobileConversationOpen, setMobileConversationOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [presenceItems, setPresenceItems] = useState<StaffPresenceItem[]>([])
  const [presenceLoading, setPresenceLoading] = useState(true)
  const [staffId, setStaffId] = useState('')
  const [staffName, setStaffName] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [actionMenuId, setActionMenuId] = useState<string | null>(null)
  const [editingItem, setEditingItem] = useState<InternalChatFeedItem | null>(null)
  const [editingBody, setEditingBody] = useState('')
  const [messageActionId, setMessageActionId] = useState<string | null>(null)
  const [bookmarkedOnly, setBookmarkedOnly] = useState(false)
  const [tasks, setTasks] = useState<InternalTask[]>([])
  const [taskPanelOpen, setTaskPanelOpen] = useState(false)
  const [taskItem, setTaskItem] = useState<InternalChatFeedItem | null>(null)
  const [taskTitle, setTaskTitle] = useState('')
  const [taskDueAt, setTaskDueAt] = useState('')
  const [taskAssigneeIds, setTaskAssigneeIds] = useState<string[]>([])
  const [savingTask, setSavingTask] = useState(false)

  const loadFeed = useCallback(async (options: {
    silent?: boolean
    append?: boolean
    preserveExisting?: boolean
    before?: string
  } = {}) => {
    if (!selectedAccountId) return
    const silent = options.silent ?? false
    const append = options.append ?? false
    const preserveExisting = options.preserveExisting ?? false
    if (append && !options.before) return
    if (!silent) {
      if (append) setLoadingMore(true)
      else setLoading(true)
      setError('')
    }
    try {
      const res = await api.appNotifications.internalChatFeed({
        accountId: selectedAccountId,
        limit: INTERNAL_CHAT_PAGE_SIZE,
        before: append ? options.before : undefined,
        search,
      })
      if (!res.success) {
        if (!silent) setError(res.error || '社内チャットの取得に失敗しました')
        return
      }
      if (append || preserveExisting) {
        setItems((current) => mergeFeedItems(current, res.data.items))
      } else {
        setItems(res.data.items)
      }
      if (!preserveExisting) {
        setNextCursor(res.data.nextCursor)
        setHasMore(res.data.hasMore)
      }
      setError('')
    } catch {
      if (!silent) setError('社内チャットの取得に失敗しました')
    } finally {
      if (!silent) {
        if (append) setLoadingMore(false)
        else setLoading(false)
      }
    }
  }, [search, selectedAccountId])

  const loadPresence = useCallback(async (silent = false) => {
    if (!silent) setPresenceLoading(true)
    try {
      const res = await api.staff.presence()
      if (res.success && res.data) {
        setPresenceItems(res.data.items)
      }
    } catch {
      // Presence is supportive information, so keep the chat usable on failure.
    } finally {
      if (!silent) setPresenceLoading(false)
    }
  }, [])

  const loadTasks = useCallback(async () => {
    if (!selectedAccountId) return
    try {
      const res = await api.appNotifications.internalTasks({ accountId: selectedAccountId })
      if (res.success) setTasks(res.data)
    } catch {
      // Task retrieval is secondary to reading the conversation.
    }
  }, [selectedAccountId])

  useEffect(() => {
    void loadFeed()
  }, [loadFeed])

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), 250)
    return () => window.clearTimeout(timer)
  }, [searchInput])

  useEffect(() => {
    void loadPresence(false)
  }, [loadPresence])

  useEffect(() => {
    void loadTasks()
  }, [loadTasks])

  useEffect(() => {
    let active = true
    api.staff.me()
      .then((res) => {
        if (!active) return
        setStaffId(res.success ? (res.data.id || '') : '')
        setStaffName(res.success ? (res.data.name || '') : '')
      })
      .catch(() => {
        if (active) {
          setStaffId('')
          setStaffName('')
        }
      })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!selectedAccountId) return
    const timer = window.setInterval(() => {
      if (!document.hidden) void loadFeed({ silent: true, preserveExisting: true })
    }, REFRESH_MS)
    const onVisible = () => {
      if (!document.hidden) void loadFeed({ silent: true, preserveExisting: true })
    }
    window.addEventListener('focus', onVisible)
    window.addEventListener('online', onVisible)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', onVisible)
      window.removeEventListener('online', onVisible)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [loadFeed, selectedAccountId])

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadPresence(true)
    }, PRESENCE_REFRESH_MS)
    const onActive = () => {
      void loadPresence(true)
    }
    window.addEventListener('focus', onActive)
    window.addEventListener('online', onActive)
    document.addEventListener('visibilitychange', onActive)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', onActive)
      window.removeEventListener('online', onActive)
      document.removeEventListener('visibilitychange', onActive)
    }
  }, [loadPresence])

  const sourceVisibleItems = useMemo(() => {
    const filtered = filter === 'all' ? items : items.filter((item) => item.source === filter)
    return bookmarkedOnly ? filtered.filter((item) => item.isBookmarked) : filtered
  }, [bookmarkedOnly, filter, items])

  const unreadCount = useMemo(
    () => sourceVisibleItems.filter(isUnreadInternalItem).length,
    [sourceVisibleItems],
  )
  const mentionCount = useMemo(
    () => sourceVisibleItems.filter((item) => isMentionedInternalItem(item, staffId, staffName)).length,
    [sourceVisibleItems, staffId, staffName],
  )
  const visibleItems = useMemo(() => {
    if (attentionFilter === 'unread') {
      return sourceVisibleItems.filter(isUnreadInternalItem)
    }
    if (attentionFilter === 'mentions') {
      return sourceVisibleItems.filter((item) => isMentionedInternalItem(item, staffId, staffName))
    }
    return sourceVisibleItems
  }, [attentionFilter, sourceVisibleItems, staffId, staffName])
  const contexts = useMemo(() => buildContexts(visibleItems), [visibleItems])

  useEffect(() => {
    if (contexts.length === 0) {
      setSelectedContextKey(null)
      setMobileConversationOpen(false)
      return
    }
    if (!selectedContextKey || !contexts.some((item) => item.key === selectedContextKey)) {
      setSelectedContextKey(contexts[0].key)
    }
  }, [contexts, selectedContextKey])

  useEffect(() => {
    setMobileConversationOpen(false)
  }, [selectedAccountId])

  const activeContext = contexts.find((item) => item.key === selectedContextKey) ?? null
  const timelineItems = useMemo(() => {
    if (!activeContext) return []
    return visibleItems
      .filter((item) => contextKey(item) === activeContext.key)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }, [activeContext, visibleItems])

  const mentionCandidates = useMemo(() => {
    const byId = new Map<string, MentionCandidate>()
    presenceItems.forEach((member) => {
      if (member.isActive) byId.set(member.id, { id: member.id, name: member.name })
    })
    return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name, 'ja')).slice(0, 20)
  }, [presenceItems])

  const supportCount = items.filter((item) => item.source === 'support').length
  const chatCount = items.filter((item) => item.source === 'chat').length
  const bookmarkCount = items.filter((item) => item.isBookmarked).length
  const openTaskCount = tasks.filter((task) => task.status === 'open').length
  const onlineCount = presenceItems.filter((item) => item.isOnline).length

  const markContextRead = useCallback(async (context: ContextItem): Promise<void> => {
    if (!selectedAccountId) return
    const hasUnread = items.some((item) => contextKey(item) === context.key && item.isUnread)
    if (!hasUnread) return
    try {
      const res = await api.appNotifications.markInternalChatRead({
        accountId: selectedAccountId,
        source: context.source,
        sourceId: context.sourceId,
      })
      if (!res.success) return
      setItems((current) => current.map((item) => (
        contextKey(item) === context.key ? { ...item, isUnread: false } : item
      )))
    } catch {
      // A read receipt failure must not block access to the conversation.
    }
  }, [items, selectedAccountId])

  const markAllRead = async () => {
    if (!selectedAccountId) return
    try {
      const res = await api.appNotifications.markInternalChatRead({
        accountId: selectedAccountId,
        source: 'all',
      })
      if (!res.success) {
        setError('既読状態の更新に失敗しました')
        return
      }
      setItems((current) => current.map((item) => ({ ...item, isUnread: false })))
      if (attentionFilter === 'unread') setAttentionFilter('all')
      setError('')
    } catch {
      setError('既読状態の更新に失敗しました')
    }
  }

  const handleReaction = async (item: InternalChatFeedItem, emoji: string): Promise<void> => {
    if (!selectedAccountId || reactingId) return
    setReactingId(`${item.id}:${emoji}`)
    try {
      const messageId = messageIdFromFeedId(item)
      const res = item.source === 'support'
        ? await api.support.cases.toggleInternalReaction(item.sourceId, selectedAccountId, messageId, emoji)
        : await api.chats.toggleInternalReaction(item.sourceId, messageId, emoji)
      if (!res.success || !res.data) {
        setError('リアクションの更新に失敗しました')
        return
      }
      const feedId = `${item.source}:${res.data.id}`
      setItems((prev) => prev.map((current) => (
        current.id === feedId ? { ...current, reactions: res.data.reactions } : current
      )))
      setError('')
    } catch {
      setError('リアクションの更新に失敗しました')
    } finally {
      setReactingId(null)
    }
  }

  const mergeMessageResult = (item: InternalChatFeedItem, data: {
    body: string
    mentions: string[]
    mentionStaffIds: string[]
    reactions: InternalChatFeedItem['reactions']
    version?: number
    editedAt?: string | null
    deletedAt?: string | null
    deletedByName?: string | null
    isDeleted?: boolean
    canEdit?: boolean
    canDelete?: boolean
  }) => {
    setItems((current) => current.map((message) => message.id === item.id ? { ...message, ...data } : message))
  }

  const startEditing = (item: InternalChatFeedItem) => {
    setActionMenuId(null)
    setEditingItem(item)
    setEditingBody(item.body)
  }

  const saveEditing = async () => {
    if (!editingItem || !selectedAccountId || messageActionId) return
    const body = editingBody.trim()
    if (!body) return
    setMessageActionId(editingItem.id)
    try {
      const mentions = mentionsFromBody(body, mentionCandidates)
      const res = editingItem.source === 'support'
        ? await api.support.cases.editInternalMessage(editingItem.sourceId, selectedAccountId, messageIdFromFeedId(editingItem), {
          body,
          baseVersion: editingItem.version ?? 0,
          mentions: mentions.names,
          mentionStaffIds: mentions.staffIds,
        })
        : await api.chats.editInternalMessage(editingItem.sourceId, messageIdFromFeedId(editingItem), {
          body,
          baseVersion: editingItem.version ?? 0,
          mentions: mentions.names,
          mentionStaffIds: mentions.staffIds,
        })
      if (!res.success || !res.data) {
        setError('メッセージの編集に失敗しました')
        return
      }
      mergeMessageResult(editingItem, res.data)
      setEditingItem(null)
      setEditingBody('')
      setError('')
    } catch {
      setError('メッセージの編集に失敗しました。再読み込みしてからお試しください')
    } finally {
      setMessageActionId(null)
    }
  }

  const deleteMessage = async (item: InternalChatFeedItem) => {
    if (!selectedAccountId || messageActionId) return
    setActionMenuId(null)
    if (!window.confirm('このメッセージを削除表示にしますか\n原文と操作履歴は保持されます')) return
    const reason = item.createdBy && item.createdBy !== staffId
      ? window.prompt('他のスタッフの投稿を削除する理由を入力してください')?.trim()
      : ''
    if (item.createdBy && item.createdBy !== staffId && !reason) return
    setMessageActionId(item.id)
    try {
      const res = item.source === 'support'
        ? await api.support.cases.softDeleteInternalMessage(item.sourceId, selectedAccountId, messageIdFromFeedId(item), {
          baseVersion: item.version ?? 0,
          reason,
        })
        : await api.chats.softDeleteInternalMessage(item.sourceId, messageIdFromFeedId(item), {
          baseVersion: item.version ?? 0,
          reason,
        })
      if (!res.success || !res.data) {
        setError('メッセージの削除に失敗しました')
        return
      }
      mergeMessageResult(item, res.data)
      setError('')
    } catch {
      setError('メッセージの削除に失敗しました。再読み込みしてからお試しください')
    } finally {
      setMessageActionId(null)
    }
  }

  const toggleBookmark = async (item: InternalChatFeedItem) => {
    if (!selectedAccountId || messageActionId) return
    setActionMenuId(null)
    setMessageActionId(item.id)
    try {
      const res = await api.appNotifications.toggleInternalChatBookmark({
        accountId: selectedAccountId,
        source: item.source,
        sourceId: item.sourceId,
        messageId: messageIdFromFeedId(item),
      })
      if (!res.success) {
        setError('ブックマークの更新に失敗しました')
        return
      }
      setItems((current) => current.map((message) => message.id === item.id
        ? { ...message, isBookmarked: res.data.isBookmarked }
        : message))
      setError('')
    } catch {
      setError('ブックマークの更新に失敗しました')
    } finally {
      setMessageActionId(null)
    }
  }

  const openTaskComposer = (item: InternalChatFeedItem) => {
    setActionMenuId(null)
    setTaskItem(item)
    setTaskTitle(item.body.replace(/\s+/g, ' ').slice(0, 80))
    setTaskDueAt('')
    setTaskAssigneeIds([])
  }

  const createTask = async () => {
    if (!taskItem || !selectedAccountId || savingTask || !taskTitle.trim()) return
    setSavingTask(true)
    try {
      const res = await api.appNotifications.createInternalTask({
        accountId: selectedAccountId,
        source: taskItem.source,
        sourceId: taskItem.sourceId,
        sourceMessageId: messageIdFromFeedId(taskItem),
        title: taskTitle.trim(),
        description: taskItem.body,
        dueAt: taskDueAt || null,
        assigneeStaffIds: taskAssigneeIds,
      })
      if (!res.success) {
        setError('タスクの作成に失敗しました')
        return
      }
      setTasks((current) => [res.data, ...current])
      setItems((current) => current.map((message) => message.id === taskItem.id
        ? { ...message, taskCount: (message.taskCount ?? 0) + 1 }
        : message))
      setTaskItem(null)
      setError('')
    } catch {
      setError('タスクの作成に失敗しました')
    } finally {
      setSavingTask(false)
    }
  }

  const toggleTaskStatus = async (task: InternalTask) => {
    try {
      const res = await api.appNotifications.updateInternalTask(task.id, task.status === 'open' ? 'done' : 'open')
      if (!res.success) return
      setTasks((current) => current.map((item) => item.id === task.id ? res.data : item))
    } catch {
      setError('タスクの更新に失敗しました')
    }
  }

  const submit = async () => {
    if (!activeContext || !selectedAccountId || posting) return
    const body = draft.trim()
    if (!body) return
    setPosting(true)
    try {
      const mentions = mentionsFromBody(body, mentionCandidates)
      const res = activeContext.source === 'support'
        ? await api.support.cases.addInternalMessage(activeContext.sourceId, selectedAccountId, {
          body,
          mentions: mentions.names,
          mentionStaffIds: mentions.staffIds,
        })
        : await api.chats.addInternalMessage(activeContext.sourceId, {
          body,
          mentions: mentions.names,
          mentionStaffIds: mentions.staffIds,
        })
      if (!res.success) {
        setError('社内チャットの投稿に失敗しました')
        return
      }
      setDraft('')
      await loadFeed({ silent: true, preserveExisting: true })
      setSelectedContextKey(activeContext.key)
      setError('')
    } catch {
      setError('社内チャットの投稿に失敗しました')
    } finally {
      setPosting(false)
    }
  }

  return (
    <div className="space-y-0 lg:space-y-4">
      <div className="hidden lg:block">
        <Header
          title="社内チャット"
          description={`${selectedAccount?.displayName || selectedAccount?.name || '選択中アカウント'} の社内相談`}
          action={
            <button
              type="button"
              onClick={() => void loadFeed()}
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              更新
            </button>
          }
        />
      </div>

      <section className="grid h-[calc(100dvh_-_128px_-_env(safe-area-inset-top)_-_env(safe-area-inset-bottom))] min-h-0 min-w-0 overflow-hidden bg-white min-[900px]:grid-cols-[280px_minmax(0,1fr)] lg:h-[calc(100vh-180px)] lg:rounded-lg lg:border lg:border-slate-200 lg:shadow-sm 2xl:grid-cols-[320px_minmax(0,1fr)_300px]">
        <aside className={`${mobileConversationOpen ? 'hidden min-[900px]:flex' : 'flex'} min-h-0 min-w-0 flex-col border-b border-slate-200 bg-white min-[900px]:border-b-0 min-[900px]:border-r`}>
          <div className="border-b border-slate-200 px-3 py-3 sm:px-4 sm:py-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-lg font-semibold text-slate-900">社内相談</p>
                <p className="mt-0.5 hidden text-xs font-medium text-slate-500 sm:block">相談先を選んで会話を確認</p>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setBookmarkedOnly((current) => !current)}
                  className={`flex h-9 w-9 items-center justify-center rounded-md border text-sm transition-colors ${
                    bookmarkedOnly
                      ? 'border-amber-300 bg-amber-50 text-amber-700'
                      : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50'
                  }`}
                  title="ブックマーク"
                  aria-label={`ブックマーク ${bookmarkCount}件`}
                  aria-pressed={bookmarkedOnly}
                >
                  ☆
                </button>
                <button
                  type="button"
                  onClick={() => setTaskPanelOpen(true)}
                  className="relative flex h-9 w-9 items-center justify-center rounded-md border border-slate-200 bg-white text-sm text-slate-600 transition-colors hover:bg-slate-50"
                  title="共有タスク"
                  aria-label={`共有タスク 未完了${openTaskCount}件`}
                >
                  ✓
                  {openTaskCount > 0 && (
                    <span className="absolute -right-1.5 -top-1.5 min-w-4 rounded-full bg-rose-500 px-1 text-center text-[9px] font-bold leading-4 text-white">
                      {openTaskCount > 99 ? '99+' : openTaskCount}
                    </span>
                  )}
                </button>
                <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700 ring-1 ring-slate-200">
                  {items.length}{hasMore ? '+' : ''}
                </span>
              </div>
            </div>
            <label className="sr-only" htmlFor="internal-chat-search">社内チャットを検索</label>
            <input
              id="internal-chat-search"
              type="search"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="本文・顧客・チケットを検索"
              className="mt-3 min-h-10 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100 sm:mt-4"
            />
            <div className="scrollbar-none -mx-3 mt-3 flex gap-1.5 overflow-x-auto px-3 pb-1 sm:mx-0 sm:px-0">
              {[
                { value: 'all' as const, label: 'すべて', count: items.length },
                { value: 'support' as const, label: 'チケット', count: supportCount },
                { value: 'chat' as const, label: '個別', count: chatCount },
              ].map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => {
                    setFilter(option.value)
                    if (option.value === 'all') setAttentionFilter('all')
                  }}
                  aria-pressed={filter === option.value}
                  className={`min-h-10 shrink-0 rounded-full border px-3 py-2 text-xs font-semibold transition-colors ${
                    filter === option.value
                      ? 'border-emerald-200 bg-emerald-50 text-emerald-800 shadow-sm ring-1 ring-emerald-100'
                      : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50'
                  }`}
                >
                  {option.label} <span className="ml-1 tabular-nums">{option.count}</span>
                </button>
              ))}
              <span className="my-2 h-5 w-px shrink-0 bg-slate-200" aria-hidden="true" />
              {[
                { value: 'unread' as const, label: '未読', count: unreadCount },
                { value: 'mentions' as const, label: '自分宛て', count: mentionCount },
              ].map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setAttentionFilter((current) => current === option.value ? 'all' : option.value)}
                  aria-pressed={attentionFilter === option.value}
                  className={`min-h-10 shrink-0 rounded-full border px-3 py-2 text-xs font-semibold transition-colors ${
                    attentionFilter === option.value
                      ? 'border-sky-200 bg-sky-50 text-sky-800 shadow-sm ring-1 ring-sky-100'
                      : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50'
                  }`}
                >
                  {option.label} <span className="ml-1 tabular-nums">{option.count}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto bg-slate-50/60 p-2.5 sm:p-3">
            <div className="mb-2 flex items-center justify-between px-1">
              <p className="text-xs font-semibold tracking-wide text-slate-500">相談一覧</p>
              <div className="flex items-center gap-2">
                {unreadCount > 0 && (
                  <button
                    type="button"
                    onClick={() => void markAllRead()}
                    className="rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"
                  >
                    すべて既読
                  </button>
                )}
                <span className="text-xs font-medium text-slate-400">{contexts.length}件</span>
              </div>
            </div>
            {loading && contexts.length === 0 ? (
              <div className="space-y-2">
                {[...Array(5)].map((_, index) => (
                  <div key={index} className="h-20 animate-pulse rounded-lg bg-white ring-1 ring-slate-100" />
                ))}
              </div>
            ) : contexts.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-200 bg-white p-4 text-sm font-medium text-slate-500">
                表示できる相談はありません
              </div>
            ) : (
              <div className="space-y-1.5 sm:space-y-2.5">
                {contexts.map((item) => {
                  const contextUnread = sourceVisibleItems.filter((feed) => contextKey(feed) === item.key && isUnreadInternalItem(feed)).length
                  const contextMention = sourceVisibleItems.filter((feed) => contextKey(feed) === item.key && isMentionedInternalItem(feed, staffId, staffName)).length
                  return (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => {
                        setSelectedContextKey(item.key)
                        setMobileConversationOpen(true)
                        void markContextRead(item)
                      }}
                      className={`w-full rounded-lg border border-l-4 px-2.5 py-2.5 text-left shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-all sm:px-3 sm:py-3 ${
                        selectedContextKey === item.key
                          ? `${sourceAccent(item.source)} border-slate-200 bg-white ring-1 ring-slate-200`
                          : `${sourceAccent(item.source)} border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50/70`
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${sourceTone(item.source)}`}>
                          <span aria-hidden="true">{sourceIcon(item.source)}</span>
                          {sourceLabel(item.source)}
                        </span>
                        <div className="flex min-w-0 items-center gap-1">
                          {contextMention > 0 && (
                            <span className="rounded-full bg-sky-50 px-1.5 py-0.5 text-[10px] font-semibold text-sky-700 ring-1 ring-sky-100">
                              自分宛て
                            </span>
                          )}
                          {contextUnread > 0 && (
                            <span className="rounded-full bg-rose-50 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700 ring-1 ring-rose-100">
                              未読 {contextUnread}
                            </span>
                          )}
                          <span className="text-[11px] font-medium text-slate-400">{formatDateTime(item.latestAt)}</span>
                        </div>
                      </div>
                      <p className="mt-1.5 truncate text-sm font-semibold text-slate-900 sm:mt-2">{item.title}</p>
                      <div className="mt-1 flex items-center justify-between gap-2">
                        <p className="min-w-0 truncate text-xs font-medium text-slate-500">{contextSubtitle(item)}</p>
                        <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                          {item.count}件
                        </span>
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
            {hasMore && (
              <button
                type="button"
                onClick={() => void loadFeed({ append: true, before: nextCursor ?? undefined })}
                disabled={loadingMore || !nextCursor}
                className="mt-3 min-h-10 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loadingMore ? '読み込み中...' : 'さらに読み込む'}
              </button>
            )}
          </div>
        </aside>

        <main className={`${mobileConversationOpen ? 'flex' : 'hidden min-[900px]:flex'} min-h-0 min-w-0 flex-col bg-white`}>
          <div className="border-b border-slate-200 bg-white px-3 py-2.5 sm:px-5 sm:py-4">
            {activeContext ? (
              <div className="flex items-start justify-between gap-2 sm:gap-3">
                <button
                  type="button"
                  onClick={() => setMobileConversationOpen(false)}
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 min-[900px]:hidden"
                  aria-label="相談一覧に戻る"
                >
                  <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="m15 18-6-6 6-6" />
                  </svg>
                </button>
                <div className="min-w-0">
                  <div className="scrollbar-none flex min-w-0 items-center gap-1.5 overflow-x-auto pb-0.5 sm:flex-wrap sm:gap-2 sm:overflow-visible">
                    <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium sm:px-2.5 sm:py-1 sm:text-xs ${sourceTone(activeContext.source)}`}>
                      {sourceLabel(activeContext.source)}
                    </span>
                    {activeContext.customerName && (
                      <span className="max-w-48 shrink-0 truncate rounded-full border border-blue-100 bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-800 sm:max-w-none sm:px-2.5 sm:py-1 sm:text-xs">
                        顧客 {activeContext.customerName}
                      </span>
                    )}
                    {activeContext.ticketTitle && (
                      <span className="max-w-48 shrink-0 truncate rounded-full border border-indigo-100 bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-800 sm:max-w-none sm:px-2.5 sm:py-1 sm:text-xs">
                        チケット {activeContext.ticketTitle}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 truncate text-sm font-semibold text-slate-900 sm:mt-2 sm:text-xl">{activeContext.title}</p>
                </div>
                <Link
                  href={activeContext.href}
                  className="shrink-0 rounded-md border border-slate-300 bg-white px-2.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 sm:px-3 sm:text-sm"
                >
                  詳細
                </Link>
              </div>
            ) : (
              <p className="text-sm font-medium text-slate-600">社内相談</p>
            )}
          </div>

          {error && (
            <div className="border-b border-red-100 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
              {error}
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto bg-[#f8fafc] px-3 py-3 sm:px-5 sm:py-5">
            {loading && items.length === 0 ? (
              <div className="space-y-4">
                {[...Array(5)].map((_, index) => (
                  <div key={index} className="flex animate-pulse gap-3">
                    <div className="h-10 w-10 rounded-full bg-slate-200" />
                    <div className="min-w-0 flex-1">
                      <div className="h-4 w-40 rounded bg-slate-200" />
                      <div className="mt-2 h-20 max-w-xl rounded-2xl bg-white" />
                    </div>
                  </div>
                ))}
              </div>
            ) : timelineItems.length === 0 ? (
              <div className="flex min-h-[360px] items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white text-sm font-medium text-slate-500">
                社内チャットはまだありません
              </div>
            ) : (
              <div className="space-y-4 sm:space-y-5">
                {timelineItems.map((item) => {
                  const disabled = reactingId?.startsWith(`${item.id}:`) ?? false
                  return (
                    <article key={item.id} className="group flex gap-2.5 sm:gap-3">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-700 ring-1 ring-slate-200 sm:h-10 sm:w-10 sm:text-sm">
                        {avatarInitial(item.createdByName)}
                      </span>
                      <div className="relative min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex min-w-0 flex-wrap items-baseline gap-2">
                            <p className="text-sm font-semibold text-slate-900">{item.createdByName || 'スタッフ'}</p>
                            <span className="text-xs font-medium text-slate-400">{formatDateTime(item.createdAt)}</span>
                            {item.editedAt && !item.isDeleted && <span className="text-[11px] font-medium text-slate-400">編集済み</span>}
                          </div>
                          <span className="relative shrink-0">
                            <button
                              type="button"
                              onClick={() => setActionMenuId((current) => current === item.id ? null : item.id)}
                              className="flex h-8 w-8 items-center justify-center rounded-md text-lg leading-none text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 sm:opacity-0 sm:group-hover:opacity-100"
                              aria-label="メッセージ操作"
                              aria-expanded={actionMenuId === item.id}
                            >
                              ⋯
                            </button>
                            {actionMenuId === item.id && (
                              <div className="absolute right-0 top-full z-40 mt-1 w-40 rounded-md border border-slate-200 bg-white p-1 shadow-lg">
                                {item.canEdit && !item.isDeleted && (
                                  <button type="button" onClick={() => startEditing(item)} className="w-full rounded px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50">編集</button>
                                )}
                                {!item.isDeleted && (
                                  <button type="button" onClick={() => openTaskComposer(item)} className="w-full rounded px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50">タスク化</button>
                                )}
                                <button type="button" onClick={() => void toggleBookmark(item)} className="w-full rounded px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50">
                                  {item.isBookmarked ? 'ブックマーク解除' : 'ブックマーク'}
                                </button>
                                {item.canDelete && !item.isDeleted && (
                                  <button type="button" onClick={() => void deleteMessage(item)} className="w-full rounded px-3 py-2 text-left text-sm text-rose-700 hover:bg-rose-50">削除</button>
                                )}
                              </div>
                            )}
                          </span>
                        </div>
                        {editingItem?.id === item.id ? (
                          <div className="mt-1 max-w-[820px] rounded-lg border border-indigo-200 bg-white p-2 shadow-sm">
                            <textarea
                              value={editingBody}
                              onChange={(event) => setEditingBody(event.target.value)}
                              rows={3}
                              className="w-full resize-y rounded-md border border-slate-200 px-3 py-2 text-sm leading-6 text-slate-800 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                              autoFocus
                            />
                            <div className="mt-2 flex justify-end gap-2">
                              <button type="button" onClick={() => setEditingItem(null)} className="rounded-md border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50">キャンセル</button>
                              <button type="button" onClick={() => void saveEditing()} disabled={!editingBody.trim() || messageActionId === item.id} className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50">保存</button>
                            </div>
                          </div>
                        ) : (
                          <div className={`mt-1 inline-block max-w-[820px] rounded-2xl rounded-tl-md px-3 py-2.5 text-sm leading-6 shadow-sm ring-1 sm:px-4 sm:py-3 ${
                            item.isDeleted
                              ? 'bg-slate-100 italic text-slate-500 ring-slate-200'
                              : 'bg-white text-slate-800 ring-slate-100'
                          }`}>
                            <MentionText text={item.body} mentions={item.mentions} />
                          </div>
                        )}
                        {item.parentId && (
                          <span className="mt-2 inline-flex rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                            スレッド返信
                          </span>
                        )}
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] font-medium text-slate-500">
                          {item.isBookmarked && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-amber-700 ring-1 ring-amber-100">保存済み</span>}
                          {(item.taskCount ?? 0) > 0 && <span className="rounded-full bg-blue-50 px-2 py-0.5 text-blue-700 ring-1 ring-blue-100">タスク {item.taskCount}</span>}
                        </div>
                        {!item.isDeleted && <ReactionStrip item={item} disabled={disabled} onReaction={handleReaction} />}
                      </div>
                    </article>
                  )
                })}
              </div>
            )}
          </div>

          <div className="border-t border-slate-200 bg-white px-3 py-2.5 sm:px-5 sm:py-4">
            <div className="scrollbar-none mb-2 flex gap-1.5 overflow-x-auto pb-1">
              {mentionCandidates.length > 0 && (
                <>
                {mentionCandidates.slice(0, 10).map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    onClick={() => setDraft((prev) => insertEmoji(prev, `@${candidate.name}`))}
                    disabled={posting || !activeContext}
                    className="shrink-0 rounded-full border border-blue-100 bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    @{candidate.name}
                  </button>
                ))}
                  <span className="my-1 h-5 w-px shrink-0 bg-slate-200" aria-hidden="true" />
                </>
              )}
              {reactionEmojis.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => setDraft((prev) => insertEmoji(prev, emoji))}
                  disabled={posting || !activeContext}
                  className="rounded-full border border-slate-200 bg-slate-50 px-2 py-1 text-xs hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {emoji}
                </button>
              ))}
            </div>
            <div className="flex items-end gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 shadow-inner">
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                rows={1}
                disabled={!activeContext || posting}
                placeholder="メッセージを入力"
                className="max-h-32 min-h-10 flex-1 resize-none border-0 bg-transparent px-2 py-2 text-sm text-slate-900 outline-none placeholder:text-slate-400 disabled:cursor-not-allowed"
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing || event.keyCode === 229) return
                  if (event.key === 'Enter' && event.shiftKey) {
                    event.preventDefault()
                    void submit()
                  }
                }}
              />
              <button
                type="button"
                onClick={() => void submit()}
                disabled={!activeContext || posting || !draft.trim()}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-lg font-semibold text-white transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40"
                aria-label="送信"
              >
                <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="m5 12 14-7-4 14-3-6-7-1Z" />
                  <path d="m12 13 7-8" />
                </svg>
              </button>
            </div>
          </div>
        </main>

        <PresencePanel items={presenceItems} loading={presenceLoading} onlineCount={onlineCount} />
      </section>

      {taskPanelOpen && (
        <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/30" role="dialog" aria-modal="true" aria-label="共有タスク">
          <button type="button" className="min-w-0 flex-1" onClick={() => setTaskPanelOpen(false)} aria-label="閉じる" />
          <aside className="flex h-full w-full max-w-md flex-col bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-4">
              <div>
                <p className="text-base font-semibold text-slate-900">共有タスク</p>
                <p className="mt-0.5 text-xs font-medium text-slate-500">未完了 {openTaskCount}件</p>
              </div>
              <button type="button" onClick={() => setTaskPanelOpen(false)} className="flex h-9 w-9 items-center justify-center rounded-md text-xl text-slate-500 hover:bg-slate-100" aria-label="閉じる">×</button>
            </div>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto bg-slate-50 p-3">
              {tasks.length === 0 ? (
                <div className="rounded-lg border border-dashed border-slate-300 bg-white p-5 text-center text-sm font-medium text-slate-500">共有タスクはありません</div>
              ) : tasks.map((task) => (
                <article key={task.id} className={`rounded-lg border bg-white p-3 ${task.status === 'done' ? 'border-slate-200 opacity-70' : 'border-blue-200'}`}>
                  <div className="flex items-start gap-3">
                    <button
                      type="button"
                      onClick={() => void toggleTaskStatus(task)}
                      className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border text-xs ${
                        task.status === 'done' ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-slate-300 bg-white text-transparent hover:border-emerald-400'
                      }`}
                      aria-label={task.status === 'done' ? '未完了に戻す' : '完了にする'}
                    >
                      ✓
                    </button>
                    <div className="min-w-0 flex-1">
                      <p className={`text-sm font-semibold text-slate-900 ${task.status === 'done' ? 'line-through' : ''}`}>{task.title}</p>
                      <div className="mt-1 flex flex-wrap gap-1.5 text-[11px] font-medium text-slate-500">
                        <span>{sourceLabel(task.source)}</span>
                        {task.dueAt && <span>期限 {formatDateTime(task.dueAt)}</span>}
                        {task.assignees.map((assignee) => <span key={assignee.staffId}>@{assignee.staffName}</span>)}
                      </div>
                      <Link href={task.href} className="mt-2 inline-flex text-xs font-semibold text-blue-700 hover:underline">元の相談を開く</Link>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </aside>
        </div>
      )}

      {taskItem && (
        <div className="fixed inset-0 z-[60] flex items-end justify-center bg-slate-950/30 p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label="タスクを作成">
          <div className="w-full max-w-lg rounded-t-lg bg-white p-4 shadow-2xl sm:rounded-lg sm:p-5">
            <div className="flex items-center justify-between gap-3">
              <p className="text-base font-semibold text-slate-900">タスクを作成</p>
              <button type="button" onClick={() => setTaskItem(null)} className="flex h-9 w-9 items-center justify-center rounded-md text-xl text-slate-500 hover:bg-slate-100" aria-label="閉じる">×</button>
            </div>
            <label className="mt-4 block">
              <span className="text-xs font-semibold text-slate-600">件名</span>
              <input value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} maxLength={200} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100" />
            </label>
            <label className="mt-3 block">
              <span className="text-xs font-semibold text-slate-600">期限</span>
              <input type="datetime-local" value={taskDueAt} onChange={(event) => setTaskDueAt(event.target.value)} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100" />
            </label>
            <div className="mt-3">
              <p className="text-xs font-semibold text-slate-600">担当者</p>
              <div className="mt-2 flex max-h-28 flex-wrap gap-1.5 overflow-y-auto">
                {mentionCandidates.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    onClick={() => setTaskAssigneeIds((current) => current.includes(candidate.id) ? current.filter((id) => id !== candidate.id) : [...current, candidate.id])}
                    className={`rounded-full border px-2.5 py-1 text-xs font-medium ${
                      taskAssigneeIds.includes(candidate.id) ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-slate-200 bg-white text-slate-600'
                    }`}
                    aria-pressed={taskAssigneeIds.includes(candidate.id)}
                  >
                    {candidate.name}
                  </button>
                ))}
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setTaskItem(null)} className="rounded-md border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">キャンセル</button>
              <button type="button" onClick={() => void createTask()} disabled={savingTask || !taskTitle.trim()} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">{savingTask ? '作成中' : '作成'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

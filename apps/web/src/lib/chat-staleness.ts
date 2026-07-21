export const CHAT_STALE_MS = 24 * 60 * 60 * 1000

export type ChatStalenessInput = {
  lastMessageAt: string | null
  lastMessageDirection: 'incoming' | 'outgoing' | null
  needsReply?: boolean
  lastUnansweredAt?: string | null
  status: string
}

/** A chat is overdue only while the latest customer message is still unanswered. */
export function isStaleChat(chat: ChatStalenessInput): boolean {
  if (chat.status === 'resolved' || chat.status === 'long_term') return false
  const needsReply = chat.needsReply ?? chat.lastMessageDirection === 'incoming'
  if (!needsReply) return false

  const unansweredAt = chat.lastUnansweredAt ?? chat.lastMessageAt
  const unansweredTime = unansweredAt ? new Date(unansweredAt).getTime() : 0
  return unansweredTime > 0 && Date.now() - unansweredTime >= CHAT_STALE_MS
}

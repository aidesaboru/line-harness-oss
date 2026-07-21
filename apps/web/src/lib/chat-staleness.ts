export const CHAT_STALE_MS = 24 * 60 * 60 * 1000

export type ChatStalenessInput = {
  lastMessageAt: string | null
  lastMessageDirection: 'incoming' | 'outgoing' | null
  status: string
}

/** A chat is overdue only while the latest customer message is still unanswered. */
export function isStaleChat(chat: ChatStalenessInput): boolean {
  if (chat.status === 'resolved' || chat.status === 'long_term') return false
  if (chat.lastMessageDirection !== 'incoming') return false

  const lastMessageAt = chat.lastMessageAt ? new Date(chat.lastMessageAt).getTime() : 0
  return lastMessageAt > 0 && Date.now() - lastMessageAt >= CHAT_STALE_MS
}

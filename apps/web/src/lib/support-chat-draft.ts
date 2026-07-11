export const SUPPORT_CHAT_DRAFT_STORAGE_KEY = 'lh_support_chat_draft'

export type SupportChatDraftContext = {
  friendId: string
  caseId: string
  lineAccountId: string
  caseTitle?: string
  draft: string
  createdAt?: string
}

export type SupportChatDraftInput = {
  friendId: string
  caseId: string
  lineAccountId: string
  caseTitle?: string | null
  draft: string
  createdAt?: string
}

export type SupportChatSendCaseResult = {
  id: string
  previousStatus: string
  nextStatus: 'customer_reply' | null
  statusUpdated: boolean
} | null | undefined

export type SupportChatRecoveryNotice = {
  caseId: string
  caseTitle: string
  supportHref: string
  title: string
  message: string
  steps: string[]
}

export type SupportChatSendCasePayload = {
  supportCaseId?: string
  lineAccountId?: string
}

export type SupportChatSendAttachmentPlan = {
  attachSupportToImage: boolean
  attachSupportToText: boolean
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

const SUPPORT_STATUS_LABELS: Record<string, string> = {
  open: '未対応',
  in_progress: '対応中',
  waiting_primary: '一次回答待ち',
  escalated: 'エスカレ中',
  waiting_secondary: '二次回答待ち',
  secondary_answered: '二次対応回答済み',
  customer_reply: '顧客返信待ち',
  on_hold: '保留',
  resolved: '完了',
  reopened: '再オープン',
}

export function createSupportChatDraftContext(input: SupportChatDraftInput): SupportChatDraftContext {
  return {
    friendId: input.friendId,
    caseId: input.caseId,
    lineAccountId: input.lineAccountId,
    caseTitle: input.caseTitle || undefined,
    draft: input.draft.trim(),
    createdAt: input.createdAt ?? new Date().toISOString(),
  }
}

export function buildSupportChatDraftUrl(
  input: Pick<SupportChatDraftContext, 'friendId' | 'caseId'> & Partial<Pick<SupportChatDraftContext, 'lineAccountId'>>,
): string {
  const params = new URLSearchParams({
    friend: input.friendId,
    supportCase: input.caseId,
  })
  if (input.lineAccountId) params.set('lineAccount', input.lineAccountId)
  return `/chats?${params.toString()}`
}

export function buildSupportCaseUrl(caseId: string): string {
  return `/support?${new URLSearchParams({ case: caseId }).toString()}`
}

export function buildSupportChatSendCasePayload(
  context: Pick<SupportChatDraftContext, 'caseId' | 'lineAccountId'> | null | undefined,
  shouldAttach: boolean,
): SupportChatSendCasePayload {
  if (!context || !shouldAttach) return {}
  return {
    supportCaseId: context.caseId,
    lineAccountId: context.lineAccountId,
  }
}

export function planSupportChatSendAttachments(
  context: SupportChatDraftContext | null | undefined,
  input: { hasLineImage: boolean; hasText: boolean },
): SupportChatSendAttachmentPlan {
  const attachSupportToImage = Boolean(context && input.hasLineImage)
  return {
    attachSupportToImage,
    attachSupportToText: Boolean(context && !attachSupportToImage && input.hasText),
  }
}

export function buildSupportChatRecoveryNotice(
  supportCase: SupportChatSendCaseResult,
  context?: Pick<SupportChatDraftContext, 'caseId' | 'caseTitle'> | null,
): SupportChatRecoveryNotice | null {
  if (!supportCase || supportCase.statusUpdated !== false) return null
  if (supportCase.previousStatus === 'customer_reply' && supportCase.nextStatus === null) return null

  const caseId = supportCase.id || context?.caseId
  if (!caseId) return null

  const caseTitle = context?.caseTitle || caseId
  const previousLabel = SUPPORT_STATUS_LABELS[supportCase.previousStatus] ?? supportCase.previousStatus

  return {
    caseId,
    caseTitle,
    supportHref: buildSupportCaseUrl(caseId),
    title: 'LINE送信は完了、チケット更新だけ確認が必要です',
    message: `チケット「${caseTitle}」のステータスを「顧客返信待ち」に更新できませんでした。顧客へのLINE送信は完了しています。`,
    steps: [
      'チケット管理でチケットを開き、最新状態を再読み込みしてください。',
      `ステータスが「${previousLabel}」のままなら「顧客返信待ち」へ保存してください。`,
      'チケット履歴に「チャットで顧客返信を送信しました」が残っているか確認してください。',
    ],
  }
}

export function storeSupportChatDraft(
  storage: StorageLike,
  context: SupportChatDraftContext,
): void {
  storage.setItem(SUPPORT_CHAT_DRAFT_STORAGE_KEY, JSON.stringify(context))
}

export function tryStoreSupportChatDraft(
  storage: StorageLike,
  context: SupportChatDraftContext,
): boolean {
  try {
    storeSupportChatDraft(storage, context)
    return true
  } catch {
    return false
  }
}

function isSupportChatDraftContext(value: unknown): value is SupportChatDraftContext {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Partial<SupportChatDraftContext>
  return (
    typeof item.friendId === 'string' &&
    typeof item.caseId === 'string' &&
    typeof item.lineAccountId === 'string' &&
    typeof item.draft === 'string' &&
    item.draft.trim().length > 0 &&
    (item.caseTitle === undefined || typeof item.caseTitle === 'string') &&
    (item.createdAt === undefined || typeof item.createdAt === 'string')
  )
}

export function consumeSupportChatDraft(
  storage: StorageLike,
  search: string,
): SupportChatDraftContext | null {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const friendId = params.get('friend')
  const supportCaseId = params.get('supportCase')
  if (!friendId || !supportCaseId) return null

  try {
    const raw = storage.getItem(SUPPORT_CHAT_DRAFT_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as unknown
    if (!isSupportChatDraftContext(parsed)) return null
    if (parsed.friendId !== friendId || parsed.caseId !== supportCaseId) return null
    storage.removeItem(SUPPORT_CHAT_DRAFT_STORAGE_KEY)
    return {
      ...parsed,
      draft: parsed.draft.trim(),
    }
  } catch {
    return null
  }
}

export function buildSupportChatFallbackContext(search: string): SupportChatDraftContext | null {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const friendId = params.get('friend')
  const supportCaseId = params.get('supportCase')
  if (!friendId || !supportCaseId) return null

  return {
    friendId,
    caseId: supportCaseId,
    lineAccountId: params.get('lineAccount') ?? '',
    draft: '',
  }
}

export function mergeSupportChatDraftContext(
  previous: SupportChatDraftContext | null,
  next: SupportChatDraftContext,
): SupportChatDraftContext {
  if (!previous) return next
  if (previous.friendId !== next.friendId || previous.caseId !== next.caseId) return next

  return {
    ...next,
    lineAccountId: next.lineAccountId || previous.lineAccountId,
    caseTitle: next.caseTitle || previous.caseTitle,
    draft: next.draft || previous.draft,
    createdAt: next.createdAt || previous.createdAt,
  }
}

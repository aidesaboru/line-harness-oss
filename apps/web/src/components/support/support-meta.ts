import type {
  SupportCase,
  SupportCaseStatus,
  SupportEscalationStatus,
  SupportPriority,
} from '@/lib/api'

export const STALE_MS = 24 * 60 * 60 * 1000

export const categoryOptions = [
  { value: 'reward', label: '報酬/支払い' },
  { value: 'delivery', label: '商品/配送/返品' },
  { value: 'claim', label: 'レビュー/クレーム' },
  { value: 'rights', label: '権利侵害' },
  { value: 'tax_contract', label: '税務/契約' },
  { value: 'operation', label: '運営確認' },
  { value: 'other', label: 'その他' },
]

export const statusOptions: Array<{ value: SupportCaseStatus; label: string }> = [
  { value: 'open', label: '未対応' },
  { value: 'in_progress', label: '対応中' },
  { value: 'waiting_primary', label: '一次回答待ち' },
  { value: 'escalated', label: 'エスカレ中' },
  { value: 'waiting_secondary', label: '二次回答待ち' },
  { value: 'customer_reply', label: '顧客返信待ち' },
  { value: 'on_hold', label: '保留' },
  { value: 'resolved', label: '完了' },
  { value: 'reopened', label: '再オープン' },
]

export const priorityOptions: Array<{ value: SupportPriority; label: string }> = [
  { value: 'urgent', label: '緊急' },
  { value: 'high', label: '高' },
  { value: 'medium', label: '中' },
  { value: 'low', label: '低' },
]

export const statusLabel = Object.fromEntries(
  statusOptions.map((item) => [item.value, item.label]),
) as Record<SupportCaseStatus, string>

export const categoryLabel = Object.fromEntries(
  categoryOptions.map((item) => [item.value, item.label]),
) as Record<string, string>

export const priorityLabel = Object.fromEntries(
  priorityOptions.map((item) => [item.value, item.label]),
) as Record<SupportPriority, string>

export const statusClass: Record<SupportCaseStatus, string> = {
  open: 'bg-red-50 text-red-700 border-red-200',
  in_progress: 'bg-amber-50 text-amber-700 border-amber-200',
  waiting_primary: 'bg-yellow-50 text-yellow-700 border-yellow-200',
  escalated: 'bg-purple-50 text-purple-700 border-purple-200',
  waiting_secondary: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  customer_reply: 'bg-blue-50 text-blue-700 border-blue-200',
  on_hold: 'bg-gray-100 text-gray-700 border-gray-200',
  resolved: 'bg-green-50 text-green-700 border-green-200',
  reopened: 'bg-pink-50 text-pink-700 border-pink-200',
}

export const priorityClass: Record<SupportPriority, string> = {
  urgent: 'bg-red-600 text-white border-red-600',
  high: 'bg-orange-100 text-orange-700 border-orange-200',
  medium: 'bg-sky-100 text-sky-700 border-sky-200',
  low: 'bg-gray-100 text-gray-600 border-gray-200',
}

export const escalationStatusMeta: Record<
  SupportEscalationStatus,
  { label: string; className: string }
> = {
  pending: { label: '回答待ち', className: 'bg-indigo-50 text-indigo-700 border-indigo-200' },
  answered: { label: '回答済み', className: 'bg-green-50 text-green-700 border-green-200' },
  needs_info: { label: '差し戻し', className: 'bg-amber-50 text-amber-700 border-amber-200' },
  transferred: { label: '転送', className: 'bg-purple-50 text-purple-700 border-purple-200' },
  expert_check: { label: '専門確認中', className: 'bg-blue-50 text-blue-700 border-blue-200' },
  closed: { label: 'クローズ', className: 'bg-gray-100 text-gray-500 border-gray-200' },
}

export const eventTypeLabel: Record<string, string> = {
  created: '案件作成',
  updated: '案件更新',
  escalated: 'エスカレ作成',
  escalation_updated: 'エスカレ更新',
  note: 'メモ',
}

export const resolveChecklist = [
  '顧客への返信が完了している',
  '二次対応の確認が完了している',
  '社内メモに判断理由が残っている',
  '必要なマニュアルが紐付いている',
  '再確認予定が不要になっている',
]

// ─── 時刻ユーティリティ ───

export function getTime(value: string | null | undefined): number {
  if (!value) return 0
  const t = new Date(value).getTime()
  return Number.isNaN(t) ? 0 : t
}

export function isUnresolvedStatus(status: SupportCaseStatus): boolean {
  return status !== 'resolved'
}

export function isOverdueCase(item: Pick<SupportCase, 'dueAt' | 'status'>): boolean {
  const t = getTime(item.dueAt)
  return isUnresolvedStatus(item.status) && t > 0 && t < Date.now()
}

export function isStaleCase(item: Pick<SupportCase, 'updatedAt' | 'status'>): boolean {
  const t = getTime(item.updatedAt)
  return isUnresolvedStatus(item.status) && t > 0 && Date.now() - t >= STALE_MS
}

export function formatElapsed(value: string | null | undefined): string {
  const t = getTime(value)
  if (!t) return ''
  const hours = Math.floor((Date.now() - t) / (60 * 60 * 1000))
  if (hours < 24) return `${hours}時間`
  return `${Math.floor(hours / 24)}日`
}

/** 期限を「あと3時間 / 2時間超過」のような相対表現にする */
export function formatRelativeDue(value: string | null | undefined): string {
  const t = getTime(value)
  if (!t) return ''
  const diffMs = t - Date.now()
  const abs = Math.abs(diffMs)
  const minutes = Math.floor(abs / (60 * 1000))
  const hours = Math.floor(abs / (60 * 60 * 1000))
  const days = Math.floor(hours / 24)
  const span = days >= 1 ? `${days}日` : hours >= 1 ? `${hours}時間` : `${minutes}分`
  return diffMs < 0 ? `${span}超過` : `あと${span}`
}

export type DueUrgency = 'overdue' | 'soon' | 'normal' | 'none'

const DUE_SOON_MS = 4 * 60 * 60 * 1000

export function dueUrgency(value: string | null | undefined): DueUrgency {
  const t = getTime(value)
  if (!t) return 'none'
  const diff = t - Date.now()
  if (diff < 0) return 'overdue'
  if (diff < DUE_SOON_MS) return 'soon'
  return 'normal'
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '-'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleString('ja-JP', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function toInputDateTime(value: string | null | undefined): string {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value.slice(0, 16)
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`
}

export function fromInputDateTime(value: string): string | null {
  if (!value.trim()) return null
  return value.length === 16 ? `${value}:00+09:00` : value
}

function toLocalInputValue(d: Date): string {
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`
}

export interface DueTimePreset {
  label: string
  compute: () => string
}

/** 期限入力でよく使う時刻のプリセット (datetime-local 形式を返す) */
export const dueTimePresets: DueTimePreset[] = [
  {
    label: '今日18時',
    compute: () => {
      const d = new Date()
      d.setHours(18, 0, 0, 0)
      return toLocalInputValue(d)
    },
  },
  {
    label: '明日10時',
    compute: () => {
      const d = new Date()
      d.setDate(d.getDate() + 1)
      d.setHours(10, 0, 0, 0)
      return toLocalInputValue(d)
    },
  },
  {
    label: '+24h',
    compute: () => {
      const d = new Date(Date.now() + 24 * 60 * 60 * 1000)
      d.setMinutes(0, 0, 0)
      return toLocalInputValue(d)
    },
  },
]

// ─── 案件編集フォーム ───

export interface CaseFormState {
  title: string
  category: string
  priority: SupportPriority
  status: SupportCaseStatus
  primaryAssignee: string
  escalationAssignee: string
  dueAt: string
  nextCheckAt: string
  customerNumber: string
  companyName: string
  contactName: string
  storeName: string
  contractType: string
  customerSummary: string
  internalNote: string
  customerReplyDraft: string
  resolutionNote: string
}

export function emptyCaseForm(): CaseFormState {
  return {
    title: '',
    category: 'other',
    priority: 'medium',
    status: 'open',
    primaryAssignee: '',
    escalationAssignee: '',
    dueAt: '',
    nextCheckAt: '',
    customerNumber: '',
    companyName: '',
    contactName: '',
    storeName: '',
    contractType: '',
    customerSummary: '',
    internalNote: '',
    customerReplyDraft: '',
    resolutionNote: '',
  }
}

export function caseFormFromDetail(detail: {
  title: string
  category: string
  priority: SupportPriority
  status: SupportCaseStatus
  primaryAssignee: string | null
  escalationAssignee: string | null
  dueAt: string | null
  nextCheckAt: string | null
  customerNumber: string | null
  companyName: string | null
  contactName: string | null
  storeName: string | null
  contractType: string | null
  customerSummary: string
  internalNote: string
  customerReplyDraft: string
  resolutionNote: string
}): CaseFormState {
  return {
    title: detail.title,
    category: detail.category,
    priority: detail.priority,
    status: detail.status,
    primaryAssignee: detail.primaryAssignee ?? '',
    escalationAssignee: detail.escalationAssignee ?? '',
    dueAt: toInputDateTime(detail.dueAt),
    nextCheckAt: toInputDateTime(detail.nextCheckAt),
    customerNumber: detail.customerNumber ?? '',
    companyName: detail.companyName ?? '',
    contactName: detail.contactName ?? '',
    storeName: detail.storeName ?? '',
    contractType: detail.contractType ?? '',
    customerSummary: detail.customerSummary,
    internalNote: detail.internalNote,
    customerReplyDraft: detail.customerReplyDraft,
    resolutionNote: detail.resolutionNote,
  }
}

// ─── 案件一覧の並び替え ───

export type CaseSortMode = 'updated' | 'due' | 'priority'

export const caseSortOptions: Array<{ value: CaseSortMode; label: string }> = [
  { value: 'updated', label: '更新が新しい順' },
  { value: 'due', label: '期限が近い順' },
  { value: 'priority', label: '優先度順' },
]

const priorityRank: Record<SupportPriority, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
}

export function sortCases(cases: SupportCase[], mode: CaseSortMode): SupportCase[] {
  if (mode === 'updated') return cases
  const sorted = [...cases]
  if (mode === 'due') {
    sorted.sort((a, b) => {
      const aResolved = a.status === 'resolved' ? 1 : 0
      const bResolved = b.status === 'resolved' ? 1 : 0
      if (aResolved !== bResolved) return aResolved - bResolved
      const at = getTime(a.dueAt) || Number.MAX_SAFE_INTEGER
      const bt = getTime(b.dueAt) || Number.MAX_SAFE_INTEGER
      return at - bt
    })
  } else {
    sorted.sort((a, b) => {
      const pr = priorityRank[a.priority] - priorityRank[b.priority]
      if (pr !== 0) return pr
      const at = getTime(a.dueAt) || Number.MAX_SAFE_INTEGER
      const bt = getTime(b.dueAt) || Number.MAX_SAFE_INTEGER
      return at - bt
    })
  }
  return sorted
}

// ─── エスカレ共有文 ───

interface ShareMessage {
  direction: string
  messageType: string
  content: string
  createdAt: string
}

function formatMessageForShare(message: ShareMessage): string {
  const speaker = message.direction === 'incoming' ? '顧客' : '運営'
  const content = message.messageType === 'text' ? message.content : `[${message.messageType}]`
  return `- ${formatDateTime(message.createdAt)} ${speaker}: ${content.replace(/\n+/g, ' ').slice(0, 220)}`
}

export interface ShareTextSource {
  title: string
  friendName: string | null
  companyName: string | null
  priority: SupportPriority
  category: string
  dueAt: string | null
  primaryAssignee: string
  escalationAssignee: string
  customerSummary: string
  question: string
  recentMessages: ShareMessage[]
}

export function buildEscalationShareText(source: ShareTextSource): string {
  const latestMessages = source.recentMessages.slice(-8).map(formatMessageForShare)
  return [
    `【案件】${source.title}`,
    `【顧客】${source.friendName || source.companyName || '顧客未紐付け'}`,
    `【優先度】${priorityLabel[source.priority]}`,
    `【種別】${categoryLabel[source.category] || source.category}`,
    `【期限】${formatDateTime(source.dueAt)}`,
    `【一次担当】${source.primaryAssignee || '未設定'}`,
    `【エスカレ先】${source.escalationAssignee || '未設定'}`,
    '',
    `【問い合わせ要約】`,
    source.customerSummary || '未記入',
    '',
    `【確認してほしいこと】`,
    source.question || '未記入',
    '',
    `【直近会話抜粋】`,
    latestMessages.length ? latestMessages.join('\n') : '会話ログなし',
    '',
    `【回答の返し方】`,
    '回答要点をこの案件のエスカレーション欄へ記入してください。顧客への最終返信はフロント側で確認して送信します。',
  ].join('\n')
}

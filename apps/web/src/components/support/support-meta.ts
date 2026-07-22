import type {
  SupportCase,
  SupportCaseStatus,
  SupportEscalationStatus,
  SupportPriority,
} from '@/lib/api'
import { textOrMessageTypePreview } from '../../lib/message-type-label'

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
  { value: 'waiting_secondary', label: '二次対応中' },
  { value: 'secondary_answered', label: '二次対応回答済み' },
  { value: 'in_progress', label: '対応中' },
  { value: 'customer_reply', label: '顧客返信待ち' },
  { value: 'resolved', label: '完了' },
]

const reopenedStatusOption: { value: SupportCaseStatus; label: string } = {
  value: 'reopened',
  label: '再オープン',
}

export type SupportStaffRole = 'owner' | 'admin' | 'staff' | 'secondary' | string | null | undefined

export interface SupportRolePermissions {
  canCreateCases: boolean
  canEditCaseRouting: boolean
  canManageManuals: boolean
  canEditCaseWork: boolean
  canLinkManuals: boolean
}

export function getSupportRolePermissions(role: SupportStaffRole): SupportRolePermissions {
  const canManageRouting = role === 'owner' || role === 'admin'
  const canUseSupport = role === 'owner' || role === 'admin' || role === 'staff'
  return {
    canCreateCases: canUseSupport,
    canEditCaseRouting: canManageRouting,
    canManageManuals: canManageRouting,
    canEditCaseWork: true,
    canLinkManuals: true,
  }
}

export function getSupportIdentityIssue(input: {
  ready: boolean
  role: SupportStaffRole
  staffName: string
}): string | null {
  if (!input.ready) return null
  const role = typeof input.role === 'string' ? input.role.trim() : ''
  if (!role) return 'ログイン権限を確認できませんでした。再ログインしてからチケット管理を開き直してください。'
  if ((role === 'staff' || role === 'secondary') && !input.staffName.trim()) {
    return 'スタッフ名がないため表示範囲を判定できません。スタッフ管理でスタッフ名を設定し、再ログインしてください。'
  }
  return null
}

export function canLoadSupportWorkspaceData(input: {
  selectedAccountId: string | null | undefined
  staffIdentityReady: boolean
  identityIssue: string | null
}): boolean {
  return Boolean(input.selectedAccountId) && input.staffIdentityReady && !input.identityIssue
}

export interface SupportEmptyState {
  title: string
  description: string
  actionLabel?: string
}

export function getSupportCaseListEmptyState(input: {
  role: SupportStaffRole
  hasActiveFilters: boolean
  statusFilter: string
  queueFilter: string
  caseFocus: CaseFocus
  search: string
}): SupportEmptyState {
  const search = input.search.trim()

  if (search) {
    return {
      title: '検索条件に合うチケットはありません',
      description: '件名、顧客名、問い合わせ内容、内部メモの言葉を変えて検索してください。',
      actionLabel: '絞り込みをリセット',
    }
  }

  if (input.caseFocus === 'stale') {
    return {
      title: '24h滞留しているチケットはありません',
      description: '今の一覧では、24時間以上動きが止まっている未完了チケットはありません。',
      actionLabel: '絞り込みをリセット',
    }
  }

  if (input.queueFilter === 'escalated') {
    return {
      title: '二次対応が確認中のチケットはありません',
      description: '今の一覧では、詳しい人の回答待ちになっているチケットはありません。',
      actionLabel: '絞り込みをリセット',
    }
  }

  if (input.queueFilter === 'primary_action') {
    return {
      title: '一次対応が動くチケットはありません',
      description: '一次対応者が次に進める番のチケットはありません。',
      actionLabel: '絞り込みをリセット',
    }
  }

  if (input.queueFilter === 'secondary_answered') {
    return {
      title: '二次対応回答済みのチケットはありません',
      description: '詳しい人から回答が戻っていて、一次対応者が確認するチケットはありません。',
      actionLabel: '絞り込みをリセット',
    }
  }

  if (input.queueFilter === 'waiting_customer') {
    return {
      title: '顧客返信待ちのチケットはありません',
      description: '顧客へ返信済みで、追加の反応を待っているチケットはありません。',
      actionLabel: '絞り込みをリセット',
    }
  }

  if (input.statusFilter === 'resolved') {
    return {
      title: '完了チケットはありません',
      description: '完了済みのチケットを確認したい場合は、期間や検索条件も見直してください。',
      actionLabel: input.hasActiveFilters ? '絞り込みをリセット' : undefined,
    }
  }

  if (input.hasActiveFilters) {
    return {
      title: '条件に合うチケットはありません',
      description: 'ステータス、キュー、検索条件を見直してください。',
      actionLabel: '絞り込みをリセット',
    }
  }

  if (input.role === 'staff') {
    return {
      title: '表示できるチケットはありません',
      description: 'staff権限では、自分が作成・担当・エスカレ先になっているチケットだけが表示されます。新しい割り当てが必要ならowner/adminに依頼してください。',
    }
  }

  return {
    title: '未完了のチケットはありません',
    description: '新しい問い合わせが来たら、チャット画面からチケット化して対応を始めます。',
  }
}

export function getVisibleStatusOptions(
  detailStatus: SupportCaseStatus,
  formStatus: SupportCaseStatus,
): Array<{ value: SupportCaseStatus; label: string }> {
  if (detailStatus === 'resolved' || formStatus === 'reopened') return [...statusOptions, reopenedStatusOption]
  return statusOptions
}

export function canOpenChatWithDraft(params: {
  status: SupportCaseStatus
  hasDraft: boolean
  hasChat: boolean
}): boolean {
  return params.status !== 'resolved' && params.hasDraft && params.hasChat
}

export function supportApiErrorMessage(res: { error?: string }, fallback: string): string {
  return formatSupportErrorMessage(res.error, fallback)
}

const supportUserFacingApiMessages = new Set([
  'LINE会話を選ぶか、問い合わせ内容を入力してください。',
  '保留にする場合は、保留理由の内部メモと次回確認日が必要です',
  '完了にする場合は、対応結果メモが必要です',
  '完了済みチケットを戻す場合は再オープンを選択してください',
  '再オープンは完了済みチケットだけで選択できます',
  '完了済みチケットは再オープンしてからエスカレーションしてください',
  'staff権限では二次対応先が設定済みのチケットだけエスカレーションできます',
  '回答済みにする場合は回答要点が必要です',
  'staff権限ではエスカレーションを回答済み、または差し戻しにのみ変更できます',
  '完了済みチケットは再オープンしてからエスカレーションを更新してください',
])

export function formatSupportErrorMessage(error: unknown, fallback: string): string {
  const raw = typeof error === 'string'
    ? error
    : error instanceof Error
      ? error.message
      : ''
  const message = raw.trim()
  if (!message) return fallback
  const displayMessage = message.replace(/サポートCRM/g, 'チケット管理').replace(/案件/g, 'チケット')

  const status = message.match(/^API error:\s*(\d+)/)?.[1]
  if (status === '401') {
    return 'ログイン期限が切れている可能性があります。ログインし直してから再読み込みしてください。'
  }
  if (status === '403') {
    return 'この操作を行う権限がありません。owner/adminに依頼してください。'
  }
  if (status === '404') {
    return `${fallback} 対象が見つかりません。最新データで再読み込みしてください。`
  }
  if (status === '409') {
    return '別の更新と競合しました。最新データで再読み込みしてからやり直してください。'
  }
  if (status === '429') {
    return '短時間に操作が集中しています。少し待ってからやり直してください。'
  }
  if (status && Number(status) >= 500) {
    return 'サーバー側でエラーが発生しました。少し待ってから再読み込みしてください。'
  }

  if (
    message === 'Failed to fetch' ||
    message.includes('NetworkError') ||
    message.includes('Load failed')
  ) {
    return '通信に失敗しました。ネットワークとWorkerの起動状態を確認してから再読み込みしてください。'
  }

  const lower = message.toLowerCase()
  if (lower.includes('support case is resolved') || lower.includes('resolved case')) {
    return '完了済みのチケットです。返信や二次対応を続ける場合は、チケットを再オープンしてください。'
  }
  if (lower.includes('forbidden') || lower.includes('permission') || lower.includes('not allowed')) {
    return 'この操作を行う権限がありません。owner/adminに依頼してください。'
  }
  if (lower.includes('not found')) {
    return `${fallback} 対象が見つかりません。最新データで再読み込みしてください。`
  }

  if (supportUserFacingApiMessages.has(displayMessage)) return displayMessage

  return fallback
}

export const priorityOptions: Array<{ value: SupportPriority; label: string }> = [
  { value: 'urgent', label: '大至急' },
  { value: 'high', label: '緊急' },
  { value: 'medium', label: '通常' },
]

export const statusLabel: Record<SupportCaseStatus, string> = {
  open: '未対応',
  in_progress: '対応中',
  waiting_primary: '回答確認',
  escalated: '二次対応中',
  waiting_secondary: '二次対応中',
  secondary_answered: '二次対応回答済み',
  customer_reply: '顧客返信待ち',
  on_hold: '保留',
  resolved: '完了',
  reopened: '再オープン',
}

export const categoryLabel = Object.fromEntries(
  categoryOptions.map((item) => [item.value, item.label]),
) as Record<string, string>

export const priorityLabel = Object.fromEntries(
  [...priorityOptions, { value: 'low', label: '通常' }].map((item) => [item.value, item.label]),
) as Record<SupportPriority, string>

export const statusClass: Record<SupportCaseStatus, string> = {
  open: 'bg-red-50 text-red-700 border-red-200',
  in_progress: 'bg-amber-50 text-amber-700 border-amber-200',
  waiting_primary: 'bg-yellow-50 text-yellow-700 border-yellow-200',
  escalated: 'bg-purple-50 text-purple-700 border-purple-200',
  waiting_secondary: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  secondary_answered: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  customer_reply: 'bg-blue-50 text-blue-700 border-blue-200',
  on_hold: 'bg-gray-100 text-gray-700 border-gray-200',
  resolved: 'bg-green-50 text-green-700 border-green-200',
  reopened: 'bg-pink-50 text-pink-700 border-pink-200',
}

export const priorityClass: Record<SupportPriority, string> = {
  urgent: 'bg-red-100 text-red-700 border-red-200',
  high: 'bg-orange-100 text-orange-700 border-orange-200',
  medium: 'bg-sky-100 text-sky-700 border-sky-200',
  low: 'bg-sky-100 text-sky-700 border-sky-200',
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
  created: 'チケット作成',
  updated: 'チケット更新',
  escalated: 'エスカレ作成',
  escalation_updated: 'エスカレ更新',
  escalation_reopened: 'エスカレ再開',
  internal_chat: '社内チャット',
  internal_thread_reply: '社内スレッド返信',
  customer_reply_sent: '顧客返信送信',
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

// ─── チケット編集フォーム ───

export interface CaseFormState {
  title: string
  category: string
  priority: SupportPriority
  status: SupportCaseStatus
  primaryAssignee: string
  escalationAssignee: string
  escalationAssignees: string[]
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
    escalationAssignees: [],
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
  escalationAssignees?: string[]
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
    priority: detail.priority === 'low' ? 'medium' : detail.priority,
    status: detail.status,
    primaryAssignee: detail.primaryAssignee ?? '',
    escalationAssignee: detail.escalationAssignee ?? '',
    escalationAssignees: detail.escalationAssignees?.length
      ? detail.escalationAssignees
      : detail.escalationAssignee ? [detail.escalationAssignee] : [],
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

export type CaseFormValidationIssueKey =
  | 'on_hold_next_check'
  | 'on_hold_internal_note'
  | 'resolved_resolution_note'
  | 'reply_missing_chat'
  | 'reply_resolved_case'

export interface CaseFormValidationIssue {
  key: CaseFormValidationIssueKey
  severity: 'error' | 'info'
  message: string
  fieldLabel: string
  blocking: boolean
}

export function getCaseFormValidationIssues(
  form: Pick<CaseFormState, 'status' | 'nextCheckAt' | 'internalNote' | 'resolutionNote' | 'customerReplyDraft'>,
  options: { hasChat?: boolean } = {},
): CaseFormValidationIssue[] {
  const issues: CaseFormValidationIssue[] = []

  if (form.status === 'on_hold') {
    if (!form.nextCheckAt) {
      issues.push({
        key: 'on_hold_next_check',
        severity: 'error',
        message: '保留にするには次回確認の日時が必要です。',
        fieldLabel: '次回確認',
        blocking: true,
      })
    }
    if (!form.internalNote.trim()) {
      issues.push({
        key: 'on_hold_internal_note',
        severity: 'error',
        message: '保留にするには内部メモに理由を残してください。',
        fieldLabel: '内部メモ',
        blocking: true,
      })
    }
  }

  if (form.status === 'resolved' && !form.resolutionNote.trim()) {
    issues.push({
      key: 'resolved_resolution_note',
      severity: 'error',
      message: '完了にするには対応結果メモが必要です。',
      fieldLabel: '対応結果メモ',
      blocking: true,
    })
  }

  if (form.customerReplyDraft.trim()) {
    if (form.status === 'resolved') {
      issues.push({
        key: 'reply_resolved_case',
        severity: 'info',
        message: '完了済みチケットからはチャット返信できません。返信を続ける場合は再オープンしてください。',
        fieldLabel: '顧客向け返信案',
        blocking: false,
      })
    } else if (options.hasChat === false) {
      issues.push({
        key: 'reply_missing_chat',
        severity: 'info',
        message: 'チャットで返信するにはLINE会話との紐付けが必要です。コピー送信はできます。',
        fieldLabel: '顧客向け返信案',
        blocking: false,
      })
    }
  }

  return issues
}

export function getBlockingCaseFormValidationIssues(
  form: Pick<CaseFormState, 'status' | 'nextCheckAt' | 'internalNote' | 'resolutionNote' | 'customerReplyDraft'>,
): CaseFormValidationIssue[] {
  return getCaseFormValidationIssues(form).filter((issue) => issue.blocking)
}

export type CreateCaseValidationIssueKey = 'create_case_source'

export interface CreateCaseValidationIssue {
  key: CreateCaseValidationIssueKey
  severity: 'error'
  message: string
  fieldLabel: string
  blocking: true
}

export function getCreateCaseValidationIssues(input: {
  friendId: string
  customerSummary: string
}): CreateCaseValidationIssue[] {
  if (input.friendId.trim() || input.customerSummary.trim()) return []
  return [{
    key: 'create_case_source',
    severity: 'error',
    message: 'LINE会話を選ぶか、問い合わせ内容を入力してください。',
    fieldLabel: 'LINE会話 / 問い合わせ内容',
    blocking: true,
  }]
}

export type ManualEditorValidationIssueKey =
  | 'manual_title'
  | 'manual_body'
  | 'manual_url'

export interface ManualEditorValidationIssue {
  key: ManualEditorValidationIssueKey
  severity: 'error'
  message: string
  fieldLabel: string
  blocking: true
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export function getManualEditorValidationIssues(input: {
  title: string
  body: string
  url: string
}): ManualEditorValidationIssue[] {
  const issues: ManualEditorValidationIssue[] = []
  const title = input.title.trim()
  const body = input.body.trim()
  const url = input.url.trim()

  if (!title) {
    issues.push({
      key: 'manual_title',
      severity: 'error',
      message: 'マニュアル名として一覧に出すタイトルが必要です。',
      fieldLabel: 'タイトル',
      blocking: true,
    })
  }

  if (!body) {
    issues.push({
      key: 'manual_body',
      severity: 'error',
      message: 'あとから担当者が判断できるように、本文に対応手順か判断基準を書いてください。',
      fieldLabel: '本文',
      blocking: true,
    })
  }

  if (url && !isHttpUrl(url)) {
    issues.push({
      key: 'manual_url',
      severity: 'error',
      message: 'リンクは http:// または https:// から始まるURLで入力してください。',
      fieldLabel: 'リンク',
      blocking: true,
    })
  }

  return issues
}

export type EscalationDraftValidationIssueKey =
  | 'escalation_resolved_case'
  | 'escalation_assignee'
  | 'escalation_locked_assignee'
  | 'escalation_question'

export interface EscalationDraftValidationIssue {
  key: EscalationDraftValidationIssueKey
  severity: 'error'
  message: string
  fieldLabel: string
  blocking: true
}

export function getEscalationDraftValidationIssues(input: {
  question: string
  assignee: string
  canEditRouting: boolean
  hasPresetAssignee: boolean
  detailStatus?: SupportCaseStatus | null
}): EscalationDraftValidationIssue[] {
  const issues: EscalationDraftValidationIssue[] = []

  if (input.detailStatus === 'resolved') {
    issues.push({
      key: 'escalation_resolved_case',
      severity: 'error',
      message: '完了済みチケットではエスカレーションを作成できません。先にチケットを再オープンしてください。',
      fieldLabel: 'チケットステータス',
      blocking: true,
    })
  }

  if (input.canEditRouting) {
    if (!input.assignee.trim()) {
      issues.push({
        key: 'escalation_assignee',
        severity: 'error',
        message: '二次対応先を指定してください。',
        fieldLabel: '二次対応先',
        blocking: true,
      })
    }
  } else if (!input.hasPresetAssignee) {
    issues.push({
      key: 'escalation_locked_assignee',
      severity: 'error',
      message: 'staff権限では二次対応先を変更できません。owner/adminに二次対応先の設定を依頼してください。',
      fieldLabel: '二次対応先',
      blocking: true,
    })
  }

  if (!input.question.trim()) {
    issues.push({
      key: 'escalation_question',
      severity: 'error',
      message: '確認してほしい要点を書いてください。',
      fieldLabel: '確認要点',
      blocking: true,
    })
  }

  return issues
}

// ─── チケット一覧の並び替え ───

export type CaseSortMode = 'updated' | 'due' | 'priority'
export type CaseFocus = 'all' | 'stale'

export const caseSortOptions: Array<{ value: CaseSortMode; label: string }> = [
  { value: 'updated', label: '更新が新しい順' },
  { value: 'due', label: '期限が近い順' },
  { value: 'priority', label: '緊急度順' },
]

const priorityRank: Record<SupportPriority, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
}

export function sortCases(cases: SupportCase[], mode: CaseSortMode): SupportCase[] {
  const sorted = [...cases]
  if (mode === 'updated') {
    sorted.sort((a, b) => {
      const at = getTime(a.updatedAt) || 0
      const bt = getTime(b.updatedAt) || 0
      return bt - at
    })
  } else if (mode === 'due') {
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

export function getDisplayCases(
  cases: SupportCase[],
  options: { caseFocus: CaseFocus; sortMode: CaseSortMode },
): SupportCase[] {
  const filtered = options.caseFocus === 'stale' ? cases.filter(isStaleCase) : cases
  if (options.caseFocus === 'stale' && options.sortMode === 'updated') {
    return [...filtered].sort((a, b) => {
      const at = getTime(a.updatedAt) || Number.MAX_SAFE_INTEGER
      const bt = getTime(b.updatedAt) || Number.MAX_SAFE_INTEGER
      return at - bt
    })
  }
  return sortCases(filtered, options.sortMode)
}

export function getInitialSupportCaseId(
  cases: SupportCase[],
  options: { caseFocus: CaseFocus; sortMode: CaseSortMode },
): string | null {
  return getDisplayCases(cases, options)[0]?.id ?? null
}

export function isSelectedCaseOutsideCurrentList(input: {
  selectedCaseId: string | null
  displayedCaseIds: readonly string[]
}): boolean {
  return Boolean(input.selectedCaseId && !input.displayedCaseIds.includes(input.selectedCaseId))
}

export function getOutsideCurrentListAction(status?: SupportCaseStatus | null): {
  label: string
  statusFilter: string
  queueFilter: string
  caseFocus: CaseFocus
} {
  if (status === 'resolved') {
    return {
      label: '完了チケットを表示',
      statusFilter: 'resolved',
      queueFilter: 'all',
      caseFocus: 'all',
    }
  }

  return {
    label: '絞り込みをリセット',
    statusFilter: 'all',
    queueFilter: 'all',
    caseFocus: 'all',
  }
}

export function buildSupportCaseSearch(currentSearch: string, caseId: string | null): string {
  const params = new URLSearchParams(currentSearch.startsWith('?') ? currentSearch.slice(1) : currentSearch)
  if (caseId) params.set('case', caseId)
  else params.delete('case')
  const next = params.toString()
  return next ? `?${next}` : ''
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
  const content = textOrMessageTypePreview(message.messageType, message.content, 220)
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
    `【チケット】${source.title}`,
    `【顧客】${source.friendName || source.companyName || '顧客未紐付け'}`,
    `【緊急度】${priorityLabel[source.priority]}`,
    `【種別】${categoryLabel[source.category] || source.category}`,
    `【期限】${formatDateTime(source.dueAt)}`,
    `【一次担当】${source.primaryAssignee || '未設定'}`,
    `【エスカレ先】${source.escalationAssignee || '未設定'}`,
    '',
    `【問い合わせ内容】`,
    source.customerSummary || '未記入',
    '',
    `【確認してほしいこと】`,
    source.question || '未記入',
    '',
    `【直近会話抜粋】`,
    latestMessages.length ? latestMessages.join('\n') : '会話ログなし',
    '',
    `【回答の返し方】`,
    '回答要点をこのチケットのエスカレーション欄へ記入してください。顧客への最終返信はフロント側で確認して送信します。',
  ].join('\n')
}

import type {
  SalesCustomer,
  SalesCustomerStatus,
  SalesCustomerStoredStatus,
} from './api'

export type SalesCustomerStatusMeta = {
  label: string
  actionLabel: string
  definition: string
  badgeClass: string
  dotClass: string
  panelClass: string
}

export const SALES_CUSTOMER_STATUS_META: Record<SalesCustomerStatus, SalesCustomerStatusMeta> = {
  unreviewed: {
    label: '確認前',
    actionLabel: '運営へ確認',
    definition: '運営側がまだ状況を判定していません。連絡前に運営へ確認します。',
    badgeClass: 'border-slate-200 bg-slate-100 text-slate-700',
    dotClass: 'bg-slate-400',
    panelClass: 'border-slate-200 bg-slate-50',
  },
  normal: {
    label: '通常運用',
    actionLabel: '通常対応可',
    definition: '現在、営業連絡を止める要因は確認されていません。',
    badgeClass: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    dotClass: 'bg-emerald-500',
    panelClass: 'border-emerald-200 bg-emerald-50/60',
  },
  attention: {
    label: '要注意',
    actionLabel: '運営確認後に連絡',
    definition: '不満や調整中の事項があり、連絡内容やタイミングの確認が必要です。',
    badgeClass: 'border-amber-200 bg-amber-50 text-amber-900',
    dotClass: 'bg-amber-500',
    panelClass: 'border-amber-200 bg-amber-50/70',
  },
  complaint: {
    label: 'クレーム対応中',
    actionLabel: '営業連絡を止める',
    definition: '契約・品質・対応などへの強い不満を運営が対応中です。',
    badgeClass: 'border-red-200 bg-red-50 text-red-800',
    dotClass: 'bg-red-500',
    panelClass: 'border-red-200 bg-red-50/70',
  },
  exit_pending: {
    label: '退会手続き中',
    actionLabel: '営業連絡を止める',
    definition: '退会・解約の申し出があり、確認や手続きを進めています。',
    badgeClass: 'border-rose-300 bg-rose-50 text-rose-900',
    dotClass: 'bg-rose-600',
    panelClass: 'border-rose-300 bg-rose-50/70',
  },
  exited: {
    label: '退会済み',
    actionLabel: '連絡対象外',
    definition: '退会・解約手続きが完了しています。',
    badgeClass: 'border-gray-300 bg-gray-100 text-gray-700',
    dotClass: 'bg-gray-500',
    panelClass: 'border-gray-300 bg-gray-50',
  },
}

export const SALES_CUSTOMER_STORED_STATUSES: SalesCustomerStoredStatus[] = [
  'normal',
  'attention',
  'complaint',
  'exit_pending',
  'exited',
]

export function salesCustomerName(customer: SalesCustomer): string {
  return customer.companyName || customer.contactName || customer.lineDisplayName || '名前未設定'
}

export function salesCustomerIdentity(customer: SalesCustomer): string {
  const values = [
    customer.companyName ? customer.contactName : null,
    customer.customerNumber ? `顧客番号 ${customer.customerNumber}` : null,
    customer.storeNames.length > 0 ? customer.storeNames.join(' / ') : null,
  ].filter((value): value is string => Boolean(value))
  return values.join(' · ')
}

export function salesCustomerSourceLabel(customer: SalesCustomer): string {
  if (customer.sourceKind === 'group') return 'グループLINE'
  if (customer.sourceKind === 'room') return 'ルームLINE'
  return '個別LINE'
}

export function formatSalesCustomerDate(value: string | null): string {
  if (!value) return '未更新'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('ja-JP', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

export function salesActionRequiredCount(counts: Record<SalesCustomerStatus, number>): number {
  return counts.unreviewed + counts.attention + counts.complaint + counts.exit_pending
}

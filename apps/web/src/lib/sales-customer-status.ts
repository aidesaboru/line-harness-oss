import type {
  SalesCustomer,
  SalesCustomerStatus,
} from './api'

export type SalesCustomerStatusMeta = {
  label: string
  definition: string
  badgeClass: string
  dotClass: string
  panelClass: string
}

export const SALES_CUSTOMER_STATUS_META: Record<SalesCustomerStatus, SalesCustomerStatusMeta> = {
  unreviewed: {
    label: '確認前',
    definition: '会話履歴がない、または根拠が足りずAIが安全に判定できない状態です。',
    badgeClass: 'border-slate-200 bg-slate-100 text-slate-700',
    dotClass: 'bg-slate-400',
    panelClass: 'border-slate-200 bg-slate-50',
  },
  normal: {
    label: '通常運用',
    definition: '未解決の問題がなく通常運用中、または以前の問題の解決・再開が明示されています。',
    badgeClass: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    dotClass: 'bg-emerald-500',
    panelClass: 'border-emerald-200 bg-emerald-50/60',
  },
  attention: {
    label: '要注意',
    definition: '苦情や退会には該当しませんが、遅延・懸念・未解決依頼・運用上のリスクが残っています。',
    badgeClass: 'border-amber-200 bg-amber-50 text-amber-900',
    dotClass: 'bg-amber-500',
    panelClass: 'border-amber-200 bg-amber-50/70',
  },
  complaint: {
    label: 'クレーム対応中',
    definition: '苦情・強い不満・誤請求・返金要求・サービス事故などが未解決または対応中です。',
    badgeClass: 'border-red-200 bg-red-50 text-red-800',
    dotClass: 'bg-red-500',
    panelClass: 'border-red-200 bg-red-50/70',
  },
  exit_pending: {
    label: '退会手続き中',
    definition: '退会・解約・利用停止の希望、申請、精算、返却などが進行中で、完了は明示されていません。',
    badgeClass: 'border-rose-300 bg-rose-50 text-rose-900',
    dotClass: 'bg-rose-600',
    panelClass: 'border-rose-300 bg-rose-50/70',
  },
  exited: {
    label: '退会済み',
    definition: '退会・解約・契約終了・アカウント閉鎖の完了が明示されています。後に再開・再契約が明示された場合だけ解除します。',
    badgeClass: 'border-gray-300 bg-gray-100 text-gray-700',
    dotClass: 'bg-gray-500',
    panelClass: 'border-gray-300 bg-gray-50',
  },
}

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

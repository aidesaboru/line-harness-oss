import { describe, expect, it } from 'vitest'
import type { SalesCustomer, SalesCustomerStatus } from './api'
import {
  SALES_CUSTOMER_STATUS_META,
  salesActionRequiredCount,
  salesCustomerIdentity,
  salesCustomerName,
  salesCustomerSourceLabel,
} from './sales-customer-status'

const customer: SalesCustomer = {
  subjectKind: 'friend',
  subjectId: 'friend-1',
  sourceKind: 'user',
  lineAccountId: 'account-1',
  lineAccountName: 'テスト',
  lineDisplayName: 'LINE名',
  customerNumber: 'C-001',
  companyName: '株式会社テスト',
  contactName: '田中様',
  storeNames: ['本店', '支店'],
  status: 'attention',
  summary: '連絡前に運営確認',
  version: 2,
  updatedByName: '運営担当',
  updatedAt: '2026-09-09T10:00:00+09:00',
  createdAt: '2026-09-01T10:00:00+09:00',
}

describe('sales customer status metadata', () => {
  it('gives every state a plain-language sales action and definition', () => {
    const statuses = Object.keys(SALES_CUSTOMER_STATUS_META) as SalesCustomerStatus[]
    expect(statuses).toEqual(['unreviewed', 'normal', 'attention', 'complaint', 'exit_pending', 'exited'])
    for (const status of statuses) {
      expect(SALES_CUSTOMER_STATUS_META[status].label).not.toBe('')
      expect(SALES_CUSTOMER_STATUS_META[status].actionLabel).not.toBe('')
      expect(SALES_CUSTOMER_STATUS_META[status].definition).not.toBe('')
    }
    expect(SALES_CUSTOMER_STATUS_META.complaint.actionLabel).toContain('止める')
    expect(SALES_CUSTOMER_STATUS_META.exit_pending.actionLabel).toContain('止める')
  })

  it('builds sales-safe identity labels without conversation content', () => {
    expect(salesCustomerName(customer)).toBe('株式会社テスト')
    expect(salesCustomerIdentity(customer)).toBe('田中様 · 顧客番号 C-001 · 本店 / 支店')
    expect(salesCustomerSourceLabel(customer)).toBe('個別LINE')
    expect(salesCustomerSourceLabel({ ...customer, sourceKind: 'group' })).toBe('グループLINE')
  })

  it('counts only unresolved or unreviewed states as requiring confirmation', () => {
    expect(salesActionRequiredCount({
      unreviewed: 3,
      normal: 10,
      attention: 2,
      complaint: 1,
      exit_pending: 4,
      exited: 5,
    })).toBe(10)
  })
})

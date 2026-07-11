import { describe, expect, it } from 'vitest'
import {
  customerBroadcastExclusionPatch,
  customerProfileFormFromMetadata,
  customerProfileFromMetadata,
  customerProfileMetadataPatch,
  isCustomerBroadcastExcluded,
  isCustomerProfileMetadataKey,
} from './customer-profile'

describe('customer profile', () => {
  it('builds an operator-friendly customer card from canonical metadata', () => {
    const profile = customerProfileFromMetadata({
      customerNumber: ' C-001 ',
      companyName: '株式会社テスト',
      contactName: '山田さん',
      storeName: '渋谷店',
      handoverDate: '2026-07-01',
      contractType: '運用代行',
      closingMonth: '3月',
      minimumGuarantee: 300000,
      googleFolderUrl: 'https://drive.google.com/drive/folders/example',
      stores: ['渋谷店', '新宿店'],
    })

    expect(profile.completionLabel).toBe('4/4')
    expect(profile.missingRequiredFields).toHaveLength(0)
    expect(profile.displayName).toBe('C-001_山田さん')
    expect(profile.primaryLine).toBe('株式会社テスト / 渋谷店')
    expect(profile.secondaryLine).toBe('C-001 / 山田さん')
    expect(profile.fields.find((field) => field.key === 'contactName')?.label).toBe('顧客名')
    expect(profile.fields.find((field) => field.key === 'closingMonth')?.value).toBe('3月')
    expect(profile.fields.find((field) => field.key === 'minimumGuarantee')?.label).toBe('最低保証開始月')
    expect(profile.fields.find((field) => field.key === 'googleFolderUrl')?.value).toBe('https://drive.google.com/drive/folders/example')
    expect(profile.fields.find((field) => field.key === 'stores')?.value).toBe('渋谷店、新宿店')
    expect(profile.broadcastExcluded).toBe(false)
  })

  it('accepts legacy snake_case aliases and reports missing required fields', () => {
    const profile = customerProfileFromMetadata({
      customer_number: 'C-002',
      company_name: '合同会社サンプル',
    })

    expect(profile.completionLabel).toBe('2/4')
    expect(profile.missingRequiredFields.map((field) => field.key)).toEqual(['contactName', 'storeName'])
    expect(profile.displayName).toBeNull()
    expect(profile.primaryLine).toBe('合同会社サンプル')
    expect(profile.secondaryLine).toBe('C-002')
  })

  it('creates a safe metadata patch with canonical keys only', () => {
    const form = customerProfileFormFromMetadata({
      customer_number: ' C-003 ',
      company_name: '株式会社フォーム',
      contact_name: '佐藤',
      store_name: '名古屋店',
      決算月: '5月',
      最低保証開始月: '2026年7月',
      GoogleフォルダURL: 'https://drive.google.com/drive/folders/sample',
    })

    expect(customerProfileMetadataPatch(form)).toMatchObject({
      customerNumber: 'C-003',
      companyName: '株式会社フォーム',
      contactName: '佐藤',
      storeName: '名古屋店',
      handoverDate: '',
      contractType: '',
      closingMonth: '5月',
      minimumGuarantee: '2026年7月',
      googleFolderUrl: 'https://drive.google.com/drive/folders/sample',
      stores: '',
    })
  })

  it('identifies keys that should not be duplicated in extra metadata', () => {
    expect(isCustomerProfileMetadataKey('customer_number')).toBe(true)
    expect(isCustomerProfileMetadataKey('customerNumber')).toBe(true)
    expect(isCustomerProfileMetadataKey('broadcastExcluded')).toBe(true)
    expect(isCustomerProfileMetadataKey('favoriteColor')).toBe(false)
  })

  it('reads and writes broadcast exclusion metadata', () => {
    expect(isCustomerBroadcastExcluded({ broadcastExcluded: true })).toBe(true)
    expect(isCustomerBroadcastExcluded({ do_not_broadcast: 'true' })).toBe(true)
    expect(isCustomerBroadcastExcluded({ broadcastExcluded: false })).toBe(false)
    expect(customerProfileFromMetadata({ sendPaused: '1' }).broadcastExcluded).toBe(true)
    expect(customerBroadcastExclusionPatch(true)).toEqual({ broadcastExcluded: true })
  })
})

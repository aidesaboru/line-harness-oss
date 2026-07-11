import { describe, expect, it } from 'vitest'
import { parseCustomerProfileBulkText } from './customer-profile-bulk'

describe('customer profile bulk parser', () => {
  it('parses comma-separated customer profile rows', () => {
    const parsed = parseCustomerProfileBulkText([
      'friendId,customerNumber,companyName,contactName,storeName',
      'friend-1,C-001,株式会社テスト,山田,渋谷店',
    ].join('\n'))

    expect(parsed.issues).toEqual([])
    expect(parsed.rows).toEqual([
      {
        friendId: 'friend-1',
        metadata: {
          customerNumber: 'C-001',
          companyName: '株式会社テスト',
          contactName: '山田',
          storeName: '渋谷店',
        },
      },
    ])
  })

  it('parses tab-separated rows and legacy snake_case headers', () => {
    const parsed = parseCustomerProfileBulkText([
      'line_user_id\tcustomer_number\tcompany_name\tstore_name',
      'U123\tC-002\t合同会社サンプル\t新宿店',
    ].join('\n'))

    expect(parsed.issues).toEqual([])
    expect(parsed.rows[0]).toMatchObject({
      lineUserId: 'U123',
      metadata: {
        customerNumber: 'C-002',
        companyName: '合同会社サンプル',
        storeName: '新宿店',
      },
    })
    expect(parsed.rows[0].metadata.contactName).toBeUndefined()
  })

  it('parses new customer memo columns from Japanese headers', () => {
    const parsed = parseCustomerProfileBulkText([
      'friendId,決算月,最低保証開始月,GoogleフォルダURL',
      'friend-1,3月,2026年7月,https://drive.google.com/drive/folders/sample',
    ].join('\n'))

    expect(parsed.issues).toEqual([])
    expect(parsed.rows[0]).toMatchObject({
      friendId: 'friend-1',
      metadata: {
        closingMonth: '3月',
        minimumGuarantee: '2026年7月',
        googleFolderUrl: 'https://drive.google.com/drive/folders/sample',
      },
    })
  })

  it('parses broadcast exclusion columns for bulk opt-out updates', () => {
    const parsed = parseCustomerProfileBulkText([
      'friendId,companyName,一斉送信除外',
      'friend-1,株式会社テスト,除外',
      'friend-2,合同会社サンプル,解除',
    ].join('\n'))

    expect(parsed.issues).toEqual([])
    expect(parsed.rows).toEqual([
      {
        friendId: 'friend-1',
        metadata: {
          companyName: '株式会社テスト',
          broadcastExcluded: true,
        },
      },
      {
        friendId: 'friend-2',
        metadata: {
          companyName: '合同会社サンプル',
          broadcastExcluded: false,
        },
      },
    ])
  })

  it('reports invalid broadcast exclusion values', () => {
    const parsed = parseCustomerProfileBulkText([
      'friendId,broadcastExcluded',
      'friend-1,たぶん',
    ].join('\n'))

    expect(parsed.rows).toEqual([])
    expect(parsed.issues).toEqual([
      '2行目: 一斉送信除外は true/false、除外/解除 などで入力してください。',
    ])
  })

  it('reports rows without identifiers or profile values', () => {
    const parsed = parseCustomerProfileBulkText([
      'friendId,customerNumber,companyName',
      ',C-003,株式会社IDなし',
      'friend-2,,',
    ].join('\n'))

    expect(parsed.rows).toEqual([])
    expect(parsed.issues).toEqual([
      '2行目: friendId か lineUserId を入れてください。',
      '3行目: 更新する顧客情報がありません。',
    ])
  })
})

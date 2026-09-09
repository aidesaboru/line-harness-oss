import { describe, expect, it } from 'vitest'
import {
  buildStaffCreatePayload,
  staffAccessSelection,
  staffAccessUpdatePayload,
  staffOperationFailureMessage,
} from './staff-form'

describe('staff create form', () => {
  it('trims the staff name and email before sending to the API', () => {
    expect(buildStaffCreatePayload({
      name: '  田島  ',
      email: '  tajima@example.com  ',
      role: 'staff',
    })).toEqual({
      ok: true,
      payload: {
        name: '田島',
        email: 'tajima@example.com',
        role: 'staff',
        secondaryCanRespond: false,
        salesOnly: false,
      },
    })
  })

  it('omits blank optional email values', () => {
    expect(buildStaffCreatePayload({
      name: '管理者',
      email: '   ',
      role: 'secondary_viewer',
    })).toEqual({
      ok: true,
      payload: {
        name: '管理者',
        role: 'secondary',
        secondaryCanRespond: false,
        salesOnly: false,
      },
    })
  })

  it('blocks blank staff names before the API request', () => {
    expect(buildStaffCreatePayload({
      name: '   ',
      email: 'staff@example.com',
      role: 'staff',
    })).toEqual({
      ok: false,
      error: 'スタッフ名を入力してください',
    })
  })
})

describe('staff access selection', () => {
  it('separates secondary viewer and responder without adding a new DB role', () => {
    expect(staffAccessUpdatePayload('secondary_viewer')).toEqual({
      role: 'secondary',
      secondaryCanRespond: false,
      salesOnly: false,
    })
    expect(staffAccessUpdatePayload('secondary_responder')).toEqual({
      role: 'secondary',
      secondaryCanRespond: true,
      salesOnly: false,
    })
    expect(staffAccessSelection('secondary', true)).toBe('secondary_responder')
    expect(staffAccessSelection('secondary', false)).toBe('secondary_viewer')
  })

  it('maps the sales viewer to a restricted staff permission flag', () => {
    expect(staffAccessUpdatePayload('sales_viewer')).toEqual({
      role: 'staff',
      secondaryCanRespond: false,
      salesOnly: true,
    })
    expect(staffAccessSelection('staff', false, true)).toBe('sales_viewer')
    expect(staffAccessSelection('staff', false, false)).toBe('staff')
  })
})

describe('staff operation failure messages', () => {
  it('uses stable user-facing messages instead of API error details', () => {
    expect(staffOperationFailureMessage('load')).toBe('スタッフの読み込みに失敗しました。もう一度お試しください。')
    expect(staffOperationFailureMessage('create')).toBe('スタッフの作成に失敗しました。入力内容を確認して、もう一度お試しください。')
    expect(staffOperationFailureMessage('update')).toBe('スタッフ情報の更新に失敗しました。もう一度お試しください。')
    expect(staffOperationFailureMessage('regenerate-key')).toBe('APIキーの再生成に失敗しました。もう一度お試しください。')
    expect(staffOperationFailureMessage('delete')).toBe('スタッフの削除に失敗しました。もう一度お試しください。')
  })
})

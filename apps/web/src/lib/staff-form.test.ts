import { describe, expect, it } from 'vitest'
import { buildStaffCreatePayload, staffOperationFailureMessage } from './staff-form'

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
      },
    })
  })

  it('omits blank optional email values', () => {
    expect(buildStaffCreatePayload({
      name: '管理者',
      email: '   ',
      role: 'admin',
    })).toEqual({
      ok: true,
      payload: {
        name: '管理者',
        role: 'admin',
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

describe('staff operation failure messages', () => {
  it('uses stable user-facing messages instead of API error details', () => {
    expect(staffOperationFailureMessage('load')).toBe('スタッフの読み込みに失敗しました。もう一度お試しください。')
    expect(staffOperationFailureMessage('create')).toBe('スタッフの作成に失敗しました。入力内容を確認して、もう一度お試しください。')
    expect(staffOperationFailureMessage('update')).toBe('スタッフ情報の更新に失敗しました。もう一度お試しください。')
    expect(staffOperationFailureMessage('regenerate-key')).toBe('APIキーの再生成に失敗しました。もう一度お試しください。')
    expect(staffOperationFailureMessage('delete')).toBe('スタッフの削除に失敗しました。もう一度お試しください。')
  })
})

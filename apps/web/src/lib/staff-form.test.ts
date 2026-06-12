import { describe, expect, it } from 'vitest'
import { buildStaffCreatePayload } from './staff-form'

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

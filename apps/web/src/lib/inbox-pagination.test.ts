import { describe, expect, it } from 'vitest'
import {
  buildUnansweredInboxListOptions,
  getInboxTotalPages,
  INBOX_OVERDUE_WAIT_MINUTES,
} from './inbox-pagination'

describe('inbox pagination helpers', () => {
  it('builds server-side unanswered inbox query options', () => {
    expect(buildUnansweredInboxListOptions({
      q: '  田島  ',
      account: 'acc-1',
      overdueOnly: true,
      page: 3,
      pageSize: 50,
    })).toEqual({
      q: '田島',
      account: 'acc-1',
      minWaitMinutes: INBOX_OVERDUE_WAIT_MINUTES,
      page: 3,
      pageSize: 50,
    })
  })

  it('omits empty filters and clamps invalid paging values', () => {
    expect(buildUnansweredInboxListOptions({
      q: '   ',
      account: '',
      overdueOnly: false,
      page: -2,
      pageSize: 0,
    })).toEqual({
      page: 1,
      pageSize: 1,
    })
  })

  it('calculates total pages without allowing page zero', () => {
    expect(getInboxTotalPages(0, 50)).toBe(1)
    expect(getInboxTotalPages(51, 50)).toBe(2)
    expect(getInboxTotalPages(-1, 0)).toBe(1)
  })
})

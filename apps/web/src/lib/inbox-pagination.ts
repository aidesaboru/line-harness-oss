export const INBOX_OVERDUE_WAIT_MINUTES = 60

export type UnansweredInboxListOptions = {
  q?: string
  account?: string
  minWaitMinutes?: number
  page: number
  pageSize: number
}

export function getInboxTotalPages(total: number, pageSize: number): number {
  const safeTotal = Math.max(0, total)
  const safePageSize = Math.max(1, pageSize)
  return Math.max(1, Math.ceil(safeTotal / safePageSize))
}

export function buildUnansweredInboxListOptions(input: {
  q: string
  account: string
  overdueOnly: boolean
  page: number
  pageSize: number
}): UnansweredInboxListOptions {
  const q = input.q.trim()
  return {
    ...(q ? { q } : {}),
    ...(input.account ? { account: input.account } : {}),
    ...(input.overdueOnly ? { minWaitMinutes: INBOX_OVERDUE_WAIT_MINUTES } : {}),
    page: Math.max(1, input.page),
    pageSize: Math.max(1, input.pageSize),
  }
}

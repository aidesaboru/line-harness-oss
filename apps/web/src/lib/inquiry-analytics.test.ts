import { describe, expect, it } from 'vitest'
import { formatInquiryTrendPeriod, niceInquiryTrendMaximum } from './inquiry-analytics'

describe('inquiry analytics presentation helpers', () => {
  it('formats daily, weekly, and monthly periods in Japanese', () => {
    expect(formatInquiryTrendPeriod('2026-09-12', 'day')).toBe('2026年9月12日')
    expect(formatInquiryTrendPeriod('2026-09-07', 'week', true)).toBe('9/7週')
    expect(formatInquiryTrendPeriod('2026-09', 'month')).toBe('2026年9月')
  })

  it('creates a readable four-step y-axis ceiling', () => {
    expect(niceInquiryTrendMaximum(43)).toBe(80)
    expect(niceInquiryTrendMaximum(8)).toBe(8)
    expect(niceInquiryTrendMaximum(0)).toBe(4)
  })
})

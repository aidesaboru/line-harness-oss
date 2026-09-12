import { describe, expect, it } from 'vitest'
import {
  createInquiryTrendScale,
  formatInquiryTrendAverage,
  formatInquiryTrendPeriod,
  selectRecentInquiryTrends,
} from './inquiry-analytics'

describe('inquiry analytics presentation helpers', () => {
  it('formats daily, weekly, and monthly periods in Japanese', () => {
    expect(formatInquiryTrendPeriod('2026-09-12', 'day')).toBe('2026年9月12日')
    expect(formatInquiryTrendPeriod('2026-09-07', 'week', true)).toBe('9/7週')
    expect(formatInquiryTrendPeriod('2026-09', 'month')).toBe('2026年9月')
  })

  it('creates a compact readable y-axis without excessive headroom', () => {
    expect(createInquiryTrendScale(43)).toEqual({ maximum: 50, ticks: [0, 10, 20, 30, 40, 50] })
    expect(createInquiryTrendScale(298)).toEqual({ maximum: 300, ticks: [0, 50, 100, 150, 200, 250, 300] })
    expect(createInquiryTrendScale(8)).toEqual({ maximum: 8, ticks: [0, 2, 4, 6, 8] })
    expect(createInquiryTrendScale(0)).toEqual({ maximum: 4, ticks: [0, 1, 2, 3, 4] })
  })

  it('keeps a readable recent window for each granularity', () => {
    const values = Array.from({ length: 40 }, (_, index) => index + 1)
    expect(selectRecentInquiryTrends(values, 'day')).toEqual(values.slice(-14))
    expect(selectRecentInquiryTrends(values, 'week')).toEqual(values.slice(-12))
    expect(selectRecentInquiryTrends(values, 'month')).toEqual(values.slice(-12))
  })

  it('keeps small averages visible instead of rounding them to zero', () => {
    expect(formatInquiryTrendAverage(0.25)).toBe('0.3')
    expect(formatInquiryTrendAverage(2)).toBe('2')
    expect(formatInquiryTrendAverage(12.6)).toBe('13')
  })
})

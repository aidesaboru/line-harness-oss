export type InquiryTrendGranularity = 'day' | 'week' | 'month'

export const INQUIRY_TREND_GRANULARITY_LABELS: Record<InquiryTrendGranularity, string> = {
  day: '日次',
  week: '週次',
  month: '月次',
}

export const INQUIRY_TREND_RECENT_PERIODS: Record<InquiryTrendGranularity, number> = {
  day: 14,
  week: 12,
  month: 12,
}

export const INQUIRY_TREND_RECENT_LABELS: Record<InquiryTrendGranularity, string> = {
  day: '直近14日',
  week: '直近12週',
  month: '直近12か月',
}

export function formatInquiryTrendPeriod(
  period: string,
  granularity: InquiryTrendGranularity,
  compact = false,
): string {
  const [year = '', month = '', day = ''] = period.split('-')
  const numericMonth = Number.parseInt(month, 10)
  const numericDay = Number.parseInt(day, 10)
  if (!year || !Number.isFinite(numericMonth)) return period
  if (granularity === 'month') return compact ? `${year.slice(2)}/${numericMonth}` : `${year}年${numericMonth}月`
  if (!Number.isFinite(numericDay)) return period
  if (granularity === 'week') return compact ? `${numericMonth}/${numericDay}週` : `${year}年${numericMonth}月${numericDay}日週`
  return compact ? `${numericMonth}/${numericDay}` : `${year}年${numericMonth}月${numericDay}日`
}

export function selectRecentInquiryTrends<T>(
  trends: readonly T[],
  granularity: InquiryTrendGranularity,
): T[] {
  return trends.slice(-INQUIRY_TREND_RECENT_PERIODS[granularity])
}

export interface InquiryTrendScale {
  maximum: number
  ticks: number[]
}

export function createInquiryTrendScale(value: number): InquiryTrendScale {
  if (!Number.isFinite(value) || value <= 4) {
    return { maximum: 4, ticks: [0, 1, 2, 3, 4] }
  }

  const magnitude = 10 ** Math.floor(Math.log10(value))
  const steps = [0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10].map((step) => step * magnitude)
  const step = steps.find((candidate) => {
    const maximum = Math.ceil(value / candidate) * candidate
    const tickCount = Math.round(maximum / candidate)
    return tickCount >= 4 && tickCount <= 7
  }) ?? magnitude
  const maximum = Math.ceil(value / step) * step
  const tickCount = Math.round(maximum / step)

  return {
    maximum,
    ticks: Array.from({ length: tickCount + 1 }, (_, index) => Number((index * step).toFixed(8))),
  }
}

export function formatInquiryTrendAverage(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return new Intl.NumberFormat('ja-JP', {
    minimumFractionDigits: value > 0 && value < 10 && !Number.isInteger(value) ? 1 : 0,
    maximumFractionDigits: value < 10 ? 1 : 0,
  }).format(value < 10 ? value : Math.round(value))
}

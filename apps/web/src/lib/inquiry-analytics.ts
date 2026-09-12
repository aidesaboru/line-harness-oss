export type InquiryTrendGranularity = 'day' | 'week' | 'month'

export const INQUIRY_TREND_GRANULARITY_LABELS: Record<InquiryTrendGranularity, string> = {
  day: '日次',
  week: '週次',
  month: '月次',
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

export function niceInquiryTrendMaximum(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 4
  const roughStep = value / 4
  const magnitude = 10 ** Math.floor(Math.log10(roughStep))
  const residual = roughStep / magnitude
  const niceResidual = residual <= 1 ? 1 : residual <= 2 ? 2 : residual <= 5 ? 5 : 10
  return niceResidual * magnitude * 4
}

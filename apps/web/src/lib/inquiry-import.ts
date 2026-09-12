export type HistoricalInquiryImportCase = {
  sourceRef: string
  customerNumber: string | null
  openedAt: string
  lastActivityAt: string
  primaryCategory: string
  labels: string[]
  inquirySummary: string
  resolutionSummary: string | null
  resolutionStatus: 'open' | 'answered' | 'resolved' | 'unknown'
  confidence: number
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value))
}

function parseCase(value: unknown, lineNumber: number): HistoricalInquiryImportCase {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${lineNumber}行目の形式が不正です`)
  }
  const item = value as Record<string, unknown>
  if (typeof item.sourceRef !== 'string' || !item.sourceRef || item.sourceRef.length > 128) {
    throw new Error(`${lineNumber}行目の参照IDが不正です`)
  }
  if (!isTimestamp(item.openedAt) || !isTimestamp(item.lastActivityAt)) {
    throw new Error(`${lineNumber}行目の日時が不正です`)
  }
  if (typeof item.primaryCategory !== 'string' || !item.primaryCategory.trim()) {
    throw new Error(`${lineNumber}行目の分類が不正です`)
  }
  if (!Array.isArray(item.labels) || item.labels.some((label) => typeof label !== 'string')) {
    throw new Error(`${lineNumber}行目の補助分類が不正です`)
  }
  if (typeof item.inquirySummary !== 'string' || !item.inquirySummary.trim() || item.inquirySummary.length > 500) {
    throw new Error(`${lineNumber}行目の問い合わせ概要が不正です`)
  }
  if (item.resolutionSummary !== null && item.resolutionSummary !== undefined && typeof item.resolutionSummary !== 'string') {
    throw new Error(`${lineNumber}行目の解決内容が不正です`)
  }
  if (!['open', 'answered', 'resolved', 'unknown'].includes(String(item.resolutionStatus))) {
    throw new Error(`${lineNumber}行目の解決状況が不正です`)
  }
  if (typeof item.confidence !== 'number' || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) {
    throw new Error(`${lineNumber}行目の確信度が不正です`)
  }

  return {
    sourceRef: item.sourceRef,
    customerNumber: typeof item.customerNumber === 'string' ? item.customerNumber : null,
    openedAt: item.openedAt,
    lastActivityAt: item.lastActivityAt,
    primaryCategory: item.primaryCategory,
    labels: item.labels as string[],
    inquirySummary: item.inquirySummary,
    resolutionSummary: typeof item.resolutionSummary === 'string' ? item.resolutionSummary : null,
    resolutionStatus: item.resolutionStatus as HistoricalInquiryImportCase['resolutionStatus'],
    confidence: item.confidence,
  }
}

export function parseInquiryImportJsonl(text: string, maxCases = 100_000): HistoricalInquiryImportCase[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim())
  if (lines.length === 0) throw new Error('投入データが空です')
  if (lines.length > maxCases) throw new Error(`一度に投入できる上限は${maxCases.toLocaleString('ja-JP')}件です`)

  return lines.map((line, index) => {
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      throw new Error(`${index + 1}行目をJSONとして読み取れません`)
    }
    return parseCase(value, index + 1)
  })
}

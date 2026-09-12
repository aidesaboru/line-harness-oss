import { describe, expect, it } from 'vitest'
import { parseInquiryImportJsonl } from './inquiry-import'

const valid = {
  sourceRef: 'csv:customer-1:episode-1',
  customerNumber: '1001',
  openedAt: '2026-09-01T00:00:00.000Z',
  lastActivityAt: '2026-09-01T01:00:00.000Z',
  primaryCategory: '税務・確定申告',
  labels: ['税務・確定申告'],
  inquirySummary: '申告方法について問い合わせ',
  resolutionSummary: '必要書類を案内',
  resolutionStatus: 'resolved',
  confidence: 0.9,
}

describe('parseInquiryImportJsonl', () => {
  it('parses newline-delimited inquiry cases without changing identifiers', () => {
    const result = parseInquiryImportJsonl(`${JSON.stringify(valid)}\n`)
    expect(result).toEqual([valid])
  })

  it('rejects malformed and over-limit input before any request is sent', () => {
    expect(() => parseInquiryImportJsonl('{bad')).toThrow('1行目')
    expect(() => parseInquiryImportJsonl(`${JSON.stringify(valid)}\n${JSON.stringify(valid)}`, 1)).toThrow('上限')
  })
})

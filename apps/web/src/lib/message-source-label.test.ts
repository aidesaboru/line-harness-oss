import { describe, expect, it } from 'vitest'
import { messageSourceLabel } from './message-source-label'

describe('message source label', () => {
  it('labels outgoing message sources without exposing raw values', () => {
    expect(messageSourceLabel('line_official')).toBe('LINE公式')
    expect(messageSourceLabel('broadcast')).toBe('一斉送信')
    expect(messageSourceLabel('auto_reply')).toBe('自動返信')
    expect(messageSourceLabel('internal_secret_source')).toBe('')
  })
})

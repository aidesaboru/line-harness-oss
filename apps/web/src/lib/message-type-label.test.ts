import { describe, expect, it } from 'vitest'
import { messageTypeLabel, messageTypePreview, textOrMessageTypePreview } from './message-type-label'

describe('message type labels', () => {
  it('formats known non-text message types for operators', () => {
    expect(messageTypeLabel('image')).toBe('画像')
    expect(messageTypePreview('flex')).toBe('【Flexメッセージ】')
  })

  it('does not expose unknown raw message type values', () => {
    expect(messageTypeLabel('internal_vendor_payload')).toBe('その他のメッセージ')
    expect(messageTypePreview('internal_vendor_payload')).toBe('【その他のメッセージ】')
  })

  it('keeps text content and truncates long previews', () => {
    expect(textOrMessageTypePreview('text', 'hello', 10)).toBe('hello')
    expect(textOrMessageTypePreview('text', '12345678901', 10)).toBe('1234567890…')
    expect(textOrMessageTypePreview('image', '{...}', 10)).toBe('【画像】')
  })
})

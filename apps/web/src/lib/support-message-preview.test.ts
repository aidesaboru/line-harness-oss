import { describe, expect, it } from 'vitest'
import { parseSupportMessagePreview } from './support-message-preview'

describe('support message preview', () => {
  it('keeps text messages as-is', () => {
    expect(parseSupportMessagePreview('text', '確認します')).toEqual({
      kind: 'text',
      text: '確認します',
    })
  })

  it('extracts stored image urls from LINE image JSON', () => {
    expect(parseSupportMessagePreview('image', JSON.stringify({
      originalContentUrl: 'https://worker.example.com/images/original.jpg',
      previewImageUrl: 'https://worker.example.com/images/preview.jpg',
    }))).toEqual({
      kind: 'image',
      originalUrl: 'https://worker.example.com/images/original.jpg',
      previewUrl: 'https://worker.example.com/images/preview.jpg',
    })
  })

  it('shows a safe file card when a file has a downloadable url', () => {
    expect(parseSupportMessagePreview('file', JSON.stringify({
      fileName: '請求書.pdf',
      contentUrl: 'https://worker.example.com/files/invoice.pdf',
    }))).toEqual({
      kind: 'file',
      label: '請求書.pdf',
      url: 'https://worker.example.com/files/invoice.pdf',
      isPdf: true,
    })
  })

  it('does not expose unsafe urls or unknown message type values', () => {
    expect(parseSupportMessagePreview('file', JSON.stringify({
      fileName: '危険.txt',
      contentUrl: 'javascript:alert(1)',
    }))).toEqual({
      kind: 'file',
      label: '危険.txt',
      url: null,
      isPdf: false,
    })
    expect(parseSupportMessagePreview('vendor_secret', 'payload')).toEqual({
      kind: 'other',
      label: '【その他のメッセージ】',
    })
  })
})

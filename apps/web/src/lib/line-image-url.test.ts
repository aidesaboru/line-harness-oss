import { describe, expect, it } from 'vitest'
import { normalizeLineImageUrls } from './line-image-url'

describe('normalizeLineImageUrls', () => {
  it('builds a LINE image payload and defaults preview to original', () => {
    expect(normalizeLineImageUrls('  https://cdn.example.com/original.png  ')).toEqual({
      ok: true,
      value: {
        mode: 'line-image',
        originalContentUrl: 'https://cdn.example.com/original.png',
        previewImageUrl: 'https://cdn.example.com/original.png',
      },
    })
  })

  it('keeps a separate HTTPS preview URL', () => {
    expect(normalizeLineImageUrls(
      'https://cdn.example.com/original.jpg',
      ' https://cdn.example.com/preview.jpg ',
    )).toEqual({
      ok: true,
      value: {
        mode: 'line-image',
        originalContentUrl: 'https://cdn.example.com/original.jpg',
        previewImageUrl: 'https://cdn.example.com/preview.jpg',
      },
    })
  })

  it('rejects blank or non-HTTPS URLs before the chat send API rejects them', () => {
    expect(normalizeLineImageUrls('')).toEqual({
      ok: false,
      error: '元画像URLを入力してください',
    })
    expect(normalizeLineImageUrls('http://cdn.example.com/original.jpg')).toEqual({
      ok: false,
      error: 'LINE送信用の画像URLはHTTPSで入力してください',
    })
    expect(normalizeLineImageUrls(
      'https://cdn.example.com/original.jpg',
      'http://cdn.example.com/preview.jpg',
    )).toEqual({
      ok: false,
      error: 'LINE送信用の画像URLはHTTPSで入力してください',
    })
  })
})

export type LineImageUrlValue = {
  mode: 'line-image'
  originalContentUrl: string
  previewImageUrl: string
}

export type LineImageUrlResult =
  | { ok: true; value: LineImageUrlValue }
  | { ok: false; error: string }

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

export function normalizeLineImageUrls(
  originalContentUrl: string,
  previewImageUrl?: string | null,
): LineImageUrlResult {
  const original = originalContentUrl.trim()
  const preview = (previewImageUrl ?? '').trim() || original

  if (!original) {
    return { ok: false, error: '元画像URLを入力してください' }
  }
  if (!isHttpsUrl(original) || !isHttpsUrl(preview)) {
    return { ok: false, error: 'LINE送信用の画像URLはHTTPSで入力してください' }
  }

  return {
    ok: true,
    value: {
      mode: 'line-image',
      originalContentUrl: original,
      previewImageUrl: preview,
    },
  }
}

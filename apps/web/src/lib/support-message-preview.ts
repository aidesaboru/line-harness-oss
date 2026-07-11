import { messageTypePreview } from './message-type-label'

export type SupportMessagePreview =
  | { kind: 'text'; text: string }
  | { kind: 'image'; previewUrl: string; originalUrl: string }
  | { kind: 'file'; label: string; url: string | null; isPdf: boolean }
  | { kind: 'other'; label: string }

function parseRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function safeHttpUrl(value: unknown): string | null {
  const raw = asText(value)
  if (!raw) return null
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' || url.protocol === 'http:' ? raw : null
  } catch {
    return null
  }
}

function fileLabelFromContent(content: string): string {
  const match = content.match(/^\[ファイル(?::\s*(.+?))?\]$/)
  return match?.[1]?.trim() || 'ファイル'
}

function isPdfLabel(label: string, url: string | null): boolean {
  return /\.pdf(?:$|[?#])/i.test(label) || Boolean(url && /\.pdf(?:$|[?#])/i.test(url))
}

export function parseSupportMessagePreview(
  messageType: string | null | undefined,
  content: string | null | undefined,
): SupportMessagePreview {
  const type = messageType || ''
  const body = content ?? ''

  if (type === 'text') {
    return { kind: 'text', text: body }
  }

  if (type === 'image') {
    const parsed = parseRecord(body)
    const originalUrl = safeHttpUrl(parsed?.originalContentUrl) ?? safeHttpUrl(parsed?.original_content_url)
    const previewUrl = safeHttpUrl(parsed?.previewImageUrl) ?? safeHttpUrl(parsed?.preview_image_url) ?? originalUrl
    if (originalUrl && previewUrl) {
      return { kind: 'image', originalUrl, previewUrl }
    }
    return { kind: 'other', label: messageTypePreview(type) }
  }

  if (type === 'file') {
    const parsed = parseRecord(body)
    const label =
      asText(parsed?.fileName) ||
      asText(parsed?.filename) ||
      asText(parsed?.name) ||
      fileLabelFromContent(body)
    const url =
      safeHttpUrl(parsed?.url) ||
      safeHttpUrl(parsed?.contentUrl) ||
      safeHttpUrl(parsed?.content_url) ||
      safeHttpUrl(parsed?.originalContentUrl) ||
      null
    return { kind: 'file', label, url, isPdf: isPdfLabel(label, url) }
  }

  return { kind: 'other', label: messageTypePreview(type) }
}

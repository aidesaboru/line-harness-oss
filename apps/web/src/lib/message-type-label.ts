const MESSAGE_TYPE_LABELS: Record<string, string> = {
  text: 'テキスト',
  image: '画像',
  flex: 'Flexメッセージ',
  sticker: 'スタンプ',
  video: '動画',
  audio: '音声',
  file: 'ファイル',
  location: '位置情報',
}

export function messageTypeLabel(type: string | null | undefined): string {
  if (!type) return 'メッセージ'
  return MESSAGE_TYPE_LABELS[type] ?? 'その他のメッセージ'
}

export function messageTypePreview(type: string | null | undefined): string {
  return `【${messageTypeLabel(type)}】`
}

export function textOrMessageTypePreview(
  type: string | null | undefined,
  content: string | null | undefined,
  limit = 80,
): string {
  if (type === 'text') {
    const text = content ?? ''
    return text.length > limit ? `${text.slice(0, limit)}…` : text
  }
  return messageTypePreview(type)
}

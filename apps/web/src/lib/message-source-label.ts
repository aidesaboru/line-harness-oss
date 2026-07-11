const MESSAGE_SOURCE_LABELS: Record<string, string> = {
  line_official: 'LINE公式',
  broadcast: '一斉送信',
  scenario: 'シナリオ配信',
  automation: '自動化',
  auto_reply: '自動返信',
  manual: '手動送信',
}

export function messageSourceLabel(source: string | null | undefined): string {
  if (!source) return ''
  return MESSAGE_SOURCE_LABELS[source] ?? ''
}

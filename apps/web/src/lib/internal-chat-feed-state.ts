export type InternalChatDegradedFeature = 'mentions' | 'readStatus' | 'bookmarks' | 'taskCounts'

export type InternalChatLoadIssue = {
  title: string
  detail: string
}

export function describeInternalChatLoadFailure(options: {
  online: boolean
  apiError?: string
}): InternalChatLoadIssue {
  if (!options.online) {
    return {
      title: 'インターネットに接続できません',
      detail: '接続を確認してから再読み込みしてください',
    }
  }
  const normalized = options.apiError?.trim().toLowerCase() ?? ''
  if (normalized.includes('timeout') || normalized.includes('network')) {
    return {
      title: '通信が一時的に不安定です',
      detail: '少し時間をおいてから再読み込みしてください',
    }
  }
  return {
    title: '社内チャットを取得できませんでした',
    detail: 'メッセージや履歴は削除されていませんので再読み込みしてください',
  }
}

export function describeInternalChatDegradedFeatures(
  features: InternalChatDegradedFeature[],
): string {
  const labels: Record<InternalChatDegradedFeature, string> = {
    mentions: 'メンション',
    readStatus: '既読状態',
    bookmarks: 'ブックマーク',
    taskCounts: 'タスク件数',
  }
  const uniqueLabels = [...new Set(features)].map((feature) => labels[feature])
  return uniqueLabels.length > 0
    ? `${uniqueLabels.join('・')}を一時的に表示できません`
    : ''
}

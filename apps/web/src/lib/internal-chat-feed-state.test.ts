import { describe, expect, test } from 'vitest'
import {
  describeInternalChatDegradedFeatures,
  describeInternalChatLoadFailure,
} from './internal-chat-feed-state'

describe('internal chat feed state', () => {
  test('explains an offline failure with a direct recovery action', () => {
    expect(describeInternalChatLoadFailure({ online: false })).toEqual({
      title: 'インターネットに接続できません',
      detail: '接続を確認してから再読み込みしてください',
    })
  })

  test('does not imply that stored messages were deleted on a server failure', () => {
    const issue = describeInternalChatLoadFailure({
      online: true,
      apiError: 'Internal server error',
    })

    expect(issue.title).toBe('社内チャットを取得できませんでした')
    expect(issue.detail).toContain('履歴は削除されていません')
  })

  test('summarizes degraded metadata without duplicating labels', () => {
    expect(describeInternalChatDegradedFeatures([
      'bookmarks',
      'taskCounts',
      'bookmarks',
    ])).toBe('ブックマーク・タスク件数を一時的に表示できません')
  })
})

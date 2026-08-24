import { describe, expect, test } from 'vitest'
import { canApplyWorkspaceEntityResponse, isWorkspaceSnapshotCurrent } from './workspace-response'

describe('workspace response guards', () => {
  test('rejects a delayed response after switching accounts', () => {
    expect(isWorkspaceSnapshotCurrent(
      { accountId: 'account-a', version: 3 },
      { accountId: 'account-b', version: 4 },
    )).toBe(false)
  })

  test('rejects an old response after switching away and back to the same account', () => {
    expect(isWorkspaceSnapshotCurrent(
      { accountId: 'account-a', version: 3 },
      { accountId: 'account-a', version: 5 },
    )).toBe(false)
  })

  test('applies an entity response only to the same current account and entity', () => {
    const request = { accountId: 'account-a', version: 3, entityId: 'chat-a' }
    expect(canApplyWorkspaceEntityResponse(
      request,
      { accountId: 'account-a', version: 3, entityId: 'chat-a' },
      'chat-a',
    )).toBe(true)
    expect(canApplyWorkspaceEntityResponse(
      request,
      { accountId: 'account-a', version: 3, entityId: 'chat-b' },
      'chat-a',
    )).toBe(false)
  })
})

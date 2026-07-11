import { describe, expect, it } from 'vitest'
import {
  SUPPORT_CHAT_DRAFT_STORAGE_KEY,
  buildSupportCaseUrl,
  buildSupportChatDraftUrl,
  buildSupportChatFallbackContext,
  buildSupportChatRecoveryNotice,
  buildSupportChatSendCasePayload,
  consumeSupportChatDraft,
  createSupportChatDraftContext,
  mergeSupportChatDraftContext,
  planSupportChatSendAttachments,
  storeSupportChatDraft,
  tryStoreSupportChatDraft,
} from './support-chat-draft'

class MemoryStorage {
  private values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

class ThrowingStorage {
  getItem(): string | null {
    throw new Error('storage unavailable')
  }

  setItem(): void {
    throw new Error('storage unavailable')
  }

  removeItem(): void {
    throw new Error('storage unavailable')
  }
}

describe('support chat draft handoff', () => {
  it('creates a trimmed draft context and encoded chat URL', () => {
    const context = createSupportChatDraftContext({
      friendId: 'friend 1',
      caseId: 'case/abc',
      lineAccountId: 'acc-1',
      caseTitle: '',
      draft: '  確認して折り返します。  ',
      createdAt: '2026-06-13T03:10:00.000',
    })

    expect(context).toEqual({
      friendId: 'friend 1',
      caseId: 'case/abc',
      lineAccountId: 'acc-1',
      caseTitle: undefined,
      draft: '確認して折り返します。',
      createdAt: '2026-06-13T03:10:00.000',
    })
    expect(buildSupportChatDraftUrl(context)).toBe('/chats?friend=friend+1&supportCase=case%2Fabc&lineAccount=acc-1')
  })

  it('consumes a matching draft once and removes it from storage', () => {
    const storage = new MemoryStorage()
    const context = createSupportChatDraftContext({
      friendId: 'friend-visible',
      caseId: 'case-visible',
      lineAccountId: 'acc-smoke',
      caseTitle: '報酬反映の確認',
      draft: '確認して折り返します。',
      createdAt: '2026-06-13T03:10:00.000',
    })
    storeSupportChatDraft(storage, context)

    expect(consumeSupportChatDraft(storage, '?friend=friend-visible&supportCase=case-visible')).toEqual(context)
    expect(storage.getItem(SUPPORT_CHAT_DRAFT_STORAGE_KEY)).toBeNull()
    expect(consumeSupportChatDraft(storage, '?friend=friend-visible&supportCase=case-visible')).toBeNull()
  })

  it('keeps the draft when the deep link points to another case', () => {
    const storage = new MemoryStorage()
    const context = createSupportChatDraftContext({
      friendId: 'friend-visible',
      caseId: 'case-visible',
      lineAccountId: 'acc-smoke',
      draft: '確認して折り返します。',
    })
    storeSupportChatDraft(storage, context)

    expect(consumeSupportChatDraft(storage, '?friend=friend-visible&supportCase=case-other')).toBeNull()
    expect(JSON.parse(storage.getItem(SUPPORT_CHAT_DRAFT_STORAGE_KEY) ?? '{}')).toMatchObject({
      friendId: 'friend-visible',
      caseId: 'case-visible',
    })
  })

  it('ignores invalid or empty draft payloads without throwing', () => {
    const storage = new MemoryStorage()
    storage.setItem(SUPPORT_CHAT_DRAFT_STORAGE_KEY, '{bad json')
    expect(consumeSupportChatDraft(storage, '?friend=friend-visible&supportCase=case-visible')).toBeNull()

    storage.setItem(SUPPORT_CHAT_DRAFT_STORAGE_KEY, JSON.stringify({
      friendId: 'friend-visible',
      caseId: 'case-visible',
      lineAccountId: 'acc-smoke',
      draft: '   ',
    }))
    expect(consumeSupportChatDraft(storage, '?friend=friend-visible&supportCase=case-visible')).toBeNull()
  })

  it('falls back cleanly when session storage is unavailable', () => {
    const storage = new ThrowingStorage()
    const context = createSupportChatDraftContext({
      friendId: 'friend-visible',
      caseId: 'case-visible',
      lineAccountId: 'acc-smoke',
      draft: '確認して折り返します。',
    })

    expect(tryStoreSupportChatDraft(storage, context)).toBe(false)
    expect(consumeSupportChatDraft(storage, '?friend=friend-visible&supportCase=case-visible')).toBeNull()
    expect(buildSupportChatFallbackContext('?friend=friend-visible&supportCase=case-visible&lineAccount=acc-smoke')).toEqual({
      friendId: 'friend-visible',
      caseId: 'case-visible',
      lineAccountId: 'acc-smoke',
      draft: '',
    })
  })

  it('keeps the richer stored context when the URL fallback reruns for the same case', () => {
    const stored = createSupportChatDraftContext({
      friendId: 'friend-visible',
      caseId: 'case-visible',
      lineAccountId: 'acc-smoke',
      caseTitle: '報酬反映の確認',
      draft: '確認して折り返します。',
      createdAt: '2026-06-13T03:10:00.000',
    })
    const fallback = buildSupportChatFallbackContext('?friend=friend-visible&supportCase=case-visible&lineAccount=acc-smoke')

    expect(fallback).not.toBeNull()
    expect(mergeSupportChatDraftContext(stored, fallback!)).toEqual(stored)
  })

  it('replaces the stored context when the deep link targets another case', () => {
    const stored = createSupportChatDraftContext({
      friendId: 'friend-visible',
      caseId: 'case-visible',
      lineAccountId: 'acc-smoke',
      caseTitle: '報酬反映の確認',
      draft: '確認して折り返します。',
    })
    const fallback = buildSupportChatFallbackContext('?friend=friend-visible&supportCase=case-other&lineAccount=acc-smoke')

    expect(fallback).not.toBeNull()
    expect(mergeSupportChatDraftContext(stored, fallback!)).toEqual(fallback)
  })

  it('does not build a fallback context without a friend and case id', () => {
    expect(buildSupportChatFallbackContext('?friend=friend-visible')).toBeNull()
    expect(buildSupportChatFallbackContext('?supportCase=case-visible')).toBeNull()
  })

  it('builds an encoded support case URL', () => {
    expect(buildSupportCaseUrl('case/abc 1')).toBe('/support?case=case%2Fabc+1')
  })

  it('attaches support case payload only to the chosen send step', () => {
    const context = createSupportChatDraftContext({
      friendId: 'friend-visible',
      caseId: 'case-visible',
      lineAccountId: 'acc-smoke',
      draft: '確認して折り返します。',
    })

    expect(buildSupportChatSendCasePayload(context, true)).toEqual({
      supportCaseId: 'case-visible',
      lineAccountId: 'acc-smoke',
    })
    expect(buildSupportChatSendCasePayload(context, false)).toEqual({})
    expect(buildSupportChatSendCasePayload(null, true)).toEqual({})
  })

  it('attaches a support case to only one message when image and text are sent together', () => {
    const context = createSupportChatDraftContext({
      friendId: 'friend-visible',
      caseId: 'case-visible',
      lineAccountId: 'acc-smoke',
      draft: '確認して折り返します。',
    })

    expect(planSupportChatSendAttachments(context, {
      hasLineImage: false,
      hasText: true,
    })).toEqual({
      attachSupportToImage: false,
      attachSupportToText: true,
    })
    expect(planSupportChatSendAttachments(context, {
      hasLineImage: true,
      hasText: false,
    })).toEqual({
      attachSupportToImage: true,
      attachSupportToText: false,
    })
    expect(planSupportChatSendAttachments(context, {
      hasLineImage: true,
      hasText: true,
    })).toEqual({
      attachSupportToImage: true,
      attachSupportToText: false,
    })
    expect(planSupportChatSendAttachments(null, {
      hasLineImage: true,
      hasText: true,
    })).toEqual({
      attachSupportToImage: false,
      attachSupportToText: false,
    })
  })

  it('does not show recovery guidance when the support case status was updated', () => {
    expect(buildSupportChatRecoveryNotice({
      id: 'case-visible',
      previousStatus: 'waiting_secondary',
      nextStatus: 'customer_reply',
      statusUpdated: true,
    }, { caseId: 'case-visible', caseTitle: '報酬確認' })).toBeNull()
    expect(buildSupportChatRecoveryNotice(null, { caseId: 'case-visible', caseTitle: '報酬確認' })).toBeNull()
  })

  it('does not show recovery guidance when the case is already waiting for a customer reply', () => {
    expect(buildSupportChatRecoveryNotice({
      id: 'case-visible',
      previousStatus: 'customer_reply',
      nextStatus: null,
      statusUpdated: false,
    }, { caseId: 'case-visible', caseTitle: '報酬確認' })).toBeNull()
  })

  it('builds recovery guidance when LINE send succeeded but case status update was not applied', () => {
    const notice = buildSupportChatRecoveryNotice({
      id: 'case-visible',
      previousStatus: 'waiting_secondary',
      nextStatus: null,
      statusUpdated: false,
    }, { caseId: 'case-visible', caseTitle: '報酬確認' })

    expect(notice).toMatchObject({
      caseId: 'case-visible',
      caseTitle: '報酬確認',
      supportHref: '/support?case=case-visible',
      title: 'LINE送信は完了、チケット更新だけ確認が必要です',
    })
    expect(notice?.message).toContain('顧客へのLINE送信は完了')
    expect(notice?.steps).toContain('ステータスが「二次回答待ち」のままなら「顧客返信待ち」へ保存してください。')
  })
})

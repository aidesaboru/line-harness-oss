import { describe, expect, test } from 'vitest'
import type { InternalTask } from '@/lib/api'
import {
  filterInternalTasks,
  internalTaskDisplayTitle,
  internalTaskSourceContext,
  internalTaskSourceLabel,
  internalTaskSupportingText,
  isGenericInternalTaskTitle,
  isInternalTaskOverdue,
  shouldResetInternalTaskDraft,
} from './internal-task-view'

function task(overrides: Partial<InternalTask> = {}): InternalTask {
  return {
    id: 'task-1',
    lineAccountId: 'acc-1',
    source: 'chat',
    sourceId: 'friend-1',
    sourceMessageId: 'message-1',
    title: '契約内容を確認する',
    description: '先方の回答を確認して担当者へ共有する',
    status: 'open',
    sourceTitle: '河原通信',
    customerName: '2449 河原通信',
    isGroupConversation: false,
    canUpdate: true,
    dueAt: '2026-08-09T10:00:00.000+09:00',
    assignees: [{ staffId: 'staff-1', staffName: '林 静香' }],
    comments: [],
    commentCount: 2,
    createdBy: 'staff-1',
    createdByName: '林 静香',
    completedBy: null,
    completedByName: null,
    completedAt: null,
    createdAt: '2026-08-08T10:00:00.000+09:00',
    updatedAt: '2026-08-08T11:00:00.000+09:00',
    href: '/chats?friend=friend-1',
    ...overrides,
  }
}

describe('internal task view helpers', () => {
  test('keeps a source draft during initial account hydration and clears it on a real switch', () => {
    expect(shouldResetInternalTaskDraft(null, 'acc-a', 'acc-a')).toBe(false)
    expect(shouldResetInternalTaskDraft(null, 'acc-b', 'acc-a')).toBe(true)
    expect(shouldResetInternalTaskDraft('acc-a', 'acc-a', 'acc-a')).toBe(false)
    expect(shouldResetInternalTaskDraft('acc-a', 'acc-b', 'acc-a')).toBe(true)
    expect(shouldResetInternalTaskDraft('acc-a', null, 'acc-a')).toBe(true)
  })

  test('distinguishes direct chats and group LINE sources', () => {
    expect(internalTaskSourceLabel(task())).toBe('個別チャット')
    expect(internalTaskSourceLabel(task({ isGroupConversation: true }))).toBe('グループLINE')
    expect(internalTaskSourceLabel(task({ source: 'support' }))).toBe('チケット')
  })

  test('combines customer and source names without repeating the same value', () => {
    expect(internalTaskSourceContext(task())).toBe('2449 河原通信')
    expect(internalTaskSourceContext(task({ customerName: '河原通信' }))).toBe('河原通信')
    expect(internalTaskSourceContext(task({ customerName: '4123_中村 裕', sourceTitle: '4123 中村裕' }))).toBe('4123_中村 裕')
    expect(internalTaskSourceContext(task({ customerName: '2449 河原通信', sourceTitle: 'ECオーナー相談グループ' }))).toBe('2449 河原通信 / ECオーナー相談グループ')
  })

  test('uses the concrete description as the visible name for old generic task titles', () => {
    const genericTask = task({
      title: '2449 河原通信への対応',
      description: '返金対象の商品を確認して経理へ共有する',
    })
    expect(isGenericInternalTaskTitle(genericTask)).toBe(true)
    expect(internalTaskDisplayTitle(genericTask)).toBe('返金対象の商品を確認して経理へ共有する')
    expect(internalTaskSupportingText(genericTask)).toBe('')
  })

  test('keeps a concrete task title and only falls back when the title is generic', () => {
    const concreteTask = task({ title: '契約内容を確認する', description: '河原通信からの依頼' })
    expect(isGenericInternalTaskTitle(concreteTask)).toBe(false)
    expect(internalTaskDisplayTitle(concreteTask)).toBe('契約内容を確認する')
    expect(internalTaskSupportingText(concreteTask)).toBe('河原通信からの依頼')
    expect(internalTaskDisplayTitle(task({ title: '河原通信への対応', description: '' }))).toBe('河原通信への対応')
    expect(isGenericInternalTaskTitle(task({
      title: '楽天からの案内への対応',
      description: '期限までに確認する',
    }))).toBe(false)
  })

  test('shortens a long old description without changing the stored task', () => {
    const displayTitle = internalTaskDisplayTitle(task({
      title: '河原通信への対応',
      description: 'あ'.repeat(130),
    }))
    expect(displayTitle).toBe(`${'あ'.repeat(120)}…`)
  })

  test('matches task identity and operational filters', () => {
    const tasks = [
      task(),
      task({ id: 'task-2', title: '住所変更', customerName: '村井玲緒菜', isGroupConversation: true }),
      task({ id: 'task-3', title: '完了済み', status: 'done', dueAt: '2026-08-01T10:00:00.000+09:00' }),
    ]
    expect(filterInternalTasks(tasks, {
      query: '村井', source: 'group', due: 'all', assigneeId: '', status: 'all',
    }).map((item) => item.id)).toEqual(['task-2'])
    expect(filterInternalTasks(tasks, {
      query: 'グループLINE', source: 'all', due: 'all', assigneeId: '', status: 'all',
    }).map((item) => item.id)).toEqual(['task-2'])
    expect(filterInternalTasks(tasks, {
      query: '', source: 'all', due: 'overdue', assigneeId: 'staff-1', status: 'open',
      now: new Date('2026-08-10T10:00:00.000+09:00').getTime(),
    }).map((item) => item.id)).toEqual(['task-1', 'task-2'])
  })

  test('does not mark completed tasks as overdue', () => {
    const now = new Date('2026-08-10T10:00:00.000+09:00').getTime()
    expect(isInternalTaskOverdue(task(), now)).toBe(true)
    expect(isInternalTaskOverdue(task({ status: 'done' }), now)).toBe(false)
  })
})

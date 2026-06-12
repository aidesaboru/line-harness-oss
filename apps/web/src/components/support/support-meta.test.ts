import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SupportCase } from '../../lib/api'
import {
  buildSupportCaseSearch,
  canOpenChatWithDraft,
  emptyCaseForm,
  formatSupportErrorMessage,
  getBlockingCaseFormValidationIssues,
  getCaseFormValidationIssues,
  getCreateCaseValidationIssues,
  getDisplayCases,
  getEscalationDraftValidationIssues,
  getManualEditorValidationIssues,
  getOutsideCurrentListAction,
  getSupportCaseListEmptyState,
  getSupportIdentityIssue,
  getSupportRolePermissions,
  getVisibleStatusOptions,
  isOverdueCase,
  isSelectedCaseOutsideCurrentList,
  sortCases,
  supportApiErrorMessage,
} from './support-meta'

function supportCase(overrides: Partial<SupportCase>): SupportCase {
  return {
    id: 'case-1',
    lineAccountId: 'acc-1',
    friendId: null,
    friendName: null,
    friendPictureUrl: null,
    lineUserId: null,
    title: '問い合わせ',
    category: 'other',
    priority: 'medium',
    status: 'open',
    primaryAssignee: null,
    escalationAssignee: null,
    escalationLevel: 'L1',
    dueAt: null,
    nextCheckAt: null,
    customerNumber: null,
    companyName: null,
    contactName: null,
    storeName: null,
    contractType: null,
    customerSummary: '',
    internalNote: '',
    customerReplyDraft: '',
    resolutionNote: '',
    manualIds: [],
    createdBy: null,
    updatedBy: null,
    closedAt: null,
    reopenedAt: null,
    createdAt: '2026-06-12T09:00:00.000',
    updatedAt: '2026-06-12T09:00:00.000',
    ...overrides,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('support case list ordering', () => {
  it('shows stale cases oldest-first when the 24h queue is selected', () => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-06-13T12:00:00.000Z').getTime())
    const cases = [
      supportCase({ id: 'fresh', updatedAt: '2026-06-13T04:00:00.000Z' }),
      supportCase({ id: 'stale-newer', updatedAt: '2026-06-12T08:00:00.000Z' }),
      supportCase({ id: 'resolved-stale', status: 'resolved', updatedAt: '2026-06-10T08:00:00.000Z' }),
      supportCase({ id: 'stale-older', updatedAt: '2026-06-11T08:00:00.000Z' }),
    ]

    expect(getDisplayCases(cases, { caseFocus: 'stale', sortMode: 'updated' }).map((item) => item.id)).toEqual([
      'stale-older',
      'stale-newer',
    ])
  })

  it('keeps resolved cases behind unresolved cases when sorting by due date', () => {
    const cases = [
      supportCase({ id: 'resolved-old-due', status: 'resolved', dueAt: '2026-06-10T10:00:00.000Z' }),
      supportCase({ id: 'open-near-due', status: 'open', dueAt: '2026-06-12T10:00:00.000Z' }),
      supportCase({ id: 'open-no-due', status: 'open', dueAt: null }),
    ]

    expect(sortCases(cases, 'due').map((item) => item.id)).toEqual([
      'open-near-due',
      'open-no-due',
      'resolved-old-due',
    ])
  })

  it('detects overdue unresolved cases but ignores resolved cases', () => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-06-13T12:00:00.000Z').getTime())

    expect(isOverdueCase(supportCase({ status: 'open', dueAt: '2026-06-13T08:00:00.000Z' }))).toBe(true)
    expect(isOverdueCase(supportCase({ status: 'resolved', dueAt: '2026-06-13T08:00:00.000Z' }))).toBe(false)
    expect(isOverdueCase(supportCase({ status: 'open', dueAt: '2026-06-13T18:00:00.000Z' }))).toBe(false)
  })
})

describe('support current-list visibility', () => {
  it('detects when the selected case is hidden by the current filters', () => {
    expect(isSelectedCaseOutsideCurrentList({
      selectedCaseId: 'case-1',
      displayedCaseIds: ['case-2', 'case-3'],
    })).toBe(true)
  })

  it('does not flag empty selection or visible selected cases', () => {
    expect(isSelectedCaseOutsideCurrentList({
      selectedCaseId: null,
      displayedCaseIds: ['case-1'],
    })).toBe(false)
    expect(isSelectedCaseOutsideCurrentList({
      selectedCaseId: 'case-1',
      displayedCaseIds: ['case-1', 'case-2'],
    })).toBe(false)
  })

  it('shows completed cases when the selected hidden case is already resolved', () => {
    expect(getOutsideCurrentListAction('resolved')).toEqual({
      label: '完了案件を表示',
      statusFilter: 'resolved',
      queueFilter: 'all',
      caseFocus: 'all',
    })
  })

  it('resets filters for hidden unresolved cases', () => {
    expect(getOutsideCurrentListAction('open')).toEqual({
      label: '絞り込みをリセット',
      statusFilter: 'all',
      queueFilter: 'all',
      caseFocus: 'all',
    })
  })
})

describe('support case URL state', () => {
  it('sets the selected case query while preserving other params', () => {
    expect(buildSupportCaseSearch('?foo=bar&case=old', 'case/new 1')).toBe('?foo=bar&case=case%2Fnew+1')
  })

  it('removes the selected case query when there is no selected case', () => {
    expect(buildSupportCaseSearch('?foo=bar&case=old', null)).toBe('?foo=bar')
    expect(buildSupportCaseSearch('?case=old', null)).toBe('')
  })
})

describe('support role permissions', () => {
  it.each([
    ['owner', true],
    ['admin', true],
    ['staff', false],
    ['', false],
    ['manager', false],
    [null, false],
    [undefined, false],
  ] as const)('maps management controls for role %s', (role, canManage) => {
    const permissions = getSupportRolePermissions(role)

    expect(permissions.canCreateCases).toBe(canManage)
    expect(permissions.canEditCaseRouting).toBe(canManage)
    expect(permissions.canManageManuals).toBe(canManage)
    expect(permissions.canEditCaseWork).toBe(true)
    expect(permissions.canLinkManuals).toBe(true)
  })
})

describe('support identity issues', () => {
  it('waits until the login identity has been verified', () => {
    expect(getSupportIdentityIssue({ ready: false, role: '', staffName: '' })).toBeNull()
  })

  it('blocks when the verified role is missing', () => {
    expect(getSupportIdentityIssue({ ready: true, role: '', staffName: '山田' })).toContain('ログイン権限')
  })

  it('requires staff users to have a name for visibility checks', () => {
    expect(getSupportIdentityIssue({ ready: true, role: 'staff', staffName: '  ' })).toContain('スタッフ名')
  })

  it('allows owner and named staff identities', () => {
    expect(getSupportIdentityIssue({ ready: true, role: 'owner', staffName: '' })).toBeNull()
    expect(getSupportIdentityIssue({ ready: true, role: 'staff', staffName: '田島' })).toBeNull()
  })
})

describe('support case empty states', () => {
  it('explains staff visibility when there are no visible cases without filters', () => {
    expect(getSupportCaseListEmptyState({
      role: 'staff',
      hasActiveFilters: false,
      statusFilter: 'all',
      queueFilter: 'all',
      caseFocus: 'all',
      search: '',
    })).toMatchObject({
      title: '表示できる案件はありません',
      description: expect.stringContaining('owner/admin'),
    })
  })

  it('explains that owner/admin have no unresolved work when no filters are active', () => {
    expect(getSupportCaseListEmptyState({
      role: 'owner',
      hasActiveFilters: false,
      statusFilter: 'all',
      queueFilter: 'all',
      caseFocus: 'all',
      search: '',
    })).toMatchObject({
      title: '未完了の案件はありません',
      description: expect.stringContaining('チャット画面から案件化'),
    })
  })

  it('prioritizes search guidance when a search term is active', () => {
    expect(getSupportCaseListEmptyState({
      role: 'owner',
      hasActiveFilters: true,
      statusFilter: 'all',
      queueFilter: 'all',
      caseFocus: 'all',
      search: ' 報酬 ',
    })).toEqual({
      title: '検索条件に合う案件はありません',
      description: '件名、顧客名、要約、内部メモの言葉を変えて検索してください。',
      actionLabel: '絞り込みをリセット',
    })
  })

  it('shows queue-specific guidance for stale and my-escalation queues', () => {
    expect(getSupportCaseListEmptyState({
      role: 'admin',
      hasActiveFilters: true,
      statusFilter: 'all',
      queueFilter: 'all',
      caseFocus: 'stale',
      search: '',
    }).title).toBe('24h滞留している案件はありません')

    expect(getSupportCaseListEmptyState({
      role: 'staff',
      hasActiveFilters: true,
      statusFilter: 'all',
      queueFilter: 'my_escalations',
      caseFocus: 'all',
      search: '',
    }).title).toBe('自分宛エスカレ案件はありません')
  })
})

describe('support case detail actions', () => {
  it('only shows reopened as a selectable status after a resolved case or while already reopened', () => {
    expect(getVisibleStatusOptions('open', 'open').some((item) => item.value === 'reopened')).toBe(false)
    expect(getVisibleStatusOptions('resolved', 'resolved').some((item) => item.value === 'reopened')).toBe(true)
    expect(getVisibleStatusOptions('open', 'reopened').some((item) => item.value === 'reopened')).toBe(true)
  })

  it('shows the chat reply action only when an unresolved case has a draft and chat target', () => {
    expect(canOpenChatWithDraft({ status: 'customer_reply', hasDraft: true, hasChat: true })).toBe(true)
    expect(canOpenChatWithDraft({ status: 'resolved', hasDraft: true, hasChat: true })).toBe(false)
    expect(canOpenChatWithDraft({ status: 'customer_reply', hasDraft: false, hasChat: true })).toBe(false)
    expect(canOpenChatWithDraft({ status: 'customer_reply', hasDraft: true, hasChat: false })).toBe(false)
  })
})

describe('support error messages', () => {
  it('turns auth and permission status errors into actionable Japanese messages', () => {
    expect(formatSupportErrorMessage(new Error('API error: 401'), '読み込みに失敗しました')).toContain('ログイン')
    expect(formatSupportErrorMessage(new Error('API error: 403'), '保存に失敗しました')).toContain('owner/admin')
  })

  it('turns missing and conflict status errors into recovery guidance', () => {
    expect(formatSupportErrorMessage(new Error('API error: 404'), '案件詳細の読み込みに失敗しました')).toContain('最新データ')
    expect(formatSupportErrorMessage(new Error('API error: 409'), '保存に失敗しました')).toContain('再読み込み')
  })

  it('turns network failures into Worker and network guidance', () => {
    expect(formatSupportErrorMessage(new TypeError('Failed to fetch'), '読み込みに失敗しました')).toContain('Worker')
  })

  it('turns resolved-case backend errors into reopen guidance', () => {
    expect(formatSupportErrorMessage('support case is resolved', '送信に失敗しました')).toContain('再オープン')
  })

  it('keeps explicit API messages when they are already user-facing', () => {
    expect(supportApiErrorMessage({ error: '完了には対応結果メモが必要です' }, '保存に失敗しました')).toBe('完了には対応結果メモが必要です')
    expect(supportApiErrorMessage({}, '保存に失敗しました')).toBe('保存に失敗しました')
  })
})

describe('support case form validation', () => {
  it('blocks saving on-hold cases until next check and internal note are filled', () => {
    const form = { ...emptyCaseForm(), status: 'on_hold' as const }

    expect(getBlockingCaseFormValidationIssues(form).map((issue) => issue.key)).toEqual([
      'on_hold_next_check',
      'on_hold_internal_note',
    ])

    expect(getBlockingCaseFormValidationIssues({
      ...form,
      nextCheckAt: '2026-06-13T10:00',
      internalNote: '確認待ち',
    })).toHaveLength(0)
  })

  it('blocks saving resolved cases until a resolution note is filled', () => {
    const form = { ...emptyCaseForm(), status: 'resolved' as const }

    expect(getBlockingCaseFormValidationIssues(form).map((issue) => issue.key)).toEqual([
      'resolved_resolution_note',
    ])
    expect(getBlockingCaseFormValidationIssues({ ...form, resolutionNote: '返信済み' })).toHaveLength(0)
  })

  it('warns about chat reply readiness without blocking normal saving', () => {
    const form = { ...emptyCaseForm(), customerReplyDraft: 'ご連絡ありがとうございます。' }

    expect(getCaseFormValidationIssues(form, { hasChat: false }).map((issue) => issue.key)).toEqual([
      'reply_missing_chat',
    ])
    expect(getBlockingCaseFormValidationIssues(form)).toHaveLength(0)
  })

  it('warns that resolved cases must be reopened before chat reply', () => {
    const form = {
      ...emptyCaseForm(),
      status: 'resolved' as const,
      resolutionNote: '対応完了',
      customerReplyDraft: '追加でご案内します。',
    }

    expect(getCaseFormValidationIssues(form, { hasChat: true }).map((issue) => issue.key)).toEqual([
      'reply_resolved_case',
    ])
  })
})

describe('support case creation validation', () => {
  it('blocks case creation when neither chat nor summary is provided', () => {
    expect(getCreateCaseValidationIssues({ friendId: ' ', customerSummary: '' })).toEqual([
      {
        key: 'create_case_source',
        severity: 'error',
        message: 'LINE会話を選ぶか、問い合わせ要約を入力してください。',
        fieldLabel: 'LINE会話 / 問い合わせ要約',
        blocking: true,
      },
    ])
  })

  it('allows case creation with a linked chat or manual summary', () => {
    expect(getCreateCaseValidationIssues({ friendId: 'friend-1', customerSummary: '' })).toHaveLength(0)
    expect(getCreateCaseValidationIssues({ friendId: '', customerSummary: '報酬が反映されていない' })).toHaveLength(0)
  })
})

describe('support manual editor validation', () => {
  it('blocks manuals without title and body', () => {
    expect(getManualEditorValidationIssues({ title: ' ', body: '', url: '' }).map((issue) => issue.key)).toEqual([
      'manual_title',
      'manual_body',
    ])
  })

  it('blocks non-http manual links', () => {
    expect(getManualEditorValidationIssues({
      title: '返品手順',
      body: '返品依頼の確認手順',
      url: '/manuals/refund',
    }).map((issue) => issue.key)).toEqual(['manual_url'])
  })

  it('accepts a complete manual draft', () => {
    expect(getManualEditorValidationIssues({
      title: '返品手順',
      body: '返品依頼の確認手順',
      url: 'https://example.com/manuals/refund',
    })).toHaveLength(0)
  })
})

describe('support escalation draft validation', () => {
  it('blocks owner/admin escalation drafts without assignee and question', () => {
    expect(getEscalationDraftValidationIssues({
      question: '',
      assignee: ' ',
      canEditRouting: true,
      hasPresetAssignee: false,
      detailStatus: 'open',
    }).map((issue) => issue.key)).toEqual([
      'escalation_assignee',
      'escalation_question',
    ])
  })

  it('blocks staff escalation drafts when the case has no preset escalation assignee', () => {
    expect(getEscalationDraftValidationIssues({
      question: '税務観点を確認したい',
      assignee: '',
      canEditRouting: false,
      hasPresetAssignee: false,
      detailStatus: 'open',
    }).map((issue) => issue.key)).toEqual(['escalation_locked_assignee'])
  })

  it('allows staff escalation drafts when the case has a preset assignee and question', () => {
    expect(getEscalationDraftValidationIssues({
      question: '税務観点を確認したい',
      assignee: '',
      canEditRouting: false,
      hasPresetAssignee: true,
      detailStatus: 'open',
    })).toHaveLength(0)
  })

  it('blocks escalation drafts for resolved cases until reopened', () => {
    expect(getEscalationDraftValidationIssues({
      question: '追加確認したい',
      assignee: '二次担当',
      canEditRouting: true,
      hasPresetAssignee: true,
      detailStatus: 'resolved',
    }).map((issue) => issue.key)).toEqual(['escalation_resolved_case'])
  })
})

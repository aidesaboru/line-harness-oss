import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SupportCase } from '../../lib/api'
import {
  buildSupportCaseSearch,
  canLoadSupportWorkspaceData,
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
  getInitialSupportCaseId,
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
  it('sorts by latest update even when the API returns another order', () => {
    const cases = [
      supportCase({ id: 'older-high-priority', priority: 'urgent', updatedAt: '2026-06-12T09:00:00.000Z' }),
      supportCase({ id: 'newer-low-priority', priority: 'low', updatedAt: '2026-06-13T09:00:00.000Z' }),
    ]

    expect(sortCases(cases, 'updated').map((item) => item.id)).toEqual([
      'newer-low-priority',
      'older-high-priority',
    ])
  })

  it('selects the first case from the current display order on initial load', () => {
    const cases = [
      supportCase({ id: 'older-high-priority', priority: 'urgent', updatedAt: '2026-06-12T09:00:00.000Z' }),
      supportCase({ id: 'newer-low-priority', priority: 'low', updatedAt: '2026-06-13T09:00:00.000Z' }),
    ]

    expect(getInitialSupportCaseId(cases, { caseFocus: 'all', sortMode: 'updated' })).toBe('newer-low-priority')
    expect(getInitialSupportCaseId(cases, { caseFocus: 'all', sortMode: 'priority' })).toBe('older-high-priority')
  })

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
      label: '完了チケットを表示',
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
    ['owner', true, true],
    ['admin', true, true],
    ['staff', true, false],
    ['', false, false],
    ['manager', false, false],
    [null, false, false],
    [undefined, false, false],
  ] as const)('maps management controls for role %s', (role, canCreate, canManage) => {
    const permissions = getSupportRolePermissions(role)

    expect(permissions.canCreateCases).toBe(canCreate)
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

  it('requires scoped staff users to have a name for visibility checks', () => {
    expect(getSupportIdentityIssue({ ready: true, role: 'staff', staffName: '  ' })).toContain('スタッフ名')
    expect(getSupportIdentityIssue({ ready: true, role: 'secondary', staffName: '  ' })).toContain('スタッフ名')
  })

  it('allows owner and named scoped staff identities', () => {
    expect(getSupportIdentityIssue({ ready: true, role: 'owner', staffName: '' })).toBeNull()
    expect(getSupportIdentityIssue({ ready: true, role: 'staff', staffName: '田島' })).toBeNull()
    expect(getSupportIdentityIssue({ ready: true, role: 'secondary', staffName: '松山' })).toBeNull()
  })
})

describe('support workspace data loading gate', () => {
  it('waits for a selected account and verified staff identity', () => {
    expect(canLoadSupportWorkspaceData({
      selectedAccountId: null,
      staffIdentityReady: true,
      identityIssue: null,
    })).toBe(false)
    expect(canLoadSupportWorkspaceData({
      selectedAccountId: 'acc-1',
      staffIdentityReady: false,
      identityIssue: null,
    })).toBe(false)
  })

  it('blocks support data loading when the verified identity is not usable', () => {
    expect(canLoadSupportWorkspaceData({
      selectedAccountId: 'acc-1',
      staffIdentityReady: true,
      identityIssue: 'スタッフ名がないため表示範囲を判定できません。',
    })).toBe(false)
  })

  it('allows support data loading after account and identity checks pass', () => {
    expect(canLoadSupportWorkspaceData({
      selectedAccountId: 'acc-1',
      staffIdentityReady: true,
      identityIssue: null,
    })).toBe(true)
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
      title: '表示できるチケットはありません',
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
      title: '未完了のチケットはありません',
      description: expect.stringContaining('チャット画面からチケット化'),
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
      title: '検索条件に合うチケットはありません',
      description: '件名、顧客名、問い合わせ内容、内部メモの言葉を変えて検索してください。',
      actionLabel: '絞り込みをリセット',
    })
  })

  it('shows queue-specific guidance for stale and action-owner queues', () => {
    expect(getSupportCaseListEmptyState({
      role: 'admin',
      hasActiveFilters: true,
      statusFilter: 'all',
      queueFilter: 'all',
      caseFocus: 'stale',
      search: '',
    }).title).toBe('24h滞留しているチケットはありません')

    expect(getSupportCaseListEmptyState({
      role: 'staff',
      hasActiveFilters: true,
      statusFilter: 'all',
      queueFilter: 'escalated',
      caseFocus: 'all',
      search: '',
    }).title).toBe('二次対応が確認中のチケットはありません')

    expect(getSupportCaseListEmptyState({
      role: 'staff',
      hasActiveFilters: true,
      statusFilter: 'all',
      queueFilter: 'primary_action',
      caseFocus: 'all',
      search: '',
    }).title).toBe('一次対応が動くチケットはありません')

    expect(getSupportCaseListEmptyState({
      role: 'staff',
      hasActiveFilters: true,
      statusFilter: 'all',
      queueFilter: 'secondary_answered',
      caseFocus: 'all',
      search: '',
    }).title).toBe('二次対応回答済みのチケットはありません')
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
    expect(formatSupportErrorMessage(new Error('API error: 404'), 'チケット詳細の読み込みに失敗しました')).toContain('最新データ')
    expect(formatSupportErrorMessage(new Error('API error: 409'), '保存に失敗しました')).toContain('再読み込み')
  })

  it('turns network failures into Worker and network guidance', () => {
    expect(formatSupportErrorMessage(new TypeError('Failed to fetch'), '読み込みに失敗しました')).toContain('Worker')
  })

  it('turns resolved-case backend errors into reopen guidance', () => {
    expect(formatSupportErrorMessage('support case is resolved', '送信に失敗しました')).toContain('再オープン')
  })

  it('keeps allowlisted API messages when they are already user-facing', () => {
    expect(supportApiErrorMessage({ error: '完了にする場合は、対応結果メモが必要です' }, '保存に失敗しました')).toBe('完了にする場合は、対応結果メモが必要です')
    expect(supportApiErrorMessage({}, '保存に失敗しました')).toBe('保存に失敗しました')
  })

  it('falls back instead of showing unknown raw API messages', () => {
    expect(supportApiErrorMessage({
      error: 'D1_ERROR friend-visible token-secret customer payload leaked',
    }, '保存に失敗しました')).toBe('保存に失敗しました')
    expect(formatSupportErrorMessage(new Error('unexpected raw backend failure'), '読み込みに失敗しました')).toBe('読み込みに失敗しました')
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
        message: 'LINE会話を選ぶか、問い合わせ内容を入力してください。',
        fieldLabel: 'LINE会話 / 問い合わせ内容',
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

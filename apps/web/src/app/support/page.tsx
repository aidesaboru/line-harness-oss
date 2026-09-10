'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Header from '@/components/layout/header'
import { useAccount } from '@/contexts/account-context'
import {
  api,
  type SupportCase,
  type SupportCaseDetail,
  type SupportCaseStatus,
  type SupportSummary,
} from '@/lib/api'
import { copyText } from '@/lib/clipboard'
import { isWorkspaceSnapshotCurrent, type WorkspaceSnapshot } from '@/lib/workspace-response'
import {
  cacheStaffSession,
  clearStaffIdentityCache,
  readStaffIdentityCache,
} from '@/lib/auth-session'
import {
  buildSupportChatDraftUrl,
  createSupportChatDraftContext,
  tryStoreSupportChatDraft,
} from '@/lib/support-chat-draft'
import CaseDetail from '@/components/support/case-detail'
import CaseList from '@/components/support/case-list'
import CreateCasePanel, { type ChatOption, type CreateCaseInput } from '@/components/support/create-case-panel'
import QueueStrip, { type QueueKey } from '@/components/support/queue-strip'
import {
  buildSupportCaseSearch,
  caseFormFromDetail,
  canLoadSupportWorkspaceData,
  emptyCaseForm,
  fromInputDateTime,
  formatSupportErrorMessage,
  getBlockingCaseFormValidationIssues,
  getCreateCaseValidationIssues,
  getDisplayCases,
  getInitialSupportCaseId,
  getOutsideCurrentListAction,
  getSupportCaseListEmptyState,
  getSupportIdentityIssue,
  getSupportRolePermissions,
  isSelectedCaseOutsideCurrentList,
  supportApiErrorMessage,
  type CaseFormState,
  type CaseFocus,
  type CaseSortMode,
} from '@/components/support/support-meta'
import {
  PlusIcon,
  ToastStack,
  btnBrandCls,
  btnSecondaryCls,
  useConfirmDialog,
  useToasts,
} from '@/components/support/support-ui'

const SEARCH_DEBOUNCE_MS = 350
const SUPPORT_REALTIME_POLL_MS = 8 * 1000
const SUPPORT_CASE_PAGE_SIZE = 100

async function loadAllSupportCases(
  params: Omit<Parameters<typeof api.support.cases.list>[0], 'limit' | 'offset'>,
): Promise<Awaited<ReturnType<typeof api.support.cases.list>>> {
  const rows: SupportCase[] = []
  for (let offset = 0; ; offset += SUPPORT_CASE_PAGE_SIZE) {
    const response = await api.support.cases.list({
      ...params,
      limit: SUPPORT_CASE_PAGE_SIZE,
      offset,
    })
    if (!response.success) return response
    rows.push(...response.data)
    if (response.data.length < SUPPORT_CASE_PAGE_SIZE) {
      return { ...response, data: rows }
    }
  }
}

export default function SupportPage() {
  const { selectedAccountId, selectedAccount, loading: accountLoading } = useAccount()
  const { toasts, notify, dismissToast } = useToasts()
  const { requestConfirm, confirmDialog } = useConfirmDialog()

  const [summary, setSummary] = useState<SupportSummary | null>(null)
  const [cases, setCases] = useState<SupportCase[]>([])
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null)
  const [mobileCaseOpen, setMobileCaseOpen] = useState(false)
  const [detail, setDetail] = useState<SupportCaseDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [chats, setChats] = useState<ChatOption[]>([])
  const [staffNames, setStaffNames] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [reminderSaving, setReminderSaving] = useState(false)
  const [slackNotificationDeleting, setSlackNotificationDeleting] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [statusFilter, setStatusFilter] = useState('all')
  const [queueFilter, setQueueFilter] = useState('all')
  const [caseFocus, setCaseFocus] = useState<CaseFocus>('all')
  const [sortMode, setSortMode] = useState<CaseSortMode>('updated')
  const [search, setSearch] = useState('')
  const [appliedSearch, setAppliedSearch] = useState('')
  const [staffName, setStaffName] = useState('')
  const [staffRole, setStaffRole] = useState('')
  const [secondaryCanRespond, setSecondaryCanRespond] = useState(false)
  const [staffIdentityReady, setStaffIdentityReady] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [createInitialFriendId, setCreateInitialFriendId] = useState<string | null>(null)
  const [caseQueryReady, setCaseQueryReady] = useState(false)
  const [chatOptionsError, setChatOptionsError] = useState<string | null>(null)

  const [caseForm, setCaseForm] = useState<CaseFormState>(emptyCaseForm)
  const [savedForm, setSavedForm] = useState<CaseFormState>(emptyCaseForm)

  const accountName = selectedAccount?.displayName || selectedAccount?.name || 'LINEアカウント'

  const dirty = useMemo(
    () => detail !== null && JSON.stringify(caseForm) !== JSON.stringify(savedForm),
    [detail, caseForm, savedForm],
  )
  const dirtyRef = useRef(dirty)
  useEffect(() => { dirtyRef.current = dirty }, [dirty])
  const selectedCaseIdRef = useRef<string | null>(null)
  useEffect(() => { selectedCaseIdRef.current = selectedCaseId }, [selectedCaseId])
  useEffect(() => { setMobileCaseOpen(false) }, [selectedAccountId])
  const casesRequestRef = useRef(0)
  const detailRequestRef = useRef(0)
  const detailIdRef = useRef<string | null>(null)
  const accountScopeRef = useRef<string | null>(selectedAccountId)
  const currentAccountIdRef = useRef<string | null>(selectedAccountId)
  currentAccountIdRef.current = selectedAccountId
  const workspaceVersionRef = useRef(0)
  useEffect(() => { detailIdRef.current = detail?.id ?? null }, [detail?.id])

  const captureWorkspace = useCallback((): WorkspaceSnapshot => ({
    accountId: selectedAccountId,
    version: workspaceVersionRef.current,
  }), [selectedAccountId])
  const isCurrentWorkspace = useCallback((snapshot: WorkspaceSnapshot) => isWorkspaceSnapshotCurrent(
    snapshot,
    { accountId: currentAccountIdRef.current, version: workspaceVersionRef.current },
  ), [])

  useEffect(() => {
    if (accountScopeRef.current === selectedAccountId) return
    accountScopeRef.current = selectedAccountId
    workspaceVersionRef.current += 1
    casesRequestRef.current += 1
    detailRequestRef.current += 1
    setSummary(null)
    setCases([])
    setSelectedCaseId(null)
    setDetail(null)
    setCaseForm(emptyCaseForm)
    setSavedForm(emptyCaseForm)
    setChats([])
    setChatOptionsError(null)
    setLoadError(null)
    setMobileCaseOpen(false)
    setCreateOpen(false)
    setCreateInitialFriendId(null)
    setLoading(Boolean(selectedAccountId))
    setDetailLoading(false)
    setSaving(false)
    setReminderSaving(false)
    setSlackNotificationDeleting(false)
  }, [selectedAccountId])

  const visibleChats = useMemo(() => chats.slice(0, 80), [chats])
  const createPanelChats = useMemo(() => {
    if (!createInitialFriendId || visibleChats.some((chat) => chat.friendId === createInitialFriendId)) {
      return visibleChats
    }
    const linkedChat = chats.find((chat) => chat.friendId === createInitialFriendId)
    return linkedChat ? [linkedChat, ...visibleChats] : visibleChats
  }, [chats, createInitialFriendId, visibleChats])
  const displayCases = useMemo(() => getDisplayCases(cases, { caseFocus, sortMode }), [cases, caseFocus, sortMode])
  const displayCaseIds = useMemo(() => displayCases.map((item) => item.id), [displayCases])
  const selectedCaseOutsideList = !loading && !detailLoading && isSelectedCaseOutsideCurrentList({
    selectedCaseId: detail?.id ?? null,
    displayedCaseIds: displayCaseIds,
  })
  const outsideCurrentListAction = useMemo(() => getOutsideCurrentListAction(detail?.status), [detail?.status])
  const verifiedStaffRole = staffIdentityReady ? staffRole : ''
  const verifiedStaffName = staffIdentityReady ? staffName : ''
  const hasActiveFilters =
    queueFilter !== 'all' || statusFilter !== 'all' || caseFocus === 'stale' || appliedSearch !== ''
  const caseListEmptyState = useMemo(() => getSupportCaseListEmptyState({
    role: verifiedStaffRole,
    hasActiveFilters,
    statusFilter,
    queueFilter,
    caseFocus,
    search: appliedSearch || search,
  }), [appliedSearch, caseFocus, hasActiveFilters, queueFilter, search, statusFilter, verifiedStaffRole])
  const detailEmptyState = !loading && !detailLoading && displayCases.length === 0
    ? caseListEmptyState
    : undefined
  const identityIssue = getSupportIdentityIssue({
    ready: staffIdentityReady,
    role: verifiedStaffRole,
    staffName: verifiedStaffName,
  })
  const identityUnavailable = Boolean(identityIssue)
  const supportDataReady = canLoadSupportWorkspaceData({
    selectedAccountId,
    staffIdentityReady,
    identityIssue,
  })
  const controlsDisabled = !staffIdentityReady || identityUnavailable || saving || reminderSaving || slackNotificationDeleting || loading || detailLoading
  const busyMessage = (() => {
    if (!staffIdentityReady) return 'ログイン権限を確認中です。'
    if (saving) return '保存中です。完了までお待ちください。'
    if (loading) return '一覧を更新中です。'
    if (detailLoading) return 'チケット詳細を読み込み中です。'
    return null
  })()

  const activeQueueKey = useMemo<QueueKey | null>(() => {
    if (queueFilter !== 'all') return queueFilter as QueueKey
    if (statusFilter === 'resolved') return 'resolved'
    if (statusFilter === 'all') return 'all'
    return null
  }, [queueFilter, statusFilter])
  const secondaryAnsweredCount = summary?.totals.secondaryAnswered ?? 0
  const showSecondaryAnsweredNotice = secondaryAnsweredCount > 0 && activeQueueKey !== 'secondary_answered'

  const assigneeSuggestions = useMemo(() => {
    const names = new Set<string>(staffNames)
    summary?.byAssignee.forEach((row) => {
      if (row.assignee && row.assignee !== '担当者なし') names.add(row.assignee)
    })
    return Array.from(names).sort()
  }, [staffNames, summary])

  const permissions = getSupportRolePermissions(verifiedStaffRole, secondaryCanRespond)
  const canCreateCases = permissions.canCreateCases
  const canEditCaseRouting = permissions.canEditCaseRouting
  const canEditCaseWork = permissions.canEditCaseWork
  const canDeleteSlackNotification = verifiedStaffRole === 'owner' || verifiedStaffRole === 'admin'
  const canEditSelectedCase = detail?.accessMode !== 'shared_proxy' && detail?.canEditCaseWork !== false
  const canEditCustomerResponseDeadline = canEditCaseRouting || (
    verifiedStaffRole === 'staff'
    && Boolean(
      detail?.primaryAssignee?.trim()
      && detail.primaryAssignee.trim().replace(/[\s　]+/g, ' ') === verifiedStaffName.trim().replace(/[\s　]+/g, ' '),
    )
  )

  useEffect(() => {
    const cached = readStaffIdentityCache()
    setStaffName(cached.name)
    setStaffRole(cached.role)
  }, [])

  useEffect(() => {
    let active = true
    api.staff.me()
      .then((res) => {
        if (!active) return
        if (!res.success) {
          setStaffName('')
          setStaffRole('')
          setSecondaryCanRespond(false)
          setStaffIdentityReady(true)
          clearStaffIdentityCache()
          return
        }
        const nextName = res.data.name || ''
        const nextRole = res.data.role || ''
        setStaffName(nextName)
        setStaffRole(nextRole)
        setSecondaryCanRespond(Boolean(res.data.secondaryCanRespond))
        setStaffIdentityReady(true)
        cacheStaffSession({ name: nextName, role: nextRole })
      })
      .catch(() => {
        if (!active) return
        setStaffName('')
        setStaffRole('')
        setSecondaryCanRespond(false)
        setStaffIdentityReady(true)
        clearStaffIdentityCache()
      })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const caseId = params.get('case')
    const createRequested = params.get('create') === '1'
    const createFriendId = params.get('friend') || params.get('createFriend')
    if (caseId) {
      setSelectedCaseId(caseId)
      setMobileCaseOpen(true)
    }
    if (createRequested || createFriendId) {
      setCreateOpen(true)
      setCreateInitialFriendId(createFriendId)
    }
    setCaseQueryReady(true)
  }, [])

  useEffect(() => {
    if (!caseQueryReady || typeof window === 'undefined') return
    const nextSearch = buildSupportCaseSearch(window.location.search, selectedCaseId)
    const nextUrl = `${window.location.pathname}${nextSearch}${window.location.hash}`
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`
    if (nextUrl !== currentUrl) window.history.replaceState(null, '', nextUrl)
  }, [caseQueryReady, selectedCaseId])

  // ─── データ読み込み ───

  const loadCases = useCallback(async () => {
    if (!supportDataReady || !selectedAccountId) return
    const requestId = ++casesRequestRef.current
    const requestAccountId = selectedAccountId
    let summaryRes: Awaited<ReturnType<typeof api.support.summary>>
    let casesRes: Awaited<ReturnType<typeof api.support.cases.list>>
    try {
      [summaryRes, casesRes] = await Promise.all([
        api.support.summary({ accountId: requestAccountId }),
        loadAllSupportCases({
          accountId: requestAccountId,
          status: statusFilter === 'all' ? undefined : statusFilter,
          queue: queueFilter !== 'all'
              ? queueFilter
              : statusFilter === 'all'
                ? 'unresolved'
                : undefined,
          q: appliedSearch || undefined,
        }),
      ])
    } catch (err) {
      if (requestId !== casesRequestRef.current || accountScopeRef.current !== requestAccountId) return
      throw err
    }
    if (requestId !== casesRequestRef.current || accountScopeRef.current !== requestAccountId) return
    if (!summaryRes.success) throw new Error(supportApiErrorMessage(summaryRes, 'チケットサマリーの読み込みに失敗しました'))
    if (!casesRes.success) throw new Error(supportApiErrorMessage(casesRes, 'チケット一覧の読み込みに失敗しました'))
    setSummary(summaryRes.data)
    setCases(casesRes.data)
    // 初回のみ表示順の先頭を自動選択。絞り込みで一覧から消えても選択中のチケットは維持する
    setSelectedCaseId((prev) => prev ?? getInitialSupportCaseId(casesRes.data, { caseFocus, sortMode }))
  }, [selectedAccountId, statusFilter, queueFilter, appliedSearch, supportDataReady, caseFocus, sortMode])

  const loadDetail = useCallback(async (id: string | null, options: { silent?: boolean } = {}) => {
    const requestId = ++detailRequestRef.current
    const requestAccountId = selectedAccountId
    if (!id || !requestAccountId || !supportDataReady) {
      setDetail(null)
      setCaseForm(emptyCaseForm)
      setSavedForm(emptyCaseForm)
      return
    }
    if (detailIdRef.current !== id) {
      setDetail(null)
      setCaseForm(emptyCaseForm)
      setSavedForm(emptyCaseForm)
    }
    if (!options.silent) setDetailLoading(true)
    try {
      const res = await api.support.cases.get(id, requestAccountId)
      if (requestId !== detailRequestRef.current || accountScopeRef.current !== requestAccountId) return
      if (!res.success) {
        setDetail(null)
        setCaseForm(emptyCaseForm)
        setSavedForm(emptyCaseForm)
        throw new Error(supportApiErrorMessage(res, 'チケット詳細の読み込みに失敗しました'))
      }
      setDetail(res.data)
      const form = caseFormFromDetail(res.data)
      setCaseForm(form)
      setSavedForm(form)
    } catch (err) {
      if (requestId !== detailRequestRef.current || accountScopeRef.current !== requestAccountId) return
      throw err
    } finally {
      if (
        !options.silent
        && requestId === detailRequestRef.current
        && accountScopeRef.current === requestAccountId
      ) setDetailLoading(false)
    }
  }, [selectedAccountId, supportDataReady])

  useEffect(() => {
    if (!staffIdentityReady || !identityUnavailable) return
    casesRequestRef.current += 1
    detailRequestRef.current += 1
    setSummary(null)
    setCases([])
    setSelectedCaseId(null)
    setDetail(null)
    setCaseForm(emptyCaseForm)
    setSavedForm(emptyCaseForm)
    setChats([])
    setChatOptionsError(null)
    setLoadError(null)
    setLoading(false)
    setDetailLoading(false)
  }, [identityUnavailable, staffIdentityReady])

  useEffect(() => {
    if (!supportDataReady || !selectedAccountId) {
      setChats([])
      setChatOptionsError(null)
      return
    }
    let active = true
    setChatOptionsError(null)
    api.chats.list({ accountId: selectedAccountId })
      .then((res) => {
        if (!active) return
        if (res.success) {
          setChats(res.data as ChatOption[])
          setChatOptionsError(null)
          return
        }
        setChats([])
        setChatOptionsError(supportApiErrorMessage(res, 'LINE会話候補の取得に失敗しました'))
      })
      .catch((err) => {
        if (!active) return
        setChats([])
        setChatOptionsError(formatSupportErrorMessage(err, 'LINE会話候補の取得に失敗しました'))
      })
    return () => { active = false }
  }, [selectedAccountId, supportDataReady])

  useEffect(() => {
    if (!supportDataReady) {
      setStaffNames([])
      return
    }
    let active = true
    api.staff.assigneeOptions()
      .then((res) => {
        if (active && res.success) {
          setStaffNames(res.data.filter((member) => member.isActive).map((member) => member.name))
        }
      })
      .catch(() => { /* 担当者候補は必須ではない。取得できなくても作成フォームは動く */ })
    return () => { active = false }
  }, [supportDataReady])

  useEffect(() => {
    if (!supportDataReady || !selectedAccountId) return
    let active = true
    setLoading(true)
    setLoadError(null)
    loadCases()
      .catch((err) => {
        if (active) setLoadError(formatSupportErrorMessage(err, 'チケット一覧の読み込みに失敗しました'))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [selectedAccountId, loadCases, supportDataReady])

  useEffect(() => {
    void loadDetail(selectedCaseId).catch((err) => {
      setLoadError(formatSupportErrorMessage(err, 'チケット詳細の読み込みに失敗しました'))
    })
  }, [selectedCaseId, loadDetail])

  // 検索は入力後に自動適用 (ボタン不要)
  useEffect(() => {
    const timer = setTimeout(() => setAppliedSearch(search.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [search])

  const refreshSupportWorkspace = useCallback(() => {
    if (!supportDataReady || !selectedAccountId || document.hidden || saving) return
    void (async () => {
      await loadCases()
      const currentCaseId = selectedCaseIdRef.current
      if (currentCaseId && !dirtyRef.current) {
        await loadDetail(currentCaseId, { silent: true })
      }
    })().catch(() => { /* 自動更新の失敗は次回に任せる */ })
  }, [loadCases, loadDetail, saving, selectedAccountId, supportDataReady])

  // 一覧・件数・選択中チケット詳細を自動更新する。編集中の詳細だけは上書きしない。
  useEffect(() => {
    if (!supportDataReady || !selectedAccountId) return
    const timer = window.setInterval(refreshSupportWorkspace, SUPPORT_REALTIME_POLL_MS)
    return () => window.clearInterval(timer)
  }, [refreshSupportWorkspace, selectedAccountId, supportDataReady])

  useEffect(() => {
    if (!supportDataReady || !selectedAccountId) return
    const handleVisibleRefresh = () => {
      if (!document.hidden) refreshSupportWorkspace()
    }
    window.addEventListener('focus', handleVisibleRefresh)
    window.addEventListener('online', handleVisibleRefresh)
    document.addEventListener('visibilitychange', handleVisibleRefresh)
    return () => {
      window.removeEventListener('focus', handleVisibleRefresh)
      window.removeEventListener('online', handleVisibleRefresh)
      document.removeEventListener('visibilitychange', handleVisibleRefresh)
    }
  }, [refreshSupportWorkspace, selectedAccountId, supportDataReady])

  // 未保存のままタブを閉じる事故を防ぐ
  useEffect(() => {
    if (!dirty) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])

  // ─── 操作 ───

  const selectCase = useCallback(async (id: string) => {
    if (id === selectedCaseId) {
      setMobileCaseOpen(true)
      return
    }
    if (controlsDisabled) return
    if (dirtyRef.current) {
      const ok = await requestConfirm({
        title: '未保存の変更があります',
        message: '保存していない編集内容は破棄されます。別のチケットを開きますか？',
        confirmLabel: '破棄して移動',
        cancelLabel: '戻る',
        tone: 'warning',
      })
      if (!ok) return
    }
    setSelectedCaseId(id)
    setMobileCaseOpen(true)
  }, [controlsDisabled, requestConfirm, selectedCaseId])

  /** 保存。保留/完了のサーバ側必須条件は事前にチェックして分かりやすく伝える */
  const persistCase = useCallback(async (form: CaseFormState, eventBody: string): Promise<boolean> => {
    if (!detail || !selectedAccountId || saving) return false
    const workspace = captureWorkspace()
    const requestAccountId = selectedAccountId
    const requestCaseId = detail.id
    const blockers = getBlockingCaseFormValidationIssues(form)
    if (blockers.length > 0) {
      notify('error', blockers.map((issue) => issue.message).join('\n'))
      return false
    }
    setSaving(true)
    try {
      const secondaryAssigneesChanged = JSON.stringify([...form.escalationAssignees].sort())
        !== JSON.stringify([...savedForm.escalationAssignees].sort())
      const res = await api.support.cases.update(requestCaseId, requestAccountId, {
        ...(canEditCaseRouting ? {
          title: form.title,
          category: form.category,
          priority: form.priority,
          primaryAssignee: form.primaryAssignee || null,
          dueAt: fromInputDateTime(form.dueAt),
          customerNumber: form.customerNumber || null,
          companyName: form.companyName || null,
          contactName: form.contactName || null,
          storeName: form.storeName || null,
          contractType: form.contractType || null,
        } : {}),
        ...(canEditCustomerResponseDeadline && form.customerResponseDueAt !== savedForm.customerResponseDueAt ? {
          customerResponseDueAt: fromInputDateTime(form.customerResponseDueAt),
        } : {}),
        status: form.status,
        nextCheckAt: fromInputDateTime(form.nextCheckAt),
        customerSummary: form.customerSummary,
        internalNote: form.internalNote,
        customerReplyDraft: form.customerReplyDraft,
        resolutionNote: form.resolutionNote,
        eventBody,
      })
      if (!isCurrentWorkspace(workspace)) return false
      if (res.success) {
        if (canEditCaseRouting && secondaryAssigneesChanged && form.status !== 'resolved') {
          const assigneeResult = await api.support.cases.setSecondaryAssignees(
            requestCaseId,
            requestAccountId,
            form.escalationAssignees,
          )
          if (!isCurrentWorkspace(workspace)) return false
          if (!assigneeResult.success) {
            notify('error', 'チケット本体は保存しましたが 二次対応先の更新に失敗しました')
            await Promise.all([loadCases(), loadDetail(requestCaseId)])
            return false
          }
        }
        notify('success', 'チケットを保存しました')
        await Promise.all([loadCases(), loadDetail(requestCaseId)])
        return true
      }
      notify('error', supportApiErrorMessage(res, 'チケットの保存に失敗しました'))
      return false
    } catch (err) {
      if (isCurrentWorkspace(workspace)) {
        notify('error', formatSupportErrorMessage(err, 'チケットの保存に失敗しました'))
      }
      return false
    } finally {
      if (isCurrentWorkspace(workspace)) setSaving(false)
    }
  }, [
    canEditCaseRouting,
    canEditCustomerResponseDeadline,
    captureWorkspace,
    detail,
    isCurrentWorkspace,
    loadCases,
    loadDetail,
    notify,
    savedForm.customerResponseDueAt,
    savedForm.escalationAssignees,
    saving,
    selectedAccountId,
  ])

  const handleSave = useCallback(() => {
    void persistCase(caseForm, '管理画面からチケット情報を更新しました')
  }, [persistCase, caseForm])

  const handleQuickStatus = useCallback(async (status: SupportCaseStatus, eventBody: string): Promise<boolean> => {
    const nextForm = { ...caseForm, status }
    setCaseForm(nextForm)
    if (detail?.accessMode === 'shared_proxy') {
      if (status !== 'resolved' || !detail.canCompleteCase) return false
      if (!nextForm.resolutionNote.trim()) {
        notify('error', '代理完了には対応結果メモが必要です')
        return false
      }
      if (!selectedAccountId || saving) return false
      const workspace = captureWorkspace()
      const requestAccountId = selectedAccountId
      const requestCaseId = detail.id
      setSaving(true)
      try {
        const res = await api.support.cases.completeShared(requestCaseId, requestAccountId, nextForm.resolutionNote)
        if (!isCurrentWorkspace(workspace)) return false
        if (!res.success) {
          notify('error', supportApiErrorMessage(res, '代理完了に失敗しました'))
          return false
        }
        notify('success', '共有チケットを代理で完了しました')
        await Promise.all([loadCases(), loadDetail(requestCaseId)])
        return true
      } catch (err) {
        if (isCurrentWorkspace(workspace)) {
          notify('error', formatSupportErrorMessage(err, '代理完了に失敗しました'))
        }
        return false
      } finally {
        if (isCurrentWorkspace(workspace)) setSaving(false)
      }
    }
    return persistCase(nextForm, eventBody)
  }, [
    captureWorkspace,
    caseForm,
    detail,
    isCurrentWorkspace,
    loadCases,
    loadDetail,
    notify,
    persistCase,
    saving,
    selectedAccountId,
  ])

  const handleEscalationResubmit = useCallback(async (
    escalationId: string,
    additionalInfo: string,
  ): Promise<boolean> => {
    if (!detail || !selectedAccountId || saving) return false
    if (dirtyRef.current) {
      notify('error', '先にチケットの未保存変更を保存または破棄してください')
      return false
    }
    const value = additionalInfo.trim()
    if (!value) {
      notify('error', '追加情報・修正内容を入力してください')
      return false
    }
    const workspace = captureWorkspace()
    const requestCaseId = detail.id
    const requestAccountId = selectedAccountId
    setSaving(true)
    try {
      const res = await api.support.escalations.resubmit(escalationId, requestAccountId, value)
      if (!isCurrentWorkspace(workspace)) return false
      if (!res.success) {
        notify('error', supportApiErrorMessage(res, '二次対応への再提出に失敗しました'))
        return false
      }
      notify('success', '追加情報を付けて二次対応へ再提出しました')
      await Promise.all([loadCases(), loadDetail(requestCaseId)])
      return true
    } catch (err) {
      if (isCurrentWorkspace(workspace)) {
        notify('error', formatSupportErrorMessage(err, '二次対応への再提出に失敗しました'))
      }
      return false
    } finally {
      if (isCurrentWorkspace(workspace)) setSaving(false)
    }
  }, [captureWorkspace, detail, isCurrentWorkspace, loadCases, loadDetail, notify, saving, selectedAccountId])

  const handleDiscard = useCallback(() => {
    setCaseForm(savedForm)
  }, [savedForm])

  const handleFollowUpReminderConfigure = useCallback(async (intervalDays: number) => {
    if (!detail || !selectedAccountId || reminderSaving) return
    const workspace = captureWorkspace()
    const requestCaseId = detail.id
    const requestAccountId = selectedAccountId
    setReminderSaving(true)
    try {
      const res = await api.support.cases.configureFollowUpReminder(requestCaseId, requestAccountId, intervalDays)
      if (!isCurrentWorkspace(workspace)) return
      if (!res.success) {
        notify('error', supportApiErrorMessage(res, 'リマインドの設定に失敗しました'))
        return
      }
      notify('success', detail.followUpReminder?.status === 'active' ? 'リマインド間隔を更新しました' : 'リマインドを開始しました')
      await Promise.all([loadCases(), loadDetail(requestCaseId, { silent: true })])
    } catch (err) {
      if (isCurrentWorkspace(workspace)) {
        notify('error', formatSupportErrorMessage(err, 'リマインドの設定に失敗しました'))
      }
    } finally {
      if (isCurrentWorkspace(workspace)) setReminderSaving(false)
    }
  }, [captureWorkspace, detail, isCurrentWorkspace, selectedAccountId, reminderSaving, notify, loadCases, loadDetail])

  const handleFollowUpReminderConfirm = useCallback(async () => {
    if (!detail || !selectedAccountId || reminderSaving) return
    const workspace = captureWorkspace()
    const requestCaseId = detail.id
    const requestAccountId = selectedAccountId
    setReminderSaving(true)
    try {
      const res = await api.support.cases.confirmFollowUpReminder(requestCaseId, requestAccountId)
      if (!isCurrentWorkspace(workspace)) return
      if (!res.success) {
        notify('error', supportApiErrorMessage(res, '本人確認に失敗しました'))
        return
      }
      notify('success', detail.status === 'resolved' ? '本人確認を完了しました' : `確認しました 次回は${res.data.intervalDays}日後です`)
      await Promise.all([loadCases(), loadDetail(requestCaseId, { silent: true })])
    } catch (err) {
      if (isCurrentWorkspace(workspace)) {
        notify('error', formatSupportErrorMessage(err, '本人確認に失敗しました'))
      }
    } finally {
      if (isCurrentWorkspace(workspace)) setReminderSaving(false)
    }
  }, [captureWorkspace, detail, isCurrentWorkspace, selectedAccountId, reminderSaving, notify, loadCases, loadDetail])

  const handleFollowUpReminderDisable = useCallback(async () => {
    if (!detail || !selectedAccountId || reminderSaving) return
    const workspace = captureWorkspace()
    const requestCaseId = detail.id
    const requestAccountId = selectedAccountId
    const ok = await requestConfirm({
      title: '案件フォローを停止しますか？',
      message: 'これまでの設定と確認履歴は残したまま 今後の通知を停止します',
      confirmLabel: '停止する',
      cancelLabel: '戻る',
      tone: 'warning',
    })
    if (!ok || !isCurrentWorkspace(workspace)) return
    setReminderSaving(true)
    try {
      const res = await api.support.cases.disableFollowUpReminder(requestCaseId, requestAccountId)
      if (!isCurrentWorkspace(workspace)) return
      if (!res.success) {
        notify('error', supportApiErrorMessage(res, 'リマインドの停止に失敗しました'))
        return
      }
      notify('success', 'リマインドを停止しました')
      await Promise.all([loadCases(), loadDetail(requestCaseId, { silent: true })])
    } catch (err) {
      if (isCurrentWorkspace(workspace)) {
        notify('error', formatSupportErrorMessage(err, 'リマインドの停止に失敗しました'))
      }
    } finally {
      if (isCurrentWorkspace(workspace)) setReminderSaving(false)
    }
  }, [captureWorkspace, detail, isCurrentWorkspace, selectedAccountId, reminderSaving, requestConfirm, notify, loadCases, loadDetail])

  const handleDeleteSlackNotification = useCallback(async () => {
    if (!detail || !selectedAccountId || slackNotificationDeleting || !canDeleteSlackNotification) return
    const workspace = captureWorkspace()
    const requestCaseId = detail.id
    const requestAccountId = selectedAccountId
    const ok = await requestConfirm({
      title: 'Slack通知を削除しますか？',
      message: 'ecオーナー通達チャンネル上の通知だけを削除します Lリンク内のチケットと対応ログと過去履歴はすべて残ります',
      confirmLabel: 'Slack通知だけ削除',
      cancelLabel: '戻る',
      tone: 'danger',
    })
    if (!ok || !isCurrentWorkspace(workspace)) return
    setSlackNotificationDeleting(true)
    try {
      const res = await api.support.cases.deleteSlackNotification(requestCaseId, requestAccountId)
      if (!isCurrentWorkspace(workspace)) return
      if (!res.success) {
        notify('error', supportApiErrorMessage(res, 'Slack通知の削除に失敗しました'))
        return
      }
      notify('success', res.data.alreadyDeleted ? 'Slack通知は削除済みです' : 'Slack通知だけを削除しました チケットと履歴は残っています')
      await loadDetail(requestCaseId, { silent: true })
    } catch (err) {
      if (isCurrentWorkspace(workspace)) {
        notify('error', formatSupportErrorMessage(err, 'Slack通知の削除に失敗しました'))
      }
    } finally {
      if (isCurrentWorkspace(workspace)) setSlackNotificationDeleting(false)
    }
  }, [
    canDeleteSlackNotification,
    captureWorkspace,
    detail,
    isCurrentWorkspace,
    loadDetail,
    notify,
    requestConfirm,
    selectedAccountId,
    slackNotificationDeleting,
  ])

  const clearCreateDeepLink = useCallback(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    params.delete('create')
    params.delete('friend')
    params.delete('createFriend')
    const next = params.toString()
    window.history.replaceState(null, '', `${window.location.pathname}${next ? `?${next}` : ''}${window.location.hash}`)
  }, [])

  const handleCreate = useCallback(async (input: CreateCaseInput, attachments: File[]): Promise<boolean> => {
    if (!selectedAccountId || saving) return false
    const workspace = captureWorkspace()
    const requestAccountId = selectedAccountId
    const blockingIssue = getCreateCaseValidationIssues(input).find((issue) => issue.blocking)
    if (blockingIssue) {
      notify('error', blockingIssue.message)
      return false
    }
    if (dirtyRef.current) {
      const ok = await requestConfirm({
        title: '未保存の変更があります',
        message: '保存していない編集内容は破棄されます。このまま新しいチケットを作成しますか？',
        confirmLabel: '破棄して作成',
        cancelLabel: '戻る',
        tone: 'warning',
      })
      if (!ok || !isCurrentWorkspace(workspace)) return false
    }
    setSaving(true)
    try {
      const res = await api.support.cases.create({
        lineAccountId: requestAccountId,
        friendId: input.friendId || null,
        title: input.title,
        category: input.category,
        priority: input.priority,
        primaryAssignee: input.primaryAssignee || null,
        escalationAssignee: input.escalationAssignees[0] || null,
        escalationAssignees: input.escalationAssignees,
        dueAt: fromInputDateTime(input.dueAt),
        customerResponseDueAt: fromInputDateTime(input.customerResponseDueAt),
        customerSummary: input.customerSummary,
      })
      if (!isCurrentWorkspace(workspace)) return false
      if (res.success) {
        const attachmentResults = await Promise.allSettled(
          attachments.map((file) => api.support.cases.uploadAttachment(res.data.id, requestAccountId, file)),
        )
        if (!isCurrentWorkspace(workspace)) return false
        const failedAttachments = attachmentResults.filter((result) => result.status === 'rejected').length
        notify(
          failedAttachments > 0 ? 'error' : 'success',
          failedAttachments > 0
            ? `チケットは作成済みです。画像${failedAttachments}件の添付だけ失敗しました`
            : attachments.length > 0 ? 'チケットと画像を登録しました' : 'チケットを作成しました',
        )
        setCreateInitialFriendId(null)
        clearCreateDeepLink()
        setSelectedCaseId(res.data.id)
        await loadCases()
        return true
      }
      notify('error', supportApiErrorMessage(res, 'チケットの作成に失敗しました'))
      return false
    } catch (err) {
      if (isCurrentWorkspace(workspace)) {
        notify('error', formatSupportErrorMessage(err, 'チケットの作成に失敗しました'))
      }
      return false
    } finally {
      if (isCurrentWorkspace(workspace)) setSaving(false)
    }
  }, [
    captureWorkspace,
    clearCreateDeepLink,
    isCurrentWorkspace,
    loadCases,
    notify,
    requestConfirm,
    saving,
    selectedAccountId,
  ])

  const handleCopyReplyDraft = useCallback(async () => {
    const result = await copyText(caseForm.customerReplyDraft)
    if (result.ok) {
      notify('success', '返信案をコピーしました')
    } else {
      notify('error', '返信案のコピーに失敗しました。チャットで返信を使うか、文章を選択してコピーしてください。')
    }
  }, [caseForm.customerReplyDraft, notify])

  const handleCreateInternalMessage = useCallback(async (body: string, parentId: string | null, mentions: string[]): Promise<boolean> => {
    if (!detail || !selectedAccountId || saving) return false
    const workspace = captureWorkspace()
    const requestCaseId = detail.id
    const requestAccountId = selectedAccountId
    setSaving(true)
    try {
      const res = await api.support.cases.addInternalMessage(requestCaseId, requestAccountId, {
        body,
        parentId,
        mentions,
      })
      if (!isCurrentWorkspace(workspace)) return false
      if (!res.success) {
        notify('error', supportApiErrorMessage(res, '社内チャットの投稿に失敗しました'))
        return false
      }
      notify('success', parentId ? 'スレッドに返信しました' : '社内チャットに投稿しました')
      await loadDetail(requestCaseId)
      return true
    } catch (err) {
      if (isCurrentWorkspace(workspace)) {
        notify('error', formatSupportErrorMessage(err, '社内チャットの投稿に失敗しました'))
      }
      return false
    } finally {
      if (isCurrentWorkspace(workspace)) setSaving(false)
    }
  }, [captureWorkspace, detail, isCurrentWorkspace, loadDetail, notify, saving, selectedAccountId])

  const handleInternalMessageReaction = useCallback(async (messageId: string, emoji: string): Promise<void> => {
    if (!detail || !selectedAccountId || saving) return
    const workspace = captureWorkspace()
    const requestCaseId = detail.id
    const requestAccountId = selectedAccountId
    try {
      const res = await api.support.cases.toggleInternalReaction(requestCaseId, requestAccountId, messageId, emoji)
      if (!isCurrentWorkspace(workspace)) return
      if (!res.success) {
        notify('error', supportApiErrorMessage(res, 'リアクションの更新に失敗しました'))
        return
      }
      setDetail((prev) => prev
        && prev.id === requestCaseId ? {
            ...prev,
            internalMessages: prev.internalMessages.map((message) => (
              message.id === res.data.id ? res.data : message
            )),
          }
        : prev)
    } catch (err) {
      if (isCurrentWorkspace(workspace)) {
        notify('error', formatSupportErrorMessage(err, 'リアクションの更新に失敗しました'))
      }
    }
  }, [captureWorkspace, detail, isCurrentWorkspace, notify, saving, selectedAccountId])

  const handleOpenChatWithDraft = useCallback(async () => {
    if (!detail?.friendId || !selectedAccountId) return
    const draft = caseForm.customerReplyDraft.trim()
    if (!draft) {
      notify('error', '顧客向け返信案を入力してください')
      return
    }
    if (dirtyRef.current && !(await persistCase(caseForm, 'チャット返信前にチケット情報を保存しました'))) {
      return
    }
    try {
      const context = createSupportChatDraftContext({
        friendId: detail.friendId,
        caseId: detail.id,
        lineAccountId: selectedAccountId,
        caseTitle: caseForm.title || detail.title,
        draft,
      })
      try {
        tryStoreSupportChatDraft(window.sessionStorage, context)
      } catch {
        // URL params still keep the support case linked when sessionStorage is blocked.
      }
      window.location.assign(buildSupportChatDraftUrl(context))
    } catch {
      notify('error', 'チャット返信の準備に失敗しました')
      return
    }
  }, [caseForm, detail, selectedAccountId, notify, persistCase])

  const handleQueueSelect = useCallback((key: QueueKey) => {
    if (controlsDisabled) return
    setMobileCaseOpen(false)
    const toggleOff = activeQueueKey === key && key !== 'all'
    if (toggleOff || key === 'all') {
      setQueueFilter('all')
      setStatusFilter('all')
      setCaseFocus('all')
      return
    }
    if (key === 'resolved') {
      setQueueFilter('all')
      setStatusFilter('resolved')
      setCaseFocus('all')
      return
    }
    setQueueFilter(key)
    setStatusFilter('all')
    setCaseFocus('all')
  }, [activeQueueKey, controlsDisabled])

  const handleResetFilters = useCallback(() => {
    if (controlsDisabled) return
    setMobileCaseOpen(false)
    setQueueFilter('all')
    setStatusFilter('all')
    setCaseFocus('all')
    setSearch('')
    setAppliedSearch('')
  }, [controlsDisabled])

  const revealSelectedCaseInList = useCallback(() => {
    if (controlsDisabled) return
    setQueueFilter(outsideCurrentListAction.queueFilter)
    setStatusFilter(outsideCurrentListAction.statusFilter)
    setCaseFocus(outsideCurrentListAction.caseFocus)
    setSearch('')
    setAppliedSearch('')
  }, [controlsDisabled, outsideCurrentListAction])

  const refreshAll = useCallback(async () => {
    if (!selectedAccountId || controlsDisabled) return
    if (dirtyRef.current) {
      const ok = await requestConfirm({
        title: '未保存の変更があります',
        message: '保存していない編集内容は破棄されます。最新データで再読み込みしますか？',
        confirmLabel: '破棄して再読み込み',
        cancelLabel: '戻る',
        tone: 'warning',
      })
      if (!ok) return
    }
    setLoading(true)
    setLoadError(null)
    try {
      await Promise.all([
        loadCases(),
        selectedCaseId ? loadDetail(selectedCaseId) : Promise.resolve(),
      ])
    } catch (err) {
      setLoadError(formatSupportErrorMessage(err, '更新に失敗しました'))
    } finally {
      setLoading(false)
    }
  }, [selectedAccountId, selectedCaseId, controlsDisabled, requestConfirm, loadCases, loadDetail])

  // ⌘S / Ctrl+S で保存、↑↓ / j k でチケット移動 (入力中は無効)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (canEditCaseWork && dirtyRef.current && detail && !saving) {
          void persistCase(caseForm, '管理画面からチケット情報を更新しました')
        }
        return
      }
      const target = e.target as HTMLElement | null
      const tag = target?.tagName ?? ''
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return
      if (e.key === 'ArrowDown' || e.key === 'j' || e.key === 'ArrowUp' || e.key === 'k') {
        if (displayCases.length === 0) return
        e.preventDefault()
        const delta = e.key === 'ArrowDown' || e.key === 'j' ? 1 : -1
        const index = displayCases.findIndex((item) => item.id === selectedCaseId)
        const nextIndex = index < 0 ? 0 : Math.min(displayCases.length - 1, Math.max(0, index + delta))
        const next = displayCases[nextIndex]
        if (next && next.id !== selectedCaseId) void selectCase(next.id)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [displayCases, selectedCaseId, selectCase, detail, saving, persistCase, caseForm, canEditCaseWork])

  if (accountLoading || accountScopeRef.current !== selectedAccountId) {
    return <div className="p-6 text-sm text-gray-500">読み込み中…</div>
  }

  return (
    <div className="space-y-4">
      <Header
        title="チケット管理"
        description={`${accountName} の問い合わせチケットを一元管理`}
        action={
          <div className="flex items-center gap-2">
            {canCreateCases && (
              <button
                type="button"
                onClick={() => setCreateOpen((prev) => !prev)}
                disabled={controlsDisabled}
                className={btnBrandCls}
                aria-expanded={createOpen}
              >
                <PlusIcon className="h-4 w-4" />
                新規チケット
              </button>
            )}
            <button onClick={() => void refreshAll()} disabled={controlsDisabled} className={btnSecondaryCls}>
              {loading ? '更新中…' : saving ? '保存中…' : '更新'}
            </button>
          </div>
        }
      />

      {loadError && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <span>{loadError}</span>
          <button
            type="button"
            onClick={() => void refreshAll()}
            disabled={controlsDisabled}
            className="shrink-0 rounded-md border border-red-300 bg-white px-2.5 py-1 text-xs font-medium text-red-700 transition-colors hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            再読み込み
          </button>
        </div>
      )}

      {identityUnavailable && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
          {identityIssue}
        </div>
      )}

      {busyMessage && (
        <div
          role="status"
          aria-live="polite"
          className="rounded-md border border-blue-200 bg-blue-50 px-4 py-2 text-sm font-medium text-blue-800"
        >
          {busyMessage}
        </div>
      )}

      <QueueStrip
        summary={summary}
        activeKey={activeQueueKey}
        staffName={verifiedStaffName}
        staffRole={verifiedStaffRole}
        disabled={controlsDisabled}
        onSelect={handleQueueSelect}
      />

      {showSecondaryAnsweredNotice && (
        <button
          type="button"
          onClick={() => handleQueueSelect('secondary_answered')}
          disabled={controlsDisabled}
          className="flex w-full flex-wrap items-center justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-left text-emerald-900 shadow-sm transition-colors hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <span>
            <span className="block text-sm font-semibold">二次対応から回答が戻っています</span>
            <span className="mt-0.5 block text-xs text-emerald-700">一次対応者が確認して顧客へ返すチケットです。</span>
          </span>
          <span className="rounded-md bg-white px-3 py-1.5 text-sm font-semibold text-emerald-700 ring-1 ring-emerald-200">
            {secondaryAnsweredCount}件を見る
          </span>
        </button>
      )}

      {verifiedStaffRole === 'staff' && (
        <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          自分が担当するチケットに加え オーナーが共有設定した一次対応者のチケットも確認できます 共有チケットは代理完了だけ実行できます
        </div>
      )}

      {verifiedStaffRole === 'secondary' && (
        <div className="rounded-md border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-800">
          自分が二次対応先に指定されたチケットだけを閲覧しています。チケット本体の変更と顧客LINEの会話履歴は制限されています。
        </div>
      )}

      {canCreateCases && createOpen && chatOptionsError && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" role="status">
          {chatOptionsError}。会話に紐付けないチケット化はできますが、LINE会話の候補は更新後にもう一度確認してください。
        </div>
      )}

      {canCreateCases && createOpen && (
        <CreateCasePanel
          chats={createPanelChats}
          staffName={verifiedStaffName}
          staffOptions={assigneeSuggestions}
          initialFriendId={createInitialFriendId}
          draftScope={selectedAccountId}
          saving={saving}
          onCreate={handleCreate}
          onClose={() => {
            setCreateOpen(false)
            setCreateInitialFriendId(null)
            clearCreateDeepLink()
          }}
        />
      )}

      <div className="grid min-h-0 gap-4 lg:h-[calc(100vh-320px)] lg:min-h-[680px] lg:grid-cols-[minmax(300px,360px)_minmax(0,1fr)] lg:items-stretch xl:grid-cols-[minmax(320px,380px)_minmax(0,1fr)] 2xl:grid-cols-[minmax(340px,400px)_minmax(0,1fr)]">
        <div className={`${mobileCaseOpen ? 'hidden lg:block' : 'block'} min-h-0`}>
          <CaseList
            cases={displayCases}
            loading={loading}
            selectedCaseId={selectedCaseId}
            statusFilter={statusFilter}
            sortMode={sortMode}
            search={search}
            emptyState={caseListEmptyState}
            disabled={controlsDisabled}
            onSelect={selectCase}
            onStatusFilterChange={(value) => {
              setMobileCaseOpen(false)
              setStatusFilter(value)
              setQueueFilter('all')
              setCaseFocus('all')
            }}
            onSortChange={setSortMode}
            onSearchChange={setSearch}
            onResetFilters={handleResetFilters}
          />
        </div>

        <div className={`${mobileCaseOpen ? 'flex' : 'hidden lg:flex'} min-h-0 flex-col`}>
          <button
            type="button"
            onClick={() => setMobileCaseOpen(false)}
            className="mb-2 inline-flex min-h-11 w-full items-center gap-2 rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 shadow-sm lg:hidden"
          >
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m15 18-6-6 6-6" />
            </svg>
            チケット一覧に戻る
          </button>
          <div className="min-h-0 flex-1">
            <CaseDetail
              detail={detail}
              detailLoading={detailLoading}
              caseForm={caseForm}
              dirty={dirty}
              saving={saving}
              reminderSaving={reminderSaving}
              slackNotificationDeleting={slackNotificationDeleting}
              canEditRouting={canEditCaseRouting && canEditSelectedCase}
              canEditCaseWork={canEditCaseWork && canEditSelectedCase}
              canEditCustomerResponseDeadline={canEditCustomerResponseDeadline && canEditSelectedCase}
              canCompleteCase={detail?.canCompleteCase ?? canEditCaseWork}
              canDeleteSlackNotification={canDeleteSlackNotification}
              staffOptions={assigneeSuggestions}
              staffName={verifiedStaffName}
              onFormChange={(patch) => setCaseForm((prev) => ({ ...prev, ...patch }))}
              onSave={handleSave}
              onDiscard={handleDiscard}
              onQuickStatus={handleQuickStatus}
              onEscalationResubmit={handleEscalationResubmit}
              onInternalMessageCreate={handleCreateInternalMessage}
              onInternalMessageReaction={handleInternalMessageReaction}
              onFollowUpReminderConfigure={handleFollowUpReminderConfigure}
              onFollowUpReminderConfirm={handleFollowUpReminderConfirm}
              onFollowUpReminderDisable={handleFollowUpReminderDisable}
              onDeleteSlackNotification={handleDeleteSlackNotification}
              onOpenChatWithDraft={() => void handleOpenChatWithDraft()}
              onCopyReplyDraft={() => void handleCopyReplyDraft()}
              emptyState={detailEmptyState}
              outsideCurrentList={selectedCaseOutsideList}
              outsideCurrentListActionLabel={outsideCurrentListAction.label}
              onResetFilters={revealSelectedCaseInList}
            />
          </div>
        </div>
      </div>

      {/* 一次担当・二次対応先入力のサジェスト (スタッフ + 既存担当者) */}
      <datalist id="support-staff-names">
        {assigneeSuggestions.map((name) => <option key={name} value={name} />)}
      </datalist>

      {confirmDialog}
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  )
}

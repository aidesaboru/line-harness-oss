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
  const [detail, setDetail] = useState<SupportCaseDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [chats, setChats] = useState<ChatOption[]>([])
  const [staffNames, setStaffNames] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [statusFilter, setStatusFilter] = useState('all')
  const [queueFilter, setQueueFilter] = useState('all')
  const [caseFocus, setCaseFocus] = useState<CaseFocus>('all')
  const [sortMode, setSortMode] = useState<CaseSortMode>('updated')
  const [search, setSearch] = useState('')
  const [appliedSearch, setAppliedSearch] = useState('')
  const [staffName, setStaffName] = useState('')
  const [staffRole, setStaffRole] = useState('')
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
  const casesRequestRef = useRef(0)
  const detailRequestRef = useRef(0)
  const detailIdRef = useRef<string | null>(null)
  useEffect(() => { detailIdRef.current = detail?.id ?? null }, [detail?.id])

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
  const controlsDisabled = !staffIdentityReady || identityUnavailable || saving || loading || detailLoading
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

  const permissions = getSupportRolePermissions(verifiedStaffRole)
  const canCreateCases = permissions.canCreateCases
  const canEditCaseRouting = permissions.canEditCaseRouting

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
          setStaffIdentityReady(true)
          clearStaffIdentityCache()
          return
        }
        const nextName = res.data.name || ''
        const nextRole = res.data.role || ''
        setStaffName(nextName)
        setStaffRole(nextRole)
        setStaffIdentityReady(true)
        cacheStaffSession({ name: nextName, role: nextRole })
      })
      .catch(() => {
        if (!active) return
        setStaffName('')
        setStaffRole('')
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
    if (caseId) setSelectedCaseId(caseId)
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
    let summaryRes: Awaited<ReturnType<typeof api.support.summary>>
    let casesRes: Awaited<ReturnType<typeof api.support.cases.list>>
    try {
      [summaryRes, casesRes] = await Promise.all([
        api.support.summary({ accountId: selectedAccountId }),
        loadAllSupportCases({
          accountId: selectedAccountId,
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
      if (requestId !== casesRequestRef.current) return
      throw err
    }
    if (requestId !== casesRequestRef.current) return
    if (!summaryRes.success) throw new Error(supportApiErrorMessage(summaryRes, 'チケットサマリーの読み込みに失敗しました'))
    if (!casesRes.success) throw new Error(supportApiErrorMessage(casesRes, 'チケット一覧の読み込みに失敗しました'))
    setSummary(summaryRes.data)
    setCases(casesRes.data)
    // 初回のみ表示順の先頭を自動選択。絞り込みで一覧から消えても選択中のチケットは維持する
    setSelectedCaseId((prev) => prev ?? getInitialSupportCaseId(casesRes.data, { caseFocus, sortMode }))
  }, [selectedAccountId, statusFilter, queueFilter, appliedSearch, supportDataReady, caseFocus, sortMode])

  const loadDetail = useCallback(async (id: string | null, options: { silent?: boolean } = {}) => {
    const requestId = ++detailRequestRef.current
    if (!id || !selectedAccountId || !supportDataReady) {
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
      const res = await api.support.cases.get(id, selectedAccountId)
      if (requestId !== detailRequestRef.current) return
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
      if (requestId !== detailRequestRef.current) return
      throw err
    } finally {
      if (!options.silent && requestId === detailRequestRef.current) setDetailLoading(false)
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
    if (id === selectedCaseId) return
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
  }, [controlsDisabled, requestConfirm, selectedCaseId])

  /** 保存。保留/完了のサーバ側必須条件は事前にチェックして分かりやすく伝える */
  const persistCase = useCallback(async (form: CaseFormState, eventBody: string): Promise<boolean> => {
    if (!detail || !selectedAccountId || saving) return false
    const blockers = getBlockingCaseFormValidationIssues(form)
    if (blockers.length > 0) {
      notify('error', blockers.map((issue) => issue.message).join('\n'))
      return false
    }
    setSaving(true)
    try {
      const res = await api.support.cases.update(detail.id, selectedAccountId, {
        ...(canEditCaseRouting ? {
          title: form.title,
          category: form.category,
          priority: form.priority,
          primaryAssignee: form.primaryAssignee || null,
          escalationAssignee: form.escalationAssignee || null,
          dueAt: fromInputDateTime(form.dueAt),
          customerNumber: form.customerNumber || null,
          companyName: form.companyName || null,
          contactName: form.contactName || null,
          storeName: form.storeName || null,
          contractType: form.contractType || null,
        } : {}),
        status: form.status,
        nextCheckAt: fromInputDateTime(form.nextCheckAt),
        customerSummary: form.customerSummary,
        internalNote: form.internalNote,
        customerReplyDraft: form.customerReplyDraft,
        resolutionNote: form.resolutionNote,
        eventBody,
      })
      if (res.success) {
        notify('success', 'チケットを保存しました')
        await Promise.all([loadCases(), loadDetail(detail.id)])
        return true
      }
      notify('error', supportApiErrorMessage(res, 'チケットの保存に失敗しました'))
      return false
    } catch (err) {
      notify('error', formatSupportErrorMessage(err, 'チケットの保存に失敗しました'))
      return false
    } finally {
      setSaving(false)
    }
  }, [detail, selectedAccountId, saving, canEditCaseRouting, notify, loadCases, loadDetail])

  const handleSave = useCallback(() => {
    void persistCase(caseForm, '管理画面からチケット情報を更新しました')
  }, [persistCase, caseForm])

  const handleQuickStatus = useCallback(async (status: SupportCaseStatus, eventBody: string): Promise<boolean> => {
    const nextForm = { ...caseForm, status }
    setCaseForm(nextForm)
    return persistCase(nextForm, eventBody)
  }, [caseForm, persistCase])

  const handleDiscard = useCallback(() => {
    setCaseForm(savedForm)
  }, [savedForm])

  const clearCreateDeepLink = useCallback(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    params.delete('create')
    params.delete('friend')
    params.delete('createFriend')
    const next = params.toString()
    window.history.replaceState(null, '', `${window.location.pathname}${next ? `?${next}` : ''}${window.location.hash}`)
  }, [])

  const handleCreate = useCallback(async (input: CreateCaseInput): Promise<boolean> => {
    if (!selectedAccountId || saving) return false
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
      if (!ok) return false
    }
    setSaving(true)
    try {
      const res = await api.support.cases.create({
        lineAccountId: selectedAccountId,
        friendId: input.friendId || null,
        title: input.title,
        category: input.category,
        priority: input.priority,
        primaryAssignee: input.primaryAssignee || null,
        escalationAssignee: input.escalationAssignee || null,
        dueAt: fromInputDateTime(input.dueAt),
        customerSummary: input.customerSummary,
      })
      if (res.success) {
        notify('success', 'チケットを作成しました')
        setCreateInitialFriendId(null)
        clearCreateDeepLink()
        setSelectedCaseId(res.data.id)
        await loadCases()
        return true
      }
      notify('error', supportApiErrorMessage(res, 'チケットの作成に失敗しました'))
      return false
    } catch (err) {
      notify('error', formatSupportErrorMessage(err, 'チケットの作成に失敗しました'))
      return false
    } finally {
      setSaving(false)
    }
  }, [selectedAccountId, saving, requestConfirm, notify, loadCases, clearCreateDeepLink])

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
    setSaving(true)
    try {
      const res = await api.support.cases.addInternalMessage(detail.id, selectedAccountId, {
        body,
        parentId,
        mentions,
      })
      if (!res.success) {
        notify('error', supportApiErrorMessage(res, '社内チャットの投稿に失敗しました'))
        return false
      }
      notify('success', parentId ? 'スレッドに返信しました' : '社内チャットに投稿しました')
      await loadDetail(detail.id)
      return true
    } catch (err) {
      notify('error', formatSupportErrorMessage(err, '社内チャットの投稿に失敗しました'))
      return false
    } finally {
      setSaving(false)
    }
  }, [detail, loadDetail, notify, saving, selectedAccountId])

  const handleInternalMessageReaction = useCallback(async (messageId: string, emoji: string): Promise<void> => {
    if (!detail || !selectedAccountId || saving) return
    try {
      const res = await api.support.cases.toggleInternalReaction(detail.id, selectedAccountId, messageId, emoji)
      if (!res.success) {
        notify('error', supportApiErrorMessage(res, 'リアクションの更新に失敗しました'))
        return
      }
      setDetail((prev) => prev
        ? {
            ...prev,
            internalMessages: prev.internalMessages.map((message) => (
              message.id === res.data.id ? res.data : message
            )),
          }
        : prev)
    } catch (err) {
      notify('error', formatSupportErrorMessage(err, 'リアクションの更新に失敗しました'))
    }
  }, [detail, notify, saving, selectedAccountId])

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
        if (dirtyRef.current && detail && !saving) void persistCase(caseForm, '管理画面からチケット情報を更新しました')
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
  }, [displayCases, selectedCaseId, selectCase, detail, saving, persistCase, caseForm])

  if (accountLoading) {
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
          staff権限では、自分が作成・担当・エスカレ先になっているチケットと、そのチケットに紐づくチャットだけが表示されます。
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
            setStatusFilter(value)
            setQueueFilter('all')
            setCaseFocus('all')
          }}
          onSortChange={setSortMode}
          onSearchChange={setSearch}
          onResetFilters={handleResetFilters}
        />

        <CaseDetail
          detail={detail}
          detailLoading={detailLoading}
          caseForm={caseForm}
          dirty={dirty}
          saving={saving}
          canEditRouting={canEditCaseRouting}
          staffOptions={assigneeSuggestions}
          staffName={verifiedStaffName}
          onFormChange={(patch) => setCaseForm((prev) => ({ ...prev, ...patch }))}
          onSave={handleSave}
          onDiscard={handleDiscard}
          onQuickStatus={handleQuickStatus}
          onInternalMessageCreate={handleCreateInternalMessage}
          onInternalMessageReaction={handleInternalMessageReaction}
          onOpenChatWithDraft={() => void handleOpenChatWithDraft()}
          onCopyReplyDraft={() => void handleCopyReplyDraft()}
          emptyState={detailEmptyState}
          outsideCurrentList={selectedCaseOutsideList}
          outsideCurrentListActionLabel={outsideCurrentListAction.label}
          onResetFilters={revealSelectedCaseInList}
        />
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

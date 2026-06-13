'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Header from '@/components/layout/header'
import { useAccount } from '@/contexts/account-context'
import {
  api,
  type SupportCase,
  type SupportCaseDetail,
  type SupportCaseStatus,
  type SupportEscalationStatus,
  type SupportManual,
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
import CaseDetail, { type DetailTab } from '@/components/support/case-detail'
import CaseList from '@/components/support/case-list'
import CreateCasePanel, { type ChatOption, type CreateCaseInput } from '@/components/support/create-case-panel'
import EscalationPanel, { type EscalateInput } from '@/components/support/escalation-panel'
import ManualPanel, { type ManualEditorInput } from '@/components/support/manual-panel'
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
  getEscalationDraftValidationIssues,
  getManualEditorValidationIssues,
  getInitialSupportCaseId,
  getOutsideCurrentListAction,
  getSupportCaseListEmptyState,
  getSupportIdentityIssue,
  getSupportRolePermissions,
  isStaleCase,
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
const AUTO_REFRESH_MS = 60 * 1000

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
  const [manuals, setManuals] = useState<SupportManual[]>([])
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
  const [manualSearch, setManualSearch] = useState('')
  const [appliedManualSearch, setAppliedManualSearch] = useState('')
  const [manualCategory, setManualCategory] = useState('all')
  const [detailTab, setDetailTab] = useState<DetailTab>('work')
  const [staffName, setStaffName] = useState('')
  const [staffRole, setStaffRole] = useState('')
  const [staffIdentityReady, setStaffIdentityReady] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
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
  const casesRequestRef = useRef(0)
  const detailRequestRef = useRef(0)
  const detailIdRef = useRef<string | null>(null)
  useEffect(() => { detailIdRef.current = detail?.id ?? null }, [detail?.id])

  const visibleChats = useMemo(() => chats.slice(0, 80), [chats])
  const staleCaseCount = useMemo(() => cases.filter(isStaleCase).length, [cases])
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
    if (detailLoading) return '案件詳細を読み込み中です。'
    return null
  })()

  const activeQueueKey = useMemo<QueueKey | null>(() => {
    if (caseFocus === 'stale') return 'stale'
    if (queueFilter !== 'all') return queueFilter as QueueKey
    if (statusFilter === 'resolved') return 'resolved'
    if (statusFilter === 'all') return 'all'
    return null
  }, [caseFocus, queueFilter, statusFilter])

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
  const canManageManuals = permissions.canManageManuals

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
    if (caseId) setSelectedCaseId(caseId)
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
        api.support.cases.list({
          accountId: selectedAccountId,
          status: statusFilter === 'all' ? undefined : statusFilter,
          queue: queueFilter === 'my_escalations'
            ? undefined
            : queueFilter !== 'all'
              ? queueFilter
              : statusFilter === 'all'
                ? 'unresolved'
                : undefined,
          scope: queueFilter === 'my_escalations' ? 'my_escalations' : undefined,
          q: appliedSearch || undefined,
        }),
      ])
    } catch (err) {
      if (requestId !== casesRequestRef.current) return
      throw err
    }
    if (requestId !== casesRequestRef.current) return
    if (!summaryRes.success) throw new Error(supportApiErrorMessage(summaryRes, '案件サマリーの読み込みに失敗しました'))
    if (!casesRes.success) throw new Error(supportApiErrorMessage(casesRes, '案件一覧の読み込みに失敗しました'))
    setSummary(summaryRes.data)
    setCases(casesRes.data)
    // 初回のみ表示順の先頭を自動選択。絞り込みで一覧から消えても選択中の案件は維持する
    setSelectedCaseId((prev) => prev ?? getInitialSupportCaseId(casesRes.data, { caseFocus, sortMode }))
  }, [selectedAccountId, statusFilter, queueFilter, appliedSearch, supportDataReady, caseFocus, sortMode])

  const loadDetail = useCallback(async (id: string | null) => {
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
    setDetailLoading(true)
    try {
      const res = await api.support.cases.get(id, selectedAccountId)
      if (requestId !== detailRequestRef.current) return
      if (!res.success) {
        setDetail(null)
        setCaseForm(emptyCaseForm)
        setSavedForm(emptyCaseForm)
        throw new Error(supportApiErrorMessage(res, '案件詳細の読み込みに失敗しました'))
      }
      setDetail(res.data)
      const form = caseFormFromDetail(res.data)
      setCaseForm(form)
      setSavedForm(form)
    } catch (err) {
      if (requestId !== detailRequestRef.current) return
      throw err
    } finally {
      if (requestId === detailRequestRef.current) setDetailLoading(false)
    }
  }, [selectedAccountId, supportDataReady])

  const loadManuals = useCallback(async () => {
    if (!selectedAccountId || !supportDataReady) return
    const res = await api.support.manuals.list({
      accountId: selectedAccountId,
      category: manualCategory === 'all' ? undefined : manualCategory,
      q: appliedManualSearch || undefined,
      active: '1',
    })
    if (!res.success) throw new Error(supportApiErrorMessage(res, 'マニュアルの読み込みに失敗しました'))
    setManuals(res.data)
  }, [selectedAccountId, manualCategory, appliedManualSearch, supportDataReady])

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
    setManuals([])
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
    api.staff.list()
      .then((res) => {
        if (active && res.success) {
          setStaffNames(res.data.filter((member) => member.isActive).map((member) => member.name))
        }
      })
      .catch(() => { /* staff権限では取得できない場合がある。サジェストなしで動作 */ })
    return () => { active = false }
  }, [supportDataReady])

  useEffect(() => {
    if (!supportDataReady || !selectedAccountId) return
    let active = true
    setLoading(true)
    setLoadError(null)
    loadCases()
      .catch((err) => {
        if (active) setLoadError(formatSupportErrorMessage(err, '案件一覧の読み込みに失敗しました'))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [selectedAccountId, loadCases, supportDataReady])

  useEffect(() => {
    if (!supportDataReady || !selectedAccountId) return
    let active = true
    loadManuals().catch((err) => {
      if (active) setLoadError(formatSupportErrorMessage(err, 'マニュアルの読み込みに失敗しました'))
    })
    return () => { active = false }
  }, [selectedAccountId, loadManuals, supportDataReady])

  useEffect(() => {
    void loadDetail(selectedCaseId).catch((err) => {
      setLoadError(formatSupportErrorMessage(err, '案件詳細の読み込みに失敗しました'))
    })
    setDetailTab('work')
  }, [selectedCaseId, loadDetail])

  // 検索は入力後に自動適用 (ボタン不要)
  useEffect(() => {
    const timer = setTimeout(() => setAppliedSearch(search.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [search])

  useEffect(() => {
    const timer = setTimeout(() => setAppliedManualSearch(manualSearch.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [manualSearch])

  // 一覧と件数は60秒ごとに自動更新 (編集中・保存中・非表示タブはスキップ)
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.hidden || dirtyRef.current) return
      void loadCases().catch(() => { /* 自動更新の失敗は次回に任せる */ })
    }, AUTO_REFRESH_MS)
    return () => clearInterval(timer)
  }, [loadCases])

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
        message: '保存していない編集内容は破棄されます。別の案件を開きますか？',
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
        notify('success', '案件を保存しました')
        await Promise.all([loadCases(), loadDetail(detail.id)])
        return true
      }
      notify('error', supportApiErrorMessage(res, '案件の保存に失敗しました'))
      return false
    } catch (err) {
      notify('error', formatSupportErrorMessage(err, '案件の保存に失敗しました'))
      return false
    } finally {
      setSaving(false)
    }
  }, [detail, selectedAccountId, saving, canEditCaseRouting, notify, loadCases, loadDetail])

  const handleSave = useCallback(() => {
    void persistCase(caseForm, '管理画面から案件情報を更新しました')
  }, [persistCase, caseForm])

  const handleQuickStatus = useCallback(async (status: SupportCaseStatus, eventBody: string): Promise<boolean> => {
    const nextForm = { ...caseForm, status }
    setCaseForm(nextForm)
    return persistCase(nextForm, eventBody)
  }, [caseForm, persistCase])

  const handleDiscard = useCallback(() => {
    setCaseForm(savedForm)
  }, [savedForm])

  /** エスカレ作成や紐付けの前に、未保存の編集を先に保存して消失を防ぐ */
  const ensureSaved = useCallback(async (): Promise<boolean> => {
    if (!dirtyRef.current) return true
    return persistCase(caseForm, '案件情報を更新しました')
  }, [persistCase, caseForm])

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
        message: '保存していない編集内容は破棄されます。このまま新しい案件を作成しますか？',
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
        dueAt: fromInputDateTime(input.dueAt),
        customerSummary: input.customerSummary,
      })
      if (res.success) {
        notify('success', '案件を作成しました')
        setSelectedCaseId(res.data.id)
        await loadCases()
        return true
      }
      notify('error', supportApiErrorMessage(res, '案件の作成に失敗しました'))
      return false
    } catch (err) {
      notify('error', formatSupportErrorMessage(err, '案件の作成に失敗しました'))
      return false
    } finally {
      setSaving(false)
    }
  }, [selectedAccountId, saving, requestConfirm, notify, loadCases])

  const handleEscalate = useCallback(async (input: EscalateInput): Promise<boolean> => {
    if (!detail || !selectedAccountId || saving) return false
    const blockingIssue = getEscalationDraftValidationIssues({
      question: input.question,
      assignee: input.assignee,
      canEditRouting: canEditCaseRouting,
      hasPresetAssignee: Boolean(detail.escalationAssignee?.trim()),
      detailStatus: detail.status,
    }).find((issue) => issue.blocking)
    if (blockingIssue) {
      notify('error', blockingIssue.message)
      return false
    }
    if (!(await ensureSaved())) return false
    setSaving(true)
    try {
      const res = await api.support.cases.escalate(detail.id, selectedAccountId, {
        ...(canEditCaseRouting ? {
          assignee: input.assignee.trim(),
          level: input.level,
          dueAt: fromInputDateTime(input.dueAt),
        } : {}),
        question: input.question.trim(),
      })
      if (res.success) {
        notify('success', 'エスカレーションを作成しました')
        await Promise.all([loadCases(), loadDetail(detail.id)])
        return true
      }
      notify('error', supportApiErrorMessage(res, 'エスカレーションの作成に失敗しました'))
      return false
    } catch (err) {
      notify('error', formatSupportErrorMessage(err, 'エスカレーションの作成に失敗しました'))
      return false
    } finally {
      setSaving(false)
    }
  }, [detail, selectedAccountId, saving, canEditCaseRouting, ensureSaved, notify, loadCases, loadDetail])

  const handleUpdateEscalation = useCallback(async (id: string, status: SupportEscalationStatus, answer: string) => {
    if (!detail || !selectedAccountId || saving) return
    if (!(await ensureSaved())) return
    setSaving(true)
    try {
      const res = await api.support.escalations.update(id, selectedAccountId, {
        status,
        answer,
        eventBody: status === 'answered' ? '二次回答の要点を登録しました' : 'エスカレーションを差し戻しました',
      })
      if (!res.success) {
        notify('error', supportApiErrorMessage(res, 'エスカレーションの更新に失敗しました'))
        return
      }
      notify('success', status === 'answered' ? '回答済みにしました' : '差し戻しました')
      await Promise.all([loadCases(), loadDetail(detail.id)])
    } catch (err) {
      notify('error', formatSupportErrorMessage(err, 'エスカレーションの更新に失敗しました'))
    } finally {
      setSaving(false)
    }
  }, [detail, selectedAccountId, saving, ensureSaved, notify, loadCases, loadDetail])

  const updateManualLinks = useCallback(async (nextIds: string[], eventBody: string, successMessage: string) => {
    if (!detail || !selectedAccountId || saving) return
    if (!(await ensureSaved())) return
    setSaving(true)
    try {
      const res = await api.support.cases.update(detail.id, selectedAccountId, { manualIds: nextIds, eventBody })
      if (!res.success) {
        notify('error', supportApiErrorMessage(res, 'マニュアルの更新に失敗しました'))
        return
      }
      notify('success', successMessage)
      await loadDetail(detail.id)
    } catch (err) {
      notify('error', formatSupportErrorMessage(err, 'マニュアルの更新に失敗しました'))
    } finally {
      setSaving(false)
    }
  }, [detail, selectedAccountId, saving, ensureSaved, notify, loadDetail])

  const handleLinkManual = useCallback((manual: SupportManual) => {
    if (!detail) return
    const nextIds = Array.from(new Set([...detail.manualIds, manual.id]))
    void updateManualLinks(nextIds, `マニュアルを紐付けました: ${manual.title}`, 'マニュアルを紐付けました')
  }, [detail, updateManualLinks])

  const handleUnlinkManual = useCallback((manual: SupportManual) => {
    if (!detail) return
    const nextIds = detail.manualIds.filter((id) => id !== manual.id)
    void updateManualLinks(nextIds, `マニュアルの紐付けを解除しました: ${manual.title}`, '紐付けを解除しました')
  }, [detail, updateManualLinks])

  const handleCreateManual = useCallback(async (input: ManualEditorInput): Promise<boolean> => {
    if (!selectedAccountId || saving) return false
    const blockingIssue = getManualEditorValidationIssues(input).find((issue) => issue.blocking)
    if (blockingIssue) {
      notify('error', blockingIssue.message)
      return false
    }
    const title = input.title.trim()
    const body = input.body.trim()
    const url = input.url.trim()
    setSaving(true)
    try {
      const res = await api.support.manuals.create({
        lineAccountId: selectedAccountId,
        title,
        category: input.category,
        body,
        url: url || null,
        keywords: input.keywords.trim(),
        owner: input.owner.trim() || null,
        approvedBy: input.approvedBy.trim() || null,
        revisedAt: input.revisedAt || null,
      })
      if (!res.success) {
        notify('error', supportApiErrorMessage(res, 'マニュアルの作成に失敗しました'))
        return false
      }
      notify('success', 'マニュアルを作成しました')
      await loadManuals()
      return true
    } catch (err) {
      notify('error', formatSupportErrorMessage(err, 'マニュアルの作成に失敗しました'))
      return false
    } finally {
      setSaving(false)
    }
  }, [selectedAccountId, saving, notify, loadManuals])

  const handleUpdateManual = useCallback(async (manual: SupportManual, input: ManualEditorInput): Promise<boolean> => {
    if (!selectedAccountId || saving) return false
    const blockingIssue = getManualEditorValidationIssues(input).find((issue) => issue.blocking)
    if (blockingIssue) {
      notify('error', blockingIssue.message)
      return false
    }
    const title = input.title.trim()
    const body = input.body.trim()
    const url = input.url.trim()
    setSaving(true)
    try {
      const res = await api.support.manuals.update(manual.id, {
        lineAccountId: selectedAccountId,
        title,
        category: input.category,
        body,
        url: url || null,
        keywords: input.keywords.trim(),
        owner: input.owner.trim() || null,
        approvedBy: input.approvedBy.trim() || null,
        revisedAt: input.revisedAt || null,
      })
      if (!res.success) {
        notify('error', supportApiErrorMessage(res, 'マニュアルの更新に失敗しました'))
        return false
      }
      notify('success', 'マニュアルを更新しました')
      await Promise.all([
        loadManuals(),
        detail ? loadDetail(detail.id) : Promise.resolve(),
      ])
      return true
    } catch (err) {
      notify('error', formatSupportErrorMessage(err, 'マニュアルの更新に失敗しました'))
      return false
    } finally {
      setSaving(false)
    }
  }, [selectedAccountId, saving, notify, loadManuals, loadDetail, detail])

  const handleArchiveManual = useCallback(async (manual: SupportManual): Promise<boolean> => {
    if (!selectedAccountId || saving) return false
    const ok = await requestConfirm({
      title: 'マニュアルを無効化します',
      message: `「${manual.title}」を一覧から外します。既存の案件履歴は残りますが、新しい紐付け候補には出なくなります。`,
      confirmLabel: '無効化する',
      cancelLabel: '戻る',
      tone: 'danger',
    })
    if (!ok) return false
    setSaving(true)
    try {
      const res = await api.support.manuals.archive(manual.id, selectedAccountId)
      if (!res.success) {
        notify('error', supportApiErrorMessage(res, 'マニュアルの無効化に失敗しました'))
        return false
      }
      notify('success', 'マニュアルを無効化しました')
      await Promise.all([
        loadManuals(),
        detail ? loadDetail(detail.id) : Promise.resolve(),
      ])
      return true
    } catch (err) {
      notify('error', formatSupportErrorMessage(err, 'マニュアルの無効化に失敗しました'))
      return false
    } finally {
      setSaving(false)
    }
  }, [selectedAccountId, saving, requestConfirm, notify, loadManuals, loadDetail, detail])

  const handleCopyReplyDraft = useCallback(async () => {
    const result = await copyText(caseForm.customerReplyDraft)
    if (result.ok) {
      notify('success', '返信案をコピーしました')
    } else {
      notify('error', '返信案のコピーに失敗しました。チャットで返信を使うか、文章を選択してコピーしてください。')
    }
  }, [caseForm.customerReplyDraft, notify])

  const handleOpenChatWithDraft = useCallback(async () => {
    if (!detail?.friendId || !selectedAccountId) return
    const draft = caseForm.customerReplyDraft.trim()
    if (!draft) {
      notify('error', '顧客向け返信案を入力してください')
      return
    }
    if (dirtyRef.current && !(await persistCase(caseForm, 'チャット返信前に案件情報を保存しました'))) {
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
    if (key === 'stale') {
      setQueueFilter('all')
      setStatusFilter('all')
      setCaseFocus('stale')
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
        loadManuals(),
      ])
    } catch (err) {
      setLoadError(formatSupportErrorMessage(err, '更新に失敗しました'))
    } finally {
      setLoading(false)
    }
  }, [selectedAccountId, selectedCaseId, controlsDisabled, requestConfirm, loadCases, loadDetail, loadManuals])

  // ⌘S / Ctrl+S で保存、↑↓ / j k で案件移動 (入力中は無効)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (dirtyRef.current && detail && !saving) void persistCase(caseForm, '管理画面から案件情報を更新しました')
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
        title="サポートCRM"
        description={`${accountName} の問い合わせ案件を一元管理`}
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
                新規案件
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
        staleCount={staleCaseCount}
        activeKey={activeQueueKey}
        staffName={verifiedStaffName}
        disabled={controlsDisabled}
        onSelect={handleQueueSelect}
      />

      {verifiedStaffRole === 'staff' && (
        <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          staff権限では、自分が作成・担当・エスカレ先になっている案件と、その案件に紐づくチャットだけが表示されます。
        </div>
      )}

      {canCreateCases && createOpen && chatOptionsError && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" role="status">
          {chatOptionsError}。会話に紐付けない案件化はできますが、LINE会話の候補は更新後にもう一度確認してください。
        </div>
      )}

      {canCreateCases && createOpen && (
        <CreateCasePanel
          chats={visibleChats}
          staffName={verifiedStaffName}
          saving={saving}
          onCreate={handleCreate}
          onClose={() => setCreateOpen(false)}
        />
      )}

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(280px,340px)_minmax(0,1fr)] xl:grid-cols-[minmax(280px,340px)_minmax(0,1fr)_360px]">
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
          detailTab={detailTab}
          onFormChange={(patch) => setCaseForm((prev) => ({ ...prev, ...patch }))}
          onSave={handleSave}
          onDiscard={handleDiscard}
          onQuickStatus={handleQuickStatus}
          onOpenChatWithDraft={() => void handleOpenChatWithDraft()}
          onTabChange={setDetailTab}
          onCopyReplyDraft={() => void handleCopyReplyDraft()}
          emptyState={detailEmptyState}
          outsideCurrentList={selectedCaseOutsideList}
          outsideCurrentListActionLabel={outsideCurrentListAction.label}
          onResetFilters={revealSelectedCaseInList}
        />

        <aside className="space-y-4 lg:col-span-2 xl:col-span-1">
          <EscalationPanel
            detail={detail}
            caseForm={caseForm}
            staffName={verifiedStaffName}
            saving={saving}
            canEditRouting={canEditCaseRouting}
            onEscalate={handleEscalate}
            onUpdateEscalation={handleUpdateEscalation}
            notify={notify}
          />
          <ManualPanel
            manuals={manuals}
            linkedManuals={detail?.manuals ?? []}
            linkedIds={detail?.manualIds ?? []}
            canLink={Boolean(detail)}
            canManage={canManageManuals}
            saving={saving}
            search={manualSearch}
            category={manualCategory}
            onSearchChange={setManualSearch}
            onCategoryChange={setManualCategory}
            onLink={handleLinkManual}
            onUnlink={handleUnlinkManual}
            onCreateManual={handleCreateManual}
            onUpdateManual={handleUpdateManual}
            onArchiveManual={handleArchiveManual}
          />
        </aside>
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

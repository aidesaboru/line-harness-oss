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
import CaseDetail, { type DetailTab } from '@/components/support/case-detail'
import CaseList from '@/components/support/case-list'
import CreateCasePanel, { type ChatOption, type CreateCaseInput } from '@/components/support/create-case-panel'
import EscalationPanel, { type EscalateInput } from '@/components/support/escalation-panel'
import ManualPanel from '@/components/support/manual-panel'
import QueueStrip, { type QueueKey } from '@/components/support/queue-strip'
import {
  caseFormFromDetail,
  emptyCaseForm,
  fromInputDateTime,
  isStaleCase,
  sortCases,
  type CaseFormState,
  type CaseSortMode,
} from '@/components/support/support-meta'
import {
  PlusIcon,
  ToastStack,
  btnBrandCls,
  btnSecondaryCls,
  useToasts,
} from '@/components/support/support-ui'

const SEARCH_DEBOUNCE_MS = 350
const AUTO_REFRESH_MS = 60 * 1000
const DISCARD_CONFIRM = '未保存の変更があります。破棄して移動しますか？'

export default function SupportPage() {
  const { selectedAccountId, selectedAccount, loading: accountLoading } = useAccount()
  const { toasts, notify, dismissToast } = useToasts()

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
  const [caseFocus, setCaseFocus] = useState<'all' | 'stale'>('all')
  const [sortMode, setSortMode] = useState<CaseSortMode>('updated')
  const [search, setSearch] = useState('')
  const [appliedSearch, setAppliedSearch] = useState('')
  const [manualSearch, setManualSearch] = useState('')
  const [appliedManualSearch, setAppliedManualSearch] = useState('')
  const [manualCategory, setManualCategory] = useState('all')
  const [detailTab, setDetailTab] = useState<DetailTab>('work')
  const [staffName, setStaffName] = useState('')
  const [createOpen, setCreateOpen] = useState(false)

  const [caseForm, setCaseForm] = useState<CaseFormState>(emptyCaseForm)
  const [savedForm, setSavedForm] = useState<CaseFormState>(emptyCaseForm)

  const accountName = selectedAccount?.displayName || selectedAccount?.name || 'LINEアカウント'

  const dirty = useMemo(
    () => detail !== null && JSON.stringify(caseForm) !== JSON.stringify(savedForm),
    [detail, caseForm, savedForm],
  )
  const dirtyRef = useRef(dirty)
  useEffect(() => { dirtyRef.current = dirty }, [dirty])

  const visibleChats = useMemo(() => chats.slice(0, 80), [chats])
  const staleCaseCount = useMemo(() => cases.filter(isStaleCase).length, [cases])
  const displayCases = useMemo(() => {
    const filtered = caseFocus === 'stale' ? cases.filter(isStaleCase) : cases
    return sortCases(filtered, sortMode)
  }, [cases, caseFocus, sortMode])

  const activeQueueKey = useMemo<QueueKey | null>(() => {
    if (caseFocus === 'stale') return 'stale'
    if (queueFilter !== 'all') return queueFilter as QueueKey
    if (statusFilter === 'resolved') return 'resolved'
    if (statusFilter === 'all') return 'all'
    return null
  }, [caseFocus, queueFilter, statusFilter])

  const hasActiveFilters =
    queueFilter !== 'all' || statusFilter !== 'all' || caseFocus === 'stale' || appliedSearch !== ''

  const assigneeSuggestions = useMemo(() => {
    const names = new Set<string>(staffNames)
    summary?.byAssignee.forEach((row) => {
      if (row.assignee && row.assignee !== '担当者なし') names.add(row.assignee)
    })
    return Array.from(names).sort()
  }, [staffNames, summary])

  useEffect(() => {
    try {
      setStaffName(localStorage.getItem('lh_staff_name') || '')
    } catch {
      setStaffName('')
    }
  }, [])

  // ─── データ読み込み ───

  const loadCases = useCallback(async () => {
    if (!selectedAccountId) return
    const [summaryRes, casesRes] = await Promise.all([
      api.support.summary({ accountId: selectedAccountId }),
      api.support.cases.list({
        accountId: selectedAccountId,
        status: statusFilter === 'all' ? undefined : statusFilter,
        queue: queueFilter === 'all' || queueFilter === 'my_escalations' ? undefined : queueFilter,
        scope: queueFilter === 'my_escalations' ? 'my_escalations' : undefined,
        q: appliedSearch || undefined,
      }),
    ])
    if (summaryRes.success) setSummary(summaryRes.data)
    if (casesRes.success) {
      setCases(casesRes.data)
      // 初回のみ先頭を自動選択。絞り込みで一覧から消えても選択中の案件は維持する
      setSelectedCaseId((prev) => prev ?? casesRes.data[0]?.id ?? null)
    }
  }, [selectedAccountId, statusFilter, queueFilter, appliedSearch])

  const loadDetail = useCallback(async (id: string | null) => {
    if (!id || !selectedAccountId) {
      setDetail(null)
      return
    }
    setDetailLoading(true)
    try {
      const res = await api.support.cases.get(id, selectedAccountId)
      if (!res.success) return
      setDetail(res.data)
      const form = caseFormFromDetail(res.data)
      setCaseForm(form)
      setSavedForm(form)
    } finally {
      setDetailLoading(false)
    }
  }, [selectedAccountId])

  const loadManuals = useCallback(async () => {
    if (!selectedAccountId) return
    const res = await api.support.manuals.list({
      accountId: selectedAccountId,
      category: manualCategory === 'all' ? undefined : manualCategory,
      q: appliedManualSearch || undefined,
      active: '1',
    })
    if (res.success) setManuals(res.data)
  }, [selectedAccountId, manualCategory, appliedManualSearch])

  useEffect(() => {
    if (!selectedAccountId) return
    let active = true
    api.chats.list({ accountId: selectedAccountId })
      .then((res) => {
        if (active && res.success) setChats(res.data as ChatOption[])
      })
      .catch(() => { /* 案件化フォームの補助情報なので失敗しても画面は使える */ })
    return () => { active = false }
  }, [selectedAccountId])

  useEffect(() => {
    let active = true
    api.staff.list()
      .then((res) => {
        if (active && res.success) {
          setStaffNames(res.data.filter((member) => member.isActive).map((member) => member.name))
        }
      })
      .catch(() => { /* staff権限では取得できない場合がある。サジェストなしで動作 */ })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!selectedAccountId) return
    let active = true
    setLoading(true)
    setLoadError(null)
    loadCases()
      .catch((err) => {
        if (active) setLoadError(err instanceof Error ? err.message : '案件一覧の読み込みに失敗しました')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [selectedAccountId, loadCases])

  useEffect(() => {
    if (!selectedAccountId) return
    let active = true
    loadManuals().catch((err) => {
      if (active) setLoadError(err instanceof Error ? err.message : 'マニュアルの読み込みに失敗しました')
    })
    return () => { active = false }
  }, [selectedAccountId, loadManuals])

  useEffect(() => {
    void loadDetail(selectedCaseId)
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

  const selectCase = useCallback((id: string) => {
    if (id === selectedCaseId) return
    if (dirtyRef.current && !window.confirm(DISCARD_CONFIRM)) return
    setSelectedCaseId(id)
  }, [selectedCaseId])

  /** 保存。保留/完了のサーバ側必須条件は事前にチェックして分かりやすく伝える */
  const persistCase = useCallback(async (form: CaseFormState, eventBody: string): Promise<boolean> => {
    if (!detail || !selectedAccountId || saving) return false
    if (form.status === 'on_hold' && (!form.nextCheckAt || !form.internalNote.trim())) {
      notify('error', '保留にする場合は、保留理由の内部メモと次回確認日時が必要です')
      return false
    }
    if (form.status === 'resolved' && !form.resolutionNote.trim()) {
      notify('error', '完了にする場合は、対応結果メモが必要です')
      return false
    }
    setSaving(true)
    try {
      const res = await api.support.cases.update(detail.id, selectedAccountId, {
        ...form,
        primaryAssignee: form.primaryAssignee || null,
        escalationAssignee: form.escalationAssignee || null,
        dueAt: fromInputDateTime(form.dueAt),
        nextCheckAt: fromInputDateTime(form.nextCheckAt),
        customerNumber: form.customerNumber || null,
        companyName: form.companyName || null,
        contactName: form.contactName || null,
        storeName: form.storeName || null,
        contractType: form.contractType || null,
        eventBody,
      })
      if (res.success) {
        notify('success', '案件を保存しました')
        await Promise.all([loadCases(), loadDetail(detail.id)])
        return true
      }
      notify('error', (res as { error?: string }).error ?? '案件の保存に失敗しました')
      return false
    } catch (err) {
      notify('error', err instanceof Error ? err.message : '案件の保存に失敗しました')
      return false
    } finally {
      setSaving(false)
    }
  }, [detail, selectedAccountId, saving, notify, loadCases, loadDetail])

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
    if (dirtyRef.current && !window.confirm(DISCARD_CONFIRM)) return false
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
      notify('error', (res as { error?: string }).error ?? '案件の作成に失敗しました')
      return false
    } catch (err) {
      notify('error', err instanceof Error ? err.message : '案件の作成に失敗しました')
      return false
    } finally {
      setSaving(false)
    }
  }, [selectedAccountId, saving, notify, loadCases])

  const handleEscalate = useCallback(async (input: EscalateInput): Promise<boolean> => {
    if (!detail || !selectedAccountId || saving) return false
    if (!input.assignee.trim() || !input.question.trim()) return false
    if (!(await ensureSaved())) return false
    setSaving(true)
    try {
      const res = await api.support.cases.escalate(detail.id, selectedAccountId, {
        assignee: input.assignee.trim(),
        level: input.level,
        dueAt: fromInputDateTime(input.dueAt),
        question: input.question.trim(),
      })
      if (res.success) {
        notify('success', 'エスカレーションを作成しました')
        await Promise.all([loadCases(), loadDetail(detail.id)])
        return true
      }
      notify('error', (res as { error?: string }).error ?? 'エスカレーションの作成に失敗しました')
      return false
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'エスカレーションの作成に失敗しました')
      return false
    } finally {
      setSaving(false)
    }
  }, [detail, selectedAccountId, saving, ensureSaved, notify, loadCases, loadDetail])

  const handleUpdateEscalation = useCallback(async (id: string, status: SupportEscalationStatus, answer: string) => {
    if (!detail || !selectedAccountId || saving) return
    if (!(await ensureSaved())) return
    setSaving(true)
    try {
      await api.support.escalations.update(id, selectedAccountId, {
        status,
        answer,
        eventBody: status === 'answered' ? '二次回答の要点を登録しました' : 'エスカレーションを差し戻しました',
      })
      notify('success', status === 'answered' ? '回答済みにしました' : '差し戻しました')
      await Promise.all([loadCases(), loadDetail(detail.id)])
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'エスカレーションの更新に失敗しました')
    } finally {
      setSaving(false)
    }
  }, [detail, selectedAccountId, saving, ensureSaved, notify, loadCases, loadDetail])

  const updateManualLinks = useCallback(async (nextIds: string[], eventBody: string, successMessage: string) => {
    if (!detail || !selectedAccountId || saving) return
    if (!(await ensureSaved())) return
    setSaving(true)
    try {
      await api.support.cases.update(detail.id, selectedAccountId, { manualIds: nextIds, eventBody })
      notify('success', successMessage)
      await loadDetail(detail.id)
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'マニュアルの更新に失敗しました')
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

  const handleCopyReplyDraft = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(caseForm.customerReplyDraft)
      notify('success', '返信案をコピーしました。チャット画面に貼り付けて送信してください')
    } catch {
      notify('error', '返信案のコピーに失敗しました')
    }
  }, [caseForm.customerReplyDraft, notify])

  const handleQueueSelect = useCallback((key: QueueKey) => {
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
  }, [activeQueueKey])

  const handleResetFilters = useCallback(() => {
    setQueueFilter('all')
    setStatusFilter('all')
    setCaseFocus('all')
    setSearch('')
    setAppliedSearch('')
  }, [])

  const refreshAll = useCallback(async () => {
    if (!selectedAccountId) return
    if (dirtyRef.current && !window.confirm('未保存の変更があります。破棄して再読み込みしますか？')) return
    setLoading(true)
    setLoadError(null)
    try {
      await Promise.all([
        loadCases(),
        selectedCaseId ? loadDetail(selectedCaseId) : Promise.resolve(),
        loadManuals(),
      ])
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : '更新に失敗しました')
    } finally {
      setLoading(false)
    }
  }, [selectedAccountId, selectedCaseId, loadCases, loadDetail, loadManuals])

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
        if (next && next.id !== selectedCaseId) selectCase(next.id)
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
            <button
              type="button"
              onClick={() => setCreateOpen((prev) => !prev)}
              className={btnBrandCls}
              aria-expanded={createOpen}
            >
              <PlusIcon className="h-4 w-4" />
              新規案件
            </button>
            <button onClick={() => void refreshAll()} disabled={loading} className={btnSecondaryCls}>
              {loading ? '更新中…' : '更新'}
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
            className="shrink-0 rounded-md border border-red-300 bg-white px-2.5 py-1 text-xs font-medium text-red-700 transition-colors hover:bg-red-100"
          >
            再読み込み
          </button>
        </div>
      )}

      <QueueStrip
        summary={summary}
        staleCount={staleCaseCount}
        activeKey={activeQueueKey}
        staffName={staffName}
        onSelect={handleQueueSelect}
      />

      {createOpen && (
        <CreateCasePanel
          chats={visibleChats}
          staffName={staffName}
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
          hasActiveFilters={hasActiveFilters}
          onSelect={selectCase}
          onStatusFilterChange={(value) => {
            setStatusFilter(value)
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
          detailTab={detailTab}
          onFormChange={(patch) => setCaseForm((prev) => ({ ...prev, ...patch }))}
          onSave={handleSave}
          onDiscard={handleDiscard}
          onQuickStatus={handleQuickStatus}
          onTabChange={setDetailTab}
          onCopyReplyDraft={() => void handleCopyReplyDraft()}
        />

        <aside className="space-y-4 lg:col-span-2 xl:col-span-1">
          <EscalationPanel
            detail={detail}
            caseForm={caseForm}
            staffName={staffName}
            saving={saving}
            onEscalate={handleEscalate}
            onUpdateEscalation={handleUpdateEscalation}
            notify={notify}
          />
          <ManualPanel
            manuals={manuals}
            linkedManuals={detail?.manuals ?? []}
            linkedIds={detail?.manualIds ?? []}
            canLink={Boolean(detail)}
            saving={saving}
            search={manualSearch}
            category={manualCategory}
            onSearchChange={setManualSearch}
            onCategoryChange={setManualCategory}
            onLink={handleLinkManual}
            onUnlink={handleUnlinkManual}
          />
        </aside>
      </div>

      {/* 一次担当・二次対応先入力のサジェスト (スタッフ + 既存担当者) */}
      <datalist id="support-staff-names">
        {assigneeSuggestions.map((name) => <option key={name} value={name} />)}
      </datalist>

      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  )
}

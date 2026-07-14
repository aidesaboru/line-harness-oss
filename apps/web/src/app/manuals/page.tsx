'use client'

import { useCallback, useEffect, useState } from 'react'
import Header from '@/components/layout/header'
import ManualPanel, { type ManualEditorInput } from '@/components/support/manual-panel'
import {
  ToastStack,
  btnSecondaryCls,
  useConfirmDialog,
  useToasts,
} from '@/components/support/support-ui'
import {
  formatSupportErrorMessage,
  getManualEditorValidationIssues,
  supportApiErrorMessage,
} from '@/components/support/support-meta'
import { useAccount } from '@/contexts/account-context'
import { api, type SupportManual } from '@/lib/api'
import {
  cacheStaffSession,
  clearStaffIdentityCache,
  readStaffIdentityCache,
} from '@/lib/auth-session'

const SEARCH_DEBOUNCE_MS = 350

export default function ManualsPage() {
  const { selectedAccountId, selectedAccount, loading: accountLoading } = useAccount()
  const { toasts, notify, dismissToast } = useToasts()
  const { requestConfirm, confirmDialog } = useConfirmDialog()
  const [manuals, setManuals] = useState<SupportManual[]>([])
  const [search, setSearch] = useState('')
  const [appliedSearch, setAppliedSearch] = useState('')
  const [category, setCategory] = useState('all')
  const [staffRole, setStaffRole] = useState('')
  const [staffReady, setStaffReady] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  const accountName = selectedAccount?.displayName || selectedAccount?.name || 'LINEアカウント'
  const canManage = staffRole === 'owner' || staffRole === 'admin'
  const controlsDisabled = !selectedAccountId || !staffReady || loading || saving

  useEffect(() => {
    const cached = readStaffIdentityCache()
    setStaffRole(cached.role || '')
  }, [])

  useEffect(() => {
    let active = true
    api.staff.me()
      .then((res) => {
        if (!active) return
        if (!res.success) {
          setStaffRole('')
          setStaffReady(true)
          clearStaffIdentityCache()
          return
        }
        const role = res.data.role || ''
        setStaffRole(role)
        setStaffReady(true)
        cacheStaffSession({ name: res.data.name || '', role })
      })
      .catch(() => {
        if (!active) return
        setStaffRole('')
        setStaffReady(true)
        clearStaffIdentityCache()
      })
    return () => { active = false }
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => setAppliedSearch(search.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [search])

  const loadManuals = useCallback(async () => {
    if (!selectedAccountId || !staffReady) return
    setLoading(true)
    setLoadError(null)
    try {
      const res = await api.support.manuals.list({
        accountId: selectedAccountId,
        category: category === 'all' ? undefined : category,
        q: appliedSearch || undefined,
        active: '1',
      })
      if (!res.success) {
        setLoadError(supportApiErrorMessage(res, 'マニュアルの読み込みに失敗しました'))
        return
      }
      setManuals(res.data)
    } catch (err) {
      setLoadError(formatSupportErrorMessage(err, 'マニュアルの読み込みに失敗しました'))
    } finally {
      setLoading(false)
    }
  }, [appliedSearch, category, selectedAccountId, staffReady])

  useEffect(() => {
    void loadManuals()
  }, [loadManuals])

  const handleCreateManual = useCallback(async (input: ManualEditorInput): Promise<boolean> => {
    if (!selectedAccountId || saving || !canManage) return false
    const blockingIssue = getManualEditorValidationIssues(input).find((issue) => issue.blocking)
    if (blockingIssue) {
      notify('error', blockingIssue.message)
      return false
    }
    setSaving(true)
    try {
      const res = await api.support.manuals.create({
        lineAccountId: selectedAccountId,
        title: input.title.trim(),
        category: input.category,
        body: input.body.trim(),
        url: input.url.trim() || null,
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
  }, [canManage, loadManuals, notify, saving, selectedAccountId])

  const handleUpdateManual = useCallback(async (manual: SupportManual, input: ManualEditorInput): Promise<boolean> => {
    if (!selectedAccountId || saving || !canManage) return false
    const blockingIssue = getManualEditorValidationIssues(input).find((issue) => issue.blocking)
    if (blockingIssue) {
      notify('error', blockingIssue.message)
      return false
    }
    setSaving(true)
    try {
      const res = await api.support.manuals.update(manual.id, {
        lineAccountId: selectedAccountId,
        title: input.title.trim(),
        category: input.category,
        body: input.body.trim(),
        url: input.url.trim() || null,
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
      await loadManuals()
      return true
    } catch (err) {
      notify('error', formatSupportErrorMessage(err, 'マニュアルの更新に失敗しました'))
      return false
    } finally {
      setSaving(false)
    }
  }, [canManage, loadManuals, notify, saving, selectedAccountId])

  const handleArchiveManual = useCallback(async (manual: SupportManual): Promise<boolean> => {
    if (!selectedAccountId || saving || !canManage) return false
    const ok = await requestConfirm({
      title: 'マニュアルを無効化します',
      message: `「${manual.title}」を一覧から外します。必要になった場合は管理者側で復旧できます。`,
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
      await loadManuals()
      return true
    } catch (err) {
      notify('error', formatSupportErrorMessage(err, 'マニュアルの無効化に失敗しました'))
      return false
    } finally {
      setSaving(false)
    }
  }, [canManage, loadManuals, notify, requestConfirm, saving, selectedAccountId])

  if (accountLoading) {
    return <div className="p-6 text-sm text-gray-500">読み込み中...</div>
  }

  return (
    <div className="space-y-4">
      <Header
        title="マニュアル"
        description={`${accountName} の対応手順を検索・管理`}
        action={
          <button type="button" onClick={() => void loadManuals()} disabled={controlsDisabled} className={btnSecondaryCls}>
            {loading ? '更新中...' : saving ? '保存中...' : '更新'}
          </button>
        }
      />

      {loadError && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {loadError}
        </div>
      )}

      {!canManage && staffReady && (
        <div className="rounded-md border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
          staff権限では閲覧と検索のみできます。追加・編集・無効化はowner/adminに依頼してください。
        </div>
      )}

      <ManualPanel
        manuals={manuals}
        linkedManuals={[]}
        linkedIds={[]}
        canLink={false}
        canManage={canManage}
        saving={saving || loading}
        search={search}
        category={category}
        onSearchChange={setSearch}
        onCategoryChange={setCategory}
        onLink={() => {}}
        onUnlink={() => {}}
        onCreateManual={handleCreateManual}
        onUpdateManual={handleUpdateManual}
        onArchiveManual={handleArchiveManual}
        showLinkActions={false}
      />

      {confirmDialog}
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  )
}

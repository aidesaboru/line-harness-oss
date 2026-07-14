'use client'

import { useCallback, useEffect, useState } from 'react'
import Header from '@/components/layout/header'
import ManualPanel, { type ManualEditorInput } from '@/components/support/manual-panel'
import SlackKnowledgeImportPanel, {
  type SlackKnowledgeImportDraft,
} from '@/components/support/slack-knowledge-import-panel'
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
import type { SupportKnowledgeImport } from '@/lib/api'

const SEARCH_DEBOUNCE_MS = 350
const DEFAULT_SLACK_KNOWLEDGE_CHANNEL_ID = 'C09SPA06P0S'
const DEFAULT_SLACK_KNOWLEDGE_CHANNEL_NAME = '早急確認-ecオーナー通達'
const SLACK_KNOWLEDGE_IMPORT_MAX_PAGES = 200

export default function ManualsPage() {
  const { selectedAccountId, selectedAccount, loading: accountLoading } = useAccount()
  const { toasts, notify, dismissToast } = useToasts()
  const { requestConfirm, confirmDialog } = useConfirmDialog()
  const [manuals, setManuals] = useState<SupportManual[]>([])
  const [knowledgeImports, setKnowledgeImports] = useState<SupportKnowledgeImport[]>([])
  const [search, setSearch] = useState('')
  const [appliedSearch, setAppliedSearch] = useState('')
  const [knowledgeSearch, setKnowledgeSearch] = useState('')
  const [appliedKnowledgeSearch, setAppliedKnowledgeSearch] = useState('')
  const [category, setCategory] = useState('all')
  const [knowledgeStatusFilter, setKnowledgeStatusFilter] = useState<'draft' | 'published' | 'dismissed' | 'all'>('published')
  const [slackChannelId, setSlackChannelId] = useState(DEFAULT_SLACK_KNOWLEDGE_CHANNEL_ID)
  const [slackChannelName, setSlackChannelName] = useState(DEFAULT_SLACK_KNOWLEDGE_CHANNEL_NAME)
  const [slackImportLimit, setSlackImportLimit] = useState(50)
  const [slackNextCursor, setSlackNextCursor] = useState<string | null>(null)
  const [staffRole, setStaffRole] = useState('')
  const [staffReady, setStaffReady] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [syncing, setSyncing] = useState(false)
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

  useEffect(() => {
    const timer = setTimeout(() => setAppliedKnowledgeSearch(knowledgeSearch.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [knowledgeSearch])

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

  const loadKnowledgeImports = useCallback(async () => {
    if (!selectedAccountId || !staffReady || !canManage) {
      setKnowledgeImports([])
      return
    }
    try {
      const res = await api.support.knowledgeImports.list({
        accountId: selectedAccountId,
        status: knowledgeStatusFilter,
        q: appliedKnowledgeSearch || undefined,
        limit: 50,
      })
      if (res.success) {
        setKnowledgeImports(res.data)
      }
    } catch {
      // 候補一覧はマニュアル閲覧の主導線ではないため、取得失敗は手動更新時に通知する。
    }
  }, [appliedKnowledgeSearch, canManage, knowledgeStatusFilter, selectedAccountId, staffReady])

  useEffect(() => {
    void loadManuals()
  }, [loadManuals])

  useEffect(() => {
    void loadKnowledgeImports()
  }, [loadKnowledgeImports])

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

  const handleSyncSlackKnowledge = useCallback(async (cursor?: string | null): Promise<void> => {
    if (!selectedAccountId || syncing || saving || !canManage) return
    setSyncing(true)
    try {
      let nextCursor = cursor || null
      let page = 0
      const totals = { imported: 0, updated: 0, skipped: 0, failed: 0, published: 0 }

      do {
        const res = await api.support.knowledgeImports.syncSlack({
          lineAccountId: selectedAccountId,
          channelId: slackChannelId.trim() || DEFAULT_SLACK_KNOWLEDGE_CHANNEL_ID,
          channelName: slackChannelName.trim() || DEFAULT_SLACK_KNOWLEDGE_CHANNEL_NAME,
          cursor: nextCursor || undefined,
          limit: slackImportLimit,
          publish: true,
        })
        if (!res.success) {
          notify('error', supportApiErrorMessage(res, 'Slack過去ログの移行に失敗しました'))
          return
        }
        totals.imported += res.data.imported
        totals.updated += res.data.updated
        totals.skipped += res.data.skipped
        totals.failed += res.data.failed
        totals.published += res.data.published
        nextCursor = res.data.nextCursor
        page += 1
      } while (nextCursor && page < SLACK_KNOWLEDGE_IMPORT_MAX_PAGES)

      setSlackNextCursor(nextCursor)
      if (nextCursor) {
        notify(
          'error',
          `途中まで移行しました。公開 ${totals.published}件 / 失敗 ${totals.failed}件。続きボタンで再開してください`,
        )
      } else {
        notify(
          'success',
          `Slack過去ログを移行しました。公開 ${totals.published}件 / 候補 ${totals.imported}件 / 更新 ${totals.updated}件 / スキップ ${totals.skipped}件`,
        )
      }
      await Promise.all([loadKnowledgeImports(), loadManuals()])
    } catch (err) {
      notify('error', formatSupportErrorMessage(err, 'Slack過去ログの移行に失敗しました'))
    } finally {
      setSyncing(false)
    }
  }, [
    canManage,
    loadKnowledgeImports,
    loadManuals,
    notify,
    saving,
    selectedAccountId,
    slackChannelId,
    slackChannelName,
    slackImportLimit,
    syncing,
  ])

  const handleUpdateKnowledgeImport = useCallback(async (
    item: SupportKnowledgeImport,
    input: SlackKnowledgeImportDraft,
  ): Promise<boolean> => {
    if (!selectedAccountId || saving || !canManage) return false
    setSaving(true)
    try {
      const res = await api.support.knowledgeImports.update(item.id, {
        lineAccountId: selectedAccountId,
        title: input.title.trim(),
        category: input.category,
        question: input.question.trim(),
        answer: input.answer.trim(),
        body: input.body.trim(),
        keywords: input.keywords.trim(),
      })
      if (!res.success) {
        notify('error', supportApiErrorMessage(res, '候補の更新に失敗しました'))
        return false
      }
      notify('success', '候補を更新しました')
      await loadKnowledgeImports()
      return true
    } catch (err) {
      notify('error', formatSupportErrorMessage(err, '候補の更新に失敗しました'))
      return false
    } finally {
      setSaving(false)
    }
  }, [canManage, loadKnowledgeImports, notify, saving, selectedAccountId])

  const handlePublishKnowledgeImport = useCallback(async (item: SupportKnowledgeImport): Promise<boolean> => {
    if (!selectedAccountId || saving || !canManage) return false
    const ok = await requestConfirm({
      title: 'ナレッジを公開します',
      message: `「${item.title}」をマニュアル一覧へ追加します。`,
      confirmLabel: '公開する',
      cancelLabel: '戻る',
      tone: 'default',
    })
    if (!ok) return false
    setSaving(true)
    try {
      const res = await api.support.knowledgeImports.publish(item.id, selectedAccountId)
      if (!res.success) {
        notify('error', supportApiErrorMessage(res, 'ナレッジの公開に失敗しました'))
        return false
      }
      notify('success', 'ナレッジを公開しました')
      await Promise.all([loadKnowledgeImports(), loadManuals()])
      return true
    } catch (err) {
      notify('error', formatSupportErrorMessage(err, 'ナレッジの公開に失敗しました'))
      return false
    } finally {
      setSaving(false)
    }
  }, [canManage, loadKnowledgeImports, loadManuals, notify, requestConfirm, saving, selectedAccountId])

  const handleDismissKnowledgeImport = useCallback(async (item: SupportKnowledgeImport): Promise<boolean> => {
    if (!selectedAccountId || saving || !canManage) return false
    const ok = await requestConfirm({
      title: '候補を却下します',
      message: `「${item.title}」を下書き候補から外します。`,
      confirmLabel: '却下する',
      cancelLabel: '戻る',
      tone: 'warning',
    })
    if (!ok) return false
    setSaving(true)
    try {
      const res = await api.support.knowledgeImports.update(item.id, {
        lineAccountId: selectedAccountId,
        status: 'dismissed',
      })
      if (!res.success) {
        notify('error', supportApiErrorMessage(res, '候補の却下に失敗しました'))
        return false
      }
      notify('success', '候補を却下しました')
      await loadKnowledgeImports()
      return true
    } catch (err) {
      notify('error', formatSupportErrorMessage(err, '候補の却下に失敗しました'))
      return false
    } finally {
      setSaving(false)
    }
  }, [canManage, loadKnowledgeImports, notify, requestConfirm, saving, selectedAccountId])

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

      {canManage && (
        <SlackKnowledgeImportPanel
          items={knowledgeImports}
          canManage={canManage}
          saving={saving}
          syncing={syncing}
          channelId={slackChannelId}
          channelName={slackChannelName}
          importLimit={slackImportLimit}
          nextCursor={slackNextCursor}
          statusFilter={knowledgeStatusFilter}
          search={knowledgeSearch}
          onChannelIdChange={setSlackChannelId}
          onChannelNameChange={setSlackChannelName}
          onImportLimitChange={setSlackImportLimit}
          onStatusFilterChange={setKnowledgeStatusFilter}
          onSearchChange={setKnowledgeSearch}
          onSync={handleSyncSlackKnowledge}
          onUpdate={handleUpdateKnowledgeImport}
          onPublish={handlePublishKnowledgeImport}
          onDismiss={handleDismissKnowledgeImport}
        />
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

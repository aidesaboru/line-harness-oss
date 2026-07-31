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
import { copyText } from '@/lib/clipboard'
import {
  cacheStaffSession,
  clearStaffIdentityCache,
  readStaffIdentityCache,
} from '@/lib/auth-session'

const SEARCH_DEBOUNCE_MS = 350
const SLACK_RECALCULATE_PAGE_LIMIT = 10
const SLACK_RECALCULATE_MAX_PAGES = 50

function buildKnowledgeBody(input: ManualEditorInput): string {
  if (input.body.trim()) return input.body.trim()
  const sections = [
    `【問い合わせ内容】\n${input.question.trim()}`,
    `【解決回答】\n${input.resolution.trim()}`,
  ]
  if (input.procedure.trim()) sections.push(`【対応手順】\n${input.procedure.trim()}`)
  if (input.applicability.trim()) sections.push(`【適用条件】\n${input.applicability.trim()}`)
  if (input.cautions.trim()) sections.push(`【注意点】\n${input.cautions.trim()}`)
  return sections.join('\n\n')
}

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
  const [recalculating, setRecalculating] = useState(false)
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
        knowledgeStatus: canManage ? undefined : 'operational',
      })
      if (!res.success) {
        setLoadError(supportApiErrorMessage(res, 'ナレッジの読み込みに失敗しました'))
        return
      }
      setManuals(res.data)
    } catch (err) {
      setLoadError(formatSupportErrorMessage(err, 'ナレッジの読み込みに失敗しました'))
    } finally {
      setLoading(false)
    }
  }, [appliedSearch, canManage, category, selectedAccountId, staffReady])

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
        body: buildKnowledgeBody(input),
        url: input.url.trim() || null,
        keywords: input.keywords.trim(),
        owner: input.owner.trim() || null,
        approvedBy: input.approvedBy.trim() || null,
        revisedAt: input.revisedAt || null,
        question: input.question.trim(),
        resolution: input.resolution.trim(),
        procedure: input.procedure.trim(),
        applicability: input.applicability.trim(),
        cautions: input.cautions.trim(),
        knowledgeStatus: input.knowledgeStatus,
        reviewNote: input.reviewNote.trim(),
      })
      if (!res.success) {
        notify('error', supportApiErrorMessage(res, 'ナレッジの作成に失敗しました'))
        return false
      }
      notify('success', 'ナレッジを作成しました')
      await loadManuals()
      return true
    } catch (err) {
      notify('error', formatSupportErrorMessage(err, 'ナレッジの作成に失敗しました'))
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
        question: input.question.trim(),
        resolution: input.resolution.trim(),
        procedure: input.procedure.trim(),
        applicability: input.applicability.trim(),
        cautions: input.cautions.trim(),
        knowledgeStatus: input.knowledgeStatus,
        reviewNote: input.reviewNote.trim(),
      })
      if (!res.success) {
        notify('error', supportApiErrorMessage(res, 'ナレッジの更新に失敗しました'))
        return false
      }
      notify('success', 'ナレッジを更新しました')
      await loadManuals()
      return true
    } catch (err) {
      notify('error', formatSupportErrorMessage(err, 'ナレッジの更新に失敗しました'))
      return false
    } finally {
      setSaving(false)
    }
  }, [canManage, loadManuals, notify, saving, selectedAccountId])

  const handleArchiveManual = useCallback(async (manual: SupportManual): Promise<boolean> => {
    if (!selectedAccountId || saving || !canManage) return false
    const ok = await requestConfirm({
      title: 'ナレッジを無効化します',
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
        notify('error', supportApiErrorMessage(res, 'ナレッジの無効化に失敗しました'))
        return false
      }
      notify('success', 'ナレッジを無効化しました')
      await loadManuals()
      return true
    } catch (err) {
      notify('error', formatSupportErrorMessage(err, 'ナレッジの無効化に失敗しました'))
      return false
    } finally {
      setSaving(false)
    }
  }, [canManage, loadManuals, notify, requestConfirm, saving, selectedAccountId])

  const handleCopy = useCallback(async (manual: SupportManual) => {
    if (!selectedAccountId) return
    const copied = await copyText(manual.resolution)
    if (!copied.ok) {
      notify('error', '結論をコピーできませんでした')
      return
    }
    notify('success', '結論をコピーしました')
    try {
      await api.support.manuals.recordUsage(manual.id, selectedAccountId, 'copied')
    } catch {
      // Copying remains available even if usage recording is temporarily unavailable.
    }
  }, [notify, selectedAccountId])

  const handleFeedback = useCallback(async (manual: SupportManual, action: 'helpful' | 'needs_improvement') => {
    if (!selectedAccountId || saving) return
    setSaving(true)
    try {
      const res = await api.support.manuals.recordUsage(manual.id, selectedAccountId, action)
      if (!res.success) {
        notify('error', supportApiErrorMessage(res, '評価を保存できませんでした'))
        return
      }
      notify('success', action === 'helpful' ? '評価を記録しました' : '改善対象として記録しました')
    } catch (err) {
      notify('error', formatSupportErrorMessage(err, '評価を保存できませんでした'))
    } finally {
      setSaving(false)
    }
  }, [notify, saving, selectedAccountId])

  const handleVerify = useCallback(async (manual: SupportManual) => {
    if (!selectedAccountId || saving || !canManage) return
    const ok = await requestConfirm({
      title: 'この内容を確認済みにします',
      message: '問い合わせと結論が対応していること、別案件の内容や顧客固有情報が混ざっていないことを確認してください。確認後は実務担当者の利用対象になります。',
      confirmLabel: '確認済みにする',
      cancelLabel: '内容を見直す',
      tone: 'default',
    })
    if (!ok) return
    setSaving(true)
    try {
      const res = await api.support.manuals.update(manual.id, {
        lineAccountId: selectedAccountId,
        knowledgeStatus: 'verified',
      })
      if (!res.success) {
        notify('error', supportApiErrorMessage(res, '確認状態を更新できませんでした'))
        return
      }
      notify('success', '確認済みにしました')
      await loadManuals()
    } catch (err) {
      notify('error', formatSupportErrorMessage(err, '確認状態を更新できませんでした'))
    } finally {
      setSaving(false)
    }
  }, [canManage, loadManuals, notify, requestConfirm, saving, selectedAccountId])

  const handleRecalculateSlackHistory = useCallback(async () => {
    if (!selectedAccountId || saving || recalculating || !canManage) return
    const ok = await requestConfirm({
      title: '過去ログの判定を更新します',
      message: '保存済みの原文は残したまま、問い合わせと結論の組み合わせ、品質状態、検索キーワードを現在の基準で再判定します。確認済みのナレッジは変更しません。',
      confirmLabel: '再判定する',
      cancelLabel: '戻る',
      tone: 'warning',
    })
    if (!ok) return

    setRecalculating(true)
    let offset = 0
    let checked = 0
    let updated = 0
    try {
      for (let page = 0; page < SLACK_RECALCULATE_MAX_PAGES; page += 1) {
        const res = await api.support.manuals.recalculateSlackHistory({
          lineAccountId: selectedAccountId,
          offset,
          limit: SLACK_RECALCULATE_PAGE_LIMIT,
        })
        if (!res.success) {
          notify('error', supportApiErrorMessage(res, '過去ログの再判定に失敗しました'))
          return
        }
        checked += res.data.checked
        updated += res.data.updatedManuals
        if (res.data.nextOffset === null) break
        offset = res.data.nextOffset
      }
      notify('success', `${checked}件を確認し ${updated}件の判定を更新しました`)
      await loadManuals()
    } catch (err) {
      notify('error', formatSupportErrorMessage(err, '過去ログの再判定に失敗しました'))
    } finally {
      setRecalculating(false)
    }
  }, [canManage, loadManuals, notify, recalculating, requestConfirm, saving, selectedAccountId])

  if (accountLoading) {
    return <div className="p-6 text-sm text-gray-500">読み込み中...</div>
  }

  return (
    <div className="space-y-4">
      <Header
        title="ナレッジ"
        description={`${accountName} の問い合わせ事例と解決方法`}
        action={
          <div className="flex flex-wrap justify-end gap-2">
            {canManage && (
              <button
                type="button"
                onClick={() => void handleRecalculateSlackHistory()}
                disabled={controlsDisabled || recalculating}
                className={btnSecondaryCls}
              >
                {recalculating ? '再判定中...' : '過去ログを再判定'}
              </button>
            )}
            <button type="button" onClick={() => void loadManuals()} disabled={controlsDisabled || recalculating} className={btnSecondaryCls}>
              {loading ? '更新中...' : saving ? '保存中...' : '更新'}
            </button>
          </div>
        }
      />

      {loadError && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {loadError}
        </div>
      )}

      {!canManage && staffReady && (
        <div className="rounded-md border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
          確認済みの回答と回答候補を検索できます。「回答候補（未確認）」は問い合わせと結論を照合してから利用してください。追加・編集はowner/adminに依頼してください。
        </div>
      )}

      <ManualPanel
        manuals={manuals}
        canManage={canManage}
        saving={saving || loading}
        search={search}
        category={category}
        onSearchChange={setSearch}
        onCategoryChange={setCategory}
        onCreateManual={handleCreateManual}
        onUpdateManual={handleUpdateManual}
        onArchiveManual={handleArchiveManual}
        onCopy={handleCopy}
        onFeedback={handleFeedback}
        onVerify={handleVerify}
      />

      {confirmDialog}
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  )
}

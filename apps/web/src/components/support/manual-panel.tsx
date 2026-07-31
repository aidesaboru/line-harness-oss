'use client'

import { useEffect, useMemo, useState } from 'react'
import type { SupportManual } from '@/lib/api'
import { categoryLabel, categoryOptions, getManualEditorValidationIssues } from './support-meta'
import {
  CheckIcon,
  CopyIcon,
  Field,
  Pill,
  PlusIcon,
  SearchIcon,
  XIcon,
  btnSecondaryCls,
  inputCls,
  selectCls,
  textareaCls,
} from './support-ui'

export type ManualEditorInput = {
  title: string
  category: string
  body: string
  url: string
  keywords: string
  owner: string
  approvedBy: string
  revisedAt: string
  question: string
  resolution: string
  procedure: string
  applicability: string
  cautions: string
  knowledgeStatus: SupportManual['knowledgeStatus']
  reviewNote: string
}

interface ManualPanelProps {
  manuals: SupportManual[]
  canManage: boolean
  saving: boolean
  search: string
  category: string
  onSearchChange: (value: string) => void
  onCategoryChange: (value: string) => void
  onCreateManual: (input: ManualEditorInput) => Promise<boolean>
  onUpdateManual: (manual: SupportManual, input: ManualEditorInput) => Promise<boolean>
  onArchiveManual: (manual: SupportManual) => Promise<boolean>
  onCopy: (manual: SupportManual) => Promise<void>
  onFeedback: (manual: SupportManual, action: 'helpful' | 'needs_improvement') => Promise<void>
  onVerify: (manual: SupportManual) => Promise<void>
}

const emptyManualInput: ManualEditorInput = {
  title: '',
  category: 'other',
  body: '',
  url: '',
  keywords: '',
  owner: '',
  approvedBy: '',
  revisedAt: '',
  question: '',
  resolution: '',
  procedure: '',
  applicability: '',
  cautions: '',
  knowledgeStatus: 'needs_review',
  reviewNote: '',
}

const statusMeta: Record<SupportManual['knowledgeStatus'], { label: string; badge: string }> = {
  verified: { label: '確認済み', badge: 'border-green-200 bg-green-50 text-green-700' },
  ready: { label: '回答候補（未確認）', badge: 'border-blue-200 bg-blue-50 text-blue-700' },
  needs_review: { label: '要整理', badge: 'border-amber-200 bg-amber-50 text-amber-800' },
  unresolved: { label: '未解決', badge: 'border-red-200 bg-red-50 text-red-700' },
}

type KnowledgeView = 'use' | 'candidates' | 'review'

const knowledgeStatuses: Record<KnowledgeView, SupportManual['knowledgeStatus'][]> = {
  use: ['verified'],
  candidates: ['ready'],
  review: ['needs_review', 'unresolved'],
}
const operationalKnowledgeStatuses: SupportManual['knowledgeStatus'][] = ['verified', 'ready']

function formatKnowledgeDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

function distinctKnowledgeText(value: string, ...duplicates: string[]): string {
  const normalized = value.trim()
  if (!normalized) return ''
  return duplicates.some((duplicate) => duplicate.trim() === normalized) ? '' : normalized
}

function manualInputFromManual(manual: SupportManual): ManualEditorInput {
  return {
    title: manual.title,
    category: manual.category,
    body: manual.body,
    url: manual.url ?? '',
    keywords: manual.keywords,
    owner: manual.owner ?? '',
    approvedBy: manual.approvedBy ?? '',
    revisedAt: manual.revisedAt ?? '',
    question: manual.question,
    resolution: manual.resolution,
    procedure: manual.procedure,
    applicability: manual.applicability,
    cautions: manual.cautions,
    knowledgeStatus: manual.knowledgeStatus,
    reviewNote: manual.reviewNote,
  }
}

function KnowledgeSection({ title, children, emphasis = false }: { title: string; children: string; emphasis?: boolean }) {
  if (!children.trim()) return null
  return (
    <section className="border-b border-gray-100 py-4 last:border-b-0">
      <h5 className="text-xs font-semibold text-gray-500">{title}</h5>
      <p className={`mt-2 whitespace-pre-wrap break-words text-sm leading-6 ${emphasis ? 'font-medium text-gray-950' : 'text-gray-700'}`}>
        {children}
      </p>
    </section>
  )
}

export default function ManualPanel({
  manuals,
  canManage,
  saving,
  search,
  category,
  onSearchChange,
  onCategoryChange,
  onCreateManual,
  onUpdateManual,
  onArchiveManual,
  onCopy,
  onFeedback,
  onVerify,
}: ManualPanelProps) {
  const [editing, setEditing] = useState<SupportManual | null>(null)
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState<ManualEditorInput>(emptyManualInput)
  const [selectedManualId, setSelectedManualId] = useState<string | null>(null)
  const [knowledgeView, setKnowledgeView] = useState<KnowledgeView>('use')
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false)
  const currentViewStatuses = useMemo(
    () => knowledgeView === 'use' && !canManage
      ? operationalKnowledgeStatuses
      : knowledgeStatuses[knowledgeView],
    [canManage, knowledgeView],
  )

  const visibleManuals = useMemo(
    () => manuals.filter((manual) => currentViewStatuses.includes(manual.knowledgeStatus)),
    [currentViewStatuses, manuals],
  )
  const selectedManual = useMemo(
    () => visibleManuals.find((manual) => manual.id === selectedManualId) ?? visibleManuals[0] ?? null,
    [selectedManualId, visibleManuals],
  )
  const viewCounts = useMemo(() => ({
    use: manuals.filter((manual) => (
      canManage ? knowledgeStatuses.use : operationalKnowledgeStatuses
    ).includes(manual.knowledgeStatus)).length,
    candidates: manuals.filter((manual) => knowledgeStatuses.candidates.includes(manual.knowledgeStatus)).length,
    review: manuals.filter((manual) => knowledgeStatuses.review.includes(manual.knowledgeStatus)).length,
  }), [canManage, manuals])
  const validationIssues = getManualEditorValidationIssues(draft)
  const submitDisabled = saving || validationIssues.some((issue) => issue.blocking)

  useEffect(() => {
    if (!canManage && knowledgeView !== 'use') {
      setKnowledgeView('use')
    }
  }, [canManage, knowledgeView])

  useEffect(() => {
    if (visibleManuals.length === 0) {
      setSelectedManualId(null)
      setMobileDetailOpen(false)
      return
    }
    if (!selectedManualId || !visibleManuals.some((manual) => manual.id === selectedManualId)) {
      setSelectedManualId(visibleManuals[0].id)
    }
  }, [selectedManualId, visibleManuals])

  const closeForm = () => {
    setEditing(null)
    setCreating(false)
    setDraft(emptyManualInput)
  }

  const openCreateForm = () => {
    setEditing(null)
    setCreating(true)
    setDraft({ ...emptyManualInput, category: category === 'all' ? 'other' : category })
  }

  const openEditForm = (manual: SupportManual) => {
    setSelectedManualId(manual.id)
    setCreating(false)
    setEditing(manual)
    setDraft(manualInputFromManual(manual))
  }

  const handleSubmit = async () => {
    if (submitDisabled) return
    const ok = editing
      ? await onUpdateManual(editing, draft)
      : await onCreateManual(draft)
    if (ok) {
      setKnowledgeView(
        draft.knowledgeStatus === 'ready'
          ? 'candidates'
          : knowledgeStatuses.review.includes(draft.knowledgeStatus)
            ? 'review'
            : 'use',
      )
      setSelectedManualId(null)
      setMobileDetailOpen(false)
      closeForm()
    }
  }

  const selectManual = (manual: SupportManual) => {
    setSelectedManualId(manual.id)
    setMobileDetailOpen(true)
  }

  const changeKnowledgeView = (view: KnowledgeView) => {
    setKnowledgeView(view)
    setSelectedManualId(null)
    setMobileDetailOpen(false)
    closeForm()
  }

  const formOpen = creating || editing !== null
  const hasFilters = Boolean(search.trim()) || category !== 'all'
  const isReviewView = knowledgeView === 'review'
  const isCandidateView = knowledgeView === 'candidates'

  return (
    <section className="overflow-hidden rounded-lg border border-gray-200 bg-white" aria-label="対応ナレッジ">
      <div className="border-b border-gray-200 p-3 sm:p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-gray-950">
              {isReviewView ? '要整理' : isCandidateView ? '確認待ち' : canManage ? '実務で使う' : 'ナレッジを探す'}
            </h3>
            <p className="mt-0.5 text-xs text-gray-500">{viewCounts[knowledgeView]}件</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canManage && (
              <div className="inline-flex rounded-md border border-gray-300 bg-gray-50 p-0.5" aria-label="ナレッジ表示">
                <button
                  type="button"
                  onClick={() => changeKnowledgeView('use')}
                  aria-pressed={knowledgeView === 'use'}
                  className={`rounded px-3 py-1.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 ${
                    knowledgeView === 'use' ? 'bg-white text-gray-950 shadow-sm' : 'text-gray-600 hover:text-gray-900'
                  }`}
                >
                  実務で使う {viewCounts.use}
                </button>
                <button
                  type="button"
                  onClick={() => changeKnowledgeView('candidates')}
                  aria-pressed={isCandidateView}
                  className={`rounded px-3 py-1.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 ${
                    isCandidateView ? 'bg-white text-gray-950 shadow-sm' : 'text-gray-600 hover:text-gray-900'
                  }`}
                >
                  確認待ち {viewCounts.candidates}
                </button>
                <button
                  type="button"
                  onClick={() => changeKnowledgeView('review')}
                  aria-pressed={isReviewView}
                  className={`rounded px-3 py-1.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 ${
                    isReviewView ? 'bg-white text-gray-950 shadow-sm' : 'text-gray-600 hover:text-gray-900'
                  }`}
                >
                  要整理 {viewCounts.review}
                </button>
              </div>
            )}
            {canManage && (
              <button type="button" onClick={openCreateForm} disabled={saving} className={btnSecondaryCls}>
                <PlusIcon className="h-4 w-4" />
                新規
              </button>
            )}
          </div>
        </div>

        <div className="mt-3 grid gap-2 md:grid-cols-[minmax(0,1fr)_220px]">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <input
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              className={`${inputCls} pl-9 ${search ? 'pr-9' : ''}`}
              placeholder="質問・結論・キーワードで検索"
              aria-label="ナレッジを検索"
            />
            {search && (
              <button
                type="button"
                onClick={() => onSearchChange('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                aria-label="検索をクリア"
              >
                <XIcon className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <select value={category} onChange={(event) => onCategoryChange(event.target.value)} className={selectCls} aria-label="カテゴリ">
            <option value="all">全カテゴリ</option>
            {categoryOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-gray-500" aria-label="表示中の状態">
          {currentViewStatuses.map((status) => (
            <Pill key={status} className={statusMeta[status].badge}>{statusMeta[status].label}</Pill>
          ))}
        </div>
      </div>

      {canManage && formOpen && (
        <div className="border-b border-gray-200 bg-gray-50 p-3 sm:p-4">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-sm font-semibold text-gray-900">{editing ? 'ナレッジを編集' : 'ナレッジを作成'}</h4>
            <button type="button" onClick={closeForm} disabled={saving} className="rounded p-1 text-gray-400 hover:bg-white hover:text-gray-700" aria-label="編集を閉じる">
              <XIcon className="h-4 w-4" />
            </button>
          </div>

          {validationIssues.length > 0 && (
            <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
              {validationIssues.map((issue) => <p key={issue.key}>{issue.fieldLabel}: {issue.message}</p>)}
            </div>
          )}

          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            <Field label="タイトル">
              <input value={draft.title} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} className={inputCls} />
            </Field>
            <Field label="カテゴリ">
              <select value={draft.category} onChange={(event) => setDraft((current) => ({ ...current, category: event.target.value }))} className={selectCls}>
                {categoryOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
            </Field>
            <div className="lg:col-span-2">
              <Field label="問い合わせ">
                <textarea value={draft.question} onChange={(event) => setDraft((current) => ({ ...current, question: event.target.value }))} className={`${textareaCls} min-h-[96px]`} />
              </Field>
            </div>
            <div className="lg:col-span-2">
              <Field label="結論">
                <textarea value={draft.resolution} onChange={(event) => setDraft((current) => ({ ...current, resolution: event.target.value }))} className={`${textareaCls} min-h-[96px]`} />
              </Field>
            </div>
            <Field label="対応手順">
              <textarea value={draft.procedure} onChange={(event) => setDraft((current) => ({ ...current, procedure: event.target.value }))} className={`${textareaCls} min-h-[96px]`} />
            </Field>
            <Field label="適用条件">
              <textarea value={draft.applicability} onChange={(event) => setDraft((current) => ({ ...current, applicability: event.target.value }))} className={`${textareaCls} min-h-[96px]`} />
            </Field>
            <Field label="注意点">
              <textarea value={draft.cautions} onChange={(event) => setDraft((current) => ({ ...current, cautions: event.target.value }))} className={`${textareaCls} min-h-[88px]`} />
            </Field>
            <Field label="ナレッジ状態">
              <select value={draft.knowledgeStatus} onChange={(event) => setDraft((current) => ({ ...current, knowledgeStatus: event.target.value as SupportManual['knowledgeStatus'] }))} className={selectCls}>
                {Object.entries(statusMeta).map(([value, meta]) => <option key={value} value={value}>{meta.label}</option>)}
              </select>
            </Field>
            <Field label="確認メモ">
              <textarea value={draft.reviewNote} onChange={(event) => setDraft((current) => ({ ...current, reviewNote: event.target.value }))} className={`${textareaCls} min-h-[72px]`} />
            </Field>
            <Field label="検索キーワード">
              <input value={draft.keywords} onChange={(event) => setDraft((current) => ({ ...current, keywords: event.target.value }))} className={inputCls} />
            </Field>
            <Field label="元スレッドURL">
              <input value={draft.url} onChange={(event) => setDraft((current) => ({ ...current, url: event.target.value }))} className={inputCls} placeholder="https://..." />
            </Field>
            <Field label="改訂日">
              <input type="date" value={draft.revisedAt} onChange={(event) => setDraft((current) => ({ ...current, revisedAt: event.target.value }))} className={inputCls} />
            </Field>
          </div>
          <button type="button" onClick={() => void handleSubmit()} disabled={submitDisabled} className={`mt-4 ${btnSecondaryCls}`}>
            <CheckIcon className="h-4 w-4" />
            {editing ? '更新' : '作成'}
          </button>
        </div>
      )}

      <div className="grid min-h-[560px] lg:grid-cols-[minmax(320px,400px)_minmax(0,1fr)]">
        <div className={`${mobileDetailOpen ? 'hidden lg:block' : 'block'} max-h-[720px] overflow-y-auto border-r-0 border-gray-200 lg:border-r`}>
          {visibleManuals.length === 0 ? (
            <div className="px-4 py-12 text-center">
              <p className="text-sm font-medium text-gray-700">
                {isReviewView
                  ? '整理が必要な候補はありません'
                  : isCandidateView
                    ? '確認待ちの候補はありません'
                    : '管理者が確認したナレッジはまだありません'}
              </p>
              {hasFilters && (
                <button
                  type="button"
                  onClick={() => {
                    onSearchChange('')
                    onCategoryChange('all')
                  }}
                  className="mt-3 rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
                >
                  条件をリセット
                </button>
              )}
            </div>
          ) : visibleManuals.map((manual) => {
            const selected = selectedManual?.id === manual.id
            const meta = statusMeta[manual.knowledgeStatus]
            return (
              <button
                key={manual.id}
                type="button"
                onClick={() => selectManual(manual)}
                aria-pressed={selected}
                className={`block w-full border-b border-gray-100 px-3 py-3 text-left transition-colors sm:px-4 ${selected ? 'bg-green-50' : 'hover:bg-gray-50'}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 break-words text-sm font-semibold leading-5 text-gray-900">{manual.title}</p>
                  <Pill className={meta.badge}>{meta.label}</Pill>
                </div>
                <p className="mt-1.5 line-clamp-2 break-words text-xs leading-5 text-gray-600">{manual.question || manual.body}</p>
                {manual.resolution && (
                  <p className="mt-1.5 line-clamp-2 break-words text-xs font-medium leading-5 text-gray-700">結論: {manual.resolution}</p>
                )}
                <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px] text-gray-400">
                  <span>{categoryLabel[manual.category] || manual.category}</span>
                  <time dateTime={manual.updatedAt}>更新 {formatKnowledgeDate(manual.updatedAt)}</time>
                </div>
              </button>
            )
          })}
        </div>

        <div className={`${mobileDetailOpen ? 'block' : 'hidden lg:block'} min-w-0 p-3 sm:p-5`}>
          {selectedManual ? (
            <article>
              <button type="button" onClick={() => setMobileDetailOpen(false)} className="sticky top-0 z-10 mb-3 rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-600 shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 lg:hidden">
                一覧へ戻る
              </button>
              <header className="border-b border-gray-200 pb-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Pill className={statusMeta[selectedManual.knowledgeStatus].badge}>{statusMeta[selectedManual.knowledgeStatus].label}</Pill>
                  <Pill className="border-gray-200 bg-gray-50 text-gray-600">{categoryLabel[selectedManual.category] || selectedManual.category}</Pill>
                  {selectedManual.useCount > 0 && <span className="text-xs text-gray-400">利用 {selectedManual.useCount}回</span>}
                  <time dateTime={selectedManual.updatedAt} className="text-xs text-gray-400">更新 {formatKnowledgeDate(selectedManual.updatedAt)}</time>
                </div>
                <h4 className="mt-2 break-words text-lg font-semibold leading-7 text-gray-950">{selectedManual.title}</h4>
                {selectedManual.needsImprovementCount > 0 && (
                  <p className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-800">
                    改善報告 {selectedManual.needsImprovementCount}件
                  </p>
                )}
              </header>

              {selectedManual.knowledgeStatus === 'ready' && (
                <div className="mt-4 rounded-md border border-blue-200 bg-blue-50 px-3 py-3 text-sm leading-6 text-blue-900" role="note">
                  <p className="font-semibold">未確認の回答候補です</p>
                  <p className="mt-1">使う前に 問い合わせ内容と結論が対応しているかを確認してください</p>
                </div>
              )}

              {isReviewView && canManage && (
                <section className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 sm:p-4" aria-labelledby="review-note-title">
                  <h5 id="review-note-title" className="text-sm font-semibold text-amber-950">確認メモ</h5>
                  <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-amber-900">
                    {selectedManual.reviewNote || '確認メモはありません 内容を確認して必要に応じて編集してください'}
                  </p>
                  <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                    <button type="button" onClick={() => void onVerify(selectedManual)} disabled={saving} className="inline-flex items-center justify-center gap-1.5 rounded-md bg-green-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-green-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 disabled:opacity-50">
                      <CheckIcon className="h-4 w-4" />
                      確認済みにする
                    </button>
                    <button type="button" onClick={() => openEditForm(selectedManual)} disabled={saving} className="rounded-md border border-amber-400 bg-white px-4 py-2.5 text-sm font-semibold text-amber-950 hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 disabled:opacity-50">
                      編集
                    </button>
                  </div>
                </section>
              )}

              <KnowledgeSection title="結論" emphasis>{selectedManual.resolution}</KnowledgeSection>
              <KnowledgeSection title="適用条件">{selectedManual.applicability}</KnowledgeSection>
              <KnowledgeSection title="対応手順">
                {distinctKnowledgeText(selectedManual.procedure, selectedManual.resolution)}
              </KnowledgeSection>
              <KnowledgeSection title="注意点">
                {distinctKnowledgeText(selectedManual.cautions, selectedManual.resolution, selectedManual.procedure)}
              </KnowledgeSection>

              <details className="border-b border-gray-100 py-4">
                <summary className="cursor-pointer rounded text-sm font-medium text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500">証跡を確認</summary>
                <div className="mt-3 space-y-4">
                  <div>
                    <h6 className="text-xs font-semibold text-gray-500">問い合わせ</h6>
                    <p className="mt-1.5 whitespace-pre-wrap break-words text-sm leading-6 text-gray-700">{selectedManual.question || '記録なし'}</p>
                  </div>
                  <div>
                    <h6 className="text-xs font-semibold text-gray-500">原文</h6>
                    <p className="mt-1.5 whitespace-pre-wrap break-words text-xs leading-5 text-gray-500">{selectedManual.sourceBody || selectedManual.body || '記録なし'}</p>
                  </div>
                </div>
                {selectedManual.url && (
                  <a href={selectedManual.url} target="_blank" rel="noopener noreferrer" className="mt-3 inline-block text-sm font-medium text-blue-600 hover:underline">
                    元スレッドを開く
                  </a>
                )}
              </details>

              <footer className="flex flex-wrap gap-2 pt-4">
                {knowledgeView === 'use' && (
                  <>
                    <button type="button" onClick={() => void onCopy(selectedManual)} disabled={!selectedManual.resolution || saving} className="inline-flex items-center gap-1.5 rounded-md bg-green-600 px-3 py-2 text-sm font-semibold text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50">
                      <CopyIcon className="h-4 w-4" />
                      {selectedManual.knowledgeStatus === 'ready' ? '候補の結論をコピー' : '結論をコピー'}
                    </button>
                    <button type="button" onClick={() => void onFeedback(selectedManual, 'helpful')} disabled={saving} className="rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50">
                      役に立った
                    </button>
                    <button type="button" onClick={() => void onFeedback(selectedManual, 'needs_improvement')} disabled={saving} className="rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50">
                      改善が必要
                    </button>
                  </>
                )}
                {canManage && (
                  <>
                    {knowledgeView !== 'review' && (
                      <>
                        {knowledgeView === 'candidates' && selectedManual.knowledgeStatus !== 'verified' && (
                          <button type="button" onClick={() => void onVerify(selectedManual)} disabled={saving} className="inline-flex items-center gap-1.5 rounded-md border border-green-300 px-3 py-2 text-sm font-medium text-green-700 hover:bg-green-50 disabled:opacity-50">
                            <CheckIcon className="h-4 w-4" />
                            確認済みにする
                          </button>
                        )}
                        <button type="button" onClick={() => openEditForm(selectedManual)} disabled={saving} className="rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50">
                          編集
                        </button>
                      </>
                    )}
                    <button type="button" onClick={() => void onArchiveManual(selectedManual)} disabled={saving} className="rounded-md border border-red-200 px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50">
                      無効化
                    </button>
                  </>
                )}
              </footer>
            </article>
          ) : (
            <div className="flex min-h-[400px] items-center justify-center text-sm text-gray-500">ナレッジを選択してください</div>
          )}
        </div>
      </div>
    </section>
  )
}

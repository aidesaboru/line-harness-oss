'use client'

import { useEffect, useMemo, useState } from 'react'
import type { SupportManual } from '@/lib/api'
import { categoryLabel, categoryOptions, getManualEditorValidationIssues } from './support-meta'
import { CheckIcon, Field, Pill, PlusIcon, SearchIcon, XIcon, btnSecondaryCls, inputCls, selectCls, textareaCls } from './support-ui'

export type ManualEditorInput = {
  title: string
  category: string
  body: string
  url: string
  keywords: string
  owner: string
  approvedBy: string
  revisedAt: string
}

interface ManualPanelProps {
  manuals: SupportManual[]
  linkedManuals: SupportManual[]
  linkedIds: string[]
  canLink: boolean
  canManage: boolean
  saving: boolean
  search: string
  category: string
  onSearchChange: (value: string) => void
  onCategoryChange: (value: string) => void
  onLink: (manual: SupportManual) => void
  onUnlink: (manual: SupportManual) => void
  onCreateManual: (input: ManualEditorInput) => Promise<boolean>
  onUpdateManual: (manual: SupportManual, input: ManualEditorInput) => Promise<boolean>
  onArchiveManual: (manual: SupportManual) => Promise<boolean>
  showLinkActions?: boolean
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
  }
}

type ParsedManualBody = {
  customerInfo: string
  question: string
  answer: string
  rest: string
  structured: boolean
}

const manualBodySectionMap: Record<string, keyof Omit<ParsedManualBody, 'structured'>> = {
  '顧客・案件情報': 'customerInfo',
  顧客情報: 'customerInfo',
  案件情報: 'customerInfo',
  問い合わせ内容: 'question',
  一次対応の問い合わせ: 'question',
  質問: 'question',
  問い: 'question',
  解決回答: 'answer',
  対応ナレッジ: 'answer',
  二次対応の回答: 'answer',
  回答: 'answer',
  本文: 'rest',
}

function cleanManualText(value: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .replace(/(^|\n)```/g, '$1')
    .replace(/```\n?/g, '')
    .replace(/^\s*!channel\s*$/gm, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function appendSectionValue(current: string, next: string): string {
  const cleaned = cleanManualText(next)
  if (!cleaned) return current
  return current ? `${current}\n\n${cleaned}` : cleaned
}

function parseManualBody(body: string): ParsedManualBody {
  const result: ParsedManualBody = {
    customerInfo: '',
    question: '',
    answer: '',
    rest: '',
    structured: false,
  }
  const matches = Array.from(body.matchAll(/【([^】]+)】/g))
  if (matches.length === 0) {
    result.rest = cleanManualText(body)
    return result
  }

  matches.forEach((match, index) => {
    const label = cleanManualText(match[1] ?? '')
    const key = manualBodySectionMap[label] ?? 'rest'
    const sectionStart = (match.index ?? 0) + match[0].length
    const sectionEnd = matches[index + 1]?.index ?? body.length
    const value = body.slice(sectionStart, sectionEnd)
    result[key] = appendSectionValue(result[key], value)
    if (key !== 'rest') result.structured = true
  })
  return result
}

function splitAnswerBlocks(answer: string): string[] {
  const blocks = answer
    .split(/\n\s*---\s*\n/g)
    .map(cleanManualText)
    .filter(Boolean)
  return blocks.length > 0 ? blocks : (answer ? [answer] : [])
}

function buildManualPreview(manual: SupportManual): string {
  const parsed = parseManualBody(manual.body)
  const source = parsed.question || parsed.answer || parsed.rest || manual.body
  return cleanManualText(source).slice(0, 180)
}

function ManualTextBlock({ children, tone = 'default' }: { children: string; tone?: 'default' | 'answer' }) {
  const toneCls = tone === 'answer'
    ? 'border-green-100 bg-green-50/60 text-gray-800'
    : 'border-gray-100 bg-gray-50 text-gray-700'
  return (
    <div className={`rounded-md border px-3 py-2 ${toneCls}`}>
      <p className="whitespace-pre-wrap break-words text-sm leading-6">{children}</p>
    </div>
  )
}

/**
 * 対応マニュアル欄。検索は入力で自動適用。
 * 選択中の案件に紐付け済みのマニュアルを上部に表示し、ワンクリックで解除できる。
 */
export default function ManualPanel({
  manuals,
  linkedManuals,
  linkedIds,
  canLink,
  canManage,
  saving,
  search,
  category,
  onSearchChange,
  onCategoryChange,
  onLink,
  onUnlink,
  onCreateManual,
  onUpdateManual,
  onArchiveManual,
  showLinkActions = true,
}: ManualPanelProps) {
  const [editing, setEditing] = useState<SupportManual | null>(null)
  const [draft, setDraft] = useState<ManualEditorInput>(emptyManualInput)
  const [selectedManualId, setSelectedManualId] = useState<string | null>(null)
  const formOpen = editing !== null || draft !== emptyManualInput
  const selectedManual = useMemo(
    () => manuals.find((manual) => manual.id === selectedManualId) ?? manuals[0] ?? null,
    [manuals, selectedManualId],
  )
  const selectedManualBody = useMemo(
    () => selectedManual ? parseManualBody(selectedManual.body) : null,
    [selectedManual],
  )
  const selectedAnswerBlocks = useMemo(
    () => selectedManualBody ? splitAnswerBlocks(selectedManualBody.answer) : [],
    [selectedManualBody],
  )
  const validationIssues = getManualEditorValidationIssues(draft)
  const blockingValidationIssues = validationIssues.filter((issue) => issue.blocking)
  const submitDisabled = saving || blockingValidationIssues.length > 0
  const hasManualFilters = Boolean(search.trim()) || category !== 'all'
  const manualEmptyTitle = hasManualFilters
    ? '条件に合うマニュアルはありません'
    : 'マニュアルはまだありません'
  const manualEmptyDescription = hasManualFilters
    ? '検索語やカテゴリを変えて探してください。'
    : canManage
      ? '右上の「新規」から、よく使う対応手順を追加できます。'
      : 'owner/adminが作成したマニュアルがここに表示されます。必要な手順がなければ作成を依頼してください。'

  useEffect(() => {
    if (manuals.length === 0) {
      setSelectedManualId(null)
      return
    }
    if (!selectedManualId || !manuals.some((manual) => manual.id === selectedManualId)) {
      setSelectedManualId(manuals[0].id)
    }
  }, [manuals, selectedManualId])

  const openCreateForm = () => {
    setEditing(null)
    setDraft({ ...emptyManualInput, category: category === 'all' ? 'other' : category })
  }

  const openEditForm = (manual: SupportManual) => {
    setSelectedManualId(manual.id)
    setEditing(manual)
    setDraft(manualInputFromManual(manual))
  }

  const closeForm = () => {
    setEditing(null)
    setDraft(emptyManualInput)
  }

  const handleSubmit = async () => {
    if (submitDisabled) return
    const ok = editing
      ? await onUpdateManual(editing, draft)
      : await onCreateManual(draft)
    if (ok) closeForm()
  }

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4" aria-label="対応マニュアル">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-gray-900">マニュアル</h3>
        {canManage && (
          <button
            type="button"
            onClick={openCreateForm}
            disabled={saving}
            className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2 py-1 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <PlusIcon className="h-3.5 w-3.5" />
            新規
          </button>
        )}
      </div>

      {canManage && formOpen && (
        <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-semibold text-gray-700">{editing ? 'マニュアル編集' : 'マニュアル新規作成'}</p>
            <button
              type="button"
              onClick={closeForm}
              disabled={saving}
              className="rounded p-1 text-gray-400 transition-colors hover:bg-white hover:text-gray-700 disabled:opacity-50"
              aria-label="マニュアルフォームを閉じる"
            >
              <XIcon className="h-4 w-4" />
            </button>
          </div>
          <div className="mt-3 space-y-3">
            {validationIssues.length > 0 && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
                <p className="font-semibold">保存前に必要な入力があります</p>
                <ul className="mt-1 space-y-1">
                  {validationIssues.map((issue) => (
                    <li key={issue.key} className="flex items-start gap-2">
                      <span className="mt-0.5 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-700">
                        必須
                      </span>
                      <span>
                        <span className="font-medium">{issue.fieldLabel}: </span>
                        {issue.message}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <Field label="タイトル">
              <input
                value={draft.title}
                onChange={(e) => setDraft((prev) => ({ ...prev, title: e.target.value }))}
                className={inputCls}
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="カテゴリ">
                <select
                  value={draft.category}
                  onChange={(e) => setDraft((prev) => ({ ...prev, category: e.target.value }))}
                  className={selectCls}
                >
                  {categoryOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                </select>
              </Field>
              <Field label="改訂日">
                <input
                  type="date"
                  value={draft.revisedAt}
                  onChange={(e) => setDraft((prev) => ({ ...prev, revisedAt: e.target.value }))}
                  className={inputCls}
                />
              </Field>
            </div>
            <Field label="本文">
              <textarea
                value={draft.body}
                onChange={(e) => setDraft((prev) => ({ ...prev, body: e.target.value }))}
                className={`${textareaCls} min-h-[120px]`}
              />
            </Field>
            <Field label="リンク">
              <input
                value={draft.url}
                onChange={(e) => setDraft((prev) => ({ ...prev, url: e.target.value }))}
                className={inputCls}
                placeholder="https://..."
              />
            </Field>
            <Field label="キーワード">
              <input
                value={draft.keywords}
                onChange={(e) => setDraft((prev) => ({ ...prev, keywords: e.target.value }))}
                className={inputCls}
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="管理担当">
                <input
                  value={draft.owner}
                  onChange={(e) => setDraft((prev) => ({ ...prev, owner: e.target.value }))}
                  className={inputCls}
                />
              </Field>
              <Field label="承認者">
                <input
                  value={draft.approvedBy}
                  onChange={(e) => setDraft((prev) => ({ ...prev, approvedBy: e.target.value }))}
                  className={inputCls}
                />
              </Field>
            </div>
            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={submitDisabled}
              title={blockingValidationIssues[0]?.message}
              className={btnSecondaryCls}
            >
              <CheckIcon className="h-4 w-4" />
              {editing ? '更新' : '作成'}
            </button>
          </div>
        </div>
      )}

      {showLinkActions && canLink && linkedManuals.length > 0 && (
        <div className="mt-3 rounded-lg border border-green-200 bg-green-50/50 p-2.5">
          <p className="text-[11px] font-semibold text-green-800">この案件に紐付け済み</p>
          <ul className="mt-1.5 space-y-1">
            {linkedManuals.map((manual) => (
              <li key={manual.id} className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-xs font-medium text-gray-700">{manual.title}</span>
                <button
                  type="button"
                  onClick={() => onUnlink(manual)}
                  disabled={saving}
                  className="inline-flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-[11px] font-medium text-gray-400 transition-colors hover:bg-white hover:text-red-600 disabled:opacity-50"
                  aria-label={`${manual.title} の紐付けを解除`}
                >
                  <XIcon className="h-3 w-3" />
                  解除
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="relative mt-3">
        <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
        <input
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          className={`${inputCls} pl-9 ${search ? 'pr-8' : ''}`}
          placeholder="タイトル・本文・キーワードで検索"
          aria-label="マニュアルを検索"
        />
        {search && (
          <button
            type="button"
            onClick={() => onSearchChange('')}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
            aria-label="検索をクリア"
          >
            <XIcon className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <select
        value={category}
        onChange={(e) => onCategoryChange(e.target.value)}
        className={`mt-2 ${selectCls}`}
        aria-label="マニュアルのカテゴリ"
      >
        <option value="all">全カテゴリ</option>
        {categoryOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
      </select>

      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(280px,360px)_minmax(0,1fr)]">
        <div className="max-h-[620px] space-y-2 overflow-y-auto overscroll-contain pr-1">
          {manuals.length === 0 ? (
            <div className="py-6 text-center">
              <p className="text-sm font-medium text-gray-600">{manualEmptyTitle}</p>
              <p className="mx-auto mt-1 max-w-xs text-xs leading-relaxed text-gray-400">{manualEmptyDescription}</p>
              {hasManualFilters && (
                <button
                  type="button"
                  onClick={() => {
                    onSearchChange('')
                    onCategoryChange('all')
                  }}
                  disabled={saving}
                  className="mt-3 rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  検索条件をリセット
                </button>
              )}
            </div>
          ) : manuals.map((manual) => {
            const linked = linkedIds.includes(manual.id)
            const selected = selectedManual?.id === manual.id
            const preview = buildManualPreview(manual)
            return (
              <article
                key={manual.id}
                className={`rounded-lg border p-3 transition-colors ${
                  selected
                    ? 'border-green-300 bg-green-50/40'
                    : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                <button
                  type="button"
                  onClick={() => setSelectedManualId(manual.id)}
                  className="block w-full text-left"
                  aria-pressed={selected}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="break-words text-sm font-semibold text-gray-900">{manual.title}</p>
                      <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-gray-500">
                        <Pill className="border-gray-200 bg-white text-gray-600">
                          {categoryLabel[manual.category] || manual.category}
                        </Pill>
                        {manual.owner === 'Slack過去ログ' && (
                          <Pill className="border-green-200 bg-green-50 text-green-700">Slackナレッジ</Pill>
                        )}
                        <span>{manual.owner || '担当未設定'}</span>
                      </p>
                    </div>
                    <span className="shrink-0 text-xs font-medium text-green-700">{selected ? '表示中' : '表示'}</span>
                  </div>
                  {preview && (
                    <p className="mt-2 line-clamp-3 whitespace-pre-wrap break-words text-sm leading-6 text-gray-600">
                      {preview}
                    </p>
                  )}
                </button>
                <div className="mt-3 flex flex-wrap gap-2 border-t border-gray-100 pt-2">
                  {showLinkActions && (
                    <button
                      type="button"
                      onClick={() => onLink(manual)}
                      disabled={!canLink || saving || linked}
                      title={!canLink ? 'チケットを選択すると紐付けできます' : undefined}
                      className={`rounded-md px-2 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed ${
                        linked
                          ? 'border border-green-200 bg-green-50 text-green-700'
                          : 'border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50'
                      }`}
                    >
                      {linked ? '紐付済' : '紐付け'}
                    </button>
                  )}
                  {manual.url && (
                    <a
                      href={manual.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="rounded-md border border-blue-100 bg-white px-2 py-1 text-xs font-medium text-blue-600 underline-offset-2 transition-colors hover:bg-blue-50 hover:underline"
                    >
                      元スレッド
                    </a>
                  )}
                  {canManage && (
                    <>
                      <button
                        type="button"
                        onClick={() => openEditForm(manual)}
                        disabled={saving}
                        className="rounded-md border border-gray-200 bg-white px-2 py-1 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        編集
                      </button>
                      <button
                        type="button"
                        onClick={() => void onArchiveManual(manual)}
                        disabled={saving}
                        className="rounded-md border border-red-200 bg-white px-2 py-1 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        無効化
                      </button>
                    </>
                  )}
                </div>
              </article>
            )
          })}
        </div>

        <div className="min-h-[420px] border-t border-gray-100 pt-4 xl:border-l xl:border-t-0 xl:pl-4 xl:pt-0">
          {selectedManual && selectedManualBody ? (
            <article className="space-y-4">
              <header className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Pill className="border-gray-200 bg-gray-50 text-gray-600">
                    {categoryLabel[selectedManual.category] || selectedManual.category}
                  </Pill>
                  {selectedManual.owner === 'Slack過去ログ' && (
                    <Pill className="border-green-200 bg-green-50 text-green-700">Slackナレッジ</Pill>
                  )}
                  {selectedManual.revisedAt && (
                    <span className="text-xs text-gray-400">更新 {selectedManual.revisedAt}</span>
                  )}
                </div>
                <h4 className="break-words text-lg font-semibold leading-7 text-gray-950">{selectedManual.title}</h4>
                <p className="text-xs text-gray-500">
                  {selectedManualBody.structured
                    ? '問い合わせ内容と解決回答を分けて確認できます。'
                    : '本文をそのまま確認できます。'}
                </p>
              </header>

              {selectedManualBody.structured ? (
                <div className="space-y-4">
                  {selectedManualBody.customerInfo && (
                    <section>
                      <h5 className="text-xs font-semibold text-gray-500">顧客・案件情報</h5>
                      <div className="mt-2 rounded-md border border-gray-100 bg-white px-3 py-2">
                        <p className="whitespace-pre-wrap break-words text-xs leading-5 text-gray-500">
                          {selectedManualBody.customerInfo}
                        </p>
                      </div>
                    </section>
                  )}
                  {selectedManualBody.question && (
                    <section>
                      <h5 className="text-sm font-semibold text-gray-900">問い合わせ内容</h5>
                      <div className="mt-2">
                        <ManualTextBlock>{selectedManualBody.question}</ManualTextBlock>
                      </div>
                    </section>
                  )}
                  {selectedAnswerBlocks.length > 0 && (
                    <section>
                      <h5 className="text-sm font-semibold text-gray-900">解決回答</h5>
                      <div className="mt-2 space-y-2">
                        {selectedAnswerBlocks.map((block, index) => (
                          <div key={`${selectedManual.id}-answer-${index}`} className="space-y-1.5">
                            {selectedAnswerBlocks.length > 1 && (
                              <p className="text-xs font-semibold text-green-700">回答メモ {index + 1}</p>
                            )}
                            <ManualTextBlock tone="answer">{block}</ManualTextBlock>
                          </div>
                        ))}
                      </div>
                    </section>
                  )}
                  {selectedManualBody.rest && (
                    <section>
                      <h5 className="text-sm font-semibold text-gray-900">補足</h5>
                      <div className="mt-2">
                        <ManualTextBlock>{selectedManualBody.rest}</ManualTextBlock>
                      </div>
                    </section>
                  )}
                </div>
              ) : (
                <ManualTextBlock>{selectedManualBody.rest}</ManualTextBlock>
              )}

              <footer className="flex flex-wrap gap-2 border-t border-gray-100 pt-3">
                {selectedManual.url && (
                  <a
                    href={selectedManual.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-md border border-blue-100 bg-white px-3 py-1.5 text-sm font-medium text-blue-600 underline-offset-2 transition-colors hover:bg-blue-50 hover:underline"
                  >
                    元スレッドを開く
                  </a>
                )}
                {canManage && (
                  <button
                    type="button"
                    onClick={() => openEditForm(selectedManual)}
                    disabled={saving}
                    className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    編集
                  </button>
                )}
              </footer>
            </article>
          ) : (
            <div className="flex min-h-[320px] items-center justify-center text-center">
              <div>
                <p className="text-sm font-medium text-gray-600">ナレッジを選択してください</p>
                <p className="mt-1 text-xs text-gray-400">左の一覧から内容を開けます。</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

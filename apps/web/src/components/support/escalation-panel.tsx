'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { SupportCaseDetail, SupportEscalation, SupportEscalationStatus } from '@/lib/api'
import { copyText } from '@/lib/clipboard'
import {
  buildEscalationShareText,
  escalationStatusMeta,
  formatDateTime,
  fromInputDateTime,
  dueUrgency,
  formatRelativeDue,
  getEscalationDraftValidationIssues,
  type CaseFormState,
} from './support-meta'
import {
  CheckIcon,
  CopyIcon,
  DueTimePresetRow,
  Field,
  Pill,
  inputCls,
  textareaCls,
  type ToastKind,
} from './support-ui'

export interface EscalateInput {
  assignee: string
  level: 'L2' | 'L3'
  dueAt: string
  question: string
}

interface EscalationPanelProps {
  detail: SupportCaseDetail | null
  caseForm: CaseFormState
  staffName: string
  saving: boolean
  canEditRouting: boolean
  onEscalate: (input: EscalateInput) => Promise<boolean>
  onUpdateEscalation: (id: string, status: SupportEscalationStatus, answer: string) => Promise<void>
  notify: (kind: ToastKind, message: string) => void
}

const ACTIVE_STATUS_RANK: Record<SupportEscalationStatus, number> = {
  pending: 0,
  needs_info: 0,
  transferred: 1,
  expert_check: 1,
  answered: 2,
  closed: 3,
}

function emptyEscalateForm(assignee = ''): EscalateInput {
  return { assignee, level: 'L2', dueAt: '', question: '' }
}

function EscalationItem({
  item,
  isMine,
  answer,
  saving,
  onAnswerChange,
  onUpdate,
}: {
  item: SupportEscalation
  isMine: boolean
  answer: string
  saving: boolean
  onAnswerChange: (value: string) => void
  onUpdate: (status: SupportEscalationStatus) => void
}) {
  const meta = escalationStatusMeta[item.status]
  const isActive = item.status === 'pending' || item.status === 'needs_info'
  const urgency = dueUrgency(item.dueAt)
  return (
    <div
      className={`rounded-lg border p-3 ${
        isMine && isActive ? 'border-green-300 bg-green-50/50 ring-1 ring-green-200' : 'border-gray-200'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-1.5 text-sm font-semibold text-gray-900">
            <span className="truncate">{item.assignee}</span>
            {isMine && <Pill className="border-green-300 bg-green-100 text-green-800">自分宛</Pill>}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Pill className="border-gray-200 bg-gray-50 text-gray-600">{item.level}</Pill>
            <Pill className={meta.className}>{meta.label}</Pill>
            {item.dueAt && (
              <span
                className={`text-[11px] ${
                  isActive && urgency === 'overdue'
                    ? 'font-semibold text-red-700'
                    : isActive && urgency === 'soon'
                      ? 'font-semibold text-amber-700'
                      : 'text-gray-400'
                }`}
              >
                期限 {formatDateTime(item.dueAt)}
                {isActive && urgency !== 'none' && `（${formatRelativeDue(item.dueAt)}）`}
              </span>
            )}
          </div>
        </div>
      </div>
      <p className="mt-2 whitespace-pre-wrap break-words text-sm text-gray-700">{item.question}</p>
      <textarea
        value={answer}
        onChange={(e) => onAnswerChange(e.target.value)}
        rows={3}
        className={`mt-2 ${textareaCls}`}
        placeholder="回答要点（判断と根拠を短く）"
        aria-label={`${item.assignee} への回答要点`}
      />
      {item.answeredAt && (
        <p className="mt-1 text-[11px] text-gray-400">回答日時 {formatDateTime(item.answeredAt)}</p>
      )}
      <div className="mt-2 grid grid-cols-2 gap-2">
        <button
          onClick={() => onUpdate('answered')}
          disabled={saving || !answer.trim()}
          className="inline-flex items-center justify-center gap-1 rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          title={answer.trim() ? undefined : '回答要点を入力すると回答済みにできます'}
        >
          <CheckIcon className="h-3.5 w-3.5" />
          回答済み
        </button>
        <button
          onClick={() => onUpdate('needs_info')}
          disabled={saving}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
        >
          差し戻し
        </button>
      </div>
    </div>
  )
}

/**
 * エスカレーション欄。
 * 二次対応先はチケットの「二次対応先」から自動引き継ぎ。自分宛の未回答は緑でハイライト。
 */
export default function EscalationPanel({
  detail,
  caseForm,
  staffName,
  saving,
  canEditRouting,
  onEscalate,
  onUpdateEscalation,
  notify,
}: EscalationPanelProps) {
  const [form, setForm] = useState<EscalateInput>(() => emptyEscalateForm())
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [copied, setCopied] = useState(false)
  const lastCaseIdRef = useRef<string | null>(null)

  // チケットを切り替えたときだけフォームをリセットし、二次対応先を引き継ぐ
  useEffect(() => {
    if (!detail) {
      lastCaseIdRef.current = null
      return
    }
    if (lastCaseIdRef.current === detail.id) return
    lastCaseIdRef.current = detail.id
    setForm(emptyEscalateForm(detail.escalationAssignee ?? ''))
    setAnswers({})
  }, [detail])

  const sortedEscalations = useMemo(() => {
    if (!detail) return []
    return [...detail.escalations].sort((a, b) => {
      const rank = ACTIVE_STATUS_RANK[a.status] - ACTIVE_STATUS_RANK[b.status]
      if (rank !== 0) return rank
      return b.createdAt.localeCompare(a.createdAt)
    })
  }, [detail])

  const shareText = useMemo(() => {
    if (!detail) return ''
    const activeEscalation =
      detail.escalations.find((item) => item.status !== 'closed') ?? detail.escalations[0]
    return buildEscalationShareText({
      title: caseForm.title || detail.title,
      friendName: detail.friendName,
      companyName: caseForm.companyName || detail.companyName,
      priority: caseForm.priority,
      category: caseForm.category,
      dueAt: fromInputDateTime(caseForm.dueAt),
      primaryAssignee: caseForm.primaryAssignee,
      escalationAssignee: form.assignee || activeEscalation?.assignee || caseForm.escalationAssignee,
      customerSummary: caseForm.customerSummary,
      question: form.question || activeEscalation?.question || '',
      recentMessages: detail.recentMessages,
    })
  }, [caseForm, detail, form.assignee, form.question])

  const handleCopyShare = async () => {
    if (!shareText) return
    const result = await copyText(shareText)
    if (result.ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } else {
      notify('error', '共有文のコピーに失敗しました。内容プレビューを開いて選択コピーしてください。')
    }
  }

  const handleSubmit = async () => {
    const ok = await onEscalate(form)
    if (ok) setForm(emptyEscalateForm(form.assignee))
  }

  const validationIssues = useMemo(() => getEscalationDraftValidationIssues({
    question: form.question,
    assignee: form.assignee,
    canEditRouting,
    hasPresetAssignee: Boolean(detail?.escalationAssignee?.trim()),
    detailStatus: detail?.status ?? null,
  }), [canEditRouting, detail?.escalationAssignee, detail?.status, form.assignee, form.question])
  const blockingValidationIssues = validationIssues.filter((issue) => issue.blocking)
  const canSubmit = Boolean(detail) && blockingValidationIssues.length === 0

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4" aria-label="エスカレーション">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900">エスカレーション</h3>
        {detail && detail.escalations.length > 0 && (
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
            {detail.escalations.length}件
          </span>
        )}
      </div>

      {!detail && (
        <p className="mt-2 text-xs text-gray-400">チケットを選択するとエスカレーションを作成できます</p>
      )}

      <fieldset disabled={!detail} className="mt-3 space-y-3 disabled:opacity-60">
        {!canEditRouting && detail && (
          <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-medium text-blue-800">
            staff権限では確認してほしい要点だけ入力できます。二次対応先、レベル、期限はowner/adminが設定します。
          </div>
        )}
        {detail && validationIssues.length > 0 && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
            <p className="font-semibold">作成前に必要な入力があります</p>
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
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <input
            value={form.assignee}
            onChange={(e) => setForm((prev) => ({ ...prev, assignee: e.target.value }))}
            disabled={!canEditRouting}
            className={`${inputCls} disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-500`}
            placeholder="二次対応先（必須）"
            list="support-staff-names"
            aria-label="二次対応先"
          />
          <div className="flex rounded-md border border-gray-300 p-0.5" role="radiogroup" aria-label="エスカレーションレベル">
            {(['L2', 'L3'] as const).map((level) => (
              <button
                key={level}
                type="button"
                role="radio"
                aria-checked={form.level === level}
                disabled={!canEditRouting}
                onClick={() => setForm((prev) => ({ ...prev, level }))}
                className={`rounded px-2.5 py-1 text-sm font-semibold transition-colors ${
                  form.level === level ? 'bg-indigo-600 text-white disabled:bg-indigo-300' : 'text-gray-500 hover:text-gray-700 disabled:hover:text-gray-500'
                }`}
              >
                {level}
              </button>
            ))}
          </div>
        </div>
        <Field label="回答期限">
          <input
            type="datetime-local"
            value={form.dueAt}
            onChange={(e) => setForm((prev) => ({ ...prev, dueAt: e.target.value }))}
            disabled={!canEditRouting}
            className={`${inputCls} disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-500`}
          />
          <DueTimePresetRow
            hasValue={Boolean(form.dueAt)}
            onApply={(value) => setForm((prev) => ({ ...prev, dueAt: value }))}
            disabled={!canEditRouting}
          />
        </Field>
        <textarea
          value={form.question}
          onChange={(e) => setForm((prev) => ({ ...prev, question: e.target.value }))}
          rows={4}
          className={textareaCls}
          placeholder="確認してほしい要点（必須）"
          aria-label="確認してほしい要点"
        />
        <button
          onClick={handleSubmit}
          disabled={!canSubmit || saving}
          className="w-full rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
          title={!detail ? 'チケットを選択してください' : blockingValidationIssues[0]?.message}
        >
          {saving ? '作成中…' : 'エスカレ作成'}
        </button>
      </fieldset>

      {detail && (
        <div className="mt-4 rounded-lg border border-indigo-100 bg-indigo-50 p-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-xs font-semibold text-indigo-900">エスカレ共有文</p>
              <p className="mt-0.5 text-[11px] text-indigo-700">チケット情報と直近会話をまとめてSlack等へ渡せます</p>
            </div>
            <button
              type="button"
              onClick={handleCopyShare}
              className={`inline-flex shrink-0 items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors ${
                copied
                  ? 'bg-green-600 text-white'
                  : 'bg-white text-indigo-700 ring-1 ring-indigo-200 hover:bg-indigo-100'
              }`}
            >
              {copied ? <CheckIcon className="h-3.5 w-3.5" /> : <CopyIcon className="h-3.5 w-3.5" />}
              {copied ? 'コピー済み' : 'コピー'}
            </button>
          </div>
          <details className="mt-2">
            <summary className="cursor-pointer select-none text-[11px] font-medium text-indigo-700 hover:underline">
              内容をプレビュー
            </summary>
            <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md bg-white p-2 text-[11px] leading-relaxed text-gray-600">
              {shareText}
            </pre>
          </details>
        </div>
      )}

      <div className="mt-4 space-y-3">
        {detail && sortedEscalations.length === 0 && (
          <p className="text-xs text-gray-400">このチケットのエスカレーションはまだありません</p>
        )}
        {sortedEscalations.map((item) => (
          <EscalationItem
            key={item.id}
            item={item}
            isMine={Boolean(staffName) && item.assignee.includes(staffName)}
            answer={answers[item.id] ?? item.answer ?? ''}
            saving={saving}
            onAnswerChange={(value) => setAnswers((prev) => ({ ...prev, [item.id]: value }))}
            onUpdate={(status) => void onUpdateEscalation(item.id, status, answers[item.id] ?? item.answer ?? '')}
          />
        ))}
      </div>
    </section>
  )
}

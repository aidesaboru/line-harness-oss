'use client'

import { useState } from 'react'
import Link from 'next/link'
import type { SupportCaseDetail, SupportCaseStatus } from '@/lib/api'
import {
  categoryLabel,
  categoryOptions,
  canOpenChatWithDraft,
  eventTypeLabel,
  formatDateTime,
  formatElapsed,
  getCaseFormValidationIssues,
  getVisibleStatusOptions,
  isOverdueCase,
  isStaleCase,
  priorityClass,
  priorityLabel,
  priorityOptions,
  resolveChecklist,
  statusClass,
  statusLabel,
  type CaseFormState,
  type SupportEmptyState,
} from './support-meta'
import {
  btnPrimaryCls,
  btnSecondaryCls,
  ChatIcon,
  CheckIcon,
  CopyIcon,
  DueBadge,
  DueTimePresetRow,
  Field,
  FlameIcon,
  Pill,
  inputCls,
  selectCls,
  textareaCls,
} from './support-ui'

export type DetailTab = 'work' | 'logs'

interface CaseDetailProps {
  detail: SupportCaseDetail | null
  detailLoading: boolean
  caseForm: CaseFormState
  dirty: boolean
  saving: boolean
  canEditRouting: boolean
  detailTab: DetailTab
  onFormChange: (patch: Partial<CaseFormState>) => void
  onSave: () => void
  onDiscard: () => void
  onQuickStatus: (status: SupportCaseStatus, eventBody: string) => Promise<boolean>
  onOpenChatWithDraft: () => void
  onTabChange: (tab: DetailTab) => void
  onCopyReplyDraft: () => void
  emptyState?: Pick<SupportEmptyState, 'title' | 'description'>
  outsideCurrentList?: boolean
  outsideCurrentListActionLabel?: string
  onResetFilters?: () => void
}

function DetailSkeleton() {
  return (
    <div className="animate-pulse space-y-4 p-4" aria-hidden="true">
      <div className="flex gap-2">
        <div className="h-5 w-16 rounded bg-gray-200" />
        <div className="h-5 w-12 rounded bg-gray-100" />
      </div>
      <div className="h-6 w-2/3 rounded bg-gray-200" />
      <div className="h-20 rounded-lg bg-gray-100" />
      <div className="grid gap-3 md:grid-cols-4">
        {[...Array(4)].map((_, i) => <div key={i} className="h-14 rounded bg-gray-100" />)}
      </div>
      <div className="h-32 rounded bg-gray-100" />
    </div>
  )
}

function EmptyDetail({ emptyState }: { emptyState?: Pick<SupportEmptyState, 'title' | 'description'> }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-24 text-center">
      <span className="rounded-full bg-gray-100 p-3 text-gray-400">
        <ChatIcon className="h-6 w-6" />
      </span>
      <p className="text-sm font-medium text-gray-600">{emptyState?.title ?? '案件を選択してください'}</p>
      <p className="max-w-sm text-xs leading-relaxed text-gray-400">
        {emptyState?.description ?? '左の一覧、または上部のキューから絞り込めます'}
      </p>
    </div>
  )
}

/** 完了確定パネル: 運用マニュアルの完了条件を確認しつつ対応結果メモを必須化 */
function CompletionPanel({
  resolutionNote,
  saving,
  onNoteChange,
  onConfirm,
  onCancel,
}: {
  resolutionNote: string
  saving: boolean
  onNoteChange: (value: string) => void
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="rounded-lg border border-green-300 bg-green-50/60 p-3" role="region" aria-label="完了前の確認">
      <p className="text-sm font-semibold text-green-900">完了前の確認</p>
      <ul className="mt-2 space-y-1">
        {resolveChecklist.map((item) => (
          <li key={item} className="flex items-start gap-1.5 text-xs text-green-800">
            <CheckIcon className="mt-0.5 h-3 w-3 shrink-0 text-green-600" />
            {item}
          </li>
        ))}
      </ul>
      <div className="mt-3">
        <Field label="対応結果メモ" hint="完了には必須">
          <textarea
            value={resolutionNote}
            onChange={(e) => onNoteChange(e.target.value)}
            rows={3}
            placeholder="対応内容と判断理由を残す"
            className={textareaCls}
            autoFocus
          />
        </Field>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className={btnSecondaryCls}>
          キャンセル
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={saving || !resolutionNote.trim()}
          className="inline-flex items-center gap-1.5 rounded-md bg-green-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <CheckIcon className="h-4 w-4" />
          完了を確定
        </button>
      </div>
    </div>
  )
}

export default function CaseDetail({
  detail,
  detailLoading,
  caseForm,
  dirty,
  saving,
  canEditRouting,
  detailTab,
  onFormChange,
  onSave,
  onDiscard,
  onQuickStatus,
  onOpenChatWithDraft,
  onTabChange,
  onCopyReplyDraft,
  emptyState,
  outsideCurrentList = false,
  outsideCurrentListActionLabel = '絞り込みをリセット',
  onResetFilters,
}: CaseDetailProps) {
  const [completing, setCompleting] = useState(false)

  if (detailLoading && !detail) {
    return (
      <section className="rounded-lg border border-gray-200 bg-white">
        <DetailSkeleton />
      </section>
    )
  }

  if (!detail) {
    return (
      <section className="rounded-lg border border-gray-200 bg-white">
        <EmptyDetail emptyState={emptyState} />
      </section>
    )
  }

  const overdue = isOverdueCase(detail)
  const stale = isStaleCase(detail)
  const unassigned = !caseForm.primaryAssignee.trim()
  const chatHref = detail.friendId ? `/chats?friend=${encodeURIComponent(detail.friendId)}` : null
  const lockedInputCls = `${inputCls} disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-500`
  const lockedSelectCls = `${selectCls} disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-500`
  const visibleStatusOptions = getVisibleStatusOptions(detail.status, caseForm.status)
  const validationIssues = getCaseFormValidationIssues(caseForm, { hasChat: Boolean(chatHref) })
  const blockingValidationIssues = validationIssues.filter((issue) => issue.blocking)
  const canSave = dirty && blockingValidationIssues.length === 0
  const showChatReplyAction = canOpenChatWithDraft({
    status: caseForm.status,
    hasDraft: Boolean(caseForm.customerReplyDraft.trim()),
    hasChat: Boolean(chatHref),
  })

  const handleConfirmComplete = async () => {
    const ok = await onQuickStatus('resolved', '対応を完了しました')
    if (ok) setCompleting(false)
  }

  return (
    <section className="relative rounded-lg border border-gray-200 bg-white" aria-label="案件詳細">
      <div className="space-y-4 p-4">
        {/* ヘッダー: タイトル + 保存 */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap gap-1.5">
              <Pill className={statusClass[caseForm.status]}>{statusLabel[caseForm.status]}</Pill>
              <Pill className={priorityClass[caseForm.priority]}>{priorityLabel[caseForm.priority]}</Pill>
              <Pill className="border-gray-200 bg-gray-50 text-gray-600">
                {categoryLabel[caseForm.category] || caseForm.category}
              </Pill>
            </div>
            <h2 className="mt-2 break-words text-lg font-semibold leading-snug text-gray-900">
              {caseForm.title || detail.title}
              {dirty && <span className="ml-2 inline-block h-2 w-2 rounded-full bg-amber-500 align-middle" title="未保存の変更あり" />}
            </h2>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-gray-500">
              <span className="truncate">{detail.friendName || detail.companyName || '顧客未紐付け'}</span>
              {chatHref && (
                <Link
                  href={chatHref}
                  className="inline-flex items-center gap-1 text-xs font-medium text-green-700 underline-offset-2 hover:underline"
                >
                  <ChatIcon className="h-3.5 w-3.5" />
                  チャットを開く
                </Link>
              )}
              <span className="text-xs text-gray-400">更新 {formatDateTime(detail.updatedAt)}</span>
              <DueBadge value={caseForm.status === 'resolved' ? null : detail.dueAt} />
            </div>
          </div>
          <button
            onClick={onSave}
            disabled={saving || !canSave}
            title={blockingValidationIssues[0]?.message ?? '⌘S / Ctrl+S でも保存できます'}
            className={btnPrimaryCls}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>

        {outsideCurrentList && (
          <div
            className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
            role="status"
          >
            <div>
              <p className="font-semibold">この案件は現在の一覧条件外です</p>
              <p className="mt-0.5 text-xs leading-relaxed text-amber-800">
                保存中の作業を守るため詳細は残しています。左の一覧とそろえる場合は絞り込みを戻してください。
              </p>
            </div>
            {onResetFilters && (
              <button
                type="button"
                onClick={onResetFilters}
                disabled={saving}
                className="rounded-md border border-amber-300 bg-white px-3 py-1.5 text-xs font-semibold text-amber-800 transition-colors hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {outsideCurrentListActionLabel}
              </button>
            )}
          </div>
        )}

        {/* 注意ストリップ */}
        {(overdue || stale || unassigned) && caseForm.status !== 'resolved' && (
          <div className="rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 text-sm text-orange-800">
            <div className="flex flex-wrap items-center gap-2">
              {overdue && <Pill className="border-red-200 bg-white text-red-700">期限超過</Pill>}
              {stale && (
                <Pill className="border-orange-200 bg-white text-orange-700">
                  <FlameIcon className="mr-1 h-3 w-3" />
                  24h滞留 {formatElapsed(detail.updatedAt)}
                </Pill>
              )}
              {unassigned && <Pill className="border-amber-200 bg-white text-amber-700">担当者なし</Pill>}
              <span className="font-medium">
                {canEditRouting ? '先に担当・期限・返信方針を確定してください' : '担当・期限の調整はowner/adminに依頼してください'}
              </span>
            </div>
          </div>
        )}

        {!canEditRouting && (
          <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-medium text-blue-800">
            staff権限では対応内容だけ編集できます。担当割り、期限、優先度、顧客属性はowner/adminが管理します。
          </div>
        )}

        {validationIssues.length > 0 && (
          <div
            className={`rounded-lg border px-3 py-2 text-sm ${
              blockingValidationIssues.length > 0
                ? 'border-red-200 bg-red-50 text-red-800'
                : 'border-blue-200 bg-blue-50 text-blue-800'
            }`}
            role={blockingValidationIssues.length > 0 ? 'alert' : 'status'}
          >
            <p className="font-semibold">
              {blockingValidationIssues.length > 0 ? '保存前に必要な入力があります' : '返信前の確認'}
            </p>
            <ul className="mt-1 space-y-1">
              {validationIssues.map((issue) => (
                <li key={issue.key} className="flex items-start gap-2">
                  <span
                    className={`mt-0.5 rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                      issue.severity === 'error' ? 'bg-red-100 text-red-700' : 'bg-blue-100 text-blue-700'
                    }`}
                  >
                    {issue.blocking ? '必須' : '確認'}
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

        {/* キーファクト: まず確認する4点 (ステータス / 優先度 / 一次担当 / 期限) */}
        <div className="rounded-lg border border-gray-200 bg-gray-50/80 p-3">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
            まず確認する4点
          </p>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Field label="ステータス">
              <select
                value={caseForm.status}
                onChange={(e) => onFormChange({ status: e.target.value as SupportCaseStatus })}
                className={selectCls}
              >
                {visibleStatusOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
            </Field>
            <Field label="優先度">
              <select
                value={caseForm.priority}
                onChange={(e) => onFormChange({ priority: e.target.value as CaseFormState['priority'] })}
                disabled={!canEditRouting}
                className={lockedSelectCls}
              >
                {priorityOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
            </Field>
            <Field label="一次担当">
              <input
                value={caseForm.primaryAssignee}
                onChange={(e) => onFormChange({ primaryAssignee: e.target.value })}
                placeholder="担当者名"
                disabled={!canEditRouting}
                className={lockedInputCls}
                list="support-staff-names"
              />
            </Field>
            <Field label="期限">
              <input
                type="datetime-local"
                value={caseForm.dueAt}
                onChange={(e) => onFormChange({ dueAt: e.target.value })}
                disabled={!canEditRouting}
                className={lockedInputCls}
              />
              <DueTimePresetRow
                hasValue={Boolean(caseForm.dueAt)}
                onApply={(value) => onFormChange({ dueAt: value })}
                disabled={!canEditRouting}
              />
            </Field>
          </div>
        </div>

        {/* クイックアクション */}
        {completing ? (
          <CompletionPanel
            resolutionNote={caseForm.resolutionNote}
            saving={saving}
            onNoteChange={(value) => onFormChange({ resolutionNote: value })}
            onConfirm={handleConfirmComplete}
            onCancel={() => setCompleting(false)}
          />
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {(caseForm.status === 'open' || caseForm.status === 'reopened') && (
              <button
                type="button"
                onClick={() => void onQuickStatus('in_progress', '対応を開始しました')}
                disabled={saving}
                className="rounded-md bg-amber-500 px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-amber-600 disabled:opacity-50"
              >
                対応開始
              </button>
            )}
            {caseForm.status !== 'resolved' && (
              <button
                type="button"
                onClick={() => setCompleting(true)}
                disabled={saving}
                className="rounded-md border border-green-600 bg-white px-3 py-1.5 text-sm font-semibold text-green-700 transition-colors hover:bg-green-50 disabled:opacity-50"
              >
                完了にする…
              </button>
            )}
            {caseForm.status === 'resolved' && (
              <button
                type="button"
                onClick={() => void onQuickStatus('reopened', '案件を再オープンしました')}
                disabled={saving}
                className="rounded-md border border-pink-300 bg-white px-3 py-1.5 text-sm font-semibold text-pink-700 transition-colors hover:bg-pink-50 disabled:opacity-50"
                title="完了後の再連絡は未対応に戻さず再オープンで扱います"
              >
                再オープン
              </button>
            )}
            {caseForm.customerReplyDraft.trim() && (
              <>
                {showChatReplyAction && (
                  <button
                    type="button"
                    onClick={onOpenChatWithDraft}
                    disabled={saving}
                    className="inline-flex items-center gap-1 rounded-md bg-green-600 px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-green-700 disabled:opacity-50"
                  >
                    <ChatIcon className="h-3.5 w-3.5" />
                    チャットで返信
                  </button>
                )}
                <button
                  type="button"
                  onClick={onCopyReplyDraft}
                  className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
                >
                  <CopyIcon className="h-3.5 w-3.5" />
                  返信案をコピー
                </button>
              </>
            )}
          </div>
        )}

        {/* タブ */}
        <div className="flex rounded-lg border border-gray-200 bg-gray-50 p-1" role="tablist">
          {[
            { key: 'work' as DetailTab, label: '対応入力' },
            { key: 'logs' as DetailTab, label: `会話・履歴 (${detail.recentMessages.length + detail.events.length})` },
          ].map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={detailTab === tab.key}
              onClick={() => onTabChange(tab.key)}
              className={`flex-1 rounded-md px-3 py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 ${
                detailTab === tab.key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {detailTab === 'work' ? (
          <div className="space-y-4">
            <div className="grid gap-3 md:grid-cols-[2fr_1fr]">
              <Field label="件名">
                <input
                  value={caseForm.title}
                  onChange={(e) => onFormChange({ title: e.target.value })}
                  disabled={!canEditRouting}
                  className={lockedInputCls}
                />
              </Field>
              <Field label="種別">
                <select
                  value={caseForm.category}
                  onChange={(e) => onFormChange({ category: e.target.value })}
                  disabled={!canEditRouting}
                  className={lockedSelectCls}
                >
                  {categoryOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                </select>
              </Field>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <Field label="二次対応先" hint="エスカレ時の確認先">
                <input
                  value={caseForm.escalationAssignee}
                  onChange={(e) => onFormChange({ escalationAssignee: e.target.value })}
                  placeholder="二次対応者名"
                  disabled={!canEditRouting}
                  className={lockedInputCls}
                  list="support-staff-names"
                />
              </Field>
              <Field label="次回確認" hint="保留時は必須">
                <input
                  type="datetime-local"
                  value={caseForm.nextCheckAt}
                  onChange={(e) => onFormChange({ nextCheckAt: e.target.value })}
                  className={inputCls}
                />
                <DueTimePresetRow
                  hasValue={Boolean(caseForm.nextCheckAt)}
                  onApply={(value) => onFormChange({ nextCheckAt: value })}
                />
              </Field>
            </div>

            <details className="group rounded-lg border border-gray-200" open={Boolean(caseForm.customerNumber || caseForm.companyName || caseForm.storeName)}>
              <summary className="cursor-pointer select-none rounded-lg px-3 py-2 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-50 group-open:rounded-b-none group-open:border-b group-open:border-gray-200">
                顧客情報
              </summary>
              <div className="grid gap-3 p-3 md:grid-cols-3 xl:grid-cols-5">
                <Field label="顧客番号">
                  <input value={caseForm.customerNumber} onChange={(e) => onFormChange({ customerNumber: e.target.value })} disabled={!canEditRouting} className={lockedInputCls} />
                </Field>
                <Field label="法人名">
                  <input value={caseForm.companyName} onChange={(e) => onFormChange({ companyName: e.target.value })} disabled={!canEditRouting} className={lockedInputCls} />
                </Field>
                <Field label="担当者名">
                  <input value={caseForm.contactName} onChange={(e) => onFormChange({ contactName: e.target.value })} disabled={!canEditRouting} className={lockedInputCls} />
                </Field>
                <Field label="店舗名">
                  <input value={caseForm.storeName} onChange={(e) => onFormChange({ storeName: e.target.value })} disabled={!canEditRouting} className={lockedInputCls} />
                </Field>
                <Field label="契約種別">
                  <input value={caseForm.contractType} onChange={(e) => onFormChange({ contractType: e.target.value })} disabled={!canEditRouting} className={lockedInputCls} />
                </Field>
              </div>
            </details>

            <Field label="問い合わせ要約" hint="エスカレ共有文に載ります">
              <textarea
                value={caseForm.customerSummary}
                onChange={(e) => onFormChange({ customerSummary: e.target.value })}
                rows={3}
                placeholder="顧客の状況・要望を短く"
                className={textareaCls}
              />
            </Field>

            <div className="grid gap-3 lg:grid-cols-2">
              <Field label="内部メモ" hint="社内のみ">
                <textarea
                  value={caseForm.internalNote}
                  onChange={(e) => onFormChange({ internalNote: e.target.value })}
                  rows={6}
                  placeholder="判断理由・確認事項など"
                  className={textareaCls}
                />
              </Field>
              <Field label="顧客向け返信案" hint="チャットで返信へ引き継ぎ">
                <textarea
                  value={caseForm.customerReplyDraft}
                  onChange={(e) => onFormChange({ customerReplyDraft: e.target.value })}
                  rows={6}
                  placeholder="顧客へ送る文章の下書き"
                  className={textareaCls}
                />
              </Field>
            </div>

            <Field label="対応結果メモ" hint="完了時は必須">
              <textarea
                value={caseForm.resolutionNote}
                onChange={(e) => onFormChange({ resolutionNote: e.target.value })}
                rows={3}
                placeholder="最終的な対応内容と判断理由"
                className={textareaCls}
              />
            </Field>
          </div>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="rounded-lg border border-gray-200">
              <div className="flex items-center justify-between border-b border-gray-200 px-3 py-2">
                <span className="text-sm font-semibold text-gray-800">会話ログ</span>
                {chatHref && (
                  <Link href={chatHref} className="inline-flex items-center gap-1 text-xs font-medium text-green-700 hover:underline">
                    <ChatIcon className="h-3.5 w-3.5" />
                    チャットを開く
                  </Link>
                )}
              </div>
              <div className="max-h-[420px] space-y-2 overflow-y-auto p-3">
                {detail.recentMessages.length === 0 ? (
                  <p className="text-sm text-gray-500">会話ログはありません</p>
                ) : detail.recentMessages.map((message) => (
                  <div
                    key={message.id}
                    className={`rounded-md px-3 py-2 text-sm ${message.direction === 'incoming' ? 'bg-green-50 text-gray-800' : 'bg-gray-100 text-gray-700'}`}
                  >
                    <div className="mb-1 flex justify-between gap-2 text-[11px] text-gray-500">
                      <span className="font-medium">{message.direction === 'incoming' ? '顧客' : '運営'}</span>
                      <span>{formatDateTime(message.createdAt)}</span>
                    </div>
                    <p className="whitespace-pre-wrap break-words">
                      {message.messageType === 'text' ? message.content : `[${message.messageType}]`}
                    </p>
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-lg border border-gray-200">
              <div className="border-b border-gray-200 px-3 py-2 text-sm font-semibold text-gray-800">対応履歴</div>
              <div className="max-h-[420px] space-y-3 overflow-y-auto p-3">
                {detail.events.length === 0 ? (
                  <p className="text-sm text-gray-500">履歴はありません</p>
                ) : detail.events.map((event) => (
                  <div key={event.id} className="border-l-2 border-gray-200 pl-3">
                    <p className="text-xs text-gray-500">
                      {formatDateTime(event.createdAt)} / {event.actorName || 'system'}
                    </p>
                    <p className="text-sm font-medium text-gray-800">
                      {eventTypeLabel[event.eventType] || event.eventType}
                    </p>
                    {event.body && <p className="mt-1 whitespace-pre-wrap text-sm text-gray-600">{event.body}</p>}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 未保存変更バー */}
      {dirty && (
        <div className="sticky bottom-0 flex items-center justify-between gap-3 rounded-b-lg border-t border-amber-200 bg-amber-50/95 px-4 py-2.5 backdrop-blur-sm">
          <span className="text-xs font-semibold text-amber-800">未保存の変更があります</span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onDiscard}
              disabled={saving}
              className="rounded-md border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-800 transition-colors hover:bg-amber-100 disabled:opacity-50"
            >
              変更を破棄
            </button>
            <button
              type="button"
              onClick={onSave}
              disabled={saving || !canSave}
              title={blockingValidationIssues[0]?.message}
              className="rounded-md bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-gray-700 disabled:opacity-50"
            >
              {saving ? '保存中…' : '保存 (⌘S)'}
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import type { InternalTask, StaffAssigneeOption } from '@/lib/api'
import {
  formatInternalTaskDateTime,
  internalTaskDisplayTitle,
  internalTaskSourceContext,
  internalTaskSourceLabel,
  internalTaskPriorityLabel,
  internalTaskStatusLabel,
  internalTaskWorkflowStatus,
  isGenericInternalTaskTitle,
  isInternalTaskOverdue,
  type TaskWorkflowStatus,
} from '@/lib/internal-task-view'

type TaskDetailDrawerProps = {
  task: InternalTask
  staffOptions: StaffAssigneeOption[]
  saving: boolean
  comment: string
  onCommentChange: (value: string) => void
  onClose: () => void
  onChangeStatus: (task: InternalTask, status: TaskWorkflowStatus) => void
  onSaveTask: (task: InternalTask, update: {
    title: string
    description: string
    dueAt: string | null
    assigneeStaffIds: string[]
    priority: NonNullable<InternalTask['priority']>
  }) => Promise<boolean>
  onAddComment: () => void
}

function formatCommentTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('ja-JP', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function datetimeLocalValue(value: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value.slice(0, 16)
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

export default function TaskDetailDrawer({
  task,
  staffOptions,
  saving,
  comment,
  onCommentChange,
  onClose,
  onChangeStatus,
  onSaveTask,
  onAddComment,
}: TaskDetailDrawerProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(task.title)
  const [description, setDescription] = useState(task.description)
  const [dueAt, setDueAt] = useState(datetimeLocalValue(task.dueAt))
  const [assigneeIds, setAssigneeIds] = useState(task.assignees.map((assignee) => assignee.staffId))
  const [priority, setPriority] = useState<NonNullable<InternalTask['priority']>>(task.priority ?? 'medium')

  useEffect(() => {
    setEditing(false)
    setTitle(task.title)
    setDescription(task.description)
    setDueAt(datetimeLocalValue(task.dueAt))
    setAssigneeIds(task.assignees.map((assignee) => assignee.staffId))
    setPriority(task.priority ?? 'medium')
    window.requestAnimationFrame(() => closeButtonRef.current?.focus())
  }, [task.id, task.title, task.description, task.dueAt, task.assignees, task.priority])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const hasChanges = useMemo(() => (
    title.trim() !== task.title
    || description.trim() !== task.description
    || (dueAt || '') !== datetimeLocalValue(task.dueAt)
    || priority !== (task.priority ?? 'medium')
    || [...assigneeIds].sort().join('\u0000') !== task.assignees.map((assignee) => assignee.staffId).sort().join('\u0000')
  ), [assigneeIds, description, dueAt, priority, task, title])
  const overdue = isInternalTaskOverdue(task)
  const displayTitle = internalTaskDisplayTitle(task)
  const hasGenericTitle = isGenericInternalTaskTitle(task)
  const showDescription = Boolean(task.description.trim()) && (
    !hasGenericTitle || task.description.replace(/\s+/g, ' ').trim().length > 120
  )

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={`タスク詳細 ${displayTitle}`}>
      <button
        type="button"
        className="absolute inset-0 h-full w-full cursor-default bg-slate-950/35 backdrop-blur-[1px]"
        onClick={onClose}
        aria-label="タスク詳細を閉じる"
      />
      <aside className="absolute inset-y-0 right-0 flex w-full max-w-xl flex-col border-l border-slate-200 bg-white shadow-2xl">
        <header className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <p className="text-xs font-bold text-slate-500">タスク詳細</p>
          </div>
          <div className="flex items-center gap-2">
            {task.canUpdate && !editing && (
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="min-h-10 rounded-md border border-slate-300 px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              >
                編集
              </button>
            )}
            <button
              ref={closeButtonRef}
              type="button"
              onClick={onClose}
              className="flex h-10 w-10 items-center justify-center rounded-md text-xl text-slate-500 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              aria-label="閉じる"
            >
              ×
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <section className="border-b border-slate-200 px-4 py-5 sm:px-5">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded px-2.5 py-1 text-xs font-bold ${task.source === 'support' ? 'bg-violet-50 text-violet-700' : task.isGroupConversation ? 'bg-cyan-50 text-cyan-700' : 'bg-blue-50 text-blue-700'}`}>
                {internalTaskSourceLabel(task)}
              </span>
              <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${internalTaskWorkflowStatus(task) === 'done' ? 'bg-emerald-50 text-emerald-700' : 'bg-blue-50 text-blue-700'}`}>
                {internalTaskStatusLabel(internalTaskWorkflowStatus(task))}
              </span>
              <span className="rounded bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-600">優先度 {internalTaskPriorityLabel(task.priority)}</span>
              {overdue && <span className="rounded bg-red-50 px-2.5 py-1 text-xs font-bold text-red-700">期限超過</span>}
              {!task.canUpdate && <span className="rounded bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-500">閲覧のみ</span>}
            </div>

            {editing ? (
              <div className="mt-4 space-y-4">
                <label className="block">
                  <span className="text-xs font-bold text-slate-600">タスク名</span>
                  <input
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    maxLength={200}
                    autoFocus
                    className="mt-1.5 w-full rounded-md border border-slate-300 px-3 py-2.5 text-sm font-semibold outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                  />
                  <span className="mt-1 block text-[11px] text-slate-400">誰が何をするかが分かる名前にします</span>
                </label>
                <label className="block">
                  <span className="text-xs font-bold text-slate-600">背景・完了条件</span>
                  <textarea
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    rows={5}
                    maxLength={5000}
                    className="mt-1.5 w-full resize-y rounded-md border border-slate-300 px-3 py-2.5 text-sm leading-6 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                  />
                </label>
                <label className="block">
                  <span className="text-xs font-bold text-slate-600">期限</span>
                  <input
                    type="datetime-local"
                    value={dueAt}
                    onChange={(event) => setDueAt(event.target.value)}
                    className="mt-1.5 w-full rounded-md border border-slate-300 px-3 py-2.5 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                  />
                </label>
                <label className="block">
                  <span className="text-xs font-bold text-slate-600">優先度</span>
                  <select
                    value={priority}
                    onChange={(event) => setPriority(event.target.value as NonNullable<InternalTask['priority']>)}
                    className="mt-1.5 w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                  >
                    <option value="low">低</option>
                    <option value="medium">通常</option>
                    <option value="high">高</option>
                    <option value="urgent">最優先</option>
                  </select>
                </label>
                <fieldset>
                  <legend className="text-xs font-bold text-slate-600">担当者</legend>
                  <div className="mt-2 flex max-h-36 flex-wrap gap-1.5 overflow-y-auto">
                    {staffOptions.map((option) => {
                      const selected = assigneeIds.includes(option.id)
                      return (
                        <button
                          key={option.id}
                          type="button"
                          onClick={() => setAssigneeIds((current) => selected
                            ? current.filter((id) => id !== option.id)
                            : [...current, option.id])}
                          className={`min-h-9 rounded-full border px-3 text-xs font-semibold ${selected ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}
                          aria-pressed={selected}
                        >
                          {option.name}
                        </button>
                      )
                    })}
                  </div>
                </fieldset>
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setEditing(false)
                      setTitle(task.title)
                      setDescription(task.description)
                      setDueAt(datetimeLocalValue(task.dueAt))
                      setAssigneeIds(task.assignees.map((assignee) => assignee.staffId))
                      setPriority(task.priority ?? 'medium')
                    }}
                    className="min-h-10 rounded-md border border-slate-300 px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    キャンセル
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      const saved = await onSaveTask(task, {
                        title: title.trim(),
                        description: description.trim(),
                        dueAt: dueAt || null,
                        assigneeStaffIds: assigneeIds,
                        priority,
                      })
                      if (saved) setEditing(false)
                    }}
                    disabled={saving || !title.trim() || !hasChanges}
                    className="min-h-10 rounded-md bg-blue-600 px-4 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    {saving ? '保存中' : '保存'}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <p className="mt-4 text-[11px] font-bold text-slate-400">対応内容</p>
                <h2 className="mt-1 break-words text-xl font-bold leading-8 text-slate-900 [overflow-wrap:anywhere]">{displayTitle}</h2>
                {showDescription && (
                  <div className="mt-4">
                    <p className="text-[11px] font-bold text-slate-400">背景・完了条件</p>
                    <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-7 text-slate-600 [overflow-wrap:anywhere]">{task.description}</p>
                  </div>
                )}
              </>
            )}

            {!editing && (
              <dl className="mt-5 grid gap-3 rounded-lg bg-slate-50 p-4 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-[11px] font-bold text-slate-400">顧客・相談元</dt>
                  <dd className="mt-1 font-semibold text-slate-700">{internalTaskSourceContext(task)}</dd>
                </div>
                <div>
                  <dt className="text-[11px] font-bold text-slate-400">期限</dt>
                  <dd className={`mt-1 font-semibold ${overdue ? 'text-red-700' : 'text-slate-700'}`}>{formatInternalTaskDateTime(task.dueAt)}</dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-[11px] font-bold text-slate-400">担当者</dt>
                  <dd className="mt-1 flex flex-wrap gap-1.5">
                    {task.assignees.length > 0 ? task.assignees.map((assignee) => (
                      <span key={assignee.staffId} className="rounded-full border border-blue-200 bg-white px-2.5 py-1 text-xs font-semibold text-blue-700">{assignee.staffName}</span>
                    )) : <span className="text-slate-500">担当者未設定</span>}
                  </dd>
                </div>
              </dl>
            )}

            <div className="mt-4 flex flex-wrap gap-2">
              <Link
                href={task.href}
                className="inline-flex min-h-10 items-center rounded-md border border-slate-300 px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              >
                元の相談を開く ↗
              </Link>
              {task.canUpdate && (
                <label className="inline-flex min-h-10 items-center gap-2 rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700">
                  <span>状態</span>
                  <select
                    value={internalTaskWorkflowStatus(task)}
                    onChange={(event) => onChangeStatus(task, event.target.value as TaskWorkflowStatus)}
                    disabled={saving}
                    className="bg-white font-semibold outline-none disabled:opacity-50"
                    aria-label="タスクの状態を変更"
                  >
                    <option value="todo">未着手</option>
                    <option value="in_progress">対応中</option>
                    <option value="review">確認待ち</option>
                    <option value="done">完了</option>
                  </select>
                </label>
              )}
            </div>
          </section>

          <section className="bg-slate-50 px-4 py-5 sm:px-5" aria-labelledby="task-comments-heading">
            <h3 id="task-comments-heading" className="text-xs font-bold text-slate-500">コメント {task.comments.length}件</h3>
            <div className="mt-3 space-y-3">
              {task.comments.length === 0 ? (
                <p className="rounded-md border border-dashed border-slate-300 bg-white px-4 py-6 text-center text-sm text-slate-500">コメントはありません</p>
              ) : task.comments.map((item) => (
                <article key={item.id} className="rounded-md border border-slate-200 bg-white px-4 py-3 shadow-sm">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs font-bold text-slate-700">{item.createdByName || 'スタッフ'}</p>
                    <time className="text-[11px] text-slate-400">{formatCommentTime(item.createdAt)}</time>
                  </div>
                  <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-slate-700 [overflow-wrap:anywhere]">{item.body}</p>
                </article>
              ))}
            </div>
          </section>
        </div>

        <footer className="border-t border-slate-200 bg-white p-3 sm:p-4">
          <label className="sr-only" htmlFor="task-comment">コメント</label>
          <div className="flex items-end gap-2">
            <textarea
              id="task-comment"
              value={comment}
              onChange={(event) => onCommentChange(event.target.value)}
              rows={2}
              maxLength={2000}
              placeholder="進捗や確認事項を入力"
              className="min-h-11 flex-1 resize-none rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
            />
            <button
              type="button"
              onClick={onAddComment}
              disabled={!comment.trim() || saving}
              className="min-h-11 rounded-md bg-blue-600 px-4 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
            >
              投稿
            </button>
          </div>
        </footer>
      </aside>
    </div>
  )
}

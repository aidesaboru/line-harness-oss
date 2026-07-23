'use client'

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import Header from '@/components/layout/header'
import { useAccount } from '@/contexts/account-context'
import { api, type InternalTask, type StaffAssigneeOption } from '@/lib/api'

type TaskScope = 'mine' | 'all'
type TaskStatus = 'open' | 'done'

function formatDateTime(value: string | null): string {
  if (!value) return '期限なし'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('ja-JP', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
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

function isOverdue(task: InternalTask): boolean {
  if (task.status !== 'open' || !task.dueAt) return false
  const due = new Date(task.dueAt)
  return !Number.isNaN(due.getTime()) && due.getTime() < Date.now()
}

function sourceLabel(source: InternalTask['source']): string {
  return source === 'support' ? 'チケット' : '個別チャット'
}

function TasksContent() {
  const searchParams = useSearchParams()
  const { selectedAccountId, selectedAccount } = useAccount()
  const [tasks, setTasks] = useState<InternalTask[]>([])
  const [scope, setScope] = useState<TaskScope>('mine')
  const [status, setStatus] = useState<TaskStatus>('open')
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [staffOptions, setStaffOptions] = useState<StaffAssigneeOption[]>([])
  const [currentStaffId, setCurrentStaffId] = useState('')
  const [comment, setComment] = useState('')
  const [loadedCommentTaskIds, setLoadedCommentTaskIds] = useState<Set<string>>(new Set())
  const [creating, setCreating] = useState(searchParams.get('create') === '1')
  const [title, setTitle] = useState(searchParams.get('title')?.trim() || '')
  const [description, setDescription] = useState('')
  const [dueAt, setDueAt] = useState('')
  const [assigneeIds, setAssigneeIds] = useState<string[]>([])

  const source = searchParams.get('source') === 'support' ? 'support' : 'chat'
  const sourceId = searchParams.get('sourceId')?.trim() || ''
  const sourceMessageId = searchParams.get('messageId')?.trim() || ''
  const accountName = selectedAccount?.displayName || selectedAccount?.name || '選択中アカウント'

  const loadTasks = useCallback(async () => {
    if (!selectedAccountId) return
    setLoading(true)
    try {
      const res = await api.appNotifications.internalTasks({
        accountId: selectedAccountId,
        status,
        scope,
      })
      if (!res.success) {
        setError(res.error || 'タスクの取得に失敗しました')
        return
      }
      setTasks(res.data)
      setLoadedCommentTaskIds(new Set())
      setSelectedTaskId((current) => (
        current && res.data.some((task) => task.id === current)
          ? current
          : res.data[0]?.id ?? null
      ))
      setError('')
    } catch {
      setError('タスクの取得に失敗しました')
    } finally {
      setLoading(false)
    }
  }, [scope, selectedAccountId, status])

  useEffect(() => {
    void loadTasks()
  }, [loadTasks])

  useEffect(() => {
    let active = true
    Promise.all([api.staff.me(), api.staff.assigneeOptions()])
      .then(([me, options]) => {
        if (!active) return
        if (me.success) {
          setCurrentStaffId(me.data.id)
          setAssigneeIds((current) => current.length > 0 ? current : [me.data.id])
        }
        if (options.success) setStaffOptions(options.data.filter((item) => item.isActive))
      })
      .catch(() => {
        if (active) setError('担当者情報の取得に失敗しました')
      })
    return () => {
      active = false
    }
  }, [])

  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === selectedTaskId) ?? null,
    [selectedTaskId, tasks],
  )

  useEffect(() => {
    if (!selectedTask || loadedCommentTaskIds.has(selectedTask.id)) return
    let active = true
    api.appNotifications.internalTaskComments(selectedTask.id)
      .then((res) => {
        if (!active) return
        if (!res.success) {
          setError(res.error || 'コメントの取得に失敗しました')
          return
        }
        setTasks((current) => current.map((task) => task.id === selectedTask.id
          ? { ...task, comments: res.data, commentCount: res.data.length }
          : task))
        setLoadedCommentTaskIds((current) => new Set(current).add(selectedTask.id))
      })
      .catch(() => {
        if (active) setError('コメントの取得に失敗しました')
      })
    return () => {
      active = false
    }
  }, [loadedCommentTaskIds, selectedTask])

  const counts = useMemo(() => ({
    open: tasks.filter((task) => task.status === 'open').length,
    overdue: tasks.filter(isOverdue).length,
  }), [tasks])

  const toggleTaskStatus = async (task: InternalTask) => {
    setSaving(true)
    try {
      const res = await api.appNotifications.updateInternalTask(
        task.id,
        task.status === 'open' ? 'done' : 'open',
      )
      if (!res.success) {
        setError(res.error || 'タスクの更新に失敗しました')
        return
      }
      if (res.data.status !== status) {
        setTasks((current) => current.filter((item) => item.id !== task.id))
        setSelectedTaskId((current) => current === task.id ? null : current)
      } else {
        setTasks((current) => current.map((item) => item.id === task.id ? res.data : item))
      }
      setError('')
    } catch {
      setError('タスクの更新に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  const addComment = async () => {
    if (!selectedTask || !comment.trim() || saving) return
    setSaving(true)
    try {
      const res = await api.appNotifications.addInternalTaskComment(selectedTask.id, comment.trim())
      if (!res.success) {
        setError(res.error || 'コメントの投稿に失敗しました')
        return
      }
      setTasks((current) => current.map((task) => task.id === selectedTask.id
        ? {
            ...task,
            comments: [...task.comments, res.data],
            commentCount: task.commentCount + 1,
            updatedAt: res.data.createdAt,
          }
        : task))
      setComment('')
      setError('')
    } catch {
      setError('コメントの投稿に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  const createTask = async () => {
    if (!selectedAccountId || !sourceId || !sourceMessageId || !title.trim() || saving) return
    setSaving(true)
    try {
      const res = await api.appNotifications.createInternalTask({
        accountId: selectedAccountId,
        source,
        sourceId,
        sourceMessageId,
        title: title.trim(),
        description: description.trim(),
        dueAt: dueAt || null,
        assigneeStaffIds: assigneeIds.length > 0 ? assigneeIds : (currentStaffId ? [currentStaffId] : []),
      })
      if (!res.success) {
        setError(res.error || 'タスクの作成に失敗しました')
        return
      }
      setStatus('open')
      setScope('mine')
      setTasks((current) => [res.data, ...current.filter((task) => task.id !== res.data.id)])
      setSelectedTaskId(res.data.id)
      setCreating(false)
      setError('')
    } catch {
      setError('タスクの作成に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <Header
        title="タスク管理"
        description={`${accountName} の社内タスク`}
      />

      {error && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700" role="alert">
          {error}
        </div>
      )}

      <section className="border-y border-slate-200 bg-white px-3 py-3 sm:rounded-lg sm:border">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-1 rounded-md bg-slate-100 p-1" aria-label="担当範囲">
            {([
              ['mine', '自分のタスク'],
              ['all', 'すべてのタスク'],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setScope(value)}
                className={`min-h-9 rounded px-3 text-sm font-semibold ${
                  scope === value ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'
                }`}
                aria-pressed={scope === value}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setStatus('open')}
              className={`min-h-9 rounded-md border px-3 text-sm font-semibold ${
                status === 'open' ? 'border-blue-300 bg-blue-50 text-blue-700' : 'border-slate-200 bg-white text-slate-600'
              }`}
              aria-pressed={status === 'open'}
            >
              未完了 {status === 'open' ? counts.open : ''}
            </button>
            <button
              type="button"
              onClick={() => setStatus('done')}
              className={`min-h-9 rounded-md border px-3 text-sm font-semibold ${
                status === 'done' ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-slate-200 bg-white text-slate-600'
              }`}
              aria-pressed={status === 'done'}
            >
              完了
            </button>
            {counts.overdue > 0 && status === 'open' && (
              <span className="rounded-md bg-red-50 px-2.5 py-2 text-xs font-bold text-red-700">
                期限超過 {counts.overdue}
              </span>
            )}
          </div>
        </div>
      </section>

      <section className="mt-4 grid min-h-[560px] gap-4 xl:grid-cols-[minmax(360px,0.9fr)_minmax(480px,1.25fr)]">
        <div className="overflow-hidden border-y border-slate-200 bg-white sm:rounded-lg sm:border">
          <div className="border-b border-slate-200 px-4 py-3">
            <p className="text-sm font-semibold text-slate-900">
              {scope === 'mine' ? '自分のタスク' : 'すべてのタスク'}
            </p>
            <p className="mt-0.5 text-xs text-slate-500">{tasks.length}件</p>
          </div>
          <div className="max-h-[680px] overflow-y-auto">
            {loading ? (
              <div className="p-8 text-center text-sm font-medium text-slate-500">読み込み中...</div>
            ) : tasks.length === 0 ? (
              <div className="p-8 text-center text-sm font-medium text-slate-500">
                該当するタスクはありません
              </div>
            ) : tasks.map((task) => {
              const overdue = isOverdue(task)
              const selected = selectedTaskId === task.id
              return (
                <button
                  key={task.id}
                  type="button"
                  onClick={() => setSelectedTaskId(task.id)}
                  className={`block w-full border-b border-slate-100 border-l-4 px-4 py-3 text-left transition-colors ${
                    selected
                      ? 'border-l-blue-500 bg-blue-50/70'
                      : overdue
                        ? 'border-l-red-500 bg-red-50/40 hover:bg-red-50/70'
                        : 'border-l-transparent hover:bg-slate-50'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border text-xs ${
                      task.status === 'done'
                        ? 'border-emerald-500 bg-emerald-500 text-white'
                        : 'border-slate-300 bg-white text-transparent'
                    }`}>✓</span>
                    <span className="min-w-0 flex-1">
                      <span className={`block text-sm font-semibold text-slate-900 ${task.status === 'done' ? 'line-through' : ''}`}>
                        {task.title}
                      </span>
                      <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-medium text-slate-500">
                        <span>{sourceLabel(task.source)}</span>
                        <span className={overdue ? 'font-bold text-red-700' : ''}>
                          {formatDateTime(task.dueAt)}
                        </span>
                        <span>{task.commentCount}コメント</span>
                      </span>
                      <span className="mt-1 block truncate text-xs text-slate-500">
                        {task.assignees.length > 0
                          ? task.assignees.map((assignee) => assignee.staffName).join('・')
                          : '担当者未設定'}
                      </span>
                    </span>
                  </div>
                </button>
              )
            })}
          </div>
        </div>

        <div className="border-y border-slate-200 bg-white sm:rounded-lg sm:border">
          {selectedTask ? (
            <div className="flex min-h-[560px] flex-col">
              <div className="border-b border-slate-200 px-4 py-4 sm:px-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2 text-xs font-semibold">
                      <span className="rounded bg-slate-100 px-2 py-1 text-slate-600">
                        {sourceLabel(selectedTask.source)}
                      </span>
                      <span className={isOverdue(selectedTask) ? 'text-red-700' : 'text-slate-500'}>
                        {formatDateTime(selectedTask.dueAt)}
                      </span>
                    </div>
                    <h2 className="mt-2 text-lg font-bold text-slate-900">{selectedTask.title}</h2>
                    {selectedTask.description && (
                      <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-600">{selectedTask.description}</p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => void toggleTaskStatus(selectedTask)}
                    disabled={saving}
                    className={`min-h-10 shrink-0 rounded-md px-4 text-sm font-semibold ${
                      selectedTask.status === 'done'
                        ? 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                        : 'bg-emerald-600 text-white hover:bg-emerald-700'
                    } disabled:opacity-50`}
                  >
                    {selectedTask.status === 'done' ? '未完了に戻す' : '完了にする'}
                  </button>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs font-medium text-slate-600">
                  {selectedTask.assignees.map((assignee) => (
                    <span key={assignee.staffId} className="rounded-full border border-blue-200 bg-blue-50 px-2.5 py-1 text-blue-700">
                      {assignee.staffName}
                    </span>
                  ))}
                  <Link href={selectedTask.href} className="rounded-md border border-slate-300 px-2.5 py-1 text-slate-700 hover:bg-slate-50">
                    元の相談を開く
                  </Link>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto bg-slate-50 px-4 py-4 sm:px-5">
                <p className="text-xs font-bold text-slate-500">コメント {selectedTask.comments.length}件</p>
                <div className="mt-3 space-y-3">
                  {selectedTask.comments.length === 0 ? (
                    <p className="rounded-md border border-dashed border-slate-300 bg-white px-4 py-6 text-center text-sm text-slate-500">
                      コメントはありません
                    </p>
                  ) : selectedTask.comments.map((item) => (
                    <article key={item.id} className="rounded-md border border-slate-200 bg-white px-4 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-xs font-bold text-slate-700">{item.createdByName || 'スタッフ'}</p>
                        <time className="text-[11px] text-slate-400">{formatCommentTime(item.createdAt)}</time>
                      </div>
                      <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-700">{item.body}</p>
                    </article>
                  ))}
                </div>
              </div>

              <div className="border-t border-slate-200 bg-white p-3 sm:p-4">
                <div className="flex items-end gap-2">
                  <textarea
                    value={comment}
                    onChange={(event) => setComment(event.target.value)}
                    rows={2}
                    maxLength={2000}
                    placeholder="進捗や確認事項を入力..."
                    className="min-h-[44px] flex-1 resize-none rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                  />
                  <button
                    type="button"
                    onClick={() => void addComment()}
                    disabled={!comment.trim() || saving}
                    className="min-h-11 rounded-md bg-blue-600 px-4 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    投稿
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex min-h-[560px] items-center justify-center p-8 text-center text-sm font-medium text-slate-500">
              タスクを選択してください
            </div>
          )}
        </div>
      </section>

      {creating && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/30 p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label="タスクを作成">
          <div className="w-full max-w-xl rounded-t-lg bg-white p-4 shadow-2xl sm:rounded-lg sm:p-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-base font-bold text-slate-900">タスクを作成</p>
                <p className="mt-0.5 text-xs text-slate-500">{sourceLabel(source)}から作成</p>
              </div>
              <button type="button" onClick={() => setCreating(false)} className="flex h-9 w-9 items-center justify-center rounded-md text-xl text-slate-500 hover:bg-slate-100" aria-label="閉じる">×</button>
            </div>
            {(!sourceId || !sourceMessageId) ? (
              <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800">
                元の相談を特定できませんでした。個別チャットまたは社内チャットからタスク化してください。
              </div>
            ) : (
              <>
                <label className="mt-4 block">
                  <span className="text-xs font-semibold text-slate-600">件名</span>
                  <input
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    maxLength={200}
                    className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                  />
                </label>
                <label className="mt-3 block">
                  <span className="text-xs font-semibold text-slate-600">内容</span>
                  <textarea
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    rows={4}
                    maxLength={5000}
                    className="mt-1 w-full resize-y rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                  />
                </label>
                <label className="mt-3 block">
                  <span className="text-xs font-semibold text-slate-600">期限</span>
                  <input
                    type="datetime-local"
                    value={dueAt}
                    onChange={(event) => setDueAt(event.target.value)}
                    className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                  />
                </label>
                <div className="mt-3">
                  <p className="text-xs font-semibold text-slate-600">担当者</p>
                  <div className="mt-2 flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
                    {staffOptions.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        onClick={() => setAssigneeIds((current) => current.includes(option.id)
                          ? current.filter((id) => id !== option.id)
                          : [...current, option.id])}
                        className={`rounded-full border px-2.5 py-1 text-xs font-medium ${
                          assigneeIds.includes(option.id)
                            ? 'border-blue-500 bg-blue-50 text-blue-700'
                            : 'border-slate-200 bg-white text-slate-600'
                        }`}
                        aria-pressed={assigneeIds.includes(option.id)}
                      >
                        {option.name}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="mt-5 flex justify-end gap-2">
                  <button type="button" onClick={() => setCreating(false)} className="rounded-md border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">キャンセル</button>
                  <button type="button" onClick={() => void createTask()} disabled={saving || !title.trim()} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
                    {saving ? '作成中' : 'タスクを作成'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default function TasksPage() {
  return (
    <Suspense fallback={<div className="p-8 text-sm font-medium text-slate-500">読み込み中...</div>}>
      <TasksContent />
    </Suspense>
  )
}

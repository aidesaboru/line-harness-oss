'use client'

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import Header from '@/components/layout/header'
import TaskDetailDrawer from '@/components/tasks/task-detail-drawer'
import { TaskBoardView, TaskListView } from '@/components/tasks/task-views'
import { useAccount } from '@/contexts/account-context'
import { ApiRequestError, api, type InternalTask, type StaffAssigneeOption } from '@/lib/api'
import { createLatestRequestGate } from '@/lib/latest-request'
import { isWorkspaceSnapshotCurrent } from '@/lib/workspace-response'
import { loadAllInternalTaskPages } from '@/lib/internal-task-pagination'
import {
  filterInternalTasks,
  internalTaskWorkflowStatus,
  isInternalTaskOverdue,
  shouldResetInternalTaskDraft,
  type TaskDueFilter,
  type TaskSourceFilter,
  type TaskViewMode,
  type TaskWorkflowStatus,
} from '@/lib/internal-task-view'

type TaskScope = 'mine' | 'all'
type TaskStatusFilter = 'all' | 'open' | 'done'

function TasksContent() {
  const searchParams = useSearchParams()
  const { selectedAccountId, selectedAccount } = useAccount()
  const [tasks, setTasks] = useState<InternalTask[]>([])
  const [scope, setScope] = useState<TaskScope>('mine')
  const [viewMode, setViewMode] = useState<TaskViewMode>('board')
  const [statusFilter, setStatusFilter] = useState<TaskStatusFilter>('all')
  const [query, setQuery] = useState('')
  const [sourceFilter, setSourceFilter] = useState<TaskSourceFilter>('all')
  const [dueFilter, setDueFilter] = useState<TaskDueFilter>('all')
  const [assigneeFilter, setAssigneeFilter] = useState('')
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [savingTaskId, setSavingTaskId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [staffOptions, setStaffOptions] = useState<StaffAssigneeOption[]>([])
  const [currentStaffId, setCurrentStaffId] = useState('')
  const [comment, setComment] = useState('')
  const [loadedCommentTaskIds, setLoadedCommentTaskIds] = useState<Set<string>>(new Set())
  const [creating, setCreating] = useState(searchParams.get('create') === '1')
  const [title, setTitle] = useState(searchParams.get('title')?.trim() || '')
  const [description, setDescription] = useState(searchParams.get('description')?.trim() || '')
  const [dueAt, setDueAt] = useState('')
  const [priority, setPriority] = useState<NonNullable<InternalTask['priority']>>('medium')
  const [assigneeIds, setAssigneeIds] = useState<string[]>([])
  const [totalTasks, setTotalTasks] = useState(0)
  const taskRequestGateRef = useRef(createLatestRequestGate())
  const commentRequestGateRef = useRef(createLatestRequestGate())
  const accountScopeRef = useRef<string | null>(selectedAccountId)
  const currentAccountIdRef = useRef<string | null>(selectedAccountId)
  const renderedAccountIdRef = useRef<string | null>(selectedAccountId)
  const workspaceVersionRef = useRef(0)
  const [loadedAccountId, setLoadedAccountId] = useState<string | null>(null)

  currentAccountIdRef.current = selectedAccountId
  if (renderedAccountIdRef.current !== selectedAccountId) {
    renderedAccountIdRef.current = selectedAccountId
    workspaceVersionRef.current += 1
  }

  const source = searchParams.get('source') === 'support' ? 'support' : 'chat'
  const sourceId = searchParams.get('sourceId')?.trim() || ''
  const sourceMessageId = searchParams.get('messageId')?.trim() || ''
  const sourceAccountId = searchParams.get('accountId')?.trim() || ''
  const canCreateFromSource = Boolean(
    selectedAccountId
    && sourceAccountId === selectedAccountId
    && sourceId
    && sourceMessageId,
  )
  const accountName = selectedAccount?.displayName || selectedAccount?.name || '選択中アカウント'

  const loadTasks = useCallback(async () => {
    const requestId = taskRequestGateRef.current.start()
    const requestAccountId = selectedAccountId
    const requestWorkspaceVersion = workspaceVersionRef.current
    const isCurrentRequest = () => (
      taskRequestGateRef.current.isLatest(requestId)
      && currentAccountIdRef.current === requestAccountId
      && workspaceVersionRef.current === requestWorkspaceVersion
    )
    if (!requestAccountId) {
      setTasks([])
      setTotalTasks(0)
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const snapshot = await loadAllInternalTaskPages(async (offset, limit) => {
        const res = await api.appNotifications.internalTasks({
          accountId: requestAccountId,
          status: 'all',
          scope,
          limit,
          offset,
        })
        if (!isCurrentRequest()) throw new Error('stale workspace')
        if (!res.success) throw new Error(res.error || 'タスクの取得に失敗しました')
        return { data: res.data, meta: res.meta }
      })
      if (!isCurrentRequest()) return
      setTasks(snapshot.items)
      setTotalTasks(snapshot.total)
      setLoadedAccountId(requestAccountId)
      setLoadedCommentTaskIds(new Set())
      setSelectedTaskId((current) => current && snapshot.items.some((task) => task.id === current) ? current : null)
      setError(snapshot.complete ? '' : 'タスク一覧の更新中に変更が重なりました もう一度更新してください')
    } catch (err) {
      if (!isCurrentRequest()) return
      setError(err instanceof Error && err.message !== 'stale workspace'
        ? err.message
        : 'タスクの取得に失敗しました')
    } finally {
      if (isCurrentRequest()) {
        setLoading(false)
      }
    }
  }, [scope, selectedAccountId])

  useEffect(() => {
    if (accountScopeRef.current === selectedAccountId) return
    const previousAccountId = accountScopeRef.current
    const resetDraft = shouldResetInternalTaskDraft(previousAccountId, selectedAccountId, sourceAccountId)
    accountScopeRef.current = selectedAccountId
    taskRequestGateRef.current.invalidate()
    commentRequestGateRef.current.invalidate()
    setTasks([])
    setLoadedAccountId(null)
    setSelectedTaskId(null)
    setLoadedCommentTaskIds(new Set())
    setTotalTasks(0)
    setComment('')
    setSavingTaskId(null)
    if (resetDraft) {
      setCreating(false)
      setTitle('')
      setDescription('')
      setDueAt('')
      setPriority('medium')
      setAssigneeIds([])
    }
    setError('')
    setLoading(Boolean(selectedAccountId))
  }, [selectedAccountId, sourceAccountId])

  useEffect(() => {
    void loadTasks()
  }, [loadTasks])

  useEffect(() => {
    const stored = window.localStorage.getItem('internal-task-view-mode')
    if (stored === 'board' || stored === 'list') setViewMode(stored)
  }, [])

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

  useEffect(() => {
    if (!creating) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setCreating(false)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [creating])

  const selectedTask = useMemo(
    () => loadedAccountId === selectedAccountId
      ? tasks.find((task) => task.id === selectedTaskId) ?? null
      : null,
    [loadedAccountId, selectedAccountId, selectedTaskId, tasks],
  )

  useEffect(() => {
    if (!selectedTask || loadedCommentTaskIds.has(selectedTask.id)) return
    const requestId = commentRequestGateRef.current.start()
    const requestAccountId = selectedAccountId
    const requestTaskId = selectedTask.id
    api.appNotifications.internalTaskComments(selectedTask.id)
      .then((res) => {
        if (
          !commentRequestGateRef.current.isLatest(requestId)
          || accountScopeRef.current !== requestAccountId
          || requestTaskId !== selectedTask.id
        ) return
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
        if (
          commentRequestGateRef.current.isLatest(requestId)
          && accountScopeRef.current === requestAccountId
        ) setError('コメントの取得に失敗しました')
      })
    return () => { commentRequestGateRef.current.invalidate() }
  }, [loadedCommentTaskIds, selectedAccountId, selectedTask])

  const visibleTasks = loadedAccountId === selectedAccountId ? tasks : []

  const filteredTasks = useMemo(() => filterInternalTasks(visibleTasks, {
    query,
    source: sourceFilter,
    due: dueFilter,
    assigneeId: assigneeFilter,
    status: viewMode === 'list' ? statusFilter : 'all',
  }), [assigneeFilter, dueFilter, query, sourceFilter, statusFilter, visibleTasks, viewMode])

  const counts = useMemo(() => ({
    todo: visibleTasks.filter((task) => internalTaskWorkflowStatus(task) === 'todo').length,
    inProgress: visibleTasks.filter((task) => internalTaskWorkflowStatus(task) === 'in_progress').length,
    review: visibleTasks.filter((task) => internalTaskWorkflowStatus(task) === 'review').length,
    done: visibleTasks.filter((task) => internalTaskWorkflowStatus(task) === 'done').length,
    overdue: visibleTasks.filter((task) => isInternalTaskOverdue(task)).length,
  }), [visibleTasks])

  const updateTask = async (
    task: InternalTask,
    update: TaskWorkflowStatus | {
      title?: string
      description?: string
      dueAt?: string | null
      assigneeStaffIds?: string[]
      priority?: NonNullable<InternalTask['priority']>
    },
  ): Promise<boolean> => {
    if (savingTaskId) return false
    const requestAccountId = selectedAccountId
    const requestWorkspaceVersion = workspaceVersionRef.current
    const isCurrentWorkspace = () => isWorkspaceSnapshotCurrent(
      { accountId: requestAccountId, version: requestWorkspaceVersion },
      { accountId: currentAccountIdRef.current, version: workspaceVersionRef.current },
    )
    setSavingTaskId(task.id)
    try {
      const payload = typeof update === 'string'
        ? { workflowStatus: update, sortOrder: Date.now(), version: task.version }
        : { ...update, version: task.version }
      const res = await api.appNotifications.updateInternalTask(task.id, payload)
      if (!isCurrentWorkspace()) return false
      if (!res.success) {
        setError(res.error || 'タスクの更新に失敗しました')
        return false
      }
      await loadTasks()
      if (!isCurrentWorkspace()) return false
      setError('')
      return true
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 409) {
        if (!isCurrentWorkspace()) return false
        await loadTasks()
        if (!isCurrentWorkspace()) return false
        setError('別のメンバーが先に更新しました 最新状態を読み込み直しました')
        return false
      }
      if (isCurrentWorkspace()) setError('タスクの更新に失敗しました')
      return false
    } finally {
      if (isCurrentWorkspace()) setSavingTaskId(null)
    }
  }

  const addComment = async () => {
    if (!selectedTask || !comment.trim() || savingTaskId) return
    const requestAccountId = selectedAccountId
    const requestWorkspaceVersion = workspaceVersionRef.current
    const requestTaskId = selectedTask.id
    const isCurrentWorkspace = () => isWorkspaceSnapshotCurrent(
      { accountId: requestAccountId, version: requestWorkspaceVersion },
      { accountId: currentAccountIdRef.current, version: workspaceVersionRef.current },
    )
    setSavingTaskId(selectedTask.id)
    try {
      const res = await api.appNotifications.addInternalTaskComment(selectedTask.id, comment.trim())
      if (!isCurrentWorkspace()) return
      if (!res.success) {
        setError(res.error || 'コメントの投稿に失敗しました')
        return
      }
      setTasks((current) => current.map((task) => task.id === requestTaskId
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
      if (isCurrentWorkspace()) setError('コメントの投稿に失敗しました')
    } finally {
      if (isCurrentWorkspace()) setSavingTaskId(null)
    }
  }

  const createTask = async () => {
    if (!canCreateFromSource || !selectedAccountId || !title.trim() || savingTaskId) return
    const requestAccountId = selectedAccountId
    const requestWorkspaceVersion = workspaceVersionRef.current
    const isCurrentWorkspace = () => isWorkspaceSnapshotCurrent(
      { accountId: requestAccountId, version: requestWorkspaceVersion },
      { accountId: currentAccountIdRef.current, version: workspaceVersionRef.current },
    )
    setSavingTaskId('creating')
    try {
      const res = await api.appNotifications.createInternalTask({
        accountId: requestAccountId,
        source,
        sourceId,
        sourceMessageId,
        title: title.trim(),
        description: description.trim(),
        dueAt: dueAt || null,
        priority,
        assigneeStaffIds: assigneeIds.length > 0 ? assigneeIds : (currentStaffId ? [currentStaffId] : []),
      })
      if (!isCurrentWorkspace()) return
      if (!res.success) {
        setError(res.error || 'タスクの作成に失敗しました')
        return
      }
      setScope('mine')
      setViewMode('board')
      window.localStorage.setItem('internal-task-view-mode', 'board')
      await loadTasks()
      if (!isCurrentWorkspace()) return
      setSelectedTaskId(res.data.id)
      setCreating(false)
      setError('')
    } catch {
      if (isCurrentWorkspace()) setError('タスクの作成に失敗しました')
    } finally {
      if (isCurrentWorkspace()) setSavingTaskId(null)
    }
  }

  const changeView = (value: TaskViewMode) => {
    setViewMode(value)
    window.localStorage.setItem('internal-task-view-mode', value)
  }

  const clearFilters = () => {
    setQuery('')
    setSourceFilter('all')
    setDueFilter('all')
    setAssigneeFilter('')
    setStatusFilter('all')
  }

  const hasFilters = Boolean(
    query
    || sourceFilter !== 'all'
    || dueFilter !== 'all'
    || assigneeFilter
    || (viewMode === 'list' && statusFilter !== 'all'),
  )

  return (
    <div>
      <Header title="タスク管理" description={`${accountName} の社内タスク`} />

      {error && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700" role="alert">
          {error}
        </div>
      )}

      <section className="border-y border-slate-200 bg-white px-3 py-3 sm:rounded-lg sm:border sm:px-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 rounded-md bg-slate-100 p-1" role="group" aria-label="表示形式">
              {([['board', '▦ ボード'], ['list', '☷ リスト']] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => changeView(value)}
                  className={`min-h-9 rounded px-3 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${viewMode === value ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
                  aria-pressed={viewMode === value}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1 rounded-md bg-slate-100 p-1" role="group" aria-label="担当範囲">
              {([['mine', '自分'], ['all', 'すべて']] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setScope(value)}
                  className={`min-h-9 rounded px-3 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${scope === value ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
                  aria-pressed={scope === value}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs font-bold">
            <span className="rounded bg-slate-100 px-2.5 py-2 text-slate-700">未着手 {counts.todo}</span>
            <span className="rounded bg-blue-50 px-2.5 py-2 text-blue-700">対応中 {counts.inProgress}</span>
            <span className="rounded bg-amber-50 px-2.5 py-2 text-amber-700">確認待ち {counts.review}</span>
            <span className="rounded bg-emerald-50 px-2.5 py-2 text-emerald-700">完了 {counts.done}</span>
            {counts.overdue > 0 && <span className="rounded bg-red-50 px-2.5 py-2 text-red-700">期限超過 {counts.overdue}</span>}
            {canCreateFromSource && (
              <button type="button" onClick={() => setCreating(true)} className="min-h-9 rounded-md bg-blue-600 px-3 text-sm font-semibold text-white hover:bg-blue-700">タスクを作成</button>
            )}
          </div>
        </div>

        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-[minmax(220px,1fr)_160px_160px_180px_auto]">
          <label className="relative block">
            <span className="sr-only">タスクを検索</span>
            <span className="pointer-events-none absolute left-3 top-2.5 text-sm text-slate-400">⌕</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="タスク名 顧客名 内容で検索"
              maxLength={100}
              className="min-h-10 w-full rounded-md border border-slate-300 bg-white py-2 pl-9 pr-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
            />
          </label>
          <label>
            <span className="sr-only">相談元</span>
            <select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value as TaskSourceFilter)} className="min-h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100">
              <option value="all">相談元 すべて</option>
              <option value="support">チケット</option>
              <option value="direct">個別チャット</option>
              <option value="group">グループLINE</option>
            </select>
          </label>
          <label>
            <span className="sr-only">期限</span>
            <select value={dueFilter} onChange={(event) => setDueFilter(event.target.value as TaskDueFilter)} className="min-h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100">
              <option value="all">期限 すべて</option>
              <option value="overdue">期限超過</option>
              <option value="next7days">7日以内</option>
              <option value="none">期限なし</option>
            </select>
          </label>
          <label>
            <span className="sr-only">担当者</span>
            <select value={assigneeFilter} onChange={(event) => setAssigneeFilter(event.target.value)} className="min-h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100">
              <option value="">担当者 すべて</option>
              {staffOptions.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
            </select>
          </label>
          {hasFilters ? (
            <button type="button" onClick={clearFilters} className="min-h-10 rounded-md border border-slate-300 px-3 text-sm font-semibold text-slate-600 hover:bg-slate-50">条件をクリア</button>
          ) : <div className="hidden lg:block" />}
        </div>

        {viewMode === 'list' && (
          <div className="mt-3 flex flex-wrap items-center gap-1" role="group" aria-label="タスクの状態">
            {([['all', 'すべて'], ['open', '未完了'], ['done', '完了']] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setStatusFilter(value)}
                className={`min-h-9 rounded-md border px-3 text-xs font-bold ${statusFilter === value ? 'border-blue-300 bg-blue-50 text-blue-700' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}
                aria-pressed={statusFilter === value}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="mt-4" aria-busy={loading}>
        <div className="mb-3 flex items-center justify-between gap-3 px-1">
          <div>
            <h2 className="text-sm font-bold text-slate-900">{scope === 'mine' ? '自分のタスク' : 'すべてのタスク'}</h2>
            <p className="mt-0.5 text-xs text-slate-500">条件に合うタスク {filteredTasks.length}件 / 読込済み {visibleTasks.length}件 / 全 {totalTasks}件</p>
          </div>
          {viewMode === 'board' && <p className="hidden text-xs text-slate-400 sm:block">右上のハンドルをドラッグして状態を変更できます</p>}
        </div>

        {loading ? (
          <div className="rounded-lg border border-slate-200 bg-white p-12 text-center text-sm font-medium text-slate-500">タスクを読み込んでいます</div>
        ) : filteredTasks.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 bg-white p-12 text-center">
            <p className="text-sm font-bold text-slate-700">条件に合うタスクはありません</p>
            <p className="mt-1 text-xs text-slate-500">検索や絞り込み条件を変えて確認してください</p>
            {hasFilters && <button type="button" onClick={clearFilters} className="mt-4 min-h-10 rounded-md border border-slate-300 px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50">条件をクリア</button>}
          </div>
        ) : viewMode === 'board' ? (
          <TaskBoardView
            tasks={filteredTasks}
            selectedTaskId={selectedTaskId}
            savingTaskId={savingTaskId}
            onSelectTask={setSelectedTaskId}
            onMoveTask={(task, nextStatus) => void updateTask(task, nextStatus)}
          />
        ) : (
          <TaskListView
            tasks={filteredTasks}
            selectedTaskId={selectedTaskId}
            savingTaskId={savingTaskId}
            onSelectTask={setSelectedTaskId}
            onMoveTask={(task, nextStatus) => void updateTask(task, nextStatus)}
          />
        )}
      </section>

      {selectedTask && (
        <TaskDetailDrawer
          task={selectedTask}
          staffOptions={staffOptions}
          saving={savingTaskId === selectedTask.id}
          comment={comment}
          onCommentChange={setComment}
          onClose={() => {
            setSelectedTaskId(null)
            setComment('')
          }}
          onChangeStatus={(task, nextStatus) => void updateTask(task, nextStatus)}
          onSaveTask={(task, update) => updateTask(task, update)}
          onAddComment={() => void addComment()}
        />
      )}

      {creating && accountScopeRef.current === selectedAccountId && (
        <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="create-task-title">
          <button type="button" className="absolute inset-0 h-full w-full cursor-default bg-slate-950/35 backdrop-blur-[1px]" onClick={() => setCreating(false)} aria-label="作成画面を閉じる" />
          <div className="relative w-full max-w-xl rounded-t-xl bg-white p-4 shadow-2xl sm:rounded-xl sm:p-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 id="create-task-title" className="text-base font-bold text-slate-900">タスクを作成</h2>
                <p className="mt-0.5 text-xs text-slate-500">{source === 'support' ? 'チケット' : 'LINEチャット'}の相談と紐づけて作成します</p>
              </div>
              <button type="button" onClick={() => setCreating(false)} className="flex h-10 w-10 items-center justify-center rounded-md text-xl text-slate-500 hover:bg-slate-100" aria-label="閉じる">×</button>
            </div>
            {(!sourceId || !sourceMessageId) ? (
              <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800">元の相談を特定できませんでした 個別チャットまたは社内チャットからタスク化してください</div>
            ) : (
              <>
                <label className="mt-4 block">
                  <span className="text-xs font-bold text-slate-600">タスク名</span>
                  <input
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    maxLength={200}
                    autoFocus
                    placeholder="例 住所変更の登録内容を確認する"
                    className="mt-1.5 w-full rounded-md border border-slate-300 px-3 py-2.5 text-sm font-semibold outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                  />
                  <span className="mt-1 block text-[11px] text-slate-400">誰が何をするかが分かる名前にします</span>
                </label>
                <label className="mt-3 block">
                  <span className="text-xs font-bold text-slate-600">背景・完了条件</span>
                  <textarea
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    rows={4}
                    maxLength={5000}
                    placeholder="確認する内容と どの状態になれば完了かを入力"
                    className="mt-1.5 w-full resize-y rounded-md border border-slate-300 px-3 py-2.5 text-sm leading-6 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                  />
                </label>
                <label className="mt-3 block">
                  <span className="text-xs font-bold text-slate-600">期限</span>
                  <input type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} className="mt-1.5 w-full rounded-md border border-slate-300 px-3 py-2.5 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100" />
                </label>
                <label className="mt-3 block">
                  <span className="text-xs font-bold text-slate-600">優先度</span>
                  <select value={priority} onChange={(event) => setPriority(event.target.value as NonNullable<InternalTask['priority']>)} className="mt-1.5 w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100">
                    <option value="low">低</option>
                    <option value="medium">通常</option>
                    <option value="high">高</option>
                    <option value="urgent">最優先</option>
                  </select>
                </label>
                <fieldset className="mt-3">
                  <legend className="text-xs font-bold text-slate-600">担当者</legend>
                  <div className="mt-2 flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
                    {staffOptions.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        onClick={() => setAssigneeIds((current) => current.includes(option.id) ? current.filter((id) => id !== option.id) : [...current, option.id])}
                        className={`min-h-9 rounded-full border px-3 text-xs font-semibold ${assigneeIds.includes(option.id) ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-slate-200 bg-white text-slate-600'}`}
                        aria-pressed={assigneeIds.includes(option.id)}
                      >
                        {option.name}
                      </button>
                    ))}
                  </div>
                </fieldset>
                <div className="mt-5 flex justify-end gap-2">
                  <button type="button" onClick={() => setCreating(false)} className="min-h-10 rounded-md border border-slate-300 px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50">キャンセル</button>
                  <button type="button" onClick={() => void createTask()} disabled={savingTaskId === 'creating' || !title.trim()} className="min-h-10 rounded-md bg-blue-600 px-4 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">{savingTaskId === 'creating' ? '作成中' : 'タスクを作成'}</button>
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

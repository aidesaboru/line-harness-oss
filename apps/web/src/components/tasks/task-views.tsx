'use client'

import { useState } from 'react'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import type { InternalTask } from '@/lib/api'
import {
  formatInternalTaskDateTime,
  formatInternalTaskUpdatedAt,
  internalTaskDisplayTitle,
  internalTaskSourceContext,
  internalTaskSourceLabel,
  internalTaskPriorityLabel,
  internalTaskStatusLabel,
  internalTaskWorkflowStatus,
  internalTaskSupportingText,
  isInternalTaskOverdue,
} from '@/lib/internal-task-view'

type TaskViewsProps = {
  tasks: InternalTask[]
  selectedTaskId: string | null
  savingTaskId: string | null
  onSelectTask: (taskId: string) => void
  onMoveTask: (task: InternalTask, status: NonNullable<InternalTask['workflowStatus']>) => void
}

function assigneeSummary(task: InternalTask): string {
  if (task.assignees.length === 0) return '担当者未設定'
  return task.assignees.map((assignee) => assignee.staffName).join('・')
}

function initials(name: string): string {
  return name.replace(/\s+/g, '').slice(0, 2) || '未'
}

function TaskAvatars({ task }: { task: InternalTask }) {
  if (task.assignees.length === 0) {
    return <span className="text-[11px] font-medium text-slate-400">担当者未設定</span>
  }
  return (
    <span className="flex items-center" aria-label={`担当 ${assigneeSummary(task)}`}>
      {task.assignees.slice(0, 3).map((assignee, index) => (
        <span
          key={assignee.staffId}
          className={`flex h-7 w-7 items-center justify-center rounded-full border-2 border-white bg-blue-100 text-[10px] font-bold text-blue-700 ${index > 0 ? '-ml-1.5' : ''}`}
          title={assignee.staffName}
        >
          {initials(assignee.staffName)}
        </span>
      ))}
      {task.assignees.length > 3 && (
        <span className="-ml-1.5 flex h-7 min-w-7 items-center justify-center rounded-full border-2 border-white bg-slate-100 px-1 text-[10px] font-bold text-slate-600">
          +{task.assignees.length - 3}
        </span>
      )}
    </span>
  )
}

function TaskCardBody({ task, selected = false }: { task: InternalTask; selected?: boolean }) {
  const overdue = isInternalTaskOverdue(task)
  const displayTitle = internalTaskDisplayTitle(task)
  const supportingText = internalTaskSupportingText(task)
  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5 pr-8">
        <span className={`rounded px-2 py-1 text-[10px] font-bold ${
          task.source === 'support'
            ? 'bg-violet-50 text-violet-700'
            : task.isGroupConversation
              ? 'bg-cyan-50 text-cyan-700'
              : 'bg-blue-50 text-blue-700'
        }`}>
          {internalTaskSourceLabel(task)}
        </span>
        {overdue && (
          <span className="rounded bg-red-50 px-2 py-1 text-[10px] font-bold text-red-700">期限超過</span>
        )}
        {!task.canUpdate && (
          <span className="rounded bg-slate-100 px-2 py-1 text-[10px] font-semibold text-slate-500">閲覧のみ</span>
        )}
        {task.priority && task.priority !== 'medium' && (
          <span className={`rounded px-2 py-1 text-[10px] font-bold ${
            task.priority === 'urgent'
              ? 'bg-red-100 text-red-800'
              : task.priority === 'high'
                ? 'bg-amber-100 text-amber-800'
                : 'bg-slate-100 text-slate-600'
          }`}>
            優先度 {internalTaskPriorityLabel(task.priority)}
          </span>
        )}
      </div>
      <p className="mt-2 text-[10px] font-bold text-slate-400">対応内容</p>
      <h3 className={`mt-2 break-words text-sm font-bold leading-5 text-slate-900 [overflow-wrap:anywhere] ${internalTaskWorkflowStatus(task) === 'done' ? 'line-through decoration-slate-400' : ''}`}>
        {displayTitle}
      </h3>
      {supportingText && (
        <p className="mt-1.5 line-clamp-2 break-words text-xs leading-5 text-slate-500 [overflow-wrap:anywhere]">
          {supportingText}
        </p>
      )}
      <p className="mt-2 truncate text-[11px] font-semibold text-slate-500" title={internalTaskSourceContext(task)}>
        <span className="mr-1 text-slate-400">顧客</span>
        {internalTaskSourceContext(task)}
      </p>
      <div className="mt-3 flex items-end justify-between gap-2 border-t border-slate-100 pt-3">
        <TaskAvatars task={task} />
        <div className="text-right text-[10px] font-semibold leading-4 text-slate-500">
          <p className={overdue ? 'text-red-700' : ''}>{formatInternalTaskDateTime(task.dueAt)}</p>
          <p>{task.commentCount}コメント</p>
        </div>
      </div>
      {selected && <span className="sr-only">選択中</span>}
    </>
  )
}

function DraggableTaskCard({
  task,
  selected,
  saving,
  onSelectTask,
}: {
  task: InternalTask
  selected: boolean
  saving: boolean
  onSelectTask: (taskId: string) => void
}) {
  const disabled = !task.canUpdate || saving
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.id,
    disabled,
    data: { taskId: task.id },
  })
  return (
    <article
      ref={setNodeRef}
      className={`relative rounded-lg border bg-white p-3 shadow-sm transition ${
        selected ? 'border-blue-400 ring-2 ring-blue-100' : 'border-slate-200 hover:border-slate-300 hover:shadow'
      } ${isDragging ? 'z-10 opacity-30' : ''} ${saving ? 'animate-pulse' : ''}`}
    >
      <button
        type="button"
        onClick={() => onSelectTask(task.id)}
        className="block w-full rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
        aria-pressed={selected}
      >
        <TaskCardBody task={task} selected={selected} />
      </button>
      <button
        type="button"
        className="absolute right-2 top-2 flex h-8 w-8 cursor-grab items-center justify-center rounded text-base font-bold text-slate-400 outline-none hover:bg-slate-100 hover:text-slate-700 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-30"
        aria-label={`${internalTaskDisplayTitle(task)}を移動`}
        title={disabled ? 'このタスクは移動できません' : 'ドラッグして状態を変更'}
        disabled={disabled}
        {...listeners}
        {...attributes}
      >
        ⋮⋮
      </button>
    </article>
  )
}

function BoardColumn({
  status,
  tasks,
  selectedTaskId,
  savingTaskId,
  onSelectTask,
}: {
  status: NonNullable<InternalTask['workflowStatus']>
  tasks: InternalTask[]
  selectedTaskId: string | null
  savingTaskId: string | null
  onSelectTask: (taskId: string) => void
}) {
  const columnId = `task-column:${status}`
  const { setNodeRef, isOver } = useDroppable({ id: columnId })
  const isDone = status === 'done'
  const tone = status === 'todo'
    ? 'bg-slate-400'
    : status === 'in_progress'
      ? 'bg-blue-500'
      : status === 'review'
        ? 'bg-amber-500'
        : 'bg-emerald-500'
  return (
    <section
      ref={setNodeRef}
      className={`min-h-[360px] w-[min(84vw,360px)] shrink-0 snap-start rounded-xl border p-3 transition-colors md:w-auto md:max-w-none ${
        isOver
          ? 'border-blue-400 bg-blue-50/70'
          : isDone
            ? 'border-emerald-200 bg-emerald-50/40'
            : 'border-slate-200 bg-slate-100/80'
      }`}
      aria-labelledby={`${columnId}-heading`}
    >
      <header className="mb-3 flex items-center justify-between gap-3 px-1">
        <div className="flex items-center gap-2">
          <span className={`h-2.5 w-2.5 rounded-full ${tone}`} />
          <h2 id={`${columnId}-heading`} className="text-sm font-bold text-slate-800">
            {internalTaskStatusLabel(status)}
          </h2>
        </div>
        <span className="rounded-full bg-white px-2.5 py-1 text-xs font-bold text-slate-600 shadow-sm">{tasks.length}</span>
      </header>
      <div className="space-y-2.5">
        {tasks.length === 0 ? (
          <div className={`flex min-h-40 items-center justify-center rounded-lg border border-dashed px-4 text-center text-xs font-medium ${isOver ? 'border-blue-300 bg-white/70 text-blue-700' : 'border-slate-300 bg-white/60 text-slate-500'}`}>
            {isOver ? `ここへ移動して${internalTaskStatusLabel(status)}にする` : `${internalTaskStatusLabel(status)}のタスクはありません`}
          </div>
        ) : tasks.map((task) => (
          <DraggableTaskCard
            key={task.id}
            task={task}
            selected={selectedTaskId === task.id}
            saving={savingTaskId === task.id}
            onSelectTask={onSelectTask}
          />
        ))}
      </div>
    </section>
  )
}

export function TaskBoardView({ tasks, selectedTaskId, savingTaskId, onSelectTask, onMoveTask }: TaskViewsProps) {
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor),
  )
  const workflowStatuses = ['todo', 'in_progress', 'review', 'done'] as const
  const activeTask = tasks.find((task) => task.id === activeTaskId) ?? null

  const handleDragStart = (event: DragStartEvent) => {
    setActiveTaskId(String(event.active.id))
  }

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveTaskId(null)
    if (!event.over) return
    const task = tasks.find((item) => item.id === String(event.active.id))
    const target = String(event.over.id).replace('task-column:', '')
    if (!task || !workflowStatuses.includes(target as (typeof workflowStatuses)[number])) return
    if (internalTaskWorkflowStatus(task) === target) return
    onMoveTask(task, target as (typeof workflowStatuses)[number])
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragCancel={() => setActiveTaskId(null)}
      onDragEnd={handleDragEnd}
    >
      <div className="overflow-x-auto overscroll-x-contain pb-3" aria-label="タスクボード">
        <div className="grid min-w-[1120px] snap-x snap-proximity grid-cols-4 items-start gap-4">
          {workflowStatuses.map((status) => (
            <BoardColumn
              key={status}
              status={status}
              tasks={tasks.filter((task) => internalTaskWorkflowStatus(task) === status)}
              selectedTaskId={selectedTaskId}
              savingTaskId={savingTaskId}
              onSelectTask={onSelectTask}
            />
          ))}
        </div>
      </div>
      <DragOverlay>
        {activeTask ? (
          <div className="w-[min(360px,85vw)] rotate-1 rounded-lg border border-blue-300 bg-white p-3 shadow-2xl">
            <TaskCardBody task={activeTask} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}

function ListStatus({ task }: { task: InternalTask }) {
  const workflowStatus = internalTaskWorkflowStatus(task)
  const done = workflowStatus === 'done'
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-bold ${done ? 'bg-emerald-50 text-emerald-700' : 'bg-blue-50 text-blue-700'}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${done ? 'bg-emerald-500' : 'bg-blue-500'}`} />
      {internalTaskStatusLabel(workflowStatus)}
    </span>
  )
}

export function TaskListView({ tasks, selectedTaskId, savingTaskId, onSelectTask }: TaskViewsProps) {
  return (
    <>
      <div className="hidden overflow-x-auto rounded-lg border border-slate-200 bg-white md:block">
        <table className="w-full min-w-[920px] border-collapse text-left">
          <thead className="border-b border-slate-200 bg-slate-50 text-[11px] font-bold text-slate-500">
            <tr>
              <th className="px-4 py-3">対応内容</th>
              <th className="w-28 px-3 py-3">状態</th>
              <th className="w-48 px-3 py-3">顧客・相談元</th>
              <th className="w-44 px-3 py-3">担当者</th>
              <th className="w-36 px-3 py-3">期限</th>
              <th className="w-24 px-3 py-3">更新</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {tasks.map((task) => {
              const overdue = isInternalTaskOverdue(task)
              const selected = selectedTaskId === task.id
              return (
                <tr key={task.id} className={`${selected ? 'bg-blue-50/70' : 'hover:bg-slate-50'} ${savingTaskId === task.id ? 'animate-pulse' : ''}`}>
                  <td className="max-w-md px-4 py-3 align-top">
                    <button
                      type="button"
                      onClick={() => onSelectTask(task.id)}
                      className="block w-full rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
                      aria-pressed={selected}
                    >
                      <span className={`block break-words text-sm font-bold leading-5 text-slate-900 [overflow-wrap:anywhere] ${internalTaskWorkflowStatus(task) === 'done' ? 'line-through' : ''}`}>{internalTaskDisplayTitle(task)}</span>
                      {internalTaskSupportingText(task) && (
                        <span className="mt-1 block line-clamp-2 break-words text-xs leading-5 text-slate-500 [overflow-wrap:anywhere]">{internalTaskSupportingText(task)}</span>
                      )}
                    </button>
                  </td>
                  <td className="px-3 py-3 align-top"><ListStatus task={task} /></td>
                  <td className="px-3 py-3 align-top">
                    <span className="block text-[10px] font-bold text-slate-500">{internalTaskSourceLabel(task)}</span>
                    <span className="mt-1 block line-clamp-2 text-xs font-semibold leading-5 text-slate-700">{internalTaskSourceContext(task)}</span>
                  </td>
                  <td className="px-3 py-3 align-top text-xs font-medium leading-5 text-slate-600">{assigneeSummary(task)}</td>
                  <td className={`px-3 py-3 align-top text-xs font-bold ${overdue ? 'text-red-700' : 'text-slate-600'}`}>
                    {overdue && <span className="block text-[10px]">期限超過</span>}
                    {formatInternalTaskDateTime(task.dueAt)}
                  </td>
                  <td className="px-3 py-3 align-top text-xs font-medium text-slate-500">{formatInternalTaskUpdatedAt(task.updatedAt)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="space-y-2 md:hidden">
        {tasks.map((task) => {
          const selected = selectedTaskId === task.id
          return (
            <button
              key={task.id}
              type="button"
              onClick={() => onSelectTask(task.id)}
              className={`block w-full rounded-lg border bg-white p-3 text-left shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${selected ? 'border-blue-400 ring-2 ring-blue-100' : 'border-slate-200'} ${savingTaskId === task.id ? 'animate-pulse' : ''}`}
              aria-pressed={selected}
            >
              <TaskCardBody task={task} selected={selected} />
            </button>
          )
        })}
      </div>
    </>
  )
}

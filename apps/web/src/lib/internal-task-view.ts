import type { InternalTask } from '@/lib/api'

export type TaskViewMode = 'board' | 'list'
export type TaskSourceFilter = 'all' | 'support' | 'direct' | 'group'
export type TaskDueFilter = 'all' | 'overdue' | 'next7days' | 'none'
export type TaskWorkflowStatus = 'todo' | 'in_progress' | 'review' | 'done'

export function shouldResetInternalTaskDraft(
  previousAccountId: string | null,
  nextAccountId: string | null,
  sourceAccountId: string,
): boolean {
  if (previousAccountId === null && nextAccountId !== null) {
    return Boolean(sourceAccountId && sourceAccountId !== nextAccountId)
  }
  return previousAccountId !== null && previousAccountId !== nextAccountId
}

function compactTaskText(value: string, maxLength = 120): string {
  const compacted = value.replace(/\s+/g, ' ').trim()
  if (compacted.length <= maxLength) return compacted
  return `${compacted.slice(0, maxLength).trimEnd()}…`
}

export function isGenericInternalTaskTitle(task: InternalTask): boolean {
  if (!task.description.trim()) return false
  const title = task.title.trim()
  const generatedTitles = [task.customerName, task.sourceTitle]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
    .map((value) => `${value}への対応`)
  return generatedTitles.includes(title)
}

export function internalTaskDisplayTitle(task: InternalTask): string {
  if (isGenericInternalTaskTitle(task)) return compactTaskText(task.description)
  return task.title.trim() || compactTaskText(task.description) || 'タスク名未設定'
}

export function internalTaskSupportingText(task: InternalTask): string {
  if (isGenericInternalTaskTitle(task)) return ''
  return task.description.trim()
}

export function internalTaskSourceLabel(task: InternalTask): string {
  if (task.source === 'support') return 'チケット'
  return task.isGroupConversation ? 'グループLINE' : '個別チャット'
}

export function internalTaskSourceContext(task: InternalTask): string {
  const values = [task.customerName, task.sourceTitle]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
  const normalized = (value: string) => value.replace(/[\s_・\-—()（）]/g, '').toLocaleLowerCase('ja-JP')
  const uniqueValues = values.filter((value, index) => (
    values.findIndex((candidate) => normalized(candidate) === normalized(value)) === index
  ))
  const consolidatedValues = uniqueValues.filter((value) => {
    const current = normalized(value)
    return !uniqueValues.some((candidate) => {
      const other = normalized(candidate)
      return other.length > current.length && other.includes(current)
    })
  })
  return consolidatedValues.join(' / ') || '顧客情報なし'
}

export function isInternalTaskOverdue(task: InternalTask, now = Date.now()): boolean {
  if (internalTaskWorkflowStatus(task) === 'done' || !task.dueAt) return false
  const due = new Date(task.dueAt)
  return !Number.isNaN(due.getTime()) && due.getTime() < now
}

export function isInternalTaskDueWithinDays(
  task: InternalTask,
  days: number,
  now = Date.now(),
): boolean {
  if (internalTaskWorkflowStatus(task) === 'done' || !task.dueAt) return false
  const due = new Date(task.dueAt).getTime()
  if (Number.isNaN(due)) return false
  return due >= now && due <= now + days * 24 * 60 * 60 * 1000
}

export function filterInternalTasks(
  tasks: InternalTask[],
  filters: {
    query: string
    source: TaskSourceFilter
    due: TaskDueFilter
    assigneeId: string
    status?: 'all' | 'open' | 'done'
    now?: number
  },
): InternalTask[] {
  const query = filters.query.trim().toLocaleLowerCase('ja-JP')
  const now = filters.now ?? Date.now()
  return tasks.filter((task) => {
    if (filters.status && filters.status !== 'all' && task.status !== filters.status) return false
    if (filters.source === 'support' && task.source !== 'support') return false
    if (filters.source === 'direct' && (task.source !== 'chat' || task.isGroupConversation)) return false
    if (filters.source === 'group' && !task.isGroupConversation) return false
    if (filters.assigneeId && !task.assignees.some((assignee) => assignee.staffId === filters.assigneeId)) {
      return false
    }
    if (filters.due === 'overdue' && !isInternalTaskOverdue(task, now)) return false
    if (filters.due === 'next7days' && !isInternalTaskDueWithinDays(task, 7, now)) return false
    if (filters.due === 'none' && task.dueAt) return false
    if (!query) return true
    const searchable = [
      task.title,
      task.description,
      task.sourceTitle,
      task.customerName,
      internalTaskSourceLabel(task),
      ...(task.labels ?? []),
      ...task.assignees.map((assignee) => assignee.staffName),
    ].filter(Boolean).join('\n').toLocaleLowerCase('ja-JP')
    return searchable.includes(query)
  })
}

export function internalTaskWorkflowStatus(task: InternalTask): TaskWorkflowStatus {
  return task.workflowStatus ?? (task.status === 'done' ? 'done' : 'todo')
}

export function internalTaskStatusLabel(status: TaskWorkflowStatus | InternalTask['status']): string {
  if (status === 'in_progress') return '対応中'
  if (status === 'review') return '確認待ち'
  if (status === 'done') return '完了'
  return '未着手'
}

export function internalTaskPriorityLabel(priority: InternalTask['priority']): string {
  if (priority === 'urgent') return '最優先'
  if (priority === 'high') return '高'
  if (priority === 'low') return '低'
  return '通常'
}

export function formatInternalTaskDateTime(value: string | null): string {
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

export function formatInternalTaskUpdatedAt(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString('ja-JP', { month: '2-digit', day: '2-digit' })
}

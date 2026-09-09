'use client'
import { useState, useEffect } from 'react'
import Header from '@/components/layout/header'
import { useConfirmDialog } from '@/components/support/support-ui'
import { fetchApi } from '@/lib/api'
import { copyText } from '@/lib/clipboard'
import {
  buildStaffCreatePayload,
  staffAccessSelection,
  staffAccessUpdatePayload,
  staffOperationFailureMessage,
  type StaffAccessSelection,
} from '@/lib/staff-form'
import type { ApiResponse } from '@line-crm/shared'
import type { StaffMember } from '@line-crm/shared'

type NewApiKey = { apiKey: string; staffId: string }
type TicketShareTarget = { id: string; name: string }
const editableRoleOptions: Array<{ value: StaffAccessSelection; label: string }> = [
  { value: 'admin', label: '管理者' },
  { value: 'staff', label: '一次対応' },
  { value: 'sales_viewer', label: '営業閲覧（顧客状況のみ）' },
  { value: 'secondary_viewer', label: '二次対応（閲覧のみ）' },
  { value: 'secondary_responder', label: '二次対応' },
]

function RoleBadge({ role, secondaryCanRespond = false, salesOnly = false }: { role: string; secondaryCanRespond?: boolean; salesOnly?: boolean }) {
  const styles =
    role === 'owner'
      ? 'bg-yellow-100 text-yellow-800'
      : role === 'admin'
        ? 'bg-blue-100 text-blue-800'
        : role === 'secondary'
          ? 'bg-indigo-100 text-indigo-800'
          : 'bg-gray-100 text-gray-600'
  const label = salesOnly
    ? '営業閲覧'
    : role === 'owner'
      ? 'オーナー'
      : role === 'admin'
        ? '管理者'
        : role === 'secondary'
          ? (secondaryCanRespond ? '二次対応' : '二次対応（閲覧のみ）')
          : '一次対応'
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${styles}`}>
      {label}
    </span>
  )
}

function maskKey(key: string): string {
  if (!key || key.length <= 8) return '••••••••'
  return key.slice(0, 4) + '••••••••' + key.slice(-4)
}

export default function StaffPage() {
  const [members, setMembers] = useState<StaffMember[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const { requestConfirm, confirmDialog } = useConfirmDialog()

  // New API key banner
  const [newKey, setNewKey] = useState<NewApiKey | null>(null)
  const [copied, setCopied] = useState(false)

  // Create form
  const [showForm, setShowForm] = useState(false)
  const [formName, setFormName] = useState('')
  const [formEmail, setFormEmail] = useState('')
  const [formRole, setFormRole] = useState<StaffAccessSelection>('staff')
  const [formLoading, setFormLoading] = useState(false)
  const [formError, setFormError] = useState('')
  const [roleSavingId, setRoleSavingId] = useState<string | null>(null)
  const [ticketShareTarget, setTicketShareTarget] = useState<TicketShareTarget | null>(null)
  const [ticketShareIds, setTicketShareIds] = useState<string[]>([])
  const [ticketShareSaving, setTicketShareSaving] = useState(false)

  const loadMembers = async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetchApi<ApiResponse<StaffMember[]>>('/api/staff')
      if (res.success) {
        setMembers(res.data)
      } else {
        setError(staffOperationFailureMessage('load'))
      }
    } catch {
      setError(staffOperationFailureMessage('load'))
    } finally {
      setLoading(false)
    }
  }

  const handleRoleChange = async (member: StaffMember, nextAccess: StaffAccessSelection) => {
    if (staffAccessSelection(member.role, Boolean(member.secondaryCanRespond), Boolean(member.salesOnly)) === nextAccess) return
    const nextPermissions = staffAccessUpdatePayload(nextAccess)
    setRoleSavingId(member.id)
    setError('')
    const previousMembers = members
    setMembers((current) =>
      current.map((m) => (m.id === member.id
        ? {
            ...m,
            role: nextPermissions.role,
            secondaryCanRespond: nextPermissions.secondaryCanRespond,
            salesOnly: nextPermissions.salesOnly,
          }
        : m)),
    )
    try {
      const res = await fetchApi<ApiResponse<StaffMember>>(`/api/staff/${member.id}`, {
        method: 'PATCH',
        body: JSON.stringify(nextPermissions),
      })
      if (!res.success) {
        setMembers(previousMembers)
        setError(staffOperationFailureMessage('update'))
        return
      }
      setMembers((current) =>
        current.map((m) => (m.id === member.id
          ? { ...res.data, ticketShareStaffIds: member.ticketShareStaffIds }
          : m)),
      )
    } catch {
      setMembers(previousMembers)
      setError(staffOperationFailureMessage('update'))
    } finally {
      setRoleSavingId(null)
    }
  }

  useEffect(() => {
    loadMembers()
  }, [])

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    setFormError('')
    const parsed = buildStaffCreatePayload({
      name: formName,
      email: formEmail,
      role: formRole,
    })
    if (!parsed.ok) {
      setFormError(parsed.error)
      return
    }
    setFormLoading(true)
    try {
      const res = await fetchApi<ApiResponse<StaffMember & { apiKey?: string }>>('/api/staff', {
        method: 'POST',
        body: JSON.stringify(parsed.payload),
      })
      if (res.success) {
        if (res.data.apiKey) {
          setNewKey({ apiKey: res.data.apiKey, staffId: res.data.id })
        }
        setFormName('')
        setFormEmail('')
        setFormRole('staff')
        setShowForm(false)
        await loadMembers()
      } else {
        setFormError(staffOperationFailureMessage('create'))
      }
    } catch {
      setFormError(staffOperationFailureMessage('create'))
    } finally {
      setFormLoading(false)
    }
  }

  const handleToggleActive = async (member: StaffMember) => {
    try {
      const res = await fetchApi<ApiResponse<StaffMember>>(`/api/staff/${member.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: !member.isActive }),
      })
      if (!res.success) {
        setError(staffOperationFailureMessage('update'))
        return
      }
      setError('')
      await loadMembers()
    } catch {
      setError(staffOperationFailureMessage('update'))
    }
  }

  const handleRegenerateKey = async (member: StaffMember) => {
    const confirmed = await requestConfirm({
      title: 'APIキーを再生成しますか？',
      message: `${member.name} の現在のAPIキーは無効になります。外部連携で使っている場合は、新しいキーへの差し替えが必要です。`,
      confirmLabel: '再生成',
      tone: 'warning',
    })
    if (!confirmed) return
    try {
      const res = await fetchApi<ApiResponse<{ apiKey: string }>>(`/api/staff/${member.id}/regenerate-key`, {
        method: 'POST',
      })
      if (res.success) {
        setError('')
        setNewKey({ apiKey: res.data.apiKey, staffId: member.id })
      } else {
        setError(staffOperationFailureMessage('regenerate-key'))
      }
    } catch {
      setError(staffOperationFailureMessage('regenerate-key'))
    }
  }

  const openTicketShareDialog = (member: StaffMember) => {
    setTicketShareTarget({ id: member.id, name: member.name })
    setTicketShareIds(member.ticketShareStaffIds ?? [])
  }

  const saveTicketShares = async () => {
    if (!ticketShareTarget || ticketShareSaving) return
    setTicketShareSaving(true)
    setError('')
    try {
      const res = await fetchApi<ApiResponse<{ staffId: string; peerStaffIds: string[] }>>(
        `/api/staff/${ticketShareTarget.id}/ticket-shares`,
        {
          method: 'PUT',
          body: JSON.stringify({ peerStaffIds: ticketShareIds }),
        },
      )
      if (!res.success) {
        setError('チケット共有の保存に失敗しました')
        return
      }
      setTicketShareTarget(null)
      await loadMembers()
    } catch {
      setError('チケット共有の保存に失敗しました')
    } finally {
      setTicketShareSaving(false)
    }
  }

  const handleCopy = async () => {
    if (!newKey) return
    const result = await copyText(newKey.apiKey)
    if (!result.ok) {
      setError('APIキーのコピーに失敗しました。表示されているキーを選択してコピーしてください。')
      return
    }
    setError('')
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div>
      {confirmDialog}
      {ticketShareTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4" role="presentation">
          <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl" role="dialog" aria-modal="true" aria-labelledby="ticket-share-title">
            <h2 id="ticket-share-title" className="text-base font-semibold text-gray-900">チケット共有を設定</h2>
            <p className="mt-1 text-sm leading-6 text-gray-600">
              {ticketShareTarget.name} と選択したスタッフは 相互のチケットを確認し 不在時に代理で完了できます
            </p>
            <div className="mt-4 max-h-64 space-y-2 overflow-y-auto">
              {members
                .filter((member) => member.id !== ticketShareTarget.id && member.role === 'staff' && !member.salesOnly && member.isActive)
                .map((member) => (
                  <label key={member.id} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-gray-200 px-3 py-2 hover:bg-gray-50">
                    <input
                      type="checkbox"
                      checked={ticketShareIds.includes(member.id)}
                      onChange={(event) => setTicketShareIds((current) => event.target.checked
                        ? [...current, member.id]
                        : current.filter((id) => id !== member.id))}
                      className="h-4 w-4 rounded border-gray-300 text-green-600 focus:ring-green-500"
                    />
                    <span className="text-sm font-medium text-gray-800">{member.name}</span>
                  </label>
                ))}
              {members.filter((member) => member.id !== ticketShareTarget.id && member.role === 'staff' && !member.salesOnly && member.isActive).length === 0 && (
                <p className="rounded-lg bg-gray-50 px-3 py-4 text-sm text-gray-500">共有できる一次対応スタッフがいません</p>
              )}
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setTicketShareTarget(null)}
                disabled={ticketShareSaving}
                className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={() => void saveTicketShares()}
                disabled={ticketShareSaving}
                className="rounded-lg bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-700 disabled:opacity-50"
              >
                {ticketShareSaving ? '保存中...' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}
      <Header
        title="スタッフ管理"
        action={
          <button
            onClick={() => setShowForm(!showForm)}
            className="px-4 py-2 text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90"
            style={{ backgroundColor: '#06C755' }}
          >
            + スタッフを追加
          </button>
        }
      />

      {/* New API key banner */}
      {newKey && (
        <div className="mb-6 p-4 bg-green-50 border border-green-200 rounded-lg">
          <p className="text-sm font-medium text-green-800 mb-2">
            APIキーが発行されました。このキーは一度しか表示されません。
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs bg-white border border-green-200 rounded px-3 py-2 font-mono break-all">
              {newKey.apiKey}
            </code>
            <button
              onClick={handleCopy}
              className="shrink-0 px-3 py-2 text-xs font-medium text-green-700 bg-white border border-green-300 rounded-lg hover:bg-green-50 transition-colors"
            >
              {copied ? 'コピー済み' : 'コピー'}
            </button>
            <button
              onClick={() => setNewKey(null)}
              className="shrink-0 px-3 py-2 text-xs font-medium text-gray-500 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
            >
              閉じる
            </button>
          </div>
        </div>
      )}

      {/* Create form */}
      {showForm && (
        <div className="mb-6 p-5 bg-white border border-gray-200 rounded-lg shadow-sm">
          <h2 className="text-sm font-semibold text-gray-900 mb-4">新しいスタッフを追加</h2>
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">名前 *</label>
                <input
                  type="text"
                  value={formName}
                  onChange={(e) => {
                    setFormName(e.target.value)
                    if (formError === 'スタッフ名を入力してください') setFormError('')
                  }}
                  required
                  placeholder="田中 太郎"
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">メールアドレス</label>
                <input
                  type="email"
                  value={formEmail}
                  onChange={(e) => setFormEmail(e.target.value)}
                  placeholder="taro@example.com"
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">ロール *</label>
                <select
                  value={formRole}
                  onChange={(e) => setFormRole(e.target.value as StaffAccessSelection)}
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-green-500"
                >
                  {editableRoleOptions.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </div>
            </div>
            {formError && (
              <p className="text-sm text-red-600">{formError}</p>
            )}
            <div className="flex items-center gap-3">
              <button
                type="submit"
                disabled={formLoading || !formName.trim()}
                className="px-4 py-2 text-sm font-medium text-white rounded-lg disabled:opacity-50 transition-opacity hover:opacity-90"
                style={{ backgroundColor: '#06C755' }}
              >
                {formLoading ? '作成中...' : '作成'}
              </button>
              <button
                type="button"
                onClick={() => { setShowForm(false); setFormError('') }}
                className="px-4 py-2 text-sm font-medium text-gray-600 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                キャンセル
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      {/* Staff list */}
      {loading ? (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="px-4 py-4 border-b border-gray-100 flex items-center gap-4 animate-pulse">
              <div className="flex-1 space-y-2">
                <div className="h-3 bg-gray-200 rounded w-32" />
                <div className="h-2 bg-gray-100 rounded w-48" />
              </div>
              <div className="h-5 bg-gray-100 rounded-full w-16" />
              <div className="h-5 bg-gray-100 rounded w-24" />
              <div className="h-8 bg-gray-100 rounded w-20" />
            </div>
          ))}
        </div>
      ) : members.length === 0 ? (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-12 text-center">
          <p className="text-gray-500 text-sm">スタッフがいません。「+ スタッフを追加」から追加してください。</p>
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">名前</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider hidden sm:table-cell">メール</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">ロール</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider hidden md:table-cell">APIキー</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">状態</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {members.map((member) => (
                <tr key={member.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3 font-medium text-gray-900">
                    <span className="block">{member.name}</span>
                    {member.role === 'staff' && (member.ticketShareStaffIds?.length ?? 0) > 0 && (
                      <span className="mt-1 block text-[11px] font-normal text-green-700">
                        共有中: {member.ticketShareStaffIds?.map((id) => members.find((item) => item.id === id)?.name ?? id).join(' / ')}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-500 hidden sm:table-cell">{member.email ?? '—'}</td>
                  <td className="px-4 py-3">
                    {member.role === 'owner' ? (
                      <RoleBadge role={member.role} secondaryCanRespond={Boolean(member.secondaryCanRespond)} salesOnly={Boolean(member.salesOnly)} />
                    ) : (
                      <div className="flex items-center gap-2">
                        <select
                          value={staffAccessSelection(member.role, Boolean(member.secondaryCanRespond), Boolean(member.salesOnly)) === 'owner'
                            ? 'staff'
                            : staffAccessSelection(member.role, Boolean(member.secondaryCanRespond), Boolean(member.salesOnly))}
                          onChange={(e) => handleRoleChange(member, e.target.value as StaffAccessSelection)}
                          disabled={Boolean(roleSavingId)}
                          className="min-w-[104px] rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-700 shadow-sm outline-none transition-colors focus:border-green-500 focus:ring-2 focus:ring-green-100 disabled:cursor-wait disabled:bg-gray-50 disabled:text-gray-400"
                          aria-label={`${member.name} の権限`}
                        >
                          {editableRoleOptions.map((option) => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                          ))}
                        </select>
                        {roleSavingId === member.id && (
                          <span className="text-[11px] font-medium text-gray-400">保存中</span>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-400 font-mono text-xs hidden md:table-cell">
                    {maskKey(member.apiKey ?? '')}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center gap-1.5 text-xs ${member.isActive ? 'text-green-700' : 'text-gray-400'}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${member.isActive ? 'bg-green-500' : 'bg-gray-300'}`} />
                      {member.isActive ? '有効' : '無効'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      {member.role !== 'owner' && (
                        <>
                          {member.role === 'staff' && !member.salesOnly && member.isActive && (
                            <button
                              onClick={() => openTicketShareDialog(member)}
                              className="px-2.5 py-1 text-xs font-medium text-green-700 bg-white border border-green-200 rounded hover:bg-green-50 transition-colors"
                            >
                              チケット共有
                            </button>
                          )}
                          <button
                            onClick={() => handleToggleActive(member)}
                            className="px-2.5 py-1 text-xs font-medium text-gray-600 bg-white border border-gray-300 rounded hover:bg-gray-50 transition-colors"
                          >
                            {member.isActive ? '無効化' : '有効化'}
                          </button>
                          <button
                            onClick={() => handleRegenerateKey(member)}
                            className="px-2.5 py-1 text-xs font-medium text-blue-600 bg-white border border-blue-200 rounded hover:bg-blue-50 transition-colors"
                          >
                            キー再生成
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

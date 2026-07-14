'use client'

import { useState } from 'react'
import type { Tag } from '@line-crm/shared'
import type { FriendListItem } from '@/lib/api'
import { api } from '@/lib/api'
import {
  customerOperationContractFieldDefinitions,
  customerProfileBasicFieldDefinitions,
  customerProfileFieldGroups,
  customerProfileFormFromMetadata,
  customerProfileMetadataPatch,
  emptyCustomerOperationContract,
  type CustomerOperationContractFieldKey,
  type CustomerProfileBasicFieldKey,
  type CustomerProfileForm,
} from '@/lib/customer-profile'
import FriendListRow from './friend-list-row'
import TagBadge from './tag-badge'

interface Props {
  friends: FriendListItem[]
  allTags: Tag[]
  onRefresh: () => void
}

export default function FriendListTable({ friends, allTags, onRefresh }: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [profileDraft, setProfileDraft] = useState<CustomerProfileForm | null>(null)
  const [addingTagForFriend, setAddingTagForFriend] = useState<string | null>(null)
  const [selectedTagId, setSelectedTagId] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const toggleExpand = (friend: FriendListItem) => {
    const nextId = expandedId === friend.id ? null : friend.id
    setExpandedId(nextId)
    setProfileDraft(nextId ? customerProfileFormFromMetadata(friend.metadata) : null)
    setAddingTagForFriend(null)
    setSelectedTagId('')
    setError('')
    setMessage('')
  }

  const handleBasicProfileChange = (key: CustomerProfileBasicFieldKey, value: string) => {
    setProfileDraft((prev) => prev ? { ...prev, basic: { ...prev.basic, [key]: value } } : prev)
  }

  const handleOperationContractChange = (index: number, key: CustomerOperationContractFieldKey, value: string) => {
    setProfileDraft((prev) => {
      if (!prev) return prev
      const operationContracts = prev.operationContracts.map((contract, i) => (
        i === index ? { ...contract, [key]: value } : contract
      ))
      return { ...prev, operationContracts }
    })
  }

  const handleAddOperationContract = () => {
    setProfileDraft((prev) => prev ? {
      ...prev,
      operationContracts: [...prev.operationContracts, emptyCustomerOperationContract()],
    } : prev)
  }

  const handleRemoveOperationContract = (index: number) => {
    setProfileDraft((prev) => {
      if (!prev) return prev
      const operationContracts = prev.operationContracts.filter((_, i) => i !== index)
      return {
        ...prev,
        operationContracts: operationContracts.length > 0 ? operationContracts : [emptyCustomerOperationContract()],
      }
    })
  }

  const handleSaveProfile = async (friendId: string) => {
    if (!profileDraft || loading) return
    setLoading(true)
    setError('')
    setMessage('')
    try {
      const res = await api.friends.updateMetadata(friendId, customerProfileMetadataPatch(profileDraft))
      if (!res.success) {
        setError('顧客情報の保存に失敗しました')
        return
      }
      setMessage('顧客情報を保存しました')
      onRefresh()
    } catch {
      setError('顧客情報の保存に失敗しました')
    } finally {
      setLoading(false)
    }
  }

  const handleAddTag = async (friendId: string) => {
    if (!selectedTagId || loading) return
    setLoading(true)
    setError('')
    setMessage('')
    try {
      const res = await api.friends.addTag(friendId, selectedTagId)
      if (!res.success) {
        setError('タグの追加に失敗しました')
        return
      }
      setMessage('タグを追加しました')
      setAddingTagForFriend(null)
      setSelectedTagId('')
      onRefresh()
    } catch {
      setError('タグの追加に失敗しました')
    } finally {
      setLoading(false)
    }
  }

  const handleRemoveTag = async (friendId: string, tagId: string) => {
    if (loading) return
    setLoading(true)
    setError('')
    setMessage('')
    try {
      const res = await api.friends.removeTag(friendId, tagId)
      if (!res.success) {
        setError('タグの削除に失敗しました')
        return
      }
      setMessage('タグを削除しました')
      onRefresh()
    } catch {
      setError('タグの削除に失敗しました')
    } finally {
      setLoading(false)
    }
  }

  if (friends.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-12 text-center shadow-sm">
        <p className="text-sm text-slate-500">顧客が見つかりません</p>
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      {error && (
        <div className="border-b border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {message && (
        <div className="border-b border-emerald-100 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          {message}
        </div>
      )}

      <div className="overflow-x-auto">
        <div className="min-w-[720px]">
          <div className="hidden grid-cols-[260px_1fr_160px] gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3 text-[11px] font-semibold uppercase text-slate-500 lg:grid">
            <div>顧客</div>
            <div>基本情報</div>
            <div className="text-right">編集</div>
          </div>
          {friends.map((friend) => {
            const isExpanded = expandedId === friend.id

            return (
              <div key={friend.id}>
                <FriendListRow
                  friend={friend}
                  expanded={isExpanded}
                  onEditClick={() => toggleExpand(friend)}
                />

                {isExpanded && profileDraft && (
                  <div className="border-b border-slate-100 bg-slate-50 px-5 py-5">
                    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm" aria-label="顧客情報の編集">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <h2 className="text-sm font-semibold text-slate-950">顧客情報</h2>
                          <p className="mt-1 text-xs text-slate-500">未入力の必須項目は黄色い枠で表示しています。</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleSaveProfile(friend.id)}
                          disabled={loading}
                          className="rounded-lg bg-slate-950 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {loading ? '保存中...' : '保存'}
                        </button>
                      </div>
                      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(320px,0.45fr)]">
                        <div className="space-y-4">
                          <section className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                            <div>
                              <h3 className="text-xs font-semibold text-slate-900">{customerProfileFieldGroups[0].title}</h3>
                              <p className="mt-0.5 text-[11px] text-slate-500">{customerProfileFieldGroups[0].description}</p>
                            </div>
                            <div className="mt-3 grid gap-3 md:grid-cols-2">
                              {customerProfileBasicFieldDefinitions.map((field) => {
                                const value = profileDraft.basic[field.key as CustomerProfileBasicFieldKey] ?? ''
                                const missing = field.required && !value.trim()
                                const isLongText = field.key === 'specialNotes'
                                return (
                                  <label key={field.key} className={isLongText ? 'block md:col-span-2' : 'block'}>
                                    <span className="flex items-center gap-1 text-xs font-semibold text-slate-600">
                                      {field.label}
                                      {field.required && <span className="text-amber-600">必須</span>}
                                    </span>
                                    {isLongText ? (
                                      <textarea
                                        value={value}
                                        onChange={(e) => handleBasicProfileChange(field.key as CustomerProfileBasicFieldKey, e.target.value)}
                                        rows={3}
                                        className={`mt-1 w-full rounded-lg border px-3 py-2 text-sm outline-none transition-colors focus:ring-2 focus:ring-green-500 ${
                                          missing
                                            ? 'border-amber-300 bg-amber-50 text-amber-950'
                                            : 'border-slate-300 bg-white text-slate-900'
                                        }`}
                                        placeholder={field.label}
                                      />
                                    ) : (
                                      <input
                                        type={field.key === 'googleFolderUrl' ? 'url' : 'text'}
                                        value={value}
                                        onChange={(e) => handleBasicProfileChange(field.key as CustomerProfileBasicFieldKey, e.target.value)}
                                        className={`mt-1 w-full rounded-lg border px-3 py-2 text-sm outline-none transition-colors focus:ring-2 focus:ring-green-500 ${
                                          missing
                                            ? 'border-amber-300 bg-amber-50 text-amber-950'
                                            : 'border-slate-300 bg-white text-slate-900'
                                        }`}
                                        placeholder={missing ? `${field.label}を入力` : field.label}
                                      />
                                    )}
                                  </label>
                                )
                              })}
                            </div>
                          </section>

                          <section className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <div>
                                <h3 className="text-xs font-semibold text-slate-900">{customerProfileFieldGroups[1].title}</h3>
                                <p className="mt-0.5 text-[11px] text-slate-500">{customerProfileFieldGroups[1].description}</p>
                              </div>
                              <button
                                type="button"
                                onClick={handleAddOperationContract}
                                disabled={loading}
                                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                              >
                                店舗を追加
                              </button>
                            </div>
                            <div className="mt-3 space-y-3">
                              {profileDraft.operationContracts.map((contract, index) => (
                                <div key={index} className="rounded-lg border border-slate-200 bg-white p-3">
                                  <div className="flex items-center justify-between gap-2">
                                    <p className="text-xs font-semibold text-slate-700">店舗 {index + 1}</p>
                                    {profileDraft.operationContracts.length > 1 && (
                                      <button
                                        type="button"
                                        onClick={() => handleRemoveOperationContract(index)}
                                        disabled={loading}
                                        className="rounded-md px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                                      >
                                        削除
                                      </button>
                                    )}
                                  </div>
                                  <div className="mt-3 grid gap-3 md:grid-cols-2">
                                    {customerOperationContractFieldDefinitions.map((field) => (
                                      <label key={field.key} className="block">
                                        <span className="text-xs font-semibold text-slate-600">{field.label}</span>
                                        <input
                                          type="text"
                                          value={contract[field.key as CustomerOperationContractFieldKey] ?? ''}
                                          onChange={(e) => handleOperationContractChange(index, field.key as CustomerOperationContractFieldKey, e.target.value)}
                                          className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition-colors focus:ring-2 focus:ring-green-500"
                                          placeholder={field.label}
                                        />
                                      </label>
                                    ))}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </section>
                        </div>

                        <section className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                          <div>
                            <h3 className="text-xs font-semibold text-slate-900">タグ管理</h3>
                            <p className="mt-0.5 text-[11px] text-slate-500">1名の顧客に複数タグを設定できます。</p>
                          </div>
                          <div className="mt-3 flex flex-wrap gap-1.5">
                            {friend.tags.length > 0 ? (
                              friend.tags.map((tag) => (
                                <TagBadge
                                  key={tag.id}
                                  tag={tag}
                                  onRemove={() => handleRemoveTag(friend.id, tag.id)}
                                />
                              ))
                            ) : (
                              <span className="text-xs text-slate-400">タグ未設定</span>
                            )}
                          </div>
                          {addingTagForFriend === friend.id ? (
                            <div className="mt-3 flex flex-col gap-2">
                              <select
                                value={selectedTagId}
                                onChange={(e) => setSelectedTagId(e.target.value)}
                                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-green-500"
                              >
                                <option value="">タグを選択</option>
                                {allTags
                                  .filter((tag) => !friend.tags.some((current) => current.id === tag.id))
                                  .map((tag) => (
                                    <option key={tag.id} value={tag.id}>{tag.name}</option>
                                  ))}
                              </select>
                              <div className="flex gap-2">
                                <button
                                  type="button"
                                  onClick={() => handleAddTag(friend.id)}
                                  disabled={loading || !selectedTagId}
                                  className="rounded-lg bg-slate-950 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
                                >
                                  追加
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setAddingTagForFriend(null)
                                    setSelectedTagId('')
                                  }}
                                  className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                                >
                                  キャンセル
                                </button>
                              </div>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setAddingTagForFriend(friend.id)}
                              disabled={loading || allTags.every((tag) => friend.tags.some((current) => current.id === tag.id))}
                              className="mt-3 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                            >
                              タグを追加
                            </button>
                          )}
                        </section>
                      </div>
                    </section>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

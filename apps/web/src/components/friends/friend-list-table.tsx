'use client'

import { useState } from 'react'
import type { FriendListItem } from '@/lib/api'
import { api } from '@/lib/api'
import {
  customerProfileFieldGroups,
  customerProfileFieldDefinitions,
  customerProfileFormFromMetadata,
  customerProfileMetadataPatch,
  type CustomerProfileFieldKey,
} from '@/lib/customer-profile'
import FriendListRow from './friend-list-row'

interface Props {
  friends: FriendListItem[]
  onRefresh: () => void
}

type ProfileDraft = Record<CustomerProfileFieldKey, string>

export default function FriendListTable({ friends, onRefresh }: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [profileDraft, setProfileDraft] = useState<ProfileDraft | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const toggleExpand = (friend: FriendListItem) => {
    const nextId = expandedId === friend.id ? null : friend.id
    setExpandedId(nextId)
    setProfileDraft(nextId ? customerProfileFormFromMetadata(friend.metadata) : null)
    setError('')
    setMessage('')
  }

  const handleProfileChange = (key: CustomerProfileFieldKey, value: string) => {
    setProfileDraft((prev) => prev ? { ...prev, [key]: value } : prev)
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
                      <div className="mt-4 grid gap-4 lg:grid-cols-2">
                        {customerProfileFieldGroups.map((group) => {
                          const fields = group.keys
                            .map((key) => customerProfileFieldDefinitions.find((field) => field.key === key))
                            .filter((field): field is NonNullable<typeof field> => Boolean(field))
                          return (
                            <section key={group.title} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                              <div>
                                <h3 className="text-xs font-semibold text-slate-900">{group.title}</h3>
                                <p className="mt-0.5 text-[11px] text-slate-500">{group.description}</p>
                              </div>
                              <div className="mt-3 grid gap-3 md:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                                {fields.map((field) => {
                                  const value = profileDraft[field.key] ?? ''
                                  const missing = field.required && !value.trim()
                                  return (
                                    <label key={field.key} className="block">
                                      <span className="flex items-center gap-1 text-xs font-semibold text-slate-600">
                                        {field.label}
                                        {field.required && <span className="text-amber-600">必須</span>}
                                      </span>
                                      <input
                                        type={field.key === 'googleFolderUrl' ? 'url' : 'text'}
                                        value={value}
                                        onChange={(e) => handleProfileChange(field.key, e.target.value)}
                                        className={`mt-1 w-full rounded-lg border px-3 py-2 text-sm outline-none transition-colors focus:ring-2 focus:ring-green-500 ${
                                          missing
                                            ? 'border-amber-300 bg-amber-50 text-amber-950'
                                            : 'border-slate-300 bg-white text-slate-900'
                                        }`}
                                        placeholder={missing ? `${field.label}を入力` : field.label}
                                      />
                                    </label>
                                  )
                                })}
                              </div>
                            </section>
                          )
                        })}
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

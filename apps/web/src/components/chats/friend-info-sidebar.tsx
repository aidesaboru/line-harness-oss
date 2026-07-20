'use client'

import { useState, useEffect } from 'react'
import { api } from '@/lib/api'
import {
  customerOperationContractFieldDefinitions,
  customerBroadcastExclusionPatch,
  customerProfileBasicFieldDefinitions,
  customerProfileFieldGroups,
  customerProfileFormFromMetadata,
  customerProfileFromMetadata,
  customerProfileMetadataPatch,
  emptyCustomerOperationContract,
  isCustomerProfileMetadataKey,
  isCustomerBroadcastExcluded,
  type CustomerOperationContractFieldKey,
  type CustomerProfileBasicFieldKey,
  type CustomerProfileForm,
} from '@/lib/customer-profile'

interface FriendDetail {
  id: string
  displayName: string | null
  pictureUrl: string | null
  isFollowing: boolean
  metadata: Record<string, unknown>
  refCode: string | null
  createdAt: string
  tags: Array<{ id: string; name: string; color: string }>
}

interface ChatStatusInfo {
  status: 'unread' | 'in_progress' | 'resolved' | 'long_term' | null
}

interface Props {
  friendId: string | null
  /** 親 (ChatDetail) が持っている chat 側の対応状況 */
  chatStatus?: ChatStatusInfo
  /** 対応中スタッフ名 (ChatDetail で operatorId → name 変換済を渡す想定) */
  operatorName?: string | null
  /** 顧客情報保存後、親画面のチャット名や一覧表示も即時更新する */
  onFriendUpdated?: (friend: FriendDetail) => void
}

function formatDate(iso: string | null): string {
  if (!iso) return '-'
  const d = new Date(iso)
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const statusLabels: Record<NonNullable<ChatStatusInfo['status']>, { label: string; className: string }> = {
  unread: { label: '未対応', className: 'bg-red-100 text-red-700' },
  in_progress: { label: '対応中', className: 'bg-yellow-100 text-yellow-700' },
  resolved: { label: '解決済', className: 'bg-green-100 text-green-700' },
  long_term: { label: '中長期対応', className: 'bg-blue-100 text-blue-700' },
}

const FRIEND_INFO_ERROR_MESSAGE = '顧客情報の取得に失敗しました。もう一度お試しください。'
const FRIEND_CUSTOMER_SAVE_ERROR_MESSAGE = '顧客情報の保存に失敗しました。もう一度お試しください。'

/** Render a metadata value safely as text. Objects/arrays → JSON, primitives → as-is. */
function renderValue(value: unknown): string {
  if (value === null || value === undefined) return '-'
  if (typeof value === 'string') return value || '-'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return '表示できない値'
  }
}

function toHttpUrl(value: string): string | null {
  const trimmed = value.trim()
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  return null
}

export default function FriendInfoSidebar({ friendId, chatStatus, operatorName, onFriendUpdated }: Props) {
  const [friend, setFriend] = useState<FriendDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editingCustomer, setEditingCustomer] = useState(false)
  const [customerForm, setCustomerForm] = useState<CustomerProfileForm>(
    () => customerProfileFormFromMetadata({}),
  )
  const [broadcastExcluded, setBroadcastExcluded] = useState(false)
  const [savingCustomer, setSavingCustomer] = useState(false)
  const [customerError, setCustomerError] = useState<string | null>(null)
  const [customerSaved, setCustomerSaved] = useState(false)

  useEffect(() => {
    if (!friendId) {
      setFriend(null)
      setEditingCustomer(false)
      setCustomerError(null)
      setCustomerSaved(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    api.friends.get(friendId).then((res) => {
      if (cancelled) return
      if (res.success && res.data) {
        setFriend(res.data as unknown as FriendDetail)
      } else {
        setError(FRIEND_INFO_ERROR_MESSAGE)
      }
    }).catch(() => {
      if (cancelled) return
      setError(FRIEND_INFO_ERROR_MESSAGE)
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [friendId])

  useEffect(() => {
    if (!friend) return
    setCustomerForm(customerProfileFormFromMetadata(friend.metadata))
    setBroadcastExcluded(isCustomerBroadcastExcluded(friend.metadata))
    setEditingCustomer(false)
    setCustomerError(null)
    setCustomerSaved(false)
  }, [friend?.id, friend?.metadata])

  // リッチメニュー — loading / error / data を区別して、null=未設定 を取得失敗と
  // 混同しないようにする。Codex review (P3) の指摘で導入。
  type RichMenuState =
    | { kind: 'loading' }
    | { kind: 'error' }
    | { kind: 'data'; id: string | null; name: string | null; isDefault: boolean }
  const [richMenu, setRichMenu] = useState<RichMenuState>({ kind: 'loading' })

  useEffect(() => {
    if (!friendId) {
      setRichMenu({ kind: 'loading' })
      return
    }
    let cancelled = false
    setRichMenu({ kind: 'loading' })
    api.friends.richMenu(friendId).then((res) => {
      if (cancelled) return
      if (res.success && res.data) {
        setRichMenu({ kind: 'data', ...res.data })
      } else {
        setRichMenu({ kind: 'error' })
      }
    }).catch(() => {
      if (cancelled) return
      setRichMenu({ kind: 'error' })
    })
    return () => { cancelled = true }
  }, [friendId])

  if (!friendId) return null

  const profile = friend ? customerProfileFromMetadata(friend.metadata) : null
  const displayName = profile?.displayName || friend?.displayName || '名前なし'
  const extraMetadataEntries = friend
    ? Object.entries(friend.metadata ?? {}).filter(([key]) => !isCustomerProfileMetadataKey(key))
    : []

  const handleCustomerBasicChange = (key: CustomerProfileBasicFieldKey, value: string) => {
    setCustomerForm((prev) => ({ ...prev, basic: { ...prev.basic, [key]: value } }))
    setCustomerError(null)
    setCustomerSaved(false)
  }

  const handleCustomerOperationChange = (index: number, key: CustomerOperationContractFieldKey, value: string) => {
    setCustomerForm((prev) => ({
      ...prev,
      operationContracts: prev.operationContracts.map((contract, i) => (
        i === index ? { ...contract, [key]: value } : contract
      )),
    }))
    setCustomerError(null)
    setCustomerSaved(false)
  }

  const handleAddCustomerOperation = () => {
    setCustomerForm((prev) => ({
      ...prev,
      operationContracts: [...prev.operationContracts, emptyCustomerOperationContract()],
    }))
    setCustomerError(null)
    setCustomerSaved(false)
  }

  const handleRemoveCustomerOperation = (index: number) => {
    setCustomerForm((prev) => {
      const operationContracts = prev.operationContracts.filter((_, i) => i !== index)
      return {
        ...prev,
        operationContracts: operationContracts.length > 0 ? operationContracts : [emptyCustomerOperationContract()],
      }
    })
    setCustomerError(null)
    setCustomerSaved(false)
  }

  const handleCustomerSave = async () => {
    if (!friend) return
    setSavingCustomer(true)
    setCustomerError(null)
    setCustomerSaved(false)
    try {
      const res = await api.friends.updateMetadata(friend.id, {
        ...customerProfileMetadataPatch(customerForm),
        ...customerBroadcastExclusionPatch(broadcastExcluded),
      })
      if (res.success && res.data) {
        const updatedFriend = res.data as unknown as FriendDetail
        setFriend(updatedFriend)
        onFriendUpdated?.(updatedFriend)
        setEditingCustomer(false)
        setCustomerSaved(true)
      } else {
        setCustomerError(FRIEND_CUSTOMER_SAVE_ERROR_MESSAGE)
      }
    } catch {
      setCustomerError(FRIEND_CUSTOMER_SAVE_ERROR_MESSAGE)
    } finally {
      setSavingCustomer(false)
    }
  }

  return (
    <div className="w-full lg:w-80 lg:flex-shrink-0 bg-white rounded-lg shadow-sm border border-gray-200 flex flex-col overflow-hidden">
      <div className="border-b border-gray-200 bg-white px-4 py-3">
        <h3 className="text-base font-bold text-gray-900">顧客詳細</h3>
        <p className="mt-0.5 text-xs text-gray-500">対応に必要な顧客情報を確認</p>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-4 space-y-3 animate-pulse">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-full bg-gray-200" />
              <div className="flex-1 space-y-2">
                <div className="h-3 bg-gray-200 rounded w-32" />
                <div className="h-2 bg-gray-100 rounded w-20" />
              </div>
            </div>
          </div>
        ) : error ? (
          <div className="p-4 text-xs text-red-600">{error}</div>
        ) : friend ? (
          <div className="divide-y divide-gray-100">
            {/* Profile Header */}
            <div className="bg-gray-50/80 p-4 flex items-start gap-3">
              {friend.pictureUrl ? (
                <img src={friend.pictureUrl} alt="" className="w-12 h-12 rounded-full flex-shrink-0" />
              ) : (
                <div className="w-12 h-12 rounded-full bg-gray-200 flex items-center justify-center flex-shrink-0">
                  <span className="text-gray-500 text-base">{displayName.charAt(0)}</span>
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-gray-900 truncate">{displayName}</p>
                <p className="text-[11px] text-gray-400 mt-0.5">
                  登録日: {formatDate(friend.createdAt)}
                </p>
                {!friend.isFollowing && (
                  <span className="inline-block mt-1 px-1.5 py-0 rounded text-[10px] font-medium bg-gray-100 text-gray-500">
                    ブロック済
                  </span>
                )}
              </div>
            </div>

            {/* Status / Operator */}
            {(chatStatus?.status || operatorName) && (
              <div className="p-4 space-y-2">
                {chatStatus?.status && statusLabels[chatStatus.status] && (
                  <div className="flex justify-between items-center">
                    <span className="text-[11px] text-gray-500">対応状況</span>
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${statusLabels[chatStatus.status].className}`}>
                      {statusLabels[chatStatus.status].label}
                    </span>
                  </div>
                )}
                {operatorName && (
                  <div className="flex justify-between items-center">
                    <span className="text-[11px] text-gray-500">対応中スタッフ</span>
                    <span className="text-xs text-gray-700">{operatorName}</span>
                  </div>
                )}
              </div>
            )}

            {/* Customer Profile */}
            {profile && (
              <div className="p-4 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h4 className="text-sm font-bold text-gray-900">顧客カード</h4>
                    <p className="mt-0.5 text-[11px] text-gray-500">
                      必須 {profile.completionLabel} 入力済み
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      if (editingCustomer) {
                        setCustomerForm(customerProfileFormFromMetadata(friend.metadata))
                        setBroadcastExcluded(isCustomerBroadcastExcluded(friend.metadata))
                        setCustomerError(null)
                      }
                      setEditingCustomer((value) => !value)
                      setCustomerSaved(false)
                    }}
                    className="rounded-md border border-gray-200 px-2 py-1 text-[11px] font-medium text-gray-600 hover:bg-gray-50"
                  >
                    {editingCustomer ? '閉じる' : '編集'}
                  </button>
                </div>

                {profile.missingRequiredFields.length > 0 && (
                  <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
                    <p className="text-[11px] font-medium text-amber-800">未入力あり</p>
                    <p className="mt-0.5 text-[11px] text-amber-700">
                      {profile.missingRequiredFields.map((field) => field.label).join('、')}
                    </p>
                  </div>
                )}
                {profile.broadcastExcluded && !editingCustomer && (
                  <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2">
                    <p className="text-[11px] font-medium text-red-800">一斉送信から除外中</p>
                    <p className="mt-0.5 text-[11px] text-red-700">
                      この顧客には一斉配信や条件配信を送りません。
                    </p>
                  </div>
                )}

                {customerError && (
                  <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[11px] text-red-700">
                    {customerError}
                  </p>
                )}
                {customerSaved && (
                  <p className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-[11px] text-green-700">
                    保存しました
                  </p>
                )}

                {editingCustomer ? (
                  <div className="space-y-4">
                    <section className="rounded-lg border border-gray-100 bg-gray-50/70 p-3">
                      <div className="mb-2">
                        <p className="text-xs font-semibold text-gray-800">{customerProfileFieldGroups[0].title}</p>
                        <p className="mt-0.5 text-[10px] text-gray-500">{customerProfileFieldGroups[0].description}</p>
                      </div>
                      <div className="space-y-2">
                        {customerProfileBasicFieldDefinitions.map((field) => {
                          const key = field.key as CustomerProfileBasicFieldKey
                          const value = customerForm.basic[key] ?? ''
                          const missing = field.required && !value.trim()
                          const isLongText = field.key === 'specialNotes'
                          return (
                            <label key={field.key} className="block">
                              <span className="mb-1 flex items-center gap-1 text-[10px] font-medium text-gray-500">
                                {field.label}
                                {field.required && <span className="text-red-500">必須</span>}
                              </span>
                              {isLongText ? (
                                <textarea
                                  value={value}
                                  rows={3}
                                  onChange={(e) => handleCustomerBasicChange(key, e.target.value)}
                                  className={`w-full rounded-md border px-2 py-1.5 text-xs text-gray-800 focus:border-green-500 focus:outline-none focus:ring-1 focus:ring-green-500 ${
                                    missing ? 'border-amber-300 bg-amber-50' : 'border-gray-300 bg-white'
                                  }`}
                                />
                              ) : (
                                <input
                                  type={field.key === 'googleFolderUrl' ? 'url' : 'text'}
                                  value={value}
                                  onChange={(e) => handleCustomerBasicChange(key, e.target.value)}
                                  className={`w-full rounded-md border px-2 py-1.5 text-xs text-gray-800 focus:border-green-500 focus:outline-none focus:ring-1 focus:ring-green-500 ${
                                    missing ? 'border-amber-300 bg-amber-50' : 'border-gray-300 bg-white'
                                  }`}
                                />
                              )}
                            </label>
                          )
                        })}
                      </div>
                    </section>

                    <section className="rounded-lg border border-gray-100 bg-gray-50/70 p-3">
                      <div className="mb-2 flex items-start justify-between gap-2">
                        <div>
                          <p className="text-xs font-semibold text-gray-800">{customerProfileFieldGroups[1].title}</p>
                          <p className="mt-0.5 text-[10px] text-gray-500">{customerProfileFieldGroups[1].description}</p>
                        </div>
                        <button
                          type="button"
                          onClick={handleAddCustomerOperation}
                          className="rounded-md border border-gray-200 bg-white px-2 py-1 text-[10px] font-medium text-gray-600 hover:bg-gray-50"
                        >
                          追加
                        </button>
                      </div>
                      <div className="space-y-3">
                        {customerForm.operationContracts.map((contract, index) => (
                          <div key={index} className="rounded-md border border-gray-100 bg-white p-2">
                            <div className="mb-2 flex items-center justify-between gap-2">
                              <p className="text-[11px] font-semibold text-gray-700">店舗 {index + 1}</p>
                              {customerForm.operationContracts.length > 1 && (
                                <button
                                  type="button"
                                  onClick={() => handleRemoveCustomerOperation(index)}
                                  className="rounded px-1.5 py-0.5 text-[10px] font-medium text-red-600 hover:bg-red-50"
                                >
                                  削除
                                </button>
                              )}
                            </div>
                            <div className="space-y-2">
                              {customerOperationContractFieldDefinitions.map((field) => {
                                const key = field.key as CustomerOperationContractFieldKey
                                return (
                                  <label key={field.key} className="block">
                                    <span className="mb-1 block text-[10px] font-medium text-gray-500">{field.label}</span>
                                    <input
                                      type="text"
                                      value={contract[key] ?? ''}
                                      onChange={(e) => handleCustomerOperationChange(index, key, e.target.value)}
                                      className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs text-gray-800 focus:border-green-500 focus:outline-none focus:ring-1 focus:ring-green-500"
                                    />
                                  </label>
                                )
                              })}
                            </div>
                          </div>
                        ))}
                      </div>
                    </section>
                    <label className="flex items-start gap-2 rounded-md border border-red-100 bg-red-50 px-3 py-2">
                      <input
                        type="checkbox"
                        checked={broadcastExcluded}
                        onChange={(e) => {
                          setBroadcastExcluded(e.target.checked)
                          setCustomerError(null)
                          setCustomerSaved(false)
                        }}
                        className="mt-0.5 h-4 w-4 rounded border-red-300 text-red-600 focus:ring-red-500"
                      />
                      <span>
                        <span className="block text-[11px] font-medium text-red-800">一斉送信から除外</span>
                        <span className="block text-[10px] leading-relaxed text-red-700">
                          クレーム対応中、配信停止、個別判断が必要な顧客に使います。
                        </span>
                      </span>
                    </label>
                    <div className="flex items-center gap-2 pt-1">
                      <button
                        type="button"
                        onClick={handleCustomerSave}
                        disabled={savingCustomer}
                        className="rounded-md px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                        style={{ backgroundColor: '#06C755' }}
                      >
                        {savingCustomer ? '保存中...' : '保存'}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setCustomerForm(customerProfileFormFromMetadata(friend.metadata))
                          setBroadcastExcluded(isCustomerBroadcastExcluded(friend.metadata))
                          setEditingCustomer(false)
                          setCustomerError(null)
                          setCustomerSaved(false)
                        }}
                        className="rounded-md bg-gray-100 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-200"
                      >
                        キャンセル
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <section className="rounded-lg border border-gray-100 bg-gray-50/70 p-3">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <p className="text-xs font-semibold text-gray-800">{customerProfileFieldGroups[0].title}</p>
                        <span className="text-[10px] text-gray-400">
                          {profile.basicFields.filter((field) => field.value).length}/{profile.basicFields.length}
                        </span>
                      </div>
                      <dl className="grid gap-2">
                        {profile.basicFields.map((field) => {
                          const href = field.key === 'googleFolderUrl' && field.value ? toHttpUrl(field.value) : null
                          return (
                            <div key={field.key} className={`rounded-md border bg-white px-2.5 py-2 ${
                              field.missing ? 'border-amber-200 ring-1 ring-amber-100' : 'border-gray-100'
                            }`}>
                              <dt className="text-[10px] font-semibold text-gray-400">{field.label}</dt>
                              <dd className={field.value ? 'mt-0.5 break-words text-sm font-medium text-gray-800' : 'mt-0.5 text-sm font-semibold text-amber-600'}>
                                {href ? (
                                  <a href={href} target="_blank" rel="noreferrer" className="text-blue-600 underline-offset-2 hover:underline">
                                    {field.value}
                                  </a>
                                ) : (
                                  field.value || (field.required ? '未入力' : '-')
                                )}
                              </dd>
                            </div>
                          )
                        })}
                      </dl>
                    </section>

                    <section className="rounded-lg border border-gray-100 bg-gray-50/70 p-3">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <p className="text-xs font-semibold text-gray-800">{customerProfileFieldGroups[1].title}</p>
                        <span className="text-[10px] text-gray-400">{profile.operationContracts.length}店舗</span>
                      </div>
                      <div className="space-y-2">
                        {profile.operationContracts.map((contract, index) => (
                          <div key={index} className="rounded-md border border-gray-100 bg-white px-2.5 py-2">
                            <p className="mb-1 text-[11px] font-semibold text-gray-700">店舗 {index + 1}</p>
                            <dl className="grid gap-1.5">
                              {customerOperationContractFieldDefinitions.map((field) => {
                                const key = field.key as CustomerOperationContractFieldKey
                                const value = contract[key]
                                return (
                                  <div key={field.key}>
                                    <dt className="text-[10px] font-semibold text-gray-400">{field.label}</dt>
                                    <dd className={value ? 'break-words text-xs font-medium text-gray-800' : 'text-xs text-gray-400'}>
                                      {value || '-'}
                                    </dd>
                                  </div>
                                )
                              })}
                            </dl>
                          </div>
                        ))}
                      </div>
                    </section>
                  </div>
                )}
              </div>
            )}

            {/* Rich Menu */}
            <div className="p-4">
              <h4 className="text-[11px] font-medium text-gray-500 mb-1.5">リッチメニュー</h4>
              {richMenu.kind === 'loading' ? (
                <p className="text-[11px] text-gray-400 italic">読み込み中...</p>
              ) : richMenu.kind === 'error' ? (
                <p className="text-[11px] text-red-500 italic">取得に失敗しました</p>
              ) : richMenu.id === null ? (
                <p className="text-[11px] text-gray-400 italic">未設定</p>
              ) : (
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs text-gray-700">{richMenu.name ?? '(名前なし)'}</span>
                  {richMenu.isDefault && (
                    <span className="px-1.5 py-0 rounded text-[10px] font-medium bg-gray-100 text-gray-500">
                      デフォルト
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* Metadata custom fields */}
            {extraMetadataEntries.length > 0 && (
              <div className="p-4">
                <h4 className="text-[11px] font-medium text-gray-500 mb-2">その他の顧客情報</h4>
                <dl className="space-y-2 text-xs">
                  {extraMetadataEntries.map(([key, value]) => (
                    <div key={key}>
                      <dt className="text-[10px] text-gray-400 uppercase tracking-wide">{key}</dt>
                      <dd className="text-gray-700 mt-0.5 whitespace-pre-wrap break-words">{renderValue(value)}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}

            {/*
              編集導線は将来追加予定 (現在の /friends は ?id= をハンドルしないため、
              リンク先が機能しない → Codex review で指摘済 → 代わりに削除。
              編集 UI が出来たら復活させる)。
            */}
          </div>
        ) : (
          <div className="p-4 text-xs text-gray-400">顧客情報がありません</div>
        )}
      </div>
    </div>
  )
}

'use client'

import type { FriendListItem } from '@/lib/api'
import { customerProfileFromMetadata } from '@/lib/customer-profile'
import TagBadge from './tag-badge'

interface Props {
  friend: FriendListItem
  expanded?: boolean
  onEditClick?: () => void
}

export default function FriendListRow({ friend, expanded = false, onEditClick }: Props) {
  const customerProfile = customerProfileFromMetadata(friend.metadata)
  const displayName = customerProfile.displayName || friend.displayName || '名前なし'
  const missingCount = customerProfile.missingRequiredFields.length
  const isFollowing = friend.isFollowing

  return (
    <div className="grid gap-3 border-b border-slate-100 px-4 py-4 transition-colors hover:bg-slate-50/70 lg:grid-cols-[260px_1fr_160px]">
      <div className="flex items-start gap-3">
        {friend.pictureUrl ? (
          <img
            src={friend.pictureUrl}
            alt={displayName}
            className="h-10 w-10 shrink-0 rounded-full bg-slate-100 object-cover"
          />
        ) : (
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-200 text-sm font-semibold text-slate-500">
            {displayName.charAt(0)}
          </div>
        )}
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-slate-950">{displayName}</p>
          <p className="mt-0.5 text-xs text-slate-400">登録 {formatJstDate(friend.createdAt)}</p>
          {!isFollowing && (
            <span className="mt-1 inline-flex rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-700">
              ブロック / 退会
            </span>
          )}
        </div>
      </div>

      <div className={`rounded-xl border px-3 py-2 ${
        missingCount > 0 ? 'border-amber-300 bg-amber-50' : 'border-slate-200 bg-white'
      }`}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-slate-500">基本情報</span>
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
            missingCount > 0 ? 'bg-amber-100 text-amber-800' : 'bg-emerald-50 text-emerald-700'
          }`}>
            {customerProfile.completionLabel}
          </span>
        </div>
        {customerProfile.primaryLine || customerProfile.secondaryLine ? (
          <div className="mt-2 space-y-1">
            {customerProfile.primaryLine && (
              <p className="truncate text-sm font-medium text-slate-800" title={customerProfile.primaryLine}>
                {customerProfile.primaryLine}
              </p>
            )}
            {customerProfile.secondaryLine && (
              <p className="truncate text-xs text-slate-500" title={customerProfile.secondaryLine}>
                {customerProfile.secondaryLine}
              </p>
            )}
          </div>
        ) : (
          <p className="mt-2 text-sm text-amber-800">顧客情報が未入力です</p>
        )}
        {missingCount > 0 && (
          <p className="mt-2 text-xs leading-5 text-amber-800">
            未入力: {customerProfile.missingRequiredFields.map((field) => field.label).join('、')}
          </p>
        )}
        {friend.tags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {friend.tags.slice(0, 4).map((tag) => <TagBadge key={tag.id} tag={tag} />)}
            {friend.tags.length > 4 && (
              <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
                +{friend.tags.length - 4}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="flex items-start justify-end">
        {onEditClick && (
          <button
            type="button"
            onClick={onEditClick}
            className={`rounded-lg border px-3 py-2 text-sm font-semibold transition-colors ${
              expanded
                ? 'border-slate-950 bg-slate-950 text-white'
                : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
            }`}
            aria-expanded={expanded}
          >
            {expanded ? '閉じる' : '編集'}
          </button>
        )}
      </div>
    </div>
  )
}

function formatJstDate(iso: string): string {
  return iso.slice(0, 10).replace(/-/g, '/')
}

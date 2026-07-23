'use client'

import React from 'react'

type MentionTextProps = {
  text: string
  mentions?: string[]
  className?: string
}

type MentionPart = {
  text: string
  mention: boolean
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function splitMentionText(text: string, mentions: string[] = []): MentionPart[] {
  const knownMentions = Array.from(new Set(mentions.map((name) => name.trim()).filter(Boolean)))
    .sort((a, b) => b.length - a.length)
  const knownPattern = knownMentions.map((name) => `@${escapeRegExp(name)}`).join('|')
  const fallbackPattern = '@[^\\s@,、。:：;；()[\\]{}]+'
  const mentionTokenPattern = new RegExp(
    knownPattern ? `${knownPattern}|${fallbackPattern}` : fallbackPattern,
    'gu',
  )
  const parts: MentionPart[] = []
  let cursor = 0

  for (const match of text.matchAll(mentionTokenPattern)) {
    const token = match[0]
    const index = match.index ?? 0
    if (index > cursor) parts.push({ text: text.slice(cursor, index), mention: false })
    const name = token.slice(1).trim()
    parts.push({
      text: token,
      mention: knownMentions.length === 0 || knownMentions.includes(name),
    })
    cursor = index + token.length
  }

  if (cursor < text.length) parts.push({ text: text.slice(cursor), mention: false })
  return parts
}

export default function MentionText({ text, mentions = [], className }: MentionTextProps) {
  const parts = splitMentionText(text, mentions)

  return (
    <span className={className}>
      {parts.map((part, index) => part.mention ? (
        <span
          key={`${part.text}-${index}`}
          className="rounded bg-blue-100 px-1 font-bold text-blue-700 ring-1 ring-inset ring-blue-200"
        >
          {part.text}
        </span>
      ) : (
        <span key={`${part.text}-${index}`}>{part.text}</span>
      ))}
    </span>
  )
}

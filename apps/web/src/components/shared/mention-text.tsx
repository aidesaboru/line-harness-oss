'use client'

type MentionTextProps = {
  text: string
  mentions?: string[]
  className?: string
}

const mentionTokenPattern = /(@[^\s@,、。:：;；()[\]{}]+)/gu

function shouldHighlight(token: string, mentions: string[]): boolean {
  const name = token.slice(1).trim()
  if (!name) return false
  if (mentions.length === 0) return true
  return mentions.includes(name)
}

export default function MentionText({ text, mentions = [], className }: MentionTextProps) {
  const parts: Array<{ text: string; mention: boolean }> = []
  let cursor = 0

  for (const match of text.matchAll(mentionTokenPattern)) {
    const token = match[0]
    const index = match.index ?? 0
    if (index > cursor) parts.push({ text: text.slice(cursor, index), mention: false })
    parts.push({ text: token, mention: shouldHighlight(token, mentions) })
    cursor = index + token.length
  }

  if (cursor < text.length) parts.push({ text: text.slice(cursor), mention: false })

  return (
    <span className={className}>
      {parts.map((part, index) => part.mention ? (
        <span
          key={`${part.text}-${index}`}
          className="rounded bg-sky-100 px-1 font-bold text-sky-700"
        >
          {part.text}
        </span>
      ) : (
        <span key={`${part.text}-${index}`}>{part.text}</span>
      ))}
    </span>
  )
}

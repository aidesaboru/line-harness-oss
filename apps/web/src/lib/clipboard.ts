export type CopyTextResult = {
  ok: boolean
  method: 'clipboard' | 'fallback' | null
}

export type CopyTextEnv = {
  navigator?: Pick<Navigator, 'clipboard'>
  document?: Document
}

function runtimeNavigator(): Pick<Navigator, 'clipboard'> | undefined {
  return typeof navigator === 'undefined' ? undefined : navigator
}

function runtimeDocument(): Document | undefined {
  return typeof document === 'undefined' ? undefined : document
}

function fallbackCopyText(text: string, doc: Document | undefined): boolean {
  if (!doc?.body || typeof doc.execCommand !== 'function') return false

  const textarea = doc.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.top = '-9999px'
  textarea.style.left = '-9999px'
  textarea.style.opacity = '0'

  doc.body.appendChild(textarea)
  try {
    textarea.focus()
    textarea.select()
    return doc.execCommand('copy')
  } catch {
    return false
  } finally {
    textarea.remove()
  }
}

export async function copyText(text: string, env: CopyTextEnv = {}): Promise<CopyTextResult> {
  if (!text) return { ok: false, method: null }

  const nav = env.navigator ?? runtimeNavigator()
  const doc = env.document ?? runtimeDocument()

  try {
    if (typeof nav?.clipboard?.writeText === 'function') {
      await nav.clipboard.writeText(text)
      return { ok: true, method: 'clipboard' }
    }
  } catch {
    // Continue to the textarea fallback. Some browsers expose clipboard but
    // reject it outside secure contexts or without a user gesture.
  }

  if (fallbackCopyText(text, doc)) return { ok: true, method: 'fallback' }
  return { ok: false, method: null }
}

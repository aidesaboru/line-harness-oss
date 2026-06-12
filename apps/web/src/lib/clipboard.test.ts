import { describe, expect, it, vi } from 'vitest'
import { copyText } from './clipboard'

function fakeDocument(execResult = true) {
  let textarea: {
    value: string
    style: Record<string, string>
    setAttribute: ReturnType<typeof vi.fn>
    focus: ReturnType<typeof vi.fn>
    select: ReturnType<typeof vi.fn>
    remove: ReturnType<typeof vi.fn>
  } | null = null
  const appended: unknown[] = []
  const body = {
    appendChild: vi.fn((element: unknown) => {
      appended.push(element)
      return element
    }),
  }
  const doc = {
    body,
    createElement: vi.fn(() => {
      textarea = {
        value: '',
        style: {},
        setAttribute: vi.fn(),
        focus: vi.fn(),
        select: vi.fn(),
        remove: vi.fn(() => {
          appended.pop()
        }),
      }
      return textarea
    }),
    execCommand: vi.fn(() => execResult),
  } as unknown as Document

  return {
    doc,
    body,
    get textarea() {
      return textarea
    },
    appended,
    execCommand: doc.execCommand as unknown as ReturnType<typeof vi.fn>,
  }
}

describe('copyText', () => {
  it('uses the async Clipboard API when available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)

    await expect(copyText('共有文', {
      navigator: { clipboard: { writeText } } as unknown as Navigator,
    })).resolves.toEqual({ ok: true, method: 'clipboard' })

    expect(writeText).toHaveBeenCalledWith('共有文')
  })

  it('falls back to a temporary textarea when Clipboard API is unavailable', async () => {
    const fake = fakeDocument(true)

    const result = await copyText('返信案', { document: fake.doc })

    expect(result).toEqual({ ok: true, method: 'fallback' })
    expect(fake.body.appendChild).toHaveBeenCalledTimes(1)
    expect(fake.textarea?.value).toBe('返信案')
    expect(fake.textarea?.focus).toHaveBeenCalled()
    expect(fake.textarea?.select).toHaveBeenCalled()
    expect(fake.execCommand).toHaveBeenCalledWith('copy')
    expect(fake.textarea?.remove).toHaveBeenCalled()
    expect(fake.appended).toHaveLength(0)
  })

  it('falls back when Clipboard API rejects the copy', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    const { doc } = fakeDocument(true)

    await expect(copyText('再送文', {
      navigator: { clipboard: { writeText } } as unknown as Navigator,
      document: doc,
    })).resolves.toEqual({ ok: true, method: 'fallback' })
  })

  it('reports failure when no copy mechanism is available', async () => {
    await expect(copyText('共有文', {})).resolves.toEqual({ ok: false, method: null })
    await expect(copyText('', {
      navigator: { clipboard: { writeText: vi.fn() } } as unknown as Navigator,
    })).resolves.toEqual({ ok: false, method: null })
  })
})

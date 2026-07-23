import { describe, expect, test } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import MentionText, { splitMentionText } from './mention-text'

describe('splitMentionText', () => {
  test('keeps a staff name containing a space as one highlighted mention', () => {
    expect(splitMentionText(
      '@宮本 森一 ご確認をお願いします',
      ['宮本 森一'],
    )).toEqual([
      { text: '@宮本 森一', mention: true },
      { text: ' ご確認をお願いします', mention: false },
    ])
  })

  test('highlights only registered mentions when metadata is available', () => {
    expect(splitMentionText(
      '@宮本 森一 から @未登録 へ共有',
      ['宮本 森一'],
    )).toEqual([
      { text: '@宮本 森一', mention: true },
      { text: ' から ', mention: false },
      { text: '@未登録', mention: false },
      { text: ' へ共有', mention: false },
    ])
  })

  test('continues to highlight a plain mention when legacy metadata is empty', () => {
    expect(splitMentionText('@梶原 確認お願いします')).toEqual([
      { text: '@梶原', mention: true },
      { text: ' 確認お願いします', mention: false },
    ])
  })

  test('renders a known mention with explicit blue emphasis', () => {
    const markup = renderToStaticMarkup(createElement(MentionText, {
      text: '@宮本 森一 ご確認をお願いします',
      mentions: ['宮本 森一'],
    }))

    expect(markup).toContain('bg-blue-100')
    expect(markup).toContain('text-blue-700')
    expect(markup).toContain('@宮本 森一</span>')
  })
})

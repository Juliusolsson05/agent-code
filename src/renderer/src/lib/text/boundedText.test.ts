import { describe, expect, it } from 'vitest'

import {
  boundedTextLineCount,
  boundedTextPage,
  collapsedTextPreview,
  countTextLines,
  exceedsInlineTextBudget,
} from './boundedText'

describe('bounded text admission', () => {
  it('caps a page by both characters and lines', () => {
    const source = Array.from({ length: 20 }, (_, index) => `line-${index}`).join('\n')
    const page = boundedTextPage(source, 0, 1_000, 3)

    expect(page.text).toBe('line-0\nline-1\nline-2\n')
    expect(page.hasNext).toBe(true)
    expect(page.end).toBe(page.text.length)
  })

  it('keeps the collapsed preview far below the inline parser budget', () => {
    const source = `${'x'.repeat(20_000)}\nend`
    const preview = collapsedTextPreview(source)

    expect(exceedsInlineTextBudget(source)).toBe(true)
    expect(preview.text.length).toBeLessThanOrEqual(2 * 1024)
    expect(preview.hasNext).toBe(true)
  })

  it('counts lines without changing empty-string semantics', () => {
    expect(countTextLines('')).toBe(0)
    expect(countTextLines('one')).toBe(1)
    expect(countTextLines('one\ntwo\n')).toBe(3)
  })

  it('keeps UTF-16 surrogate pairs and CRLF sequences on one page', () => {
    const emojiSource = 'a😀b'
    const emojiFirst = boundedTextPage(emojiSource, 0, 2, 10)
    const emojiSecond = boundedTextPage(emojiSource, emojiFirst.end, 2, 10)
    expect(emojiFirst.text).toBe('a')
    expect(emojiSecond.text).toBe('😀')

    const crlfSource = 'a\r\nb'
    const crlfFirst = boundedTextPage(crlfSource, 0, 2, 10)
    const crlfSecond = boundedTextPage(crlfSource, crlfFirst.end, 2, 10)
    expect(crlfFirst.text).toBe('a')
    expect(crlfSecond.text).toBe('\r\n')
  })

  it('reports a lower bound instead of scanning hidden output forever', () => {
    expect(boundedTextLineCount('one\ntwo', 10, 100)).toEqual({
      count: 2,
      truncated: false,
    })
    expect(boundedTextLineCount('one\ntwo\nthree', 2, 100)).toEqual({
      count: 2,
      truncated: true,
    })
    expect(boundedTextLineCount('x'.repeat(1_000), 10, 20)).toEqual({
      count: 1,
      truncated: true,
    })
  })
})

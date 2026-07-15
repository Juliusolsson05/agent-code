import { describe, expect, it } from 'vitest'

import {
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
})

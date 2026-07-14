import { describe, expect, it } from 'vitest'

import {
  countFenceMarkers,
  lastClosedCodeFenceEnd,
  splitStreamingCodeFence,
} from './helpers'

describe('streaming backtick fence scanning', () => {
  it('keeps shorter backtick runs inside a four-backtick fence as code', () => {
    const text = [
      'before',
      '````md',
      '```js',
      'inside',
      '```',
      'after',
    ].join('\n')

    expect(countFenceMarkers(text)).toBe(1)
    expect(lastClosedCodeFenceEnd(text)).toBe(0)
    expect(splitStreamingCodeFence(text)).toEqual({
      prose: 'before',
      language: 'md',
      code: ['```js', 'inside', '```', 'after'].join('\n'),
    })
  })

  it('closes a fence only with a run at least as long as its opener', () => {
    const text = ['````md', '```', 'still code', '````', 'tail'].join('\n')
    const expectedEnd = text.indexOf('tail')

    expect(countFenceMarkers(text)).toBe(2)
    expect(lastClosedCodeFenceEnd(text)).toBe(expectedEnd)
    expect(splitStreamingCodeFence(text)).toBeNull()
  })

  it('does not treat inline triple-backtick code as a block fence', () => {
    const text = 'Use ```const answer = 42``` in the explanation.'

    expect(countFenceMarkers(text)).toBe(0)
    expect(lastClosedCodeFenceEnd(text)).toBe(0)
    expect(splitStreamingCodeFence(text)).toBeNull()
  })
})

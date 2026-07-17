import { describe, expect, it } from 'vitest'

import { toolResultContentText } from '@providers/shared/renderer/rows/toolResultContent'

describe('toolResultContentText', () => {
  it('preserves string identity and joins provider text blocks', () => {
    const source = 'large output'
    expect(toolResultContentText(source)).toBe(source)
    expect(toolResultContentText([
      { type: 'text', text: 'one' },
      { type: 'text', text: 'two' },
    ])).toBe('one\ntwo')
  })

  it('keeps unknown structured blocks inspectable instead of erasing them', () => {
    expect(toolResultContentText([{ type: 'future_block', value: 3 }] as never)).toContain('future_block')
  })
})

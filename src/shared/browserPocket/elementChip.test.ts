import { describe, expect, it } from 'vitest'

import { formatElementChip, insertAtCaret } from './elementChip'

describe('formatElementChip', () => {
  it('escapes quotes, angle brackets and newlines so the tag stays one parseable line', () => {
    expect(formatElementChip({ url: 'http://localhost:3000/login?a=1&b=2', selector: 'form > button', role: 'button', name: 'Sign "in"\n<now>', width: 320.4, height: 44 }))
      .toBe('<browser-element url="http://localhost:3000/login?a=1&amp;b=2" selector="form > button" role="button" name="Sign &quot;in&quot; &lt;now>" size="320×44" />')
  })
})

describe('insertAtCaret', () => {
  it('inserts at the caret with single-space padding, not at the end', () => {
    expect(insertAtCaret('fix this please', 8, '<c/>')).toEqual({ text: 'fix this <c/> please', caret: 13 })
  })
  it('does not double spaces that are already there', () => {
    expect(insertAtCaret('fix this  please', 9, '<c/>').text).toBe('fix this <c/> please')
  })
  it('appends when there is no caret, and handles an empty draft', () => {
    expect(insertAtCaret('abc', null, '<c/>').text).toBe('abc <c/>')
    expect(insertAtCaret('', 0, '<c/>')).toEqual({ text: '<c/>', caret: 4 })
  })
})

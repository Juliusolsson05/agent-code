import { describe, expect, it } from 'vitest'

import { draftAfterAcceptance, imagesAfterAcceptance } from './promptDeliveryDraft'

describe('draftAfterAcceptance', () => {
  it('clears the unchanged submitted snapshot', () => {
    expect(draftAfterAcceptance('first', 'first')).toBe('')
  })

  it('keeps text a non-textarea writer appended during the send, without the sent prompt', () => {
    // Dictation appends to draftInput while the textarea is locked. Those
    // words belong to the next prompt; the sent one must not come back.
    expect(draftAfterAcceptance('fix the build\n\nand add a test', 'fix the build')).toBe('and add a test')
  })

  it('keeps text a writer prepended during the send, without the sent prompt', () => {
    // Reply-to-selection prepends a quote.
    expect(draftAfterAcceptance('> quoted line\n\nfix the build', 'fix the build')).toBe('> quoted line')
  })

  it('keeps an unrelated draft untouched rather than guessing at an edit', () => {
    expect(draftAfterAcceptance('my next prompt', 'first')).toBe('my next prompt')
  })
})

describe('imagesAfterAcceptance', () => {
  it('removes only submitted images and preserves attachments for the next draft', () => {
    const next = imagesAfterAcceptance(
      [{ id: 'submitted' }, { id: 'next' }],
      new Set(['submitted']),
    )
    expect(next).toEqual([{ id: 'next' }])
  })
})

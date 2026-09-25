import { describe, expect, it } from 'vitest'

import { draftAfterFailure, imagesAfterFailure } from './promptDeliveryDraft'

describe('draftAfterFailure', () => {
  it('restores the failed prompt into an empty composer', () => {
    expect(draftAfterFailure('', 'fix the build')).toBe('fix the build')
    expect(draftAfterFailure('  \n', 'fix the build')).toBe('fix the build')
  })

  it('keeps text that a non-textarea writer inserted during the send, after the failed prompt', () => {
    // Dictation or a template can write draftInput while the textarea is
    // locked. Losing either side would silently destroy user text.
    expect(draftAfterFailure('and add a test', 'fix the build')).toBe(
      'fix the build\n\nand add a test',
    )
  })

  it('does not double a prompt that is somehow still in the draft', () => {
    expect(draftAfterFailure('fix the build', 'fix the build')).toBe('fix the build')
  })
})

describe('imagesAfterFailure', () => {
  it('puts submitted images back ahead of images added during the send', () => {
    expect(imagesAfterFailure([{ id: 'later' }], [{ id: 'a' }, { id: 'b' }])).toEqual([
      { id: 'a' },
      { id: 'b' },
      { id: 'later' },
    ])
  })

  it('does not duplicate an image id that is already in the draft', () => {
    expect(imagesAfterFailure([{ id: 'a' }], [{ id: 'a' }])).toEqual([{ id: 'a' }])
  })

  it('returns the current array untouched when nothing was submitted', () => {
    const current = [{ id: 'x' }]
    expect(imagesAfterFailure(current, [])).toBe(current)
  })
})

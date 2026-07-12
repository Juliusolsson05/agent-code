import { describe, expect, it } from 'vitest'

import { draftAfterAcceptance, imagesAfterAcceptance } from './promptDeliveryDraft'

describe('draftAfterAcceptance', () => {
  it('clears the unchanged submitted snapshot', () => {
    expect(draftAfterAcceptance('first', 'first')).toBe('')
  })

  it('preserves a next draft typed while acknowledgement was pending', () => {
    expect(draftAfterAcceptance('my next prompt', 'first')).toBe('my next prompt')
  })

  it('removes only submitted images and preserves attachments for the next draft', () => {
    const next = imagesAfterAcceptance(
      [{ id: 'submitted' }, { id: 'next' }],
      new Set(['submitted']),
    )
    expect(next).toEqual([{ id: 'next' }])
  })
})

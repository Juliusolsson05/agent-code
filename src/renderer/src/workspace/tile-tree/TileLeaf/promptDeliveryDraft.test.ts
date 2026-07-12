import { describe, expect, it } from 'vitest'

import { draftAfterAcceptance } from './promptDeliveryDraft'

describe('draftAfterAcceptance', () => {
  it('clears the unchanged submitted snapshot', () => {
    expect(draftAfterAcceptance('first', 'first')).toBe('')
  })

  it('preserves a next draft typed while acknowledgement was pending', () => {
    expect(draftAfterAcceptance('my next prompt', 'first')).toBe('my next prompt')
  })
})

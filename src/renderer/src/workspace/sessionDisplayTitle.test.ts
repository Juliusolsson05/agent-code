import { describe, expect, it } from 'vitest'

import { cwdBasename, sessionDisplayTitle } from './sessionDisplayTitle'

// One rule for "what do we call an untitled session" (#865). Before this, a
// dozen copies disagreed: folder name here, raw session UUID in the close
// dialog, `kind · folder` in the buried picker.
describe('sessionDisplayTitle', () => {
  it('prefers the explicit title, then the live folder, then the spawn folder', () => {
    expect(sessionDisplayTitle({ title: ' Review ', cwd: '/work/api' }, '/work/web')).toBe('Review')
    expect(sessionDisplayTitle({ cwd: '/work/api' }, '/work/web')).toBe('web')
    expect(sessionDisplayTitle({ cwd: '/work/api/' })).toBe('api')
  })

  it('falls back to the raw cwd when there is no folder segment', () => {
    expect(sessionDisplayTitle({ cwd: '/' })).toBe('/')
    expect(cwdBasename('')).toBe('')
  })
})

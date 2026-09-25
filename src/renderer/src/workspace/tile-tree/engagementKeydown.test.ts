import { describe, expect, it } from 'vitest'

import { isEngagementKeydown } from './engagementKeydown'

// PR #1176 review: arrowing OUT of a terminal pane cleared the marker of the
// pane being left, because its keydown capture handler counted every key.
// Option+Arrow reaches the pane as two keydowns: the bare Alt, then the Arrow,
// which the workspace router has already preventDefault-ed.

describe('isEngagementKeydown', () => {
  it('ignores a key the workspace router already consumed (pane navigation)', () => {
    expect(isEngagementKeydown({ key: 'ArrowRight', defaultPrevented: true })).toBe(false)
  })

  it('ignores a bare modifier, such as the Alt of Option+Arrow', () => {
    for (const key of ['Alt', 'Meta', 'Control', 'Shift']) {
      expect(isEngagementKeydown({ key, defaultPrevented: false })).toBe(false)
    }
  })

  it('counts real typing and unconsumed keys the terminal will receive', () => {
    expect(isEngagementKeydown({ key: 'a', defaultPrevented: false })).toBe(true)
    expect(isEngagementKeydown({ key: 'Enter', defaultPrevented: false })).toBe(true)
    // An arrow the router did NOT take goes to the TUI: that's engagement.
    expect(isEngagementKeydown({ key: 'ArrowUp', defaultPrevented: false })).toBe(true)
  })
})

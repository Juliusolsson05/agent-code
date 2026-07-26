import { describe, expect, it } from 'vitest'

import {
  describeCommandState,
  panel,
  status,
  toggle,
  value,
} from '@renderer/features/command-palette/commandState'
import { builtInCommandCatalog } from '@renderer/features/command-palette/catalog'

// ---------------------------------------------------------------------------
// Phase 6: semantic command state.
//
// The old `{label, tone}` rendered a boolean, a selected value, contextual
// information, an unsupported capability and async progress through one
// identical chip. These assert that the six concrete defects the audit named
// can no longer be expressed.
// ---------------------------------------------------------------------------

describe('tone is derived, never authored', () => {
  it('has no tone field on the state type itself', () => {
    // The structural guarantee. A caller physically cannot colour a state
    // independently of what it means, so colour and meaning cannot drift.
    expect('tone' in toggle(true)).toBe(false)
    expect('tone' in value('Claude')).toBe(false)
    expect('tone' in status('error', 'x')).toBe(false)
  })

  it('colours an on-toggle accent and an off-toggle neutral', () => {
    expect(describeCommandState(toggle(true)).tone).toBe('accent')
    expect(describeCommandState(toggle(false)).tone).toBe('neutral')
  })

  it('always colours a context value neutral', () => {
    // Provider badges on Reload/Switch/Copy Resume are context, not enabled
    // state. Accent tone made them read as live toggles.
    expect(describeCommandState(value('Claude')).tone).toBe('neutral')
    expect(describeCommandState(value('Codex', {})).tone).toBe('neutral')
  })
})

describe('vocabularies', () => {
  it('renders panels as Open/Closed and capabilities as On/Off', () => {
    // The audit found panels split between both with no rule.
    expect(describeCommandState(panel(true)).label).toBe('Open')
    expect(describeCommandState(panel(false)).label).toBe('Closed')
    expect(describeCommandState(toggle(true)).label).toBe('On')
    expect(describeCommandState(toggle(false)).label).toBe('Off')
  })
})

describe('states this command cannot change', () => {
  it('carries the explanation for a state this command cannot change', () => {
    // Tail's motivating case: auto-follow is on because Tail All turned it on,
    // and invoking Tail cannot turn it off. The old flat "On (all)" label went
    // through the same chip as a plain On and explained nothing. `detail` is
    // what conveys it — a parallel `truth: 'effective'` marker was carried for
    // a while and no surface ever read it.
    const state = toggle(true, { detail: 'On via Auto-follow All Visible Agents' })
    expect(state).toMatchObject({ kind: 'toggle', value: 'on' })
    expect(describeCommandState(state).detail).toBe('On via Auto-follow All Visible Agents')
  })

  it('renders mixed as accent, not as off', () => {
    // Mixed means SOMETHING is on. Rendering it like off would tell the user
    // the opposite of what is happening.
    expect(describeCommandState(toggle('mixed')).tone).toBe('accent')
    expect(describeCommandState(toggle('mixed')).label).toBe('Mixed')
  })
})

describe('status is first-class', () => {
  it('models unavailable as a status rather than a value that reads Unavailable', () => {
    // Caffeinate's case. As a plain label it looked identical to "off" and the
    // command stayed fully executable.
    const state = status('unavailable', 'caffeinate is only available on macOS')
    const presented = describeCommandState(state)
    expect(presented.label).toBe('Unavailable')
    expect(presented.muted).toBe(true)
    expect(presented.detail).toContain('macOS')
  })

  it('mutes loading and colours error', () => {
    expect(describeCommandState(status('loading', 'reloading')).muted).toBe(true)
    expect(describeCommandState(status('error', 'kill failed')).tone).toBe('danger')
    // An error is actionable, so it is NOT muted — the user should be able to
    // retry the row that failed.
    expect(describeCommandState(status('error', 'kill failed')).muted).toBe(false)
  })
})

describe('catalog migration', () => {
  it('leaves no command returning a legacy {label, tone} state', () => {
    // Every getState now returns a discriminated variant. A stray legacy object
    // would render with no kind and fall through the badge switch.
    for (const command of builtInCommandCatalog) {
      const source = command.getState?.toString() ?? ''
      expect(source).not.toMatch(/tone:\s*'(neutral|accent|danger)'/)
    }
  })
})

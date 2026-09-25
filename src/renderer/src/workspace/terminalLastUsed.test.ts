import { describe, expect, it } from 'vitest'

import type { WorkspaceState } from '@renderer/workspace/types'

import {
  TERMINAL_LAST_USED_RESOLUTION_MS,
  terminalLastUsedAt,
  withTerminalLastUsed,
  withTerminalLastUsedFloor,
} from './terminalLastUsed'

// The durable last-used record (#1178). What matters is what NEVER moves it:
// a restart, another session kind, a keystroke inside the resolution window,
// and a clock that stepped backwards. Each of those returning the same state
// object is also what keeps typing from scheduling a workspace write per key.

function state(lastUsedAt?: number, kind: 'terminal' | 'claude' = 'terminal'): WorkspaceState {
  return {
    tabs: [{ id: 'tab', title: 'project' }],
    activeTabId: 'tab',
    stage: { lanes: [{}], rows: [{ length: 1 }], focusedLane: 0 },
    pinnedSessionIds: [],
    sessions: { shell: { cwd: '/w', kind, projectId: 'tab', joinedAt: 0, ...(lastUsedAt === undefined ? {} : { lastUsedAt }) } },
  } as WorkspaceState
}

describe('withTerminalLastUsed', () => {
  it('records a use on a terminal with no record', () => {
    expect(withTerminalLastUsed(state(), 'shell', 5_000).sessions.shell!.lastUsedAt).toBe(5_000)
  })

  it('returns the same state inside the resolution window, so typing does not autosave per key', () => {
    const before = state(10_000)
    expect(withTerminalLastUsed(before, 'shell', 10_000 + TERMINAL_LAST_USED_RESOLUTION_MS - 1)).toBe(before)
    expect(withTerminalLastUsed(before, 'shell', 10_000 + TERMINAL_LAST_USED_RESOLUTION_MS).sessions.shell!.lastUsedAt)
      .toBe(10_000 + TERMINAL_LAST_USED_RESOLUTION_MS)
  })

  it('never moves backwards when the clock does', () => {
    const before = state(1_000_000)
    expect(withTerminalLastUsed(before, 'shell', 1)).toBe(before)
  })

  it('ignores agents and sessions that are gone', () => {
    const agent = state(undefined, 'claude')
    expect(withTerminalLastUsed(agent, 'shell', 5_000)).toBe(agent)
    expect(withTerminalLastUsed(agent, 'missing', 5_000)).toBe(agent)
  })
})

describe('withTerminalLastUsedFloor', () => {
  it('gives a record-less terminal a floor, and never moves an existing record', () => {
    expect(withTerminalLastUsedFloor(state(), 'shell', 7_000).sessions.shell!.lastUsedAt).toBe(7_000)
    // Three days old, then a restart: the floor must not refresh it, or the
    // shell would look freshly used again — the bug this exists to fix.
    const old = state(1_000)
    expect(withTerminalLastUsedFloor(old, 'shell', 999_999_999)).toBe(old)
  })
})

it('reads a missing or malformed record as unknown', () => {
  expect(terminalLastUsedAt(undefined)).toBeNull()
  expect(terminalLastUsedAt({})).toBeNull()
  expect(terminalLastUsedAt({ lastUsedAt: Number.NaN })).toBeNull()
})

it('reads the latest the shell can have been used, never the throttled record itself', () => {
  // A use at 59 s after a record at 0 is dropped by the throttle. Reading 0
  // would let a one-minute threshold call that shell old at 60 s (review of
  // #1179); every dropped use is under one resolution after the record.
  const record = withTerminalLastUsed(withTerminalLastUsed(state(), 'shell', 0 + 1), 'shell', 59_000)
  expect(record.sessions.shell!.lastUsedAt).toBe(1)
  expect(terminalLastUsedAt(record.sessions.shell)).toBeGreaterThan(59_000)
})

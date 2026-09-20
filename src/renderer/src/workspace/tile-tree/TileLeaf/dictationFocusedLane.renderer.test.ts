import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  beginDictationHold,
  clearDictationFocusedSession,
  endDictationHold,
  registerDictationTarget,
  setDictationFocusedSession,
} from './dictationHotkeyRegistry'
import type { DictationTargetHandle } from './dictationHotkeyRegistry'

// ---------------------------------------------------------------------------
// #1031 item 3. With no DOM-focused input, the registry picked the most
// RECENTLY focused dictation target anywhere in the workspace. Clear Lane
// (⌥⌫) makes that trivially reachable: clear the lane you are looking at, hold
// Fn, speak — and the words land in a DIFFERENT agent's composer, which may
// then send them.
//
// This drives the real registry: real registration, the real picker, the real
// press/release dispatch. Only the native hotkey IPC is stubbed, because it is
// the process boundary.
// ---------------------------------------------------------------------------

const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
const unregisters: Array<() => void> = []

function target(sessionId: string, overrides: Partial<DictationTargetHandle> = {}) {
  const start = vi.fn()
  const stop = vi.fn()
  const handle: DictationTargetHandle = {
    sessionId,
    enabled: true,
    focused: false,
    lastFocusedAt: 0,
    start,
    stop,
    cancel: vi.fn(),
    isStarting: () => false,
    isActive: () => start.mock.calls.length > stop.mock.calls.length,
    ...overrides,
  }
  unregisters.push(registerDictationTarget(handle))
  return { handle, start, stop }
}

beforeEach(() => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      onDictationHotkeyDown: () => () => {},
      onDictationHotkeyUp: () => () => {},
    },
  })
  clearDictationFocusedSession()
})

afterEach(() => {
  for (const unregister of unregisters.splice(0)) unregister()
  clearDictationFocusedSession()
  if (originalApi) Object.defineProperty(window, 'api', originalApi)
})

describe('dictation follows the focused lane (#1031 item 3)', () => {
  it('does NOT cross into another lane when the focused lane is empty', () => {
    // Exactly the Clear Lane sequence: lane A is cleared and focused, lane B
    // holds the composer the user typed in a moment ago.
    const other = target('lane-b', { lastFocusedAt: Date.now() })
    setDictationFocusedSession(null)

    beginDictationHold('keyboard')
    expect(other.start).not.toHaveBeenCalled()
    endDictationHold()
    expect(other.stop).not.toHaveBeenCalled()
  })

  it('records into the FOCUSED session, not the most recently typed one', () => {
    // The same crossing without Clear Lane: the focused lane's occupant has no
    // DOM focus, but you last typed somewhere else.
    const stale = target('lane-b', { lastFocusedAt: Date.now() })
    const focused = target('lane-a', { lastFocusedAt: 0 })
    setDictationFocusedSession('lane-a')

    beginDictationHold('keyboard')
    expect(focused.start).toHaveBeenCalledTimes(1)
    expect(stale.start).not.toHaveBeenCalled()
  })

  it('refuses when the focused session has no dictation target at all', () => {
    // A hibernated agent, or a pane that does not take dictation. Refusing is
    // the only answer that cannot put the user's words in front of another
    // agent.
    const other = target('lane-b', { lastFocusedAt: Date.now() })
    setDictationFocusedSession('lane-a')

    beginDictationHold('keyboard')
    expect(other.start).not.toHaveBeenCalled()
  })

  it('still lets a DOM-focused input win, whatever the workspace says', () => {
    // If they are typing into a pane, Fn records there, full stop — the
    // takeover surfaces (Spotlight, Reader) rely on this.
    const typing = target('lane-b', { focused: true })
    setDictationFocusedSession('lane-a')

    beginDictationHold('keyboard')
    expect(typing.start).toHaveBeenCalledTimes(1)
  })

  it('keeps the launch fallback while nothing has reported focus yet', () => {
    // The bug this registry was BUILT for: on a fresh launch no input has
    // focus, and without a fallback Fn was a silent no-op until the user
    // clicked a pane. "Nobody has told us yet" must stay distinct from "the
    // focused lane is empty".
    const recent = target('lane-b', { lastFocusedAt: 10 })
    target('lane-c', { lastFocusedAt: 5 })

    beginDictationHold('keyboard')
    expect(recent.start).toHaveBeenCalledTimes(1)
  })

  it('routes the RELEASE to whichever target consumed the press', () => {
    // Focus can move mid-hold; the release must not orphan a recorder.
    const first = target('lane-a')
    setDictationFocusedSession('lane-a')
    beginDictationHold('keyboard')
    expect(first.start).toHaveBeenCalledTimes(1)

    setDictationFocusedSession('lane-b')
    target('lane-b')
    endDictationHold()
    expect(first.stop).toHaveBeenCalledTimes(1)
  })
})

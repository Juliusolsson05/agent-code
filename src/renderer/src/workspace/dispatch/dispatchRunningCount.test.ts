import { describe, expect, it } from 'vitest'

import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import type { SessionId } from '@renderer/workspace/types'
import { countWorkingSessions } from '@renderer/workspace/dispatch/DispatchAgentList'

// #880's acceptance, on the Dispatch half: "a row with no runtime counts as
// not running in BOTH places". Only the shared helper was tested, so a
// mutation replacing this whole condition with `true` — the header reporting
// every session as running — left the entire renderer suite green (#1085
// review, finding 1). The count is the thing the user reads; it needs its own
// assertion.

const working = (over: Partial<SessionRuntime>): SessionRuntime => ({ ...emptyRuntime(), ...over })
const ids = (...values: string[]) => values as SessionId[]

describe('the Dispatch group header count', () => {
  it('does not count a session this renderer has no runtime for', () => {
    // THE BUG: `undefined !== 'idle'` is true, so the header read N running
    // while every row beside it rendered `starting`.
    expect(countWorkingSessions({}, ids('a', 'b'))).toBe(0)
  })

  it('counts only the sessions that are actually working', () => {
    const runtimes = {
      running: working({ sessionStatus: 'running' }),
      streaming: working({ streamPhase: 'requesting' }),
      idle: working({ sessionStatus: 'idle', streamPhase: 'idle' }),
    } as Record<SessionId, SessionRuntime>

    expect(countWorkingSessions(runtimes, ids('running', 'streaming', 'idle'))).toBe(2)
    // And only the ones ASKED for: a header counts its own rows, not the map.
    expect(countWorkingSessions(runtimes, ids('idle'))).toBe(0)
    expect(countWorkingSessions(runtimes, ids())).toBe(0)
  })

  it('counts a mix of observed and unobserved rows correctly', () => {
    const runtimes = { live: working({ sessionStatus: 'running' }) } as Record<SessionId, SessionRuntime>
    expect(countWorkingSessions(runtimes, ids('live', 'missing'))).toBe(1)
  })
})

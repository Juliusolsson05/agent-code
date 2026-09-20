import { describe, expect, it } from 'vitest'

import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import { sessionIsWorking } from '@renderer/session-runtime/working'

// #880. The Dispatch group header's `running/total` count and the worktree
// panel's `live` flag both read
//
//   runtime?.sessionStatus === 'running' || runtime?.streamPhase !== 'idle'
//
// and both counted a session with NO runtime as running, because
// `undefined !== 'idle'`. The row beside the count rendered `starting` from
// the same state, so one session was described two ways at once.
//
// Latent today — spawn and rehydrate always create a runtime, and close
// removes it with the session — which is why it is worth a test rather than a
// bug report: the next path that lists a session before its runtime exists
// would have reintroduced it silently.

const working = (over: Partial<SessionRuntime>): SessionRuntime => ({ ...emptyRuntime(), ...over })

describe('sessionIsWorking', () => {
  it('does not count a session this renderer has no runtime for', () => {
    // THE BUG. Not "false because nothing is running" — false because there is
    // nothing to read. A count must not assert about a session it cannot see.
    expect(sessionIsWorking(undefined)).toBe(false)
  })

  it('counts a session whose canonical status is running', () => {
    expect(sessionIsWorking(working({ sessionStatus: 'running' }))).toBe(true)
  })

  it('counts a session mid-stream before its status settles', () => {
    // The reason `streamPhase` is in the rule at all: a provider mid-turn has
    // a phase first, and a header that ignored it would read `0 running` while
    // panes streamed.
    expect(sessionIsWorking(working({ streamPhase: 'requesting' }))).toBe(true)
  })

  it('does not count an idle session', () => {
    expect(sessionIsWorking(working({ sessionStatus: 'idle', streamPhase: 'idle' }))).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'

import { emptyRuntime } from '@renderer/session-runtime/state'
import { isLimitIdle } from '@renderer/workspace/hook/actions/providerSwitchCore'

// The switch guard's one exception, tested on its own.
//
// WHY this is a separate pure predicate rather than an inline clause in
// `switchAgentProvider`: the modal ALSO needs it (a pane parked on a usage
// limit must not be counted as "mid-turn and will be skipped"), and the two
// answers must agree by construction — a modal that promises to switch an
// agent the core then refuses is worse than no promise at all.
//
// The comparison is against `turnStartedAt`, not against wall-clock age: a
// limit hit that PRECEDES the current turn's start belongs to an earlier,
// already-resolved episode (the user waited out the window and sent another
// prompt), and switching that agent would kill a genuinely running turn.
describe('isLimitIdle', () => {
  it('treats a process still marked active as idle when a limit hit is newer than the last turn start', () => {
    const runtime = {
      ...emptyRuntime(),
      processActive: true,
      turnStartedAt: 1_000,
      limitHit: { at: 2_000, source: 'transcript' as const },
    }
    expect(isLimitIdle(runtime)).toBe(true)
  })

  it('does not override a genuinely running turn', () => {
    const runtime = {
      ...emptyRuntime(),
      processActive: true,
      turnStartedAt: 3_000,
      limitHit: { at: 2_000, source: 'transcript' as const },
    }
    expect(isLimitIdle(runtime)).toBe(false)
  })

  it('is false without a limit signal at all', () => {
    const runtime = { ...emptyRuntime(), processActive: true, turnStartedAt: 3_000 }
    expect(isLimitIdle(runtime)).toBe(false)
  })

  it('accepts a limit hit on a pane that never recorded a turn start', () => {
    // Restored/detached panes replay durable history without ever running the
    // stream-phase machine, so `turnStartedAt` stays null. A transcript-sourced
    // limit hit is the only evidence such a pane can produce, and refusing it
    // would make exactly the panes a usage limit stranded unswitchable.
    const runtime = {
      ...emptyRuntime(),
      processActive: true,
      limitHit: { at: 2_000, source: 'api_error' as const },
    }
    expect(isLimitIdle(runtime)).toBe(true)
  })
})

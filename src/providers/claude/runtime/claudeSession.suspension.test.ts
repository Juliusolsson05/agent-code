import { describe, expect, it, vi } from 'vitest'

import { ClaudeSession } from './claudeSession.js'

// The app half of #1040's sleep-ordering fix.
//
// ClaudeSession waits a minute after a suspension before sealing flows, so a
// stream that survived the sleep is not cut off (#963). But a stream that did
// NOT survive usually reports its own death first — the proxy's `error` hook
// fires seconds after wake — and whichever signal arrives first decides what
// the user is told. The adapter therefore has to learn the suspension instant
// immediately; sealing still happens on the timer.

describe('ClaudeSession.noteSystemSuspension', () => {
  it('tells the proxy adapter the suspension instant before the seal grace', () => {
    const noteSuspension = vi.fn()
    const sealFlowsSilentSince = vi.fn()
    const session = new ClaudeSession()
    ;(session as unknown as { headless: unknown }).headless = {
      proxy: { noteSuspension, sealFlowsSilentSince },
    }

    const suspendedAt = Date.parse('2026-09-20T04:00:00.000Z')
    session.noteSystemSuspension({ suspendedAt, resumedAt: suspendedAt + 60_000, source: 'power-monitor' })

    expect(noteSuspension).toHaveBeenCalledWith(suspendedAt)
    // The seal itself still waits out the grace period.
    expect(sealFlowsSilentSince).not.toHaveBeenCalled()
  })

  it('does nothing when there is no proxy (a session without one still works)', () => {
    const session = new ClaudeSession()
    expect(() => session.noteSystemSuspension({
      suspendedAt: 1, resumedAt: 2, source: 'power-monitor',
    })).not.toThrow()
  })
})

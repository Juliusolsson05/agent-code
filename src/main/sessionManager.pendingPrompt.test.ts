import { describe, expect, it, vi } from 'vitest'

import { SessionManager } from './sessionManager.js'
import type { PromptGateState, PromptReadinessOutcome } from '@shared/types/session.js'

// #854. `create_agent` delivered a child's bootstrap prompt immediately and
// failed if the child was not ready for one yet. The run journal says what
// "not ready yet" actually was, across 11 app runs and 55 recorded bootstrap
// failures:
//
//   26  Claude session … prompt input is blocked by claude.trust-dialog
//   21  Claude session … prompt input is still warming (composer-unpainted)
//    5  Codex session … was not ready for prompt delivery (timeout)
//    3  did not record prompt acceptance
//   …only 5 ever reached the absorption stage at all.
//
// 47 of 55 are states that clear on their own — a human answering a
// first-launch trust dialog in a fresh worktree, or a TUI finishing its first
// paint. The child was fine; the prompt was early. And the failure made it
// worse: `retry-same-session` invited an immediate retry into the same window,
// and it is the SECOND attempt that writes prompt bytes without Enter and
// leaves the orphaned draft that forces the parent to close the child.
//
// These drive the real SessionManager. The gate is the seam: a session exposes
// `awaitReadyForPrompt`, and everything below turns on what it answers.

type GateAnswer = PromptReadinessOutcome

function warming(reason: 'composer-unpainted' | 'replay-pending' = 'composer-unpainted'): GateAnswer {
  return { kind: 'timeout', waitedMs: 2_000, lastState: { kind: 'warming', reason } as Extract<PromptGateState, { kind: 'warming' }> }
}
const blockedByTrustDialog: GateAnswer = { kind: 'blocked', condition: 'claude.trust-dialog', resolvable: true }

/**
 * A Claude-shaped session whose gate answers from a script, and whose composer
 * accepts a prompt the way the real delivery protocol proves it did: the
 * written text appears on screen, then Enter.
 */
function scriptedSession(answers: GateAnswer[]) {
  let screen = '❯'
  const write = vi.fn((data: string) => {
    if (data !== '\r') screen = `❯ ${data}`
  })
  let asked = 0
  return {
    write,
    asked: () => asked,
    isExited: () => false,
    snapshotScreen: () => screen,
    awaitReadyForPrompt: vi.fn(async (): Promise<GateAnswer> => {
      const answer = answers[Math.min(asked, answers.length - 1)]!
      asked += 1
      return answer
    }),
    armPromptAcceptance: () => ({
      promise: Promise.resolve({ kind: 'user' as const, acceptedAt: 123 }),
      cancel: vi.fn(),
    }),
  }
}

/**
 * A session whose gate stays shut until the test opens it — the shape the two
 * dominant recorded failures have (a composer that has not painted, a trust
 * dialog nobody has answered yet), and the only way to control WHEN the wait
 * ends relative to everything else.
 */
function gatedSession() {
  let screen = '❯'
  let open = false
  let asked = 0
  let acceptance: Promise<{ kind: 'user'; acceptedAt: number }> | null = null
  return {
    write: vi.fn((data: string) => { if (data !== '\r') screen = `❯ ${data}` }),
    open: () => { open = true },
    close: () => { open = false },
    asked: () => asked,
    isExited: () => false,
    snapshotScreen: () => screen,
    awaitReadyForPrompt: vi.fn(async (): Promise<GateAnswer> => {
      asked += 1
      return open ? { kind: 'ready', waitedMs: 1 } : warming()
    }),
    armPromptAcceptance: () => ({
      promise: acceptance ?? Promise.resolve({ kind: 'user' as const, acceptedAt: 123 }),
      cancel: vi.fn(),
    }),
    /** Hold the delivery open: the window in which a second waiter can arm. */
    holdAcceptance: () => {
      let settle!: () => void
      acceptance = new Promise(resolve => {
        settle = () => resolve({ kind: 'user' as const, acceptedAt: 123 })
      })
      return settle
    },
  }
}

function managerWith(session: unknown, sessionId = 'child'): SessionManager {
  const manager = new SessionManager()
  // WHY install a structural session: this is about the manager's waiting, not
  // about spawning a provider. A real Claude PTY would make the gate's timing
  // nondeterministic and hide the thing being pinned.
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(sessionId, {
    kind: 'claude', session,
  })
  return manager
}

describe('a bootstrap prompt waits for a child that is not ready YET (#854)', () => {
  it.each([
    { name: 'a composer that has not painted', answers: [warming(), warming(), { kind: 'ready', waitedMs: 1 } as GateAnswer] },
    { name: 'a first-launch trust dialog a human has to answer', answers: [blockedByTrustDialog, blockedByTrustDialog, { kind: 'ready', waitedMs: 1 } as GateAnswer] },
    { name: 'a replay that has not quiesced', answers: [warming('replay-pending'), { kind: 'ready', waitedMs: 1 } as GateAnswer] },
  ])('delivers once the gate opens: $name', async ({ answers }) => {
    const session = scriptedSession(answers)
    const manager = managerWith(session)

    const result = await manager.deliverPromptWhenReady('child', 'the brief')

    expect(result.ok).toBe(true)
    // The prompt is written ONCE, and only after the gate opened. A retry loop
    // that wrote on every attempt is the orphaned-draft bug.
    expect(session.write.mock.calls.map(([data]) => data)).toEqual(['the brief', '\r'])
    // One MORE gate check than the script has answers: `deliverPromptToAgent`
    // asks again itself, immediately before writing. That second opinion is
    // deliberate in the delivery path and worth pinning here — a waiter that
    // saw `ready` and then wrote blind would race a gate that closed again.
    expect(session.asked()).toBe(answers.length + 1)
  })

  it('gives up when the session cannot accept prompts at all', async () => {
    // The control that keeps "wait for it" from meaning "wait forever". A
    // terminal verdict is the provider saying there is nothing to wait for.
    const session = scriptedSession([{ kind: 'terminal', reason: 'exited' } as GateAnswer])
    const manager = managerWith(session)

    const result = await manager.deliverPromptWhenReady('child', 'the brief')

    expect(result).toMatchObject({ ok: false, disposition: 'session-unusable' })
    expect(session.write).not.toHaveBeenCalled()
  })

  it('stops waiting when the session is retired, through the real removal path', async () => {
    // A child closed while its brief was still waiting must not leave a waiter
    // behind, and the reason has to be honest in the journal: the session
    // ended, it did not fail to become ready. Driven through the manager's own
    // session removal rather than by calling the cancel directly, because
    // "some other code path also has to remember to cancel" is exactly the
    // kind of coupling that rots.
    vi.useFakeTimers()
    try {
      const session = gatedSession()
      const manager = managerWith(session)

      const pending = manager.deliverPromptWhenReady('child', 'the brief')
      await vi.advanceTimersByTimeAsync(10)
      expect(session.asked()).toBeGreaterThan(0)

      // `cleanupSessionState` is the one place per-session state is torn down
      // — every close, kill and exit funnels through it, and its own comment
      // says that is the point. Driving it is what proves the cancellation is
      // wired to session removal rather than to one caller remembering.
      ;(manager as unknown as { cleanupSessionState: (id: string, kind: string) => boolean })
        .cleanupSessionState('child', 'claude')
      await vi.advanceTimersByTimeAsync(10)

      const settled = await pending
      expect(settled.ok).toBe(false)
      expect(settled.ok === false && settled.message).toContain('session-ended')
      expect(session.write).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses a second waiter, so one child cannot get its brief twice', async () => {
    vi.useFakeTimers()
    try {
      const session = gatedSession()
      const manager = managerWith(session)

      const first = manager.deliverPromptWhenReady('child', 'the brief')
      await vi.advanceTimersByTimeAsync(10)
      const second = await manager.deliverPromptWhenReady('child', 'the brief again')

      expect(second).toMatchObject({ ok: false, code: 'delivery-in-flight', promptWritten: false })
      manager.cancelPendingPromptDelivery('child', 'test-teardown')
      await vi.advanceTimersByTimeAsync(10)
      await first
    } finally {
      vi.useRealTimers()
    }
  })

  it('is superseded by a direct delivery, rather than firing a second copy later', async () => {
    // The parent, told its child's brief is pending, sends the same prompt
    // itself anyway. Two deliveries of one bootstrap is a duplicated task and
    // a child told the same thing twice.
    //
    // The timing is controlled, because the interesting order is the one that
    // is NOT protected by the in-flight reservation: the direct delivery
    // COMPLETES, and only then does the gate open for the waiter.
    vi.useFakeTimers()
    try {
      const session = gatedSession()
      const manager = managerWith(session)

      const pending = manager.deliverPromptWhenReady('child', 'the brief')
      await vi.advanceTimersByTimeAsync(10)

      session.open()
      // The orchestration send path is the only one that says it is replacing
      // the brief. Every other delivery leaves a waiting brief alone (#854
      // review) — that case is asserted below.
      const direct = await manager.deliverPromptToAgent(
        'child', 'the brief, sent by hand', undefined, undefined, undefined,
        { supersedesPendingPrompt: true },
      )
      expect(direct.ok).toBe(true)

      // Long past the waiter's next re-arm: if it were still armed it would
      // find an open gate and write a second copy.
      await vi.advanceTimersByTimeAsync(10_000)

      const settled = await pending
      expect(settled.ok).toBe(false)
      expect(session.write.mock.calls.map(([data]) => data)).toEqual(['the brief, sent by hand', '\r'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('does NOT let an unrelated delivery eat the waiting brief', async () => {
    // `deliverPromptToAgent` has seven callers: a human typing in the child's
    // pane, the phone, the goal loop, two compaction paths, and the
    // orchestration send. Only the last is sending the brief. Cancelling from
    // all of them meant a human who typed into a child whose composer was busy
    // silently threw away the brief its parent had been promised — and
    // `occupied` (a human draft) appears ten times in the recorded corpus.
    vi.useFakeTimers()
    try {
      const session = gatedSession()
      const manager = managerWith(session)

      const pending = manager.deliverPromptWhenReady('child', 'the brief')
      await vi.advanceTimersByTimeAsync(10)

      session.open()
      // A human pressing Enter in the child's pane: no supersede flag.
      await manager.deliverPromptToAgent('child', 'something the user typed')
      // Past the re-arm pacing — nothing woke the waiter early, because
      // nothing cancelled it. That wait is the feature working, not a stall.
      await vi.advanceTimersByTimeAsync(3_000)

      // The brief still arrives, because nobody said they were replacing it.
      await expect(pending).resolves.toMatchObject({ ok: true })
      expect(session.write.mock.calls.map(([data]) => data))
        .toEqual(['something the user typed', '\r', 'the brief', '\r'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not let a finishing waiter delete a DIFFERENT waiter (#854 review)', async () => {
    // "One waiter per session" is the whole double-delivery invariant, and the
    // map was keyed and deleted by session id. The `ready` branch releases the
    // slot BEFORE delivering — deliberately, so a concurrent delivery is not
    // mistaken for a second waiter — which opens a window where another waiter
    // can arm. That waiter's entry was then deleted by the first one's
    // `finally`, leaving it unreachable: no direct delivery could supersede
    // it, and it fired its own copy when the gate opened. Two briefs, one
    // child.
    //
    // Only one caller exists today, so the invariant held by luck rather than
    // by construction.
    vi.useFakeTimers()
    try {
      const session = gatedSession()
      const manager = managerWith(session)
      const settleDelivery = session.holdAcceptance()

      const first = manager.deliverPromptWhenReady('child', 'brief A')
      session.open()
      // Let the gate open and the delivery start; it now hangs on acceptance.
      await vi.advanceTimersByTimeAsync(3_000)

      // The gate shuts again while that delivery is absorbing — which is what
      // Claude's really does, since a composer mid-paste reads as occupied.
      // That is what PARKS the second waiter instead of letting it run
      // straight through.
      session.close()
      // The slot is free while the first waiter delivers, so a second can arm.
      const second = manager.deliverPromptWhenReady('child', 'brief B')
      await vi.advanceTimersByTimeAsync(10)

      // The first delivery completes, and its teardown runs.
      settleDelivery()
      await first
      await vi.advanceTimersByTimeAsync(10)

      // The second waiter must still be REACHABLE. With deletion by id, its
      // entry is gone and this returns false — after which nothing can stop it
      // delivering a second brief.
      expect(manager.cancelPendingPromptDelivery('child', 'test')).toBe(true)
      await vi.advanceTimersByTimeAsync(10)
      await expect(second).resolves.toMatchObject({ ok: false })
      // And only ONE brief ever reached the composer.
      expect(session.write.mock.calls.map(([data]) => data)).toEqual(['brief A', '\r'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses to WAIT for a provider that has no gate, instead of retrying once and calling it a wait', async () => {
    // The regression this replaces (#854 review): an earlier version fell
    // through to one immediate delivery here, on the premise that a provider
    // without `awaitReadyForPrompt` owns readiness in its own delivery path.
    // That premise is false for OpenCode and Grok — they report not-readiness
    // as an ordinary `before-write` failure — so the "wait" was a single retry
    // into the same window, measured at 1 ms, after which the prompt was gone
    // while the caller's reply told the parent not to send it again.
    //
    // Refusing hands the caller back the retry it would have had.
    let screen = '❯'
    const session = {
      write: vi.fn((data: string) => { if (data !== '\r') screen = `❯ ${data}` }),
      isExited: () => false,
      snapshotScreen: () => screen,
      armPromptAcceptance: () => ({ promise: Promise.resolve({ kind: 'user' as const, acceptedAt: 1 }), cancel: vi.fn() }),
    }
    const manager = managerWith(session)

    expect(manager.canWaitForPromptReadiness('child')).toBe(false)
    const result = await manager.deliverPromptWhenReady('child', 'the brief')

    expect(result).toMatchObject({ ok: false, retrySafe: true, disposition: 'retry-same-session', promptWritten: false })
    // And nothing was written, so there is no half-delivered draft to clean up.
    expect(session.write).not.toHaveBeenCalled()
  })

  it('says a gated session CAN be waited on', () => {
    // The control: "nothing can be waited on" would satisfy the case above and
    // turn the whole feature off.
    const manager = managerWith(gatedSession())

    expect(manager.canWaitForPromptReadiness('child')).toBe(true)
    expect(manager.canWaitForPromptReadiness('no-such-session')).toBe(false)
  })

  it('does not let one waiter\'s teardown remove another waiter (#854 review)', async () => {
    // "One waiter per session" is the whole double-delivery invariant, and it
    // held by luck: the map was keyed by session id and deleted by session id,
    // so a waiter that armed while another was delivering had its entry
    // removed by that other one's teardown. It was then unreachable —
    // `cancelPendingPromptDelivery` returned false, no direct delivery could
    // supersede it — and it fired its own copy when the gate opened.
    vi.useFakeTimers()
    try {
      const session = gatedSession()
      const manager = managerWith(session)

      const first = manager.deliverPromptWhenReady('child', 'brief A')
      await vi.advanceTimersByTimeAsync(10)
      // A second waiter is refused while the first holds the slot, which is
      // the guard that makes the identity check reachable only in teardown.
      const second = await manager.deliverPromptWhenReady('child', 'brief B')
      expect(second).toMatchObject({ ok: false, code: 'delivery-in-flight' })

      manager.cancelPendingPromptDelivery('child', 'test')
      await vi.advanceTimersByTimeAsync(10)
      await first

      // The slot is free again, and a new waiter owns it — not a ghost of the
      // one that just left.
      expect(manager.cancelPendingPromptDelivery('child', 'nothing-to-cancel')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

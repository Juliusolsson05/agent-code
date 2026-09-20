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
  return {
    write: vi.fn((data: string) => { if (data !== '\r') screen = `❯ ${data}` }),
    open: () => { open = true },
    asked: () => asked,
    isExited: () => false,
    snapshotScreen: () => screen,
    awaitReadyForPrompt: vi.fn(async (): Promise<GateAnswer> => {
      asked += 1
      return open ? { kind: 'ready', waitedMs: 1 } : warming()
    }),
    armPromptAcceptance: () => ({
      promise: Promise.resolve({ kind: 'user' as const, acceptedAt: 123 }),
      cancel: vi.fn(),
    }),
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
      const direct = await manager.deliverPromptToAgent('child', 'the brief, sent by hand')
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

  it('delivers straight away for a provider with no gate to wait on', async () => {
    // Not every provider exposes readiness. Waiting on a capability that does
    // not exist would hang the brief forever for those.
    let screen = '❯'
    const session = {
      write: vi.fn((data: string) => { if (data !== '\r') screen = `❯ ${data}` }),
      isExited: () => false,
      snapshotScreen: () => screen,
      armPromptAcceptance: () => ({ promise: Promise.resolve({ kind: 'user' as const, acceptedAt: 1 }), cancel: vi.fn() }),
    }
    const manager = managerWith(session)

    await expect(manager.deliverPromptWhenReady('child', 'the brief')).resolves.toMatchObject({ ok: true })
    expect(session.write.mock.calls.map(([data]) => data)).toEqual(['the brief', '\r'])
  })
})

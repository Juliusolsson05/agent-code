import { afterEach, describe, expect, it, vi } from 'vitest'

import { CodexSession } from './codexSession.js'

afterEach(() => vi.useRealTimers())

// An idle, genuinely usable Codex screen. Shape copied from a real codex
// 0.144.6 capture: composer marker plus the model/·/cwd footer, which is what
// isCodexReadyForPromptScreen actually requires. Tests that assert `ready` must
// use this, or they pass for the wrong reason.
const READY_SCREEN = ['› ', '  gpt-5.6-sol high fast · /tmp/x'].join('\n')

// Installs a headless stub whose getConditionSnapshot returns the SHAPE
// CodexHeadless actually produces: { provider, conditions, ts } where each
// entry is a { kind, state, actions } record keyed by kind, and an idle
// session yields `conditions: {}` (the evaluator only inserts a key when
// detect returns non-null). Matching the real shape matters — an earlier cut
// of this fix shipped dead code precisely because its tests invented a shape
// no production object has.
function installHeadless(
  session: CodexSession,
  conditions: Record<string, unknown>,
  screen = 'Starting Codex…',
): void {
  ;(session as unknown as { headless: unknown }).headless = {
    getScreen: () => screen,
    getConditionSnapshot: () => ({ provider: 'codex', conditions, ts: Date.now() }),
  }
}

describe('CodexSession prompt readiness lifecycle', () => {
  it('stops a partially started headless before killing its PTY', async () => {
    const session = new CodexSession()
    const order: string[] = []
    const internals = session as unknown as {
      headless: { stop(): Promise<void> } | null
      pty: { kill(): void } | null
      rollbackStart(): Promise<void>
    }
    internals.headless = {
      stop: async () => { order.push('headless.stop') },
    }
    internals.pty = {
      kill: () => { order.push('pty.kill') },
    }

    await internals.rollbackStart()

    // WHY order matters: killing the PTY first can race coordinator cleanup
    // with filesystem events from the exiting process. Revocation must be
    // complete before the last producer is torn down.
    expect(order).toEqual(['headless.stop', 'pty.kill'])
    expect(internals.headless).toBeNull()
    expect(internals.pty).toBeNull()
  })

  it('returns terminal exit instead of polling until the deadline', async () => {
    vi.useFakeTimers()
    const session = new CodexSession()
    // Uses the shared helper so the stub carries every method the readiness
    // poll actually calls. A partial stub here previously hid whether
    // production could cope with a real CodexHeadless.
    installHeadless(session, {})
    const readiness = session.awaitReadyForPrompt({ timeoutMs: 10_000, pollIntervalMs: 50 })

    ;(session as unknown as { exited: boolean }).exited = true
    await vi.advanceTimersByTimeAsync(50)
    await expect(readiness).resolves.toEqual({ kind: 'terminal', reason: 'exited' })
  })

  it('reports blocked while the trust dialog owns the screen instead of polling to the deadline', async () => {
    // Regression: readiness was derived from the screen ALONE, so a trust
    // dialog — which hides the composer by design — was indistinguishable from
    // "the composer has not painted yet". That produced `timeout`, whose
    // disposition is 'retry-same-session', so callers retried immediately and
    // each attempt held the prompt-delivery reservation for a further 15s.
    // sessionManager.write() drops every external write while that reservation
    // is held, so the user's clicks on "trust directory" / "cancel" never
    // reached the PTY and the app had to be restarted.
    //
    // 'blocked' carries disposition 'retry-after-resolve', which tells the
    // caller a HUMAN must act — the retry loop stops and the modal works.
    vi.useFakeTimers()
    const session = new CodexSession()
    installHeadless(session, {
      'codex.trust-dialog': {
        kind: 'codex.trust-dialog',
        state: { visible: true, workspace: '/tmp/x' },
        actions: [
          { kind: 'pty', id: 'accept', label: 'Trust folder', data: '\r' },
          { kind: 'pty', id: 'reject', label: 'Quit', data: '2\r' },
        ],
      },
    })

    const readiness = session.awaitReadyForPrompt({ timeoutMs: 15_000, pollIntervalMs: 50 })
    await vi.advanceTimersByTimeAsync(50)

    await expect(readiness).resolves.toEqual({
      kind: 'blocked',
      condition: 'codex.trust-dialog',
      resolvable: true,
    })
  })

  it('blocks while an approval modal is on screen', async () => {
    // The approval modal deadlocks exactly like the trust dialog: it hides the
    // composer, so a screen-only readiness check polls to the 15s deadline
    // while the delivery reservation drops the modal's own keystrokes. Non-empty
    // `options` is what proves the modal is on screen right now.
    vi.useFakeTimers()
    const session = new CodexSession()
    installHeadless(session, {
      'codex.approval': {
        kind: 'codex.approval',
        state: {
          command: 'rm -rf /tmp/x',
          options: [{ key: '1', label: 'Yes' }, { key: '2', label: 'No' }],
        },
        actions: [{ kind: 'pty', id: 'approve', label: 'Approve', data: 'y' }],
      },
    })

    const readiness = session.awaitReadyForPrompt({ timeoutMs: 15_000, pollIntervalMs: 50 })
    await vi.advanceTimersByTimeAsync(50)
    await expect(readiness).resolves.toEqual({
      kind: 'blocked', condition: 'codex.approval', resolvable: true,
    })
  })

  it('does not block on a stale approval whose modal has gone', async () => {
    // codex.approval outlives its modal: approvalMetadata is set on
    // exec_approval_request and cleared at exactly one site, the
    // exec_command_end handler. Deny an approval and no command ever runs, so
    // nothing clears it and mergeApprovalState keeps the record alive from
    // metadata alone — synthesizing `options: []`, which is the discriminant.
    // Blocking on that would strand a healthy session forever with nothing for
    // a human to resolve. Note it still advertises actions, so filtering on
    // `resolvable` would NOT catch this.
    vi.useFakeTimers()
    const session = new CodexSession()
    installHeadless(
      session,
      {
        'codex.approval': {
          kind: 'codex.approval',
          state: { command: 'rm -rf /tmp/x', options: [] },
          actions: [{ kind: 'pty', id: 'approve', label: 'Approve', data: 'y' }],
        },
      },
      READY_SCREEN,
    )

    const readiness = session.awaitReadyForPrompt({ timeoutMs: 15_000, pollIntervalMs: 50 })
    await vi.advanceTimersByTimeAsync(50)
    await expect(readiness).resolves.toMatchObject({ kind: 'ready' })
  })

  it('recovers to ready once the trust dialog is answered', async () => {
    // The recovery path is the user-visible half of the bug: a fix that blocked
    // forever would pass every other test here.
    vi.useFakeTimers()
    const session = new CodexSession()
    const conditions: Record<string, unknown> = {
      'codex.trust-dialog': {
        kind: 'codex.trust-dialog',
        state: { visible: true, workspace: '/tmp/x' },
        actions: [{ kind: 'pty', id: 'accept', label: 'Trust folder', data: '\r' }],
      },
    }
    let screen = 'Do you trust the contents of this directory?'
    ;(session as unknown as { headless: unknown }).headless = {
      getScreen: () => screen,
      getConditionSnapshot: () => ({ provider: 'codex', conditions, ts: Date.now() }),
    }

    await expect(
      session.awaitReadyForPrompt({ timeoutMs: 15_000, pollIntervalMs: 50 }),
    ).resolves.toMatchObject({ kind: 'blocked' })

    // User accepts: the dialog leaves the screen, so detect returns null and the
    // evaluator drops the key entirely.
    delete conditions['codex.trust-dialog']
    screen = READY_SCREEN

    const after = session.awaitReadyForPrompt({ timeoutMs: 15_000, pollIntervalMs: 50 })
    await vi.advanceTimersByTimeAsync(50)
    await expect(after).resolves.toMatchObject({ kind: 'ready' })
  })

  it('keeps polling to a timeout when the composer is merely unpainted', async () => {
    // Asserts the POSITIVE outcome. An earlier version only checked that the
    // promise had not settled synchronously, which passed even when the fix was
    // mutated to resolve immediately — it proved nothing.
    vi.useFakeTimers()
    const session = new CodexSession()
    installHeadless(session, {})

    const readiness = session.awaitReadyForPrompt({ timeoutMs: 15_000, pollIntervalMs: 50 })
    await vi.advanceTimersByTimeAsync(15_050)
    await expect(readiness).resolves.toMatchObject({
      kind: 'timeout',
      lastState: { kind: 'warming', reason: 'composer-unpainted' },
    })
  })

  it('reports a trust dialog with no actions as unresolvable', async () => {
    // Guards the `resolvable` derivation, which nothing else exercises: with
    // every fixture carrying actions, hardcoding it to true kept the suite green.
    vi.useFakeTimers()
    const session = new CodexSession()
    installHeadless(session, {
      'codex.trust-dialog': {
        kind: 'codex.trust-dialog',
        state: { visible: true, workspace: '/tmp/x' },
        actions: [],
      },
    })

    const readiness = session.awaitReadyForPrompt({ timeoutMs: 15_000, pollIntervalMs: 50 })
    await vi.advanceTimersByTimeAsync(50)
    await expect(readiness).resolves.toMatchObject({ resolvable: false })
  })
})

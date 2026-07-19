import { afterEach, describe, expect, it, vi } from 'vitest'

import { CodexSession } from './codexSession.js'

afterEach(() => vi.useRealTimers())

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
  it('returns terminal exit instead of polling until the deadline', async () => {
    vi.useFakeTimers()
    const session = new CodexSession()
    ;(session as unknown as { headless: { getScreen(): string } }).headless = {
      getScreen: () => 'Starting Codex…',
    }
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

  it('does not block on a stale approval condition', async () => {
    // codex.approval can outlive the modal: approvalMetadata is set on
    // exec_approval_request and cleared at exactly one site, the
    // exec_command_end handler. Deny an approval and no command ever runs, so
    // nothing clears it and mergeApprovalState keeps the record live on
    // metadata alone. Blocking on it would make every later prompt to an
    // otherwise healthy session fail forever with nothing for a human to
    // resolve — worse and far more routine than the deadlock being fixed.
    // Note it still advertises actions, so filtering on `resolvable` would NOT
    // have caught this.
    vi.useFakeTimers()
    const session = new CodexSession()
    installHeadless(
      session,
      {
        'codex.approval': {
          kind: 'codex.approval',
          state: { command: 'rm -rf /tmp/x' },
          actions: [
            { kind: 'pty', id: 'approve', label: 'Approve', data: 'y' },
            { kind: 'pty', id: 'deny', label: 'Deny', data: '\x1b' },
          ],
        },
      },
      // A genuinely idle, usable screen. Shape copied from a real codex
      // 0.144.6 capture: composer marker plus the model/·/cwd footer, which is
      // what isCodexReadyForPromptScreen actually requires.
      ['› ', '  gpt-5.6-sol high fast · /tmp/x'].join('\n'),
    )

    const readiness = session.awaitReadyForPrompt({ timeoutMs: 15_000, pollIntervalMs: 50 })
    await vi.advanceTimersByTimeAsync(50)
    await expect(readiness).resolves.toMatchObject({ kind: 'ready' })
  })

  it('keeps polling when no condition is active and the composer is simply unpainted', () => {
    // The blocked path must not swallow ordinary warming: a session that is
    // merely still starting has no condition, and must still poll rather than
    // report itself blocked.
    vi.useFakeTimers()
    const session = new CodexSession()
    installHeadless(session, {})

    let settled = false
    void session
      .awaitReadyForPrompt({ timeoutMs: 15_000, pollIntervalMs: 50 })
      .then(() => { settled = true })

    expect(settled).toBe(false)
  })
})

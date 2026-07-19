import { afterEach, describe, expect, it, vi } from 'vitest'

import { CodexSession } from './codexSession.js'

afterEach(() => vi.useRealTimers())

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

  it('reports blocked while a condition owns the screen instead of polling to the deadline', async () => {
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
    // caller a HUMAN must act — the loop stops and the modal becomes usable.
    vi.useFakeTimers()
    const session = new CodexSession()
    ;(session as unknown as {
      headless: { getScreen(): string; getConditionSnapshot(): unknown }
    }).headless = {
      getScreen: () => 'Do you trust the contents of this directory?',
      getConditionSnapshot: () => ({
        provider: 'codex',
        conditions: {
          'codex.trust-dialog': {
            kind: 'codex.trust-dialog',
            actions: [{ kind: 'pty', id: 'accept', label: 'Trust folder', data: '\r' }],
          },
        },
        ts: Date.now(),
      }),
    }

    const readiness = session.awaitReadyForPrompt({ timeoutMs: 15_000, pollIntervalMs: 50 })
    await vi.advanceTimersByTimeAsync(50)

    await expect(readiness).resolves.toEqual({
      kind: 'blocked',
      condition: 'codex.trust-dialog',
      resolvable: true,
    })
  })

  it('keeps polling when no condition is active and the composer is simply unpainted', () => {
    // The blocked path must not swallow ordinary warming: a session that is
    // merely still starting has no condition, and must still poll rather than
    // report itself blocked.
    vi.useFakeTimers()
    const session = new CodexSession()
    ;(session as unknown as {
      headless: { getScreen(): string; getConditionSnapshot(): unknown }
    }).headless = {
      getScreen: () => 'Starting Codex…',
      getConditionSnapshot: () => ({ provider: 'codex', conditions: {}, ts: Date.now() }),
    }

    let settled = false
    void session
      .awaitReadyForPrompt({ timeoutMs: 15_000, pollIntervalMs: 50 })
      .then(() => { settled = true })

    expect(settled).toBe(false)
  })
})

import { describe, expect, it, vi } from 'vitest'

import type { PromptDeliveryIo } from '@shared/types/providerConfig.js'
import { AntigravitySession } from './antigravitySession.js'
import { deliverAntigravityPrompt } from './promptDelivery.js'

// The Antigravity delivery policy. What is pinned: WHICH failures are
// retry-safe (only the session's own `antigravity-not-ready`, which it throws
// when nothing was handed to agy) and what promptWritten claims. Everything
// else may have reached agy as a session/prompt, and a resend would run the
// prompt twice — so it must be do-not-retry with promptWritten true.

function io(deliverPromptText: (text: string) => Promise<void | { turnStarted: boolean }>): PromptDeliveryIo {
  return {
    session: { deliverPromptText } as unknown as PromptDeliveryIo['session'],
    write: () => false,
    sessionId: 'ag-pane-1',
    prompt: 'hello',
  }
}

const notReady = (message: string) => Object.assign(new Error(message), { code: 'antigravity-not-ready' })

describe('deliverAntigravityPrompt', () => {
  it('fails loudly with a retry-safe, never-written result when the session has no delivery capability', async () => {
    const result = await deliverAntigravityPrompt({ session: {} as PromptDeliveryIo['session'], write: () => false, sessionId: 'ag-pane-1', prompt: 'hello' })
    expect(result).toMatchObject({
      ok: false,
      stage: 'before-write',
      code: 'missing-capability',
      retrySafe: true,
      disposition: 'session-unusable',
      promptWritten: false,
      enterWritten: false,
    })
    if (!result.ok) expect(result.message).toContain('ag-pane-1')
  })

  it('accepts on transport acknowledgement once the session handed the prompt to agy', async () => {
    const deliver = vi.fn(async () => {})
    const before = Date.now()
    const result = await deliverAntigravityPrompt(io(deliver))
    expect(deliver).toHaveBeenCalledWith('hello')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.acceptance.kind).toBe('transport')
      expect(result.acceptance.acceptedAt).toBeGreaterThanOrEqual(before)
    }
  })

  it('reports a prompt queued behind a running turn as a queue acceptance (#889)', async () => {
    const result = await deliverAntigravityPrompt(io(vi.fn(async () => ({ turnStarted: false }))))
    expect(result.ok && result.acceptance.kind).toBe('queue')
    const started = await deliverAntigravityPrompt(io(vi.fn(async () => ({ turnStarted: true }))))
    expect(started.ok && started.acceptance.kind).toBe('transport')
  })

  it('maps antigravity-not-ready to retry-same-session with nothing written', async () => {
    const result = await deliverAntigravityPrompt(io(async () => {
      throw notReady('agy is not running')
    }))
    expect(result).toMatchObject({
      ok: false,
      stage: 'before-write',
      code: 'not-ready',
      retrySafe: true,
      disposition: 'retry-same-session',
      promptWritten: false,
      enterWritten: false,
    })
    if (!result.ok) expect(result.message).toContain('agy is not running')
  })

  it('the real session, not started, throws exactly the code the policy treats as retry-safe', async () => {
    // Pins the string contract between antigravitySession.ts and this policy:
    // a renamed error code would silently turn every not-ready refusal into a
    // do-not-retry "outcome unknown".
    const spawn = vi.fn()
    const session = new AntigravitySession({ cwd: '/work' }, { spawn, mcpProxyScript: '/proxy.mjs', scriptRunner: '/node', conversationExists: () => false })
    const result = await deliverAntigravityPrompt({ ...io(async () => {}), session })
    expect(result).toMatchObject({ ok: false, code: 'not-ready', retrySafe: true, disposition: 'retry-same-session', promptWritten: false })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('maps any other error to do-not-retry with the prompt possibly written', async () => {
    // The package's own error codes ('rejected', 'closed', even its unwrapped
    // 'not-ready') are not proof that nothing reached agy; only the session's
    // wrapped code is.
    for (const thrown of [
      Object.assign(new Error('agy rejected the prompt'), { code: 'rejected' }),
      Object.assign(new Error('agy is not ready yet'), { code: 'not-ready' }),
      new Error('ACP connection closed (stream ended)'),
    ]) {
      const result = await deliverAntigravityPrompt(io(async () => {
        throw thrown
      }))
      expect(result).toMatchObject({
        ok: false,
        stage: 'after-enter',
        code: 'transport-failed',
        retrySafe: false,
        disposition: 'do-not-retry',
        promptWritten: true,
        enterWritten: true,
      })
      if (!result.ok) expect(result.message).toContain(thrown.message)
    }
  })

  it('a non-Error throw is also do-not-retry and keeps its text in the message', async () => {
    const result = await deliverAntigravityPrompt(io(async () => {
      throw 'socket hang up'
    }))
    expect(result).toMatchObject({ ok: false, code: 'transport-failed', retrySafe: false, disposition: 'do-not-retry', promptWritten: true })
    if (!result.ok) expect(result.message).toContain('socket hang up')
  })
})

import { describe, expect, it, vi } from 'vitest'

import { deliverGrokPrompt } from './promptDelivery.js'
import type { PromptDeliveryIo } from '@shared/types/providerConfig.js'

// The delivery policy mapping, mirroring the OpenCode policy's tests. What is
// being pinned: WHICH failures are retry-safe (only never-written ones) and
// what promptWritten claims (only ever a refusal proves nothing was written).

function io(deliverPromptText: (text: string) => Promise<void>): PromptDeliveryIo {
  return {
    // The structured runtime would fail the capability probe; the terminal
    // runtime owns deliverPromptText. Both shapes flow through the same policy.
    session: { deliverPromptText } as unknown as PromptDeliveryIo['session'],
    sessionId: 'grok-session-1',
    prompt: 'hello',
  } as PromptDeliveryIo
}

describe('deliverGrokPrompt', () => {
  it('fails loudly with a retry-safe, never-written result when the capability is missing', async () => {
    const result = await deliverGrokPrompt({
      session: {} as PromptDeliveryIo['session'],
      sessionId: 'grok-session-1',
      prompt: 'hello',
    } as PromptDeliveryIo)
    expect(result).toMatchObject({
      ok: false,
      stage: 'before-write',
      code: 'missing-capability',
      retrySafe: true,
      disposition: 'session-unusable',
      promptWritten: false,
    })
  })

  it('accepts transport acknowledgement when native accepted the prompt', async () => {
    const deliver = vi.fn(async () => {})
    const result = await deliverGrokPrompt(io(deliver))
    expect(deliver).toHaveBeenCalledWith('hello')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.acceptance.kind).toBe('transport')
  })

  it('maps a not-ready refusal to retry-same-session with nothing written', async () => {
    const deliver = vi.fn(async () => {
      throw Object.assign(new Error('Grok control connection is not ready'), { code: 'grok-terminal-not-ready' })
    })
    const result = await deliverGrokPrompt(io(deliver))
    expect(result).toMatchObject({
      ok: false,
      stage: 'before-write',
      code: 'not-ready',
      retrySafe: true,
      disposition: 'retry-same-session',
      promptWritten: false,
    })
  })

  it('maps native rejection to do-not-retry with nothing run', async () => {
    const deliver = vi.fn(async () => {
      throw Object.assign(new Error('Grok refused the prompt'), { code: 'grok-terminal-rejected' })
    })
    const result = await deliverGrokPrompt(io(deliver))
    expect(result).toMatchObject({
      ok: false,
      stage: 'before-write',
      code: 'transport-failed',
      retrySafe: false,
      disposition: 'do-not-retry',
      promptWritten: false,
    })
  })

  it('maps uncertain and unconfirmed outcomes to possibly-performed, never retryable', async () => {
    // `uncertain` (control closed under the prompt) and `unconfirmed` (the
    // acceptance bound expired) share one branch: native may already be
    // running the turn and the uncertain-prompts decision forbids resending.
    const deliver = vi.fn(async () => {
      throw new Error('Grok prompt delivery outcome is uncertain')
    })
    const result = await deliverGrokPrompt(io(deliver))
    expect(result).toMatchObject({
      ok: false,
      stage: 'after-enter',
      code: 'transport-failed',
      retrySafe: false,
      disposition: 'do-not-retry',
      promptWritten: true,
    })
  })
})

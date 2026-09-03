import { describe, expect, it, vi } from 'vitest'

import { deliverOpencodePrompt } from './promptDelivery.js'

describe('deliverOpencodePrompt', () => {
  it('reports a terminal readiness timeout as retry-safe and pre-write', async () => {
    const error = Object.assign(new Error('TUI is still starting'), {
      code: 'opencode-terminal-not-ready',
    })

    await expect(deliverOpencodePrompt({
      sessionId: 'local-session',
      prompt: 'continue',
      session: {
        deliverPromptText: vi.fn(async () => { throw error }),
      } as never,
      write: vi.fn(),
    })).resolves.toMatchObject({
      ok: false,
      stage: 'before-write',
      code: 'not-ready',
      retrySafe: true,
      disposition: 'retry-same-session',
      promptWritten: false,
      enterWritten: false,
    })
  })

  it('keeps an uncertain transport throw non-retryable', async () => {
    await expect(deliverOpencodePrompt({
      sessionId: 'local-session',
      prompt: 'continue',
      session: {
        deliverPromptText: vi.fn(async () => { throw new Error('socket closed') }),
      } as never,
      write: vi.fn(),
    })).resolves.toMatchObject({
      ok: false,
      stage: 'after-enter',
      retrySafe: false,
      disposition: 'do-not-retry',
      promptWritten: true,
    })
  })
})

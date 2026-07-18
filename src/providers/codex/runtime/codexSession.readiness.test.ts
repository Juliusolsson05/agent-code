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
})

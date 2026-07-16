import { describe, expect, it, vi } from 'vitest'

import { hasActiveCliLease } from './cliUpdateOrchestrator.js'

describe('hasActiveCliLease', () => {
  it('defers a Codex replacement while a headless workflow owns the CLI', () => {
    const manager = {
      list: vi.fn(() => []),
      getSessionKind: vi.fn(),
    }

    expect(hasActiveCliLease(
      manager as never,
      'codex',
      cli => cli === 'codex',
    )).toBe(true)
    expect(manager.getSessionKind).not.toHaveBeenCalled()
  })

  it('retains the visible-session lease for both providers', () => {
    const manager = {
      list: vi.fn(() => ['session-1']),
      getSessionKind: vi.fn(() => 'claude' as const),
    }

    expect(hasActiveCliLease(manager as never, 'claude')).toBe(true)
    expect(hasActiveCliLease(manager as never, 'codex')).toBe(false)
  })
})

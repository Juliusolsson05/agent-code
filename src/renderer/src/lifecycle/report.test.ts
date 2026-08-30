import { afterEach, describe, expect, it, vi } from 'vitest'

import { reportLifecycle } from './report.js'

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'window')
})

describe('reportLifecycle', () => {
  it('filters content and correlation ids before crossing preload', () => {
    const reportSessionLifecycle = vi.fn()
    ;(globalThis as Record<string, unknown>).window = {
      api: { reportSessionLifecycle },
    }

    reportLifecycle(
      'submit.surface',
      'session-1',
      {
        surface: 'queued-strip',
        queueReason: 'live-current-turn',
        prompt: 'not allowlisted',
      } as never,
      {
        submissionId: '4d137d6d-22fc-411b-9fec-2271a3117e86',
        semanticTurnId: 'prompt prose is not an id',
        sessionId: 'cannot-shadow-session-scope',
      } as never,
    )

    expect(reportSessionLifecycle).toHaveBeenCalledWith({
      name: 'submit.surface',
      sessionId: 'session-1',
      data: {
        surface: 'queued-strip',
        queueReason: 'live-current-turn',
      },
      correlationIds: {
        submissionId: '4d137d6d-22fc-411b-9fec-2271a3117e86',
      },
    })
  })

  it('preserves generic legacy submit rows for non-Codex providers', () => {
    const reportSessionLifecycle = vi.fn()
    ;(globalThis as Record<string, unknown>).window = {
      api: { reportSessionLifecycle },
    }

    reportLifecycle('submit.begin', 'opencode-pane', {
      provider: 'opencode',
      source: 'text-only',
    }, {
      submissionId: '4d137d6d-22fc-411b-9fec-2271a3117e86',
    })

    expect(reportSessionLifecycle).toHaveBeenCalledWith({
      name: 'submit.begin',
      sessionId: 'opencode-pane',
      data: { provider: 'opencode', source: 'text-only' },
      correlationIds: {
        submissionId: '4d137d6d-22fc-411b-9fec-2271a3117e86',
      },
    })
  })

  it('is a no-op when the bridge is absent or throws', () => {
    expect(() => reportLifecycle('submit.write', 'session-1')).not.toThrow()

    ;(globalThis as Record<string, unknown>).window = {
      api: { reportSessionLifecycle: (): never => { throw new Error('preload unavailable') } },
    }
    expect(() => reportLifecycle('submit.write', 'session-1')).not.toThrow()
  })
})

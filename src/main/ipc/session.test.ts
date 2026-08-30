import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      harness.handlers.set(channel, handler)
    },
  },
}))

const { registerSessionIpc } = await import('./session.js')

describe('session input transcript observations', () => {
  beforeEach(() => {
    harness.handlers.clear()
  })

  it('records body and Enter writes under the existing composer submission id', () => {
    const recordCodexTranscriptObservation = vi.fn()
    const manager = {
      isDeliveryInFlight: vi.fn(() => false),
      write: vi.fn(() => true),
      recordCodexTranscriptObservation,
    }
    const append = vi.fn()
    const pasteDebugJournals = { get: vi.fn(() => ({ append })) }
    registerSessionIpc(manager as never, pasteDebugJournals as never)
    const input = harness.handlers.get('session:input')
    if (!input) throw new Error('session:input was not registered')

    expect(input({}, 'codex-pane', 'hello', 'submission-1')).toBe(true)
    expect(input({}, 'codex-pane', '\r', 'submission-1')).toBe(true)

    expect(recordCodexTranscriptObservation.mock.calls).toEqual([
      [
        'submit.write',
        'codex-pane',
        { phase: 'body', bytes: 5, ok: true, deliveryInFlight: false },
        { submissionId: 'submission-1' },
      ],
      [
        'submit.write',
        'codex-pane',
        { phase: 'enter', bytes: 1, ok: true, deliveryInFlight: false },
        { submissionId: 'submission-1' },
      ],
    ])
    // The legacy raw paste journal remains unchanged; Stage 0 adds a safe
    // projection and does not replace evidence collectors during observation.
    expect(append).toHaveBeenCalledTimes(2)
  })
})

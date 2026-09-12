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

vi.mock('@main/window/windowRegistry.js', () => ({
  claimSessionForWindow: vi.fn(),
  releaseSession: vi.fn(),
  windowIdFor: () => 'requesting-window',
}))

const { registerSessionIpc } = await import('./session.js')

describe('recovered renderer screen seed', () => {
  it.each([
    { ok: true, destroyed: false, available: true, sends: 1 },
    { ok: false, destroyed: false, available: true, sends: 0 },
    { ok: true, destroyed: true, available: true, sends: 0 },
    { ok: true, destroyed: false, available: false, sends: 0 },
  ])('seeds only successful live requesters ($ok/$destroyed/$available)', async ({ ok, destroyed, available, sends }) => {
    const screen = { plain: 'latest raw tick', markdown: 'latest raw tick', recent: 'latest raw tick', recentMarkdown: 'latest raw tick' }
    const recover = vi.fn(async () => ({ ok }))
    const getScreenSnapshot = vi.fn(() => available ? screen : null)
    registerSessionIpc({ recover, getScreenSnapshot } as never, {} as never)
    const sender = { isDestroyed: () => destroyed, send: vi.fn() }
    await expect(harness.handlers.get('session:recover')!({ sender }, { sessionId: 's1' })).resolves.toEqual({ ok })
    expect(sender.send).toHaveBeenCalledTimes(sends)
    if (sends) {
      expect(getScreenSnapshot).toHaveBeenCalledWith('s1')
      expect(recover.mock.invocationCallOrder[0]).toBeLessThan(getScreenSnapshot.mock.invocationCallOrder[0]!)
      expect(sender.send).toHaveBeenCalledWith('session:screen', {
        sessionId: 's1', plain: screen.plain, markdown: screen.markdown,
      })
    }
  })
})

describe('session input transcript observations', () => {
  beforeEach(() => {
    harness.handlers.clear()
  })

  it('records separate and combined body/Enter writes under the composer submission id', () => {
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
    expect(input(
      {},
      'codex-pane',
      '\x1b[200~zero delay\x1b[201~\r',
      'submission-2',
    )).toBe(true)

    expect(recordCodexTranscriptObservation.mock.calls).toEqual([
      [
        'submit.write',
        'codex-pane',
        { phase: 'body', ok: true, deliveryInFlight: false },
        { submissionId: 'submission-1' },
      ],
      [
        'submit.write',
        'codex-pane',
        { phase: 'enter', ok: true, deliveryInFlight: false },
        { submissionId: 'submission-1' },
      ],
      [
        'submit.write',
        'codex-pane',
        { phase: 'body-enter', ok: true, deliveryInFlight: false },
        { submissionId: 'submission-2' },
      ],
    ])
    // The legacy raw paste journal remains unchanged; Stage 0 adds a safe
    // projection and does not replace evidence collectors during observation.
    expect(append).toHaveBeenCalledTimes(3)
  })
})

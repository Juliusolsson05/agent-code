import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  listSessions: vi.fn(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      harness.handlers.set(channel, handler)
    },
  },
}))

vi.mock('@providers/registry.main.js', () => ({
  getMainProvider: () => ({ listSessions: harness.listSessions }),
}))

const { registerSessionIpc } = await import('./session.js')

describe('session input transcript observations', () => {
  beforeEach(() => {
    harness.handlers.clear()
    harness.listSessions.mockReset()
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

describe('session resume listing evidence', () => {
  beforeEach(() => {
    harness.handlers.clear()
    harness.listSessions.mockReset()
  })

  it('records the exact provider/cwd and successful result count', async () => {
    harness.listSessions.mockResolvedValue([
      { sessionId: 'provider-session', summary: 'saved', lastModified: 1 },
    ])
    const record = vi.fn()
    const manager = {}
    const pasteDebugJournals = {}
    registerSessionIpc(
      manager as never,
      pasteDebugJournals as never,
      { record } as never,
    )
    const list = harness.handlers.get('session:list-for-cwd')
    if (!list) throw new Error('session:list-for-cwd was not registered')

    await expect(list(
      {},
      '/repo/worktrees/../worktrees/codex',
      20,
      'codex',
    )).resolves.toHaveLength(1)
    expect(harness.listSessions).toHaveBeenCalledWith(
      '/repo/worktrees/../worktrees/codex',
      20,
    )
    expect(record).toHaveBeenCalledWith({
      area: 'session.resume-list',
      name: 'session.resume-list.complete',
      data: {
        provider: 'codex',
        cwd: '/repo/worktrees/codex',
        limit: 20,
        resultCount: 1,
        outcome: 'success',
      },
    })
  })

  it('preserves listing failure and records it separately from zero results', async () => {
    const failure = new Error('recorded lister failure')
    harness.listSessions.mockRejectedValue(failure)
    const recordError = vi.fn()
    registerSessionIpc(
      {} as never,
      {} as never,
      { record: vi.fn(), recordError } as never,
    )
    const list = harness.handlers.get('session:list-for-cwd')
    if (!list) throw new Error('session:list-for-cwd was not registered')

    await expect(list({}, '/repo/codex', 20, 'codex')).rejects.toBe(failure)
    expect(recordError).toHaveBeenCalledWith(
      'session.resume-list.error',
      failure,
      {
        provider: 'codex',
        cwd: '/repo/codex',
        limit: 20,
        outcome: 'error',
      },
    )
  })
})

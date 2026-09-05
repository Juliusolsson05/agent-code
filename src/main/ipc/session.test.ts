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

  it('records provider/target correlation and count without retaining the cwd', async () => {
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
        targetFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        limit: 20,
        resultCount: 1,
        outcome: 'success',
      },
    })
    expect(JSON.stringify(record.mock.calls)).not.toContain('/repo/worktrees/codex')
  })

  it('preserves listing failure and records it separately from zero results', async () => {
    const failure = new Error('recorded lister failure at /repo/codex')
    harness.listSessions.mockRejectedValue(failure)
    const record = vi.fn()
    registerSessionIpc(
      {} as never,
      {} as never,
      { record } as never,
    )
    const list = harness.handlers.get('session:list-for-cwd')
    if (!list) throw new Error('session:list-for-cwd was not registered')

    await expect(list({}, '/repo/codex', 20, 'codex')).rejects.toBe(failure)
    expect(record).toHaveBeenCalledWith({
      area: 'session.resume-list',
      name: 'session.resume-list.error',
      severity: 'warn',
      data: {
        provider: 'codex',
        targetFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        limit: 20,
        outcome: 'error',
      },
    })
    expect(JSON.stringify(record.mock.calls)).not.toContain('/repo/codex')
  })
})

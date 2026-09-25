import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  routed: vi.fn(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      harness.handlers.set(channel, handler)
    },
  },
  ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) => harness.handlers.get(channel)!({}, ...args),
  },
}))

vi.mock('@main/window/windowRegistry.js', () => ({
  claimSessionForWindow: vi.fn((sessionId: string, windowId: string) => ({ sessionId, windowId, rendererGeneration: 0, revision: 1 })),
  captureSessionWindowLease: vi.fn(),
  isSessionWindowLeaseCurrent: () => true,
  releaseSession: vi.fn(),
  sendToSessionWindow: harness.routed,
  windowIdFor: () => 'requesting-window',
}))

// The sub-agent watcher polls real directories; nothing here is about fleets.
vi.mock('@main/subagents/index.js', () => ({ SubAgentWatcherManager: class { observeParentEntry() {} stop() {} stopAll() {} } }))

const { registerSessionIpc } = await import('./session.js')
const { sessionApi } = await import('@preload/api/session.js')
const { SessionFeedTap } = await import('@main/sessions/sessionFeedTap.js')
const { EventEmitter } = await import('node:events')

it('sends the prompt\'s committed row before answering its delivery (#1181)', async () => {
  // Claude's acceptance IS main seeing the prompt's JSONL line, and the
  // renderer drops its pending Sending row the moment the reply lands. The
  // row sits in the tap's burst buffer until setImmediate while the reply
  // resumes in a microtask, so without the barrier the reply overtakes it
  // and the prompt blinks out of the feed. Driven through the REAL tap: the
  // barrier moved there when the module-global coalescer was deleted (#1177).
  const manager = new EventEmitter()
  const tap = new SessionFeedTap(manager as never)
  const order: string[] = []
  tap.addSink(channel => {
    if (channel === 'jsonl-entries') order.push('row')
  })
  Object.assign(manager, {
    deliverPromptToAgent: vi.fn(async () => {
      manager.emit('jsonl-entry', { sessionId: 's1', file: '/t.jsonl', entry: { uuid: 'prompt', type: 'user' } })
      return { ok: true, acceptance: { kind: 'transport', acceptedAt: 1 } }
    }),
  })
  try {
    registerSessionIpc(manager as never, {} as never, tap)
    await sessionApi.deliverPrompt('s1', 'hello')
    order.push('reply')
    expect(order).toEqual(['row', 'reply'])
  } finally {
    tap.dispose()
  }
})

it('transports generated-task draft protection from preload through main without granting waiter replacement', async () => {
  const deliverPromptToAgent = vi.fn(async () => ({ ok: false, message: 'Native draft occupied' }))
  registerSessionIpc({ deliverPromptToAgent } as never, {} as never, { flushCommitted: () => {} })
  // Real preload -> registered handler composition catches a dropped option
  // at either IPC end. The internal supersede option must not cross with it.
  await sessionApi.deliverPrompt('s1', 'Restart the server', undefined, undefined, { requireEmptyNativeComposer: true, supersedesPendingPrompt: true } as never)
  expect(deliverPromptToAgent).toHaveBeenCalledExactlyOnceWith('s1', 'Restart the server', undefined, undefined, undefined, { requireEmptyNativeComposer: true })
})

describe('recovered renderer screen seed', () => {
  it.each([
    { ok: true, destroyed: false, available: true, sends: 1 },
    { ok: false, destroyed: false, available: true, sends: 0 },
    { ok: true, destroyed: true, available: true, sends: 0 },
    { ok: true, destroyed: false, available: false, sends: 0 },
  ])('seeds only successful live requesters ($ok/$destroyed/$available)', async ({ ok, destroyed, available, sends }) => {
    harness.routed.mockClear()
    const screen = { plain: 'latest raw tick', markdown: 'latest raw tick', recent: 'latest raw tick', recentMarkdown: 'latest raw tick' }
    const recover = vi.fn(async (_options, admitted) => { if (ok) admitted(); return { ok } })
    const getScreenSnapshot = vi.fn(() => available ? screen : null)
    registerSessionIpc({ recover, getScreenSnapshot } as never, {} as never, { flushCommitted: () => {} })
    const sender = { isDestroyed: () => destroyed, send: vi.fn() }
    await expect(harness.handlers.get('session:recover')!({ sender }, { sessionId: 's1' })).resolves.toEqual({ ok })
    expect(harness.routed).toHaveBeenCalledTimes(sends)
    expect(sender.send).not.toHaveBeenCalled()
    if (sends) {
      expect(getScreenSnapshot).toHaveBeenCalledWith('s1')
      expect(recover.mock.invocationCallOrder[0]).toBeLessThan(getScreenSnapshot.mock.invocationCallOrder[0]!)
      expect(harness.routed).toHaveBeenCalledWith('s1', 'session:screen', {
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
    registerSessionIpc(manager as never, pasteDebugJournals as never, { flushCommitted: () => {} })
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

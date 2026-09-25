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
    // Asynchronous like the real one: the preload's load-time document
    // announcement runs at import, before any handler is registered.
    invoke: async (channel: string, ...args: unknown[]) => harness.handlers.get(channel)?.({}, ...args),
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

describe('screen leases (#762)', () => {
  it('seeds the current screen on acquire, and drops a renderer\'s leases only when its document is replaced or it dies', async () => {
    const { screenInterest } = await import('@main/sessions/screenInterest.js')
    const manager = new EventEmitter()
    Object.assign(manager, {
      getScreenSnapshot: () => ({ plain: 'now', markdown: 'now', recent: 'now', recentMarkdown: 'now' }),
    })
    registerSessionIpc(manager as never, {} as never, new SessionFeedTap(manager as never))
    harness.routed.mockClear()
    const sender = Object.assign(new EventEmitter(), { id: 4242 })
    const lease = harness.handlers.get('session:screen-lease')!

    // An opening debug panel is right at once, even for an idle backend:
    // the current screen goes down the ordinary session:screen path.
    lease({ sender }, 'pane', 'doc-1')
    expect(screenInterest.wants('pane')).toBe(true)
    // The same aliased wire payload the recover seed sends (recent/markdown
    // equal to plain/markdown are dropped on the wire, #746).
    expect(harness.routed).toHaveBeenCalledWith('pane', 'session:screen', { sessionId: 'pane', plain: 'now', markdown: 'now' })

    // Any navigation, including one the window blocks, leaves the page and
    // its leases alone: only a new document's lease or death drops them.
    sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(screenInterest.wants('pane')).toBe(true)
    // The release is the caller's own (another webContents cannot end it).
    const release = harness.handlers.get('session:screen-release')!
    release({ sender: { id: 1 } }, 'pane', 'doc-1')
    expect(screenInterest.wants('pane')).toBe(true)
    release({ sender }, 'pane', 'doc-1')
    expect(screenInterest.wants('pane')).toBe(false)

    // A real reload whose new page never opens a debug panel: its preload's
    // load-time announcement alone retires the old page's leases, or the
    // heaviest IPC stream would forward forever (steering q15).
    const announce = harness.handlers.get('session:screen-document')!
    lease({ sender }, 'old-page', 'doc-1')
    announce({ sender }, 'doc-2')
    expect(screenInterest.wants('old-page')).toBe(false)
    // Re-announcing the live document (nothing reloaded) keeps its leases,
    // and the dead page's late release cannot touch them.
    lease({ sender }, 'pane', 'doc-2')
    announce({ sender }, 'doc-2')
    release({ sender }, 'pane', 'doc-1')
    expect(screenInterest.wants('pane')).toBe(true)
    sender.emit('destroyed')
    expect(screenInterest.wants('pane')).toBe(false)
  })

  it('leases a session with no screen yet without sending an empty frame', async () => {
    const manager = new EventEmitter()
    Object.assign(manager, { getScreenSnapshot: () => null })
    registerSessionIpc(manager as never, {} as never, new SessionFeedTap(manager as never))
    harness.routed.mockClear()
    harness.handlers.get('session:screen-lease')!({ sender: Object.assign(new EventEmitter(), { id: 77 }) }, 'fresh', 'doc')
    expect(harness.routed).not.toHaveBeenCalledWith('fresh', 'session:screen', expect.anything())
  })
})

describe('session:get-screen-debug (#762)', () => {
  it('answers with main\'s latest raw screen and the recorded tail history', async () => {
    const { screenTailHistory } = await import('@main/sessions/screenInterest.js')
    const manager = new EventEmitter()
    Object.assign(manager, {
      getScreenSnapshot: () => ({ plain: 'latest', markdown: 'latest', recent: 'latest\nmore', recentMarkdown: 'latest\nmore' }),
    })
    registerSessionIpc(manager as never, {} as never, new SessionFeedTap(manager as never))
    screenTailHistory.record('debug-pane', 'first frame')
    screenTailHistory.record('debug-pane', 'second frame')
    try {
      const answer = await harness.handlers.get('session:get-screen-debug')!({}, 'debug-pane') as {
        screen: { recent: string } | null; samples: Array<{ content: string }>
      }
      expect(answer.screen?.recent).toBe('latest\nmore')
      expect(answer.samples.map(sample => sample.content)).toEqual(['first frame', 'second frame'])
    } finally {
      screenTailHistory.forget('debug-pane')
    }
  })
})

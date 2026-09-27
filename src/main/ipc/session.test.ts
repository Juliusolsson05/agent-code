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

const { registerSessionIpc, classifySpawnFailure } = await import('./session.js')
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

// #1311 review: raw PTY attaches now outlive the provider process, so they are
// owned by the renderer page that took them. A reload or a crash never runs
// the leaf cleanup; its references are released for it.
describe('raw PTY attach ownership (#1311)', () => {
  it('releases a page\'s attaches when it reloads or dies, and ignores its late detach', () => {
    const detached: string[] = []
    const manager = Object.assign(new EventEmitter(), {
      attachAgentPty: (sessionId: string) => (sessionId === 'no-backend' ? null : 'replay'),
      detachAgentPty: (sessionId: string) => { detached.push(sessionId) },
    })
    registerSessionIpc(manager as never, {} as never, new SessionFeedTap(manager as never))
    const attach = harness.handlers.get('session:agent-pty-attach')!
    const detach = harness.handlers.get('session:agent-pty-detach')!
    const announce = harness.handlers.get('session:screen-document')!
    const sender = Object.assign(new EventEmitter(), { id: 5151 })

    announce({ sender }, 'doc-1')
    attach({ sender }, 'pane', 'doc-1')
    attach({ sender }, 'no-backend', 'doc-1')
    // Re-announcing the live document keeps everything.
    announce({ sender }, 'doc-1')
    expect(detached).toEqual([])
    // A reload: the old page's one real reference is released for it.
    announce({ sender }, 'doc-2')
    expect(detached).toEqual(['pane'])
    // The dead page's late detach must not take the new page's reference.
    detach({ sender }, 'pane', 'doc-1')
    expect(detached).toEqual(['pane'])

    attach({ sender }, 'pane', 'doc-2')
    sender.emit('destroyed')
    expect(detached).toEqual(['pane', 'pane'])
  })

  it('passes an ordinary detach through once per attach', () => {
    const detached: string[] = []
    const manager = Object.assign(new EventEmitter(), {
      attachAgentPty: () => 'replay',
      detachAgentPty: (sessionId: string) => { detached.push(sessionId) },
    })
    registerSessionIpc(manager as never, {} as never, new SessionFeedTap(manager as never))
    const sender = Object.assign(new EventEmitter(), { id: 5252 })
    harness.handlers.get('session:screen-document')!({ sender }, 'doc')
    harness.handlers.get('session:agent-pty-attach')!({ sender }, 'pane', 'doc')
    harness.handlers.get('session:agent-pty-detach')!({ sender }, 'pane', 'doc')
    harness.handlers.get('session:agent-pty-detach')!({ sender }, 'pane', 'doc')
    expect(detached).toEqual(['pane'])
  })

  // #1311 round 2 (review A): a reload can reuse the webContents id, so the
  // sender alone cannot tell the old page's queued detach from the new
  // page's. The page document says which page sent it.
  it('ignores a delayed detach from the previous document after the new one attached', () => {
    const detached: string[] = []
    const attached: string[] = []
    const manager = Object.assign(new EventEmitter(), {
      attachAgentPty: (sessionId: string) => { attached.push(sessionId); return 'replay' },
      detachAgentPty: (sessionId: string) => { detached.push(sessionId) },
    })
    registerSessionIpc(manager as never, {} as never, new SessionFeedTap(manager as never))
    const attach = harness.handlers.get('session:agent-pty-attach')!
    const detach = harness.handlers.get('session:agent-pty-detach')!
    const announce = harness.handlers.get('session:screen-document')!
    const sender = Object.assign(new EventEmitter(), { id: 5353 })

    announce({ sender }, 'doc-a')
    attach({ sender }, 'pane', 'doc-a')
    announce({ sender }, 'doc-b')
    expect(detached).toEqual(['pane'])
    attach({ sender }, 'pane', 'doc-b')
    // Page A's detach, queued before the reload, arrives now.
    detach({ sender }, 'pane', 'doc-a')
    expect(detached).toEqual(['pane'])
    // And a stale attach from page A takes no reference at all.
    expect(attach({ sender }, 'other', 'doc-a')).toBeNull()
    expect(attached).toEqual(['pane', 'pane'])
    detach({ sender }, 'pane', 'doc-b')
    expect(detached).toEqual(['pane', 'pane'])
  })

  // Review A mutation: two views of one session on one page (a Spotlight
  // remount, a duplicate leaf) hold two references.
  it('counts overlapping attaches of one session on one page', () => {
    const detached: string[] = []
    const manager = Object.assign(new EventEmitter(), {
      attachAgentPty: () => 'replay',
      detachAgentPty: (sessionId: string) => { detached.push(sessionId) },
    })
    registerSessionIpc(manager as never, {} as never, new SessionFeedTap(manager as never))
    const sender = Object.assign(new EventEmitter(), { id: 5454 })
    harness.handlers.get('session:screen-document')!({ sender }, 'doc')
    harness.handlers.get('session:agent-pty-attach')!({ sender }, 'pane', 'doc')
    harness.handlers.get('session:agent-pty-attach')!({ sender }, 'pane', 'doc')
    harness.handlers.get('session:agent-pty-detach')!({ sender }, 'pane', 'doc')
    expect(detached).toEqual(['pane'])
    sender.emit('destroyed')
    expect(detached).toEqual(['pane', 'pane'])
  })
})

// #1281 / #1283 item 3 (terminal half): a plain terminal's view reference now
// outlives the shell too, so it gets the same page ownership as the agent PTY
// above. Before, the manager flag had no release at all, and a reloaded or
// crashed renderer could never give one back.
describe('terminal attach ownership (#1281)', () => {
  function register(id: number) {
    const detached: string[] = []
    const manager = Object.assign(new EventEmitter(), {
      attachTerminal: (sessionId: string) => (sessionId === 'agent-pane' ? null : 'replay'),
      detachTerminal: (sessionId: string) => { detached.push(sessionId) },
      detachAgentPty: vi.fn(),
    })
    registerSessionIpc(manager as never, {} as never, new SessionFeedTap(manager as never))
    const sender = Object.assign(new EventEmitter(), { id })
    return {
      detached,
      sender,
      attach: (sessionId: string, document: string) => harness.handlers.get('session:terminal-attach')!({ sender }, sessionId, document),
      detach: (sessionId: string, document: string) => harness.handlers.get('session:terminal-detach')!({ sender }, sessionId, document),
      announce: (document: string) => harness.handlers.get('session:screen-document')!({ sender }, document),
    }
  }

  it('releases a page\'s terminal views when it reloads or dies, and ignores its late detach', () => {
    const page = register(6161)
    page.announce('doc-1')
    expect(page.attach('shell', 'doc-1')).toBe('replay')
    // Not a terminal: main took no reference, so the reload releases none.
    expect(page.attach('agent-pane', 'doc-1')).toBe('')
    page.announce('doc-2')
    expect(page.detached).toEqual(['shell'])
    // The dead page's queued detach must not take the new page's reference.
    page.attach('shell', 'doc-2')
    page.detach('shell', 'doc-1')
    expect(page.detached).toEqual(['shell'])
    page.sender.emit('destroyed')
    expect(page.detached).toEqual(['shell', 'shell'])
  })

  it('passes a leaf\'s detach through once per attach, and a stale page gets the replay without a reference', () => {
    const page = register(6262)
    page.announce('doc')
    page.attach('shell', 'doc')
    page.detach('shell', 'doc')
    page.detach('shell', 'doc')
    expect(page.detached).toEqual(['shell'])
    // A page that already reloaded away takes nothing that could leak.
    expect(page.attach('shell', 'old-doc')).toBe('')
    page.sender.emit('destroyed')
    expect(page.detached).toEqual(['shell'])
  })
})

// #1267 (steering q22 at the source): session:spawn relayed the raw provider
// exception over IPC, where every renderer surface had to remember not to
// show it. Main launders it like recover() does; only curated, secret-free
// failures cross as themselves.
describe('session:spawn rejections', () => {
  const { readFileSync } = require('node:fs') as typeof import('node:fs')
  const { join } = require('node:path') as typeof import('node:path')
  const recorded = (JSON.parse(readFileSync(join(import.meta.dirname,
    '../../../testing/fixtures/spawn-failure/posix-spawnp-2026-09-23.json'), 'utf8')) as { reason: string }).reason

  async function rejectionOf(error: unknown, options: Record<string, unknown> = { kind: 'claude' }, journal?: { record: ReturnType<typeof vi.fn> }): Promise<string> {
    registerSessionIpc({ spawn: vi.fn(async () => { throw error }) } as never, {} as never, { flushCommitted: () => {} }, journal as never)
    const handler = harness.handlers.get('session:spawn')!
    return await Promise.resolve(handler({ sender: {} }, { cwd: '/repo', ...options })).then(() => 'resolved', (e: Error) => e.message)
  }

  // #1324 review A/B: a non-Error whose toString throws used to escape as
  // the rejection, carrying whatever it threw.
  it('never reads a non-Error throw', async () => {
    const hostile = { toString: () => { throw new Error('token=secret') } }
    expect(await rejectionOf(hostile)).toBe('Session failed to start. Check provider setup and retry.')
  })

  // #1324 review A/B: proxy guidance only for a Claude spawn that runs the
  // proxy; both recognised signatures reach it.
  it('gives the Claude proxy guidance only to a Claude proxy spawn', async () => {
    expect(await rejectionOf(new Error('spawn /repo/mitmdump: ENOENT'), { kind: 'codex', useProxy: false })).toBe('Session failed to start. Check provider setup and retry.')
    expect(await rejectionOf(new Error('Unable to locate mitmAddon.py'), { kind: 'claude', useProxy: true })).toContain('Claude proxy startup failed')
    expect(await rejectionOf(new Error('Unable to find mitmdump on PATH'), { kind: 'claude', useProxy: true })).toContain('Claude proxy startup failed')
    expect(await rejectionOf(new Error('Unable to find mitmdump on PATH'), { kind: 'claude', useProxy: false })).toBe('Session failed to start. Check provider setup and retry.')
  })

  // #1324 review round 2 A/B: an Error's message can be a getter. One that
  // throws escaped as the rejection; one that answered the window sentence
  // first and a token next was returned as-is and read again by IPC.
  it('never lets an Error\'s own message getter reach the rejection', async () => {
    const throwing = new Error('x')
    Object.defineProperty(throwing, 'message', { get() { throw new Error('token=secret') } })
    expect(await rejectionOf(throwing)).toBe('Session failed to start. Check provider setup and retry.')
    let reads = 0
    const shifting = new Error('x')
    Object.defineProperty(shifting, 'message', { get: () => (reads++ === 0 ? 'The requesting window can no longer own this session' : 'token=secret') })
    registerSessionIpc({ spawn: vi.fn(async () => { throw shifting }) } as never, {} as never, { flushCommitted: () => {} })
    const rejected = await Promise.resolve(harness.handlers.get('session:spawn')!({ sender: {} }, { cwd: '/repo', kind: 'claude' })).then(() => null, (e: Error) => e)
    expect(rejected).not.toBe(shifting)
    expect(rejected!.message).toBe('The requesting window can no longer own this session')
    expect(rejected!.message).toBe('The requesting window can no longer own this session')
  })

  // #1324 review round 2 A/B: the guidance needs BOTH a Claude spawn and
  // useProxy exactly true (sessionManager starts mitmproxy only then).
  it('gives no proxy guidance to a Codex proxy spawn or a Claude spawn without useProxy', async () => {
    expect(await rejectionOf(new Error('Unable to find mitmdump on PATH'), { kind: 'codex', useProxy: true })).toBe('Session failed to start. Check provider setup and retry.')
    expect(await rejectionOf(new Error('Unable to find mitmdump on PATH'), { kind: 'claude' })).toBe('Session failed to start. Check provider setup and retry.')
  })

  // #1324 review round 2 B/C: every signature a debugger reads from the
  // journal, one representative each, so a collapsed classifier fails here.
  it('signs each known failure with its own code', async () => {
    const { MissingWorkspaceDirectoryError } = await import('@main/workspaceDirectory.js')
    const { ProviderCliNotFoundError } = await import('@main/sessionManager.js')
    const signatureOf = (error: unknown, proxyApplies = false) => classifySpawnFailure(error, proxyApplies).signature
    expect(signatureOf(new Error(recorded))).toBe('posix-spawnp')
    expect(signatureOf(new MissingWorkspaceDirectoryError('/repo/gone'))).toBe('missing-workspace')
    expect(signatureOf(new ProviderCliNotFoundError('codex'))).toBe('cli-not-found')
    expect(signatureOf(new Error('The requesting window can no longer own this session'))).toBe('window-refused')
    expect(signatureOf({ toString: () => 'x' })).toBe('non-error-throw')
    expect(signatureOf(new Error('Unable to locate mitmAddon.py'), true)).toBe('claude-proxy')
    // A Codex error naming mitmdump is what it is, not a Claude proxy failure.
    expect(signatureOf(new Error('spawn /repo/mitmdump: ENOENT'))).toBe('enoent')
    expect(signatureOf(new Error('spawn /usr/bin/codex EACCES'))).toBe('eacces')
    expect(signatureOf(new Error('Session recovery was cancelled'))).toBe('unclassified')
  })

  // #1439 review c: the patched node-pty (scripts/patch-node-pty.mjs) throws
  // "posix_spawnp failed: <call>: <strerror>" instead of the bare
  // "posix_spawnp failed.", and the prefix is what this classifier keys on. The
  // first message is the one a reviewer recorded from the patched build (a
  // missing spawn-helper); the second is the #1437 shape, a full PTY table.
  // Both must keep their signature, and neither may fall to enoent.
  it('classifies the patched node-pty spawn failures the same way', () => {
    const signatureOf = (error: unknown) => classifySpawnFailure(error, false).signature
    expect(signatureOf(new Error('posix_spawnp failed: posix_spawn failed: No such file or directory'))).toBe('posix-spawnp')
    expect(signatureOf(new Error('posix_spawnp failed: posix_openpt failed: Device not configured'))).toBe('posix-spawnp')
  })

  // #1324 review C: the laundered rejection is all the incident journal and
  // a debug bundle see, so the failure's identity is journaled as a fixed
  // signature, never its text.
  it('journals which known failure it was, without its text', async () => {
    const journal = { record: vi.fn() }
    await rejectionOf(new Error(`${recorded} env=ANTHROPIC_API_KEY=sk-ant-secret`), { kind: 'codex' }, journal)
    expect(journal.record).toHaveBeenCalledWith(expect.objectContaining({ name: 'session.spawn.failed', data: { kind: 'codex', signature: 'posix-spawnp' } }))
    expect(JSON.stringify(journal.record.mock.calls)).not.toContain('sk-ant')
  })

  it('never relays a raw provider exception', async () => {
    const message = await rejectionOf(new Error(`${recorded} env=ANTHROPIC_API_KEY=sk-ant-secret https://user:pass@proxy.example`))
    expect(message).toBe('Session failed to start. Check provider setup and retry.')
  })

  it('keeps the curated failures that name their fix', async () => {
    const { MissingWorkspaceDirectoryError } = await import('@main/workspaceDirectory.js')
    const { ProviderCliNotFoundError } = await import('@main/sessionManager.js')
    expect(await rejectionOf(new MissingWorkspaceDirectoryError('/repo/.worktrees/gone'))).toBe('Workspace folder is missing: /repo/.worktrees/gone')
    expect(await rejectionOf(new ProviderCliNotFoundError('codex'))).toBe('codex CLI not found. Open Setup (File › Setup…) to install it or enter its path.')
  })

  it('keeps the window-ownership refusal, which our own code writes', async () => {
    const { claimSessionForWindow } = await import('@main/window/windowRegistry.js')
    vi.mocked(claimSessionForWindow).mockReturnValueOnce(null as never)
    registerSessionIpc({ spawn: vi.fn(async (_options: unknown, claim: (id: string) => void) => { claim('s1'); return 's1' }) } as never, {} as never, { flushCommitted: () => {} })
    const handler = harness.handlers.get('session:spawn')!
    const message = await Promise.resolve(handler({ sender: {} }, { cwd: '/repo', kind: 'claude' })).then(() => 'resolved', (e: Error) => e.message)
    expect(message).toBe('The requesting window can no longer own this session')
  })

  it('turns a Claude proxy startup failure into the proxy guidance, not its raw text', async () => {
    const message = await rejectionOf(new Error('Timed out waiting for mitmproxy on 127.0.0.1:51234 with token=abc'), { kind: 'claude', useProxy: true })
    expect(message).toContain('Claude proxy startup failed')
    expect(message).not.toContain('token=abc')
  })
})

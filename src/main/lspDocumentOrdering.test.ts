import { describe, expect, it, vi } from 'vitest'

// Three ordering defects found by the #918 planning audit (#922, #923, #924),
// none of which had been reproduced when they were filed. Each test below
// reproduces one against the real code path — LspManager's own methods, and for
// #922 the real IPC handlers registered by `registerLspIpc` — with the
// language-server CONNECTION as the only stub. That connection is a true edge:
// a JSON-RPC channel to a spawned tsserver. Everything between the IPC handler
// and that channel is the code under test.

const ipcHandlers = new Map<string, (evt: unknown, ...args: unknown[]) => Promise<unknown>>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (evt: unknown, ...args: unknown[]) => Promise<unknown>) => {
      ipcHandlers.set(channel, handler)
    },
  },
}))

const { LspManager } = await import('./lspManager.js')
const { registerLspIpc } = await import('./ipc/lsp.js')

type Manager = InstanceType<typeof LspManager>

type Notification = { method: string; params: unknown }

type FakeServer = {
  key: string
  generation: string
  closed: boolean
  /** #924's bound. A fake without it reads NaN and is retired on the first
   *  abandonment, which is how this stub first "proved" a fix that worked. */
  abandonedRequests: number
  initialized: Promise<{ capabilities: Record<string, unknown> }>
  connection: { sendRequest: (method: string, params: unknown, token?: unknown) => Promise<unknown> }
  process: { killed: boolean; kill: () => void; stdin: { destroyed: boolean } }
}

/**
 * A manager wired to one fake server, with every document record built through
 * the REAL `openDocument` so the shared-document bookkeeping under test is the
 * bookkeeping the app produces — not a literal I typed.
 */
function managerWithServer(options?: {
  sendRequest?: FakeServer['connection']['sendRequest']
}): { manager: Manager; server: FakeServer; notifications: Notification[] } {
  const notifications: Notification[] = []
  const server: FakeServer = {
    key: 'server',
    generation: 'gen-1',
    closed: false,
    abandonedRequests: 0,
    initialized: Promise.resolve({ capabilities: { completionProvider: { resolveProvider: true } } }),
    connection: {
      sendRequest: options?.sendRequest ?? (async () => null),
    },
    process: { killed: false, kill: () => {}, stdin: { destroyed: false } },
  }
  const manager = new LspManager()
  const internal = manager as unknown as {
    servers: Map<string, FakeServer>
    getOrCreateServer: () => Promise<FakeServer>
    sendNotificationIfOpen: (server: unknown, method: string, params: unknown) => Promise<void>
  }
  internal.servers.set('server', server)
  internal.getOrCreateServer = async () => server
  internal.sendNotificationIfOpen = async (_server, method, params) => {
    notifications.push({ method, params })
  }
  return { manager, server, notifications }
}

const OPEN = {
  language: 'typescript',
  workspaceRoot: '/repo',
  filePath: 'shared.ts',
} as const

describe('#923 — a completion must survive the synchronization it caused', () => {
  it('returns items when the request had to restore this alias’s draft first', async () => {
    // Two Monaco surfaces show the same file. They are separate client URIs
    // with separate drafts, and the language server sees ONE document, so a
    // request from the inactive alias has to push that alias's text first.
    //
    // THE DEFECT: `changeSharedDocument` advances `doc.version` for every alias
    // of the shared URI, and `getCompletions` captured `requestedVersion`
    // BEFORE `sendDocRequest` ran that restore. So the version check at the end
    // compared the pre-sync number against the post-sync one and threw away the
    // result of its own synchronization. Not a race: it is deterministic
    // whenever the other surface was active with different text, which is the
    // normal state of a split view.
    const { manager } = managerWithServer({
      sendRequest: async method =>
        method === 'textDocument/completion'
          ? [{ label: 'fromServer', kind: 1 }]
          : null,
    })

    await manager.openDocument({ ...OPEN, clientUri: 'inmemory://a', content: 'draft A' })
    await manager.openDocument({ ...OPEN, clientUri: 'inmemory://b', content: 'draft B' })
    // B is the active alias on the server (it opened last and pushed its text).
    await manager.changeDocument('inmemory://b', 'draft B edited')

    const completions = await manager.getCompletions(
      'inmemory://a',
      { line: 0, character: 0 },
      { triggerKind: 1 },
    )

    expect(completions.items.map(item => item.label)).toEqual(['fromServer'])
  })

  it('still rejects a result the user typed past', async () => {
    // The other half of the contract, and the reason the version check exists:
    // an edit made by THIS surface while the server was answering must still
    // invalidate the list, or Monaco repopulates resolve handles for text that
    // is no longer on screen.
    let release: (() => void) | undefined
    const { manager } = managerWithServer({
      sendRequest: async method => {
        if (method !== 'textDocument/completion') return null
        await new Promise<void>(resolve => { release = resolve })
        return [{ label: 'stale', kind: 1 }]
      },
    })

    await manager.openDocument({ ...OPEN, clientUri: 'inmemory://a', content: 'draft A' })
    const pending = manager.getCompletions('inmemory://a', { line: 0, character: 0 }, { triggerKind: 1 })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))

    // The user types. This advances the intent epoch and the document version.
    const changed = manager.changeDocument('inmemory://a', 'draft A typed more')
    release?.()
    await Promise.all([pending, changed])

    await expect(pending).resolves.toEqual({ items: [], incomplete: false })
  })
})

describe('#924 — a newer intent must not wait out an obsolete request', () => {
  it('applies a change while a language request is still unanswered', async () => {
    // THE DEFECT: `sendDocRequest` holds BOTH the per-client queue and the
    // per-server-document queue until the server answers or the 15 s local
    // timeout fires. Bumping the intent epoch marks the in-flight response
    // invalid but does not release those queues, so the didChange carrying the
    // user's newest text sits behind a request whose answer is already known to
    // be worthless. Under a server that ignores cancellation — which is
    // allowed, cancellation is advisory in LSP — that is a 15 s stall on
    // synchronizing what the user just typed.
    vi.useFakeTimers()
    try {
      let requestsSent = 0
      const { manager, notifications } = managerWithServer({
        // Never answers, and ignores the cancellation token: the worst legal
        // server behaviour, and the one the local timeout exists for.
        sendRequest: async () => {
          requestsSent += 1
          return await new Promise(() => {})
        },
      })

      await manager.openDocument({ ...OPEN, clientUri: 'inmemory://a', content: 'first' })
      const hover = manager.getHover('inmemory://a', { line: 0, character: 0 })
      await vi.advanceTimersByTimeAsync(10)

      const changed = manager.changeDocument('inmemory://a', 'second')
      let changeSettled = false
      void changed.then(() => { changeSettled = true })

      // Well inside the 15 s request timeout: the abandonment budget has to be
      // its own, much smaller number, or this assertion is just the timeout.
      // NOT awaited — with the bug this promise does not settle until the
      // timeout, and awaiting it would turn a clear assertion into a runner
      // timeout that says nothing about which step stalled.
      await vi.advanceTimersByTimeAsync(1_000)

      expect(notifications.filter(n => n.method === 'textDocument/didChange')).toHaveLength(1)
      expect(changeSettled).toBe(true)
      // The request really was in flight and really was never answered —
      // otherwise this asserts nothing about abandonment.
      expect(requestsSent).toBe(1)

      // The abandoned request answers null rather than hanging or throwing.
      await vi.advanceTimersByTimeAsync(20_000)
      await expect(hover).resolves.toBeNull()
      await changed

      // And it left nothing behind. Every request subscribes to its client
      // URI's intent; a subscription that outlives its request would make the
      // map grow by one closure per language request for the life of the app,
      // and every later keystroke would call a stack of dead ones.
      const internal = manager as unknown as { documentIntentWaiters: Map<string, Set<unknown>> }
      expect(internal.documentIntentWaiters.size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('abandons a request whose intent moved while it was synchronizing', async () => {
    // The ordering hole inside the fix. `onIntentPast` subscribes AFTER the
    // restore-this-alias's-draft step, and that step awaits a didChange
    // notification — so the epoch can advance between the last check and the
    // subscription existing. `changeDocument` bumps the epoch synchronously,
    // before it queues, which is exactly how this window is reached in
    // practice: the change cannot run yet, but its intent is already known.
    //
    // A subscription that only listens forward never hears that bump, and the
    // request goes back to holding both queues for the full 15 s. The check
    // performed once at subscription time is what closes it.
    vi.useFakeTimers()
    try {
      let releaseNotification: (() => void) | undefined
      let requestsSent = 0
      const { manager } = managerWithServer({
        sendRequest: async () => {
          requestsSent += 1
          return await new Promise(() => {})
        },
      })
      const internal = manager as unknown as {
        sendNotificationIfOpen: (server: unknown, method: string, params: unknown) => Promise<void>
      }

      await manager.openDocument({ ...OPEN, clientUri: 'inmemory://a', content: 'first' })
      await manager.openDocument({ ...OPEN, clientUri: 'inmemory://b', content: 'second' })
      // B is active on the server, so a request from A must restore A's draft
      // first — that restore is the await this test suspends in.
      internal.sendNotificationIfOpen = async () => {
        await new Promise<void>(resolve => { releaseNotification = resolve })
      }

      const hover = manager.getHover('inmemory://a', { line: 0, character: 0 })
      await vi.waitFor(() => expect(releaseNotification).toBeTypeOf('function'))

      // The user types. The epoch advances NOW; the change itself waits for
      // the client queue this request is holding.
      void manager.changeDocument('inmemory://a', 'first edited')
      releaseNotification?.()

      await vi.advanceTimersByTimeAsync(1_000)
      await expect(hover).resolves.toBeNull()
      expect(requestsSent).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('retires a server that collects abandoned requests it never answers', async () => {
    // The bound (#924). Abandoning a request leaves one pending RPC alive on
    // the connection, with a response handler held for it. A server that
    // ignores cancellation AND never answers therefore leaks one per
    // abandonment, forever. The cap converts that into a bounded leak plus a
    // deliberate restart — the same path a crash already takes, so the next
    // open re-spawns.
    vi.useFakeTimers()
    try {
      const { manager, server } = managerWithServer({
        sendRequest: async () => await new Promise(() => {}),
      })
      await manager.openDocument({ ...OPEN, clientUri: 'inmemory://a', content: 'text' })
      const internal = manager as unknown as { docs: Map<string, unknown> }

      // 33 abandonments: one past LSP_MAX_ABANDONED_REQUESTS.
      for (let attempt = 0; attempt < 33; attempt++) {
        const request = manager.getHover('inmemory://a', { line: 0, character: 0 })
        await vi.advanceTimersByTimeAsync(1)
        // Any newer intent abandons it; a change is the one a user produces.
        void manager.changeDocument('inmemory://a', `text ${attempt}`)
        await vi.advanceTimersByTimeAsync(300)
        await expect(request).resolves.toBeNull()
        if (server.closed) break
      }

      expect(server.closed).toBe(true)
      // Retiring a server drops its documents, exactly as a crash does, so the
      // next open spawns a fresh process rather than talking to a dead one.
      expect(internal.docs.has('inmemory://a')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('#922 — text accepted during authorization must not vanish', () => {
  it('opens the document with the latest accepted revision', async () => {
    // THE DEFECT: `lsp:open-document` registers renderer ownership BEFORE its
    // queued entry awaits `authorizeContext` (disk work, and a server spawn
    // behind it). `lsp:change-document` only checks ownership, then calls
    // `lspManager.changeDocument` directly — bypassing the IPC queue that the
    // open is holding. The manager has no document for that URI yet, so the
    // change hits `if (!doc) return`, resolves successfully, and the open then
    // installs the ORIGINAL text. The renderer was told its edit landed; the
    // server never saw it.
    ipcHandlers.clear()
    const { manager, notifications } = managerWithServer()

    let releaseAuthorization: (() => void) | undefined
    const authorizationPaused = new Promise<void>(resolve => {
      releaseAuthorization = () => resolve()
    })
    const roots = {
      // `roots.authorize` is the real dependency this test steers: it is where
      // the open sits (root validation touches disk, and a server spawn queues
      // behind it) while the renderer keeps typing. Pausing it reproduces the
      // window exactly, without a sleep.
      authorize: async () => {
        await authorizationPaused
        return '/repo'
      },
    }
    registerLspIpc(manager, roots as never, {} as never)

    const sender = { id: 1, once: () => {}, on: () => {}, isDestroyed: () => false }
    const evt = { sender }

    const open = ipcHandlers.get('lsp:open-document')!(evt, {
      clientUri: 'inmemory://a',
      content: 'first',
      language: 'typescript',
      workspaceRoot: '/repo',
      // null: a virtual document, so authorization is root validation alone and
      // the test does not depend on a file existing on disk. The ordering
      // defect is in the queue, not in what is being authorized.
      filePath: null,
      authorization: { kind: 'editor-root' },
    })

    // The renderer types while authorization is still pending. NOT awaited
    // here: the fix makes this call queue behind the open, so awaiting it
    // before releasing authorization deadlocks the test rather than testing
    // anything. That it no longer resolves early IS the contract — an
    // acknowledgement that arrives before the document exists is the bug.
    const change = ipcHandlers.get('lsp:change-document')!(evt, 'inmemory://a', 'second')
    let changeSettled = false
    void change.then(() => { changeSettled = true }, () => { changeSettled = true })
    await Promise.resolve()
    expect(changeSettled).toBe(false)

    releaseAuthorization?.()
    await open
    await change

    const didOpen = notifications.find(n => n.method === 'textDocument/didOpen')
    const didChange = notifications.filter(n => n.method === 'textDocument/didChange')
    const text = (didChange.at(-1)?.params as { contentChanges?: Array<{ text: string }> })
      ?.contentChanges?.[0]?.text
      ?? (didOpen?.params as { textDocument?: { text: string } })?.textDocument?.text

    // The server must hold what the user last typed. Anything else is the
    // silent loss the issue is about.
    expect(text).toBe('second')
  })

  it('rejects a change whose document never opened, instead of acknowledging it', async () => {
    // The other half of #922: routing the change through the queue fixes the
    // ordering, and the boolean is what stops the silent acknowledgement. When
    // the open ahead of it FAILS, the queued change finds no document — and
    // resolving successfully there is the same lie in a different shape.
    ipcHandlers.clear()
    const { manager } = managerWithServer()

    let failAuthorization: ((err: Error) => void) | undefined
    const authorizationPaused = new Promise<string>((_resolve, reject) => {
      failAuthorization = reject
    })
    registerLspIpc(
      manager,
      { authorize: async () => await authorizationPaused } as never,
      {} as never,
    )

    const sender = { id: 1, once: () => {}, on: () => {}, isDestroyed: () => false }
    const evt = { sender }

    const open = ipcHandlers.get('lsp:open-document')!(evt, {
      clientUri: 'inmemory://a',
      content: 'first',
      language: 'typescript',
      workspaceRoot: '/repo',
      filePath: null,
      authorization: { kind: 'editor-root' },
    })
    const change = ipcHandlers.get('lsp:change-document')!(evt, 'inmemory://a', 'second')

    failAuthorization?.(new Error('root is not authorized'))
    await expect(open).rejects.toThrow('root is not authorized')
    await expect(change).rejects.toThrow('LSP document is not open')
  })
})

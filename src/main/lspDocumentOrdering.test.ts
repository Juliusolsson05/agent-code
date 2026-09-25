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

  it('releases the queue for a SIBLING alias, not only for the one that typed', async () => {
    // #1108 review, 1 — the case the whole of #923 is about, and the one the
    // first fix missed. Monaco gives two surfaces on one disk file two
    // different model URIs on purpose, and both map to ONE server document.
    // The queue that blocks is keyed by that server document; the wake was
    // keyed by client URI. So a request from alias A kept holding the shared
    // queue while the user typed in alias B, and B's didChange waited out the
    // full 15 s.
    //
    // Nothing is lost by abandoning A: when B's change lands,
    // `changeSharedDocument` advances `version` on every alias including A, so
    // A's answer would be rejected by the ticket check anyway. The 15 s bought
    // nobody anything.
    vi.useFakeTimers()
    try {
      const { manager, notifications } = managerWithServer({
        sendRequest: async () => await new Promise(() => {}),
      })
      await manager.openDocument({ ...OPEN, clientUri: 'inmemory://a', content: 'draft A' })
      await manager.openDocument({ ...OPEN, clientUri: 'inmemory://b', content: 'draft B' })
      notifications.length = 0

      const hover = manager.getHover('inmemory://a', { line: 0, character: 0 })
      await vi.advanceTimersByTimeAsync(10)

      // The user types in the OTHER surface.
      const changed = manager.changeDocument('inmemory://b', 'draft B edited')
      let changeSettled = false
      void changed.then(() => { changeSettled = true })
      await vi.advanceTimersByTimeAsync(1_000)

      expect(changeSettled).toBe(true)
      // B's TEXT is what has to have reached the server, not merely some
      // didChange: A's request legitimately emits one of its own when it
      // restores A's draft before asking. Asserting a count would pass on the
      // wrong notification.
      const texts = notifications
        .filter(n => n.method === 'textDocument/didChange')
        .map(n => (n.params as { contentChanges?: Array<{ text: string }> }).contentChanges?.[0]?.text)
      expect(texts).toContain('draft B edited')

      await vi.advanceTimersByTimeAsync(20_000)
      await expect(hover).resolves.toBeNull()
      await changed
    } finally {
      vi.useRealTimers()
    }
  })

  it('releases the queue for a sibling alias being OPENED, not only one already open', async () => {
    // The third way intent arrives on a shared document: a second surface
    // opens the same file while a request from the first is in flight. That
    // open rewrites the shared text (it pushes its own draft), so the answer
    // in flight is doomed just as surely as after a change.
    //
    // `bumpDocumentIntent` cannot fan out for it — the opening URI has no
    // record yet, so there is no `serverDocumentKey` to look up — which is why
    // `openDocumentNow` announces explicitly once it knows the key.
    vi.useFakeTimers()
    try {
      const { manager } = managerWithServer({
        sendRequest: async () => await new Promise(() => {}),
      })
      await manager.openDocument({ ...OPEN, clientUri: 'inmemory://a', content: 'draft A' })

      const hover = manager.getHover('inmemory://a', { line: 0, character: 0 })
      await vi.advanceTimersByTimeAsync(10)

      const opened = manager.openDocument({ ...OPEN, clientUri: 'inmemory://b', content: 'draft B' })
      let openSettled = false
      void opened.then(() => { openSettled = true })
      await vi.advanceTimersByTimeAsync(1_000)

      // Well inside the 15 s request timeout.
      expect(openSettled).toBe(true)
      const internal = manager as unknown as { docs: Map<string, unknown> }
      expect(internal.docs.has('inmemory://b')).toBe(true)

      await vi.advanceTimersByTimeAsync(20_000)
      await expect(hover).resolves.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats a cancelled request answered with an ERROR as a non-answer', async () => {
    // #1108 review, 2. Cancelling an LSP request does not reject it locally —
    // the client only sends `$/cancelRequest` — and the protocol ADVISES a
    // server to answer a cancelled request with an error (`RequestCancelled`,
    // `ContentModified`). With the raw promise in the race, that error became
    // the race's result and was thrown out of `getHover` /
    // `getSemanticTokens` / `getCompletions`. `provideDocumentSemanticTokens`
    // has no catch, and semantic tokens are re-requested on every model
    // change — the request most likely to be abandoned by the debounced
    // didChange right behind it.
    //
    // No fake in this file honours the cancellation token, which is exactly
    // why this was invisible. This one does.
    vi.useFakeTimers()
    try {
      let rejectRequest: ((err: Error) => void) | undefined
      const { manager } = managerWithServer({
        sendRequest: async (_method, _params, token) => await new Promise((_resolve, reject) => {
          rejectRequest = reject
          ;(token as { onCancellationRequested?: (cb: () => void) => void } | undefined)
            ?.onCancellationRequested?.(() => {
              const err = new Error('Request cancelled') as Error & { code?: number }
              err.code = -32800
              reject(err)
            })
        }),
      })
      await manager.openDocument({ ...OPEN, clientUri: 'inmemory://a', content: 'first' })

      const tokens = manager.getSemanticTokens('inmemory://a')
      await vi.advanceTimersByTimeAsync(10)
      expect(rejectRequest).toBeTypeOf('function')

      void manager.changeDocument('inmemory://a', 'second')
      await vi.advanceTimersByTimeAsync(1_000)

      // Null, not a throw. A throw here reaches Monaco's semantic-tokens
      // provider, which has no catch.
      await expect(tokens).resolves.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects a completion a SIBLING alias invalidated, not only one the user typed past', async () => {
    // #1108 review, 4. The ticket comparison in `getCompletions` was untested:
    // removing it left both #923 tests green, because the "typed past" case is
    // already rejected earlier by the epoch guard inside `sendDocRequest`.
    //
    // The ticket is the ONLY thing that rejects a list when a SIBLING's change
    // advanced this document's version without touching this URI's epoch.
    let release: (() => void) | undefined
    const { manager } = managerWithServer({
      sendRequest: async method => {
        if (method !== 'textDocument/completion') return null
        await new Promise<void>(resolve => { release = resolve })
        return [{ label: 'stale', kind: 1 }]
      },
    })
    await manager.openDocument({ ...OPEN, clientUri: 'inmemory://a', content: 'draft A' })
    await manager.openDocument({ ...OPEN, clientUri: 'inmemory://b', content: 'draft B' })

    const pending = manager.getCompletions('inmemory://a', { line: 0, character: 0 }, { triggerKind: 1 })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))

    // The sibling's text is pushed onto the shared document directly, which is
    // what `changeSharedDocument` does when B becomes active — it advances
    // `version` on EVERY alias, including the one mid-request.
    const internal = manager as unknown as {
      docs: Map<string, { version: number }>
      serverDocuments: Map<string, { version: number }>
    }
    for (const doc of internal.docs.values()) doc.version += 1
    release?.()

    await expect(pending).resolves.toEqual({ items: [], incomplete: false })
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

      // Nothing is retired yet: an abandoned request only counts once it has
      // stayed unanswered for the whole request budget (15 s), and the loop
      // above spans about ten seconds.
      expect(server.closed).toBe(false)
      await vi.advanceTimersByTimeAsync(15_000)

      expect(server.closed).toBe(true)
      // Retiring a server drops its documents, exactly as a crash does, so the
      // next open spawns a fresh process rather than talking to a dead one.
      expect(internal.docs.has('inmemory://a')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('#924 fix pass — a busy server is not a wedged one', () => {
  it('lets a split-view edit through when a sibling request is queued behind the one it wakes', async () => {
    // Review round 1 (A1), reproduced as written by the reviewer. B's hover
    // queues behind A's on the shared server document and has not
    // subscribed to intent yet. A's edit wakes A's hover only; B then took
    // the queue and read only B's own (unchanged) epoch, so A's edit waited
    // out the full 15 s: acknowledged at 15,250 ms.
    vi.useFakeTimers()
    try {
      const { manager } = managerWithServer({ sendRequest: async () => await new Promise(() => {}) })
      for (const alias of ['a', 'b']) {
        await manager.openDocument({ ...OPEN, clientUri: `inmemory://${alias}`, content: `draft ${alias}` })
      }
      const first = manager.getHover('inmemory://a', { line: 0, character: 0 })
      await vi.advanceTimersByTimeAsync(1)
      const second = manager.getHover('inmemory://b', { line: 0, character: 0 })
      await vi.advanceTimersByTimeAsync(1)
      let applied = false
      const change = manager.changeDocument('inmemory://a', 'edited A').then(() => { applied = true })
      await vi.advanceTimersByTimeAsync(1_000)
      expect(applied).toBe(true)
      await vi.advanceTimersByTimeAsync(30_000)
      await Promise.all([first, second, change])
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets a sibling edit through when it lands while a request is restoring its draft', async () => {
    // Review round 1 (A1), second entrance: A's request is mid-restore of
    // its own draft (its didChange notification is suspended) when B is
    // edited. A subscribed after B's notification had passed and compared
    // only A's epoch.
    vi.useFakeTimers()
    try {
      const { manager } = managerWithServer({ sendRequest: async () => await new Promise(() => {}) })
      const internal = manager as unknown as {
        sendNotificationIfOpen: (server: unknown, method: string, params: unknown) => Promise<void>
      }
      for (const alias of ['a', 'b']) {
        await manager.openDocument({ ...OPEN, clientUri: `inmemory://${alias}`, content: `draft ${alias}` })
      }
      // B was opened last, so the server holds B's text and A's hover must
      // restore A's draft first. Suspend exactly that notification.
      let releaseRestore: (() => void) | undefined
      const record = internal.sendNotificationIfOpen
      internal.sendNotificationIfOpen = async (server, method, params) => {
        if (method === 'textDocument/didChange' && !releaseRestore) {
          await new Promise<void>(resolve => { releaseRestore = resolve })
        }
        return await record(server, method, params)
      }
      const hover = manager.getHover('inmemory://a', { line: 0, character: 0 })
      await vi.advanceTimersByTimeAsync(1)
      expect(releaseRestore).toBeTypeOf('function')

      let applied = false
      const change = manager.changeDocument('inmemory://b', 'edited B').then(() => { applied = true })
      await vi.advanceTimersByTimeAsync(1)
      releaseRestore?.()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(applied).toBe(true)
      await vi.advanceTimersByTimeAsync(30_000)
      await Promise.all([hover, change])
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets a tab close through while one of its requests is unanswered', async () => {
    // Review round 1 (Pi, 5): closing is the third intent besides change and
    // open, and the user-visible one when a tab is closed mid-hover. It rides
    // the same fan-out, but nothing closed a document with a request in
    // flight, so a close that stopped waking the request would wait 15 s.
    vi.useFakeTimers()
    try {
      const { manager } = managerWithServer({ sendRequest: async () => await new Promise(() => {}) })
      await manager.openDocument({ ...OPEN, clientUri: 'inmemory://a', content: 'text' })
      const hover = manager.getHover('inmemory://a', { line: 0, character: 0 })
      await vi.advanceTimersByTimeAsync(1)
      let closed = false
      const close = manager.closeDocument('inmemory://a').then(() => { closed = true })
      await vi.advanceTimersByTimeAsync(1_000)
      expect(closed).toBe(true)
      await expect(hover).resolves.toBeNull()
      await close
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps no intent bookkeeping for a first open that failed', async () => {
    // Review round 2 (reproduced as written): the shared intent counter was
    // bumped before the server document existed, so a first open whose
    // didOpen hit a destroyed stream left an entry that no close, discard or
    // dispose ever reached, one per failed URI for the manager's lifetime.
    const { manager, server } = managerWithServer()
    const internal = manager as unknown as {
      docs: Map<string, unknown>
      serverDocuments: Map<string, unknown>
      serverDocumentIntentEpochs: Map<string, number>
      sendNotificationIfOpen: (server: unknown, method: string, params: unknown) => Promise<void>
    }
    // The production notification path, with only the connection failing.
    internal.sendNotificationIfOpen = (LspManager.prototype as unknown as {
      sendNotificationIfOpen: typeof internal.sendNotificationIfOpen
    }).sendNotificationIfOpen
    Object.assign(server.connection, {
      sendNotification: async () => {
        throw Object.assign(new Error('stream destroyed'), { code: 'ERR_STREAM_DESTROYED' })
      },
      dispose: () => {},
    })
    expect(await manager.openDocument({ ...OPEN, clientUri: 'inmemory://failed-open', content: 'draft' })).toBe(false)
    expect(internal.docs.size).toBe(0)
    expect(internal.serverDocuments.size).toBe(0)
    await manager.closeDocument('inmemory://failed-open')
    expect(internal.serverDocumentIntentEpochs.size).toBe(0)
  })

  it('stops counting an abandoned request once the server finally answers it', async () => {
    // Review round 1 (A2): the slow-server test answers before the 15 s
    // stuck-check fires, so deleting the decrement for an ALREADY-counted
    // request survived. Without it, non-overlapping slow requests would
    // accumulate and retire a server that never had more than one stuck.
    vi.useFakeTimers()
    try {
      let answer: ((value: null) => void) | undefined
      const { manager, server } = managerWithServer({
        sendRequest: async () => await new Promise(resolve => { answer = resolve }),
      })
      await manager.openDocument({ ...OPEN, clientUri: 'inmemory://a', content: 'text' })
      const hover = manager.getHover('inmemory://a', { line: 0, character: 0 })
      await vi.advanceTimersByTimeAsync(1)
      void manager.changeDocument('inmemory://a', 'text 2')
      await vi.advanceTimersByTimeAsync(15_300)
      await expect(hover).resolves.toBeNull()
      expect(server.abandonedRequests).toBe(1)

      answer?.(null)
      await vi.advanceTimersByTimeAsync(1)
      expect(server.abandonedRequests).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('actually tells the server to cancel a request a newer edit abandoned', async () => {
    // Review round 1 (A3): the error-answer test passes through the grace
    // timeout even when no cancellation is sent, so removing
    // `cancellation.cancel()` survived. An unsent cancel leaves obsolete
    // work running on the server.
    vi.useFakeTimers()
    try {
      let cancelled = false
      const { manager } = managerWithServer({
        sendRequest: async (_method, _params, token) => {
          ;(token as { onCancellationRequested: (listener: () => void) => void })
            .onCancellationRequested(() => { cancelled = true })
          return await new Promise(() => {})
        },
      })
      await manager.openDocument({ ...OPEN, clientUri: 'inmemory://a', content: 'text' })
      const hover = manager.getHover('inmemory://a', { line: 0, character: 0 })
      await vi.advanceTimersByTimeAsync(1)
      void manager.changeDocument('inmemory://a', 'text 2')
      await vi.advanceTimersByTimeAsync(300)
      await expect(hover).resolves.toBeNull()
      expect(cancelled).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never retires a slow server that answers every abandoned request', async () => {
    // A server still indexing can be several seconds behind, and every
    // keystroke abandons the request in flight. The first cut counted an
    // abandonment 250 ms after the cancel, so a server answering each request
    // after 12 s had ~40 "abandoned" at once and was retired after a few
    // seconds of typing, silently turning LSP off for the open editors. It
    // answered every one of them.
    vi.useFakeTimers()
    try {
      const { manager, server } = managerWithServer({
        sendRequest: async () => await new Promise(resolve => setTimeout(() => resolve(null), 12_000)),
      })
      await manager.openDocument({ ...OPEN, clientUri: 'inmemory://a', content: 'text' })

      for (let attempt = 0; attempt < 40; attempt++) {
        const request = manager.getHover('inmemory://a', { line: 0, character: 0 })
        await vi.advanceTimersByTimeAsync(1)
        void manager.changeDocument('inmemory://a', `text ${attempt}`)
        await vi.advanceTimersByTimeAsync(300)
        await expect(request).resolves.toBeNull()
      }
      await vi.advanceTimersByTimeAsync(30_000)

      expect(server.closed).toBe(false)
      expect(server.abandonedRequests).toBe(0)
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

  it('rejects a change for a document that WAS open and is now gone', async () => {
    // The other half of #922. Routing the change through the queue fixes the
    // ordering; the boolean is what stops the silent acknowledgement when the
    // document the renderer is editing has disappeared underneath it.
    ipcHandlers.clear()
    const { manager, server } = managerWithServer()
    registerLspIpc(manager, { authorize: async () => '/repo' } as never, {} as never)

    const sender = { id: 1, once: () => {}, on: () => {}, isDestroyed: () => false }
    const evt = { sender }
    await ipcHandlers.get('lsp:open-document')!(evt, {
      clientUri: 'inmemory://a',
      content: 'first',
      language: 'typescript',
      workspaceRoot: '/repo',
      filePath: null,
      authorization: { kind: 'editor-root' },
    })

    // The server dies, exactly as a crash does: its documents go with it.
    ;(manager as unknown as { discardServer: (s: unknown, kill?: boolean) => void })
      .discardServer(server, false)

    await expect(ipcHandlers.get('lsp:change-document')!(evt, 'inmemory://a', 'second'))
      .rejects.toThrow('LSP document is not open')
  })

  it('resolves a change for a language with no server, because that is fail open', async () => {
    // #1108 review, 3. "No document" is also the ORDINARY state for a language
    // whose server binary is not installed — the registry documents that as
    // fail open: "the editor works without LSP for that language". Rejecting
    // there turns a documented no-op into a rejection on every debounced
    // change, and the renderer's coalescing gate never advances its synced
    // version, so every later hover and completion re-issues a doomed round
    // trip instead of one no-op per version.
    ipcHandlers.clear()
    const { manager } = managerWithServer()
    // No server for this language: `getOrCreateServer` answers null, which is
    // what a missing binary produces.
    ;(manager as unknown as { getOrCreateServer: () => Promise<null> }).getOrCreateServer = async () => null
    registerLspIpc(manager, { authorize: async () => '/repo' } as never, {} as never)

    const sender = { id: 1, once: () => {}, on: () => {}, isDestroyed: () => false }
    const evt = { sender }
    await ipcHandlers.get('lsp:open-document')!(evt, {
      clientUri: 'inmemory://none',
      content: 'first',
      language: 'typescript',
      workspaceRoot: '/repo',
      filePath: null,
      authorization: { kind: 'editor-root' },
    })

    await expect(ipcHandlers.get('lsp:change-document')!(evt, 'inmemory://none', 'second'))
      .resolves.toBeUndefined()
  })
})

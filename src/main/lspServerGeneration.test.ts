import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

import { LspManager } from './lspManager.js'

// ---------------------------------------------------------------------------
// #921. A server's `key` is derived from the language spec and the workspace
// root, so a replacement spawned after a crash REUSES it. `discardServer`
// already knew that for the registry — it compares object identity — but it
// deleted `docs` and `serverDocuments` by `key`.
//
// So a late callback from the DEAD server (`exit`, a destroyed-stream error, a
// rejected `initialized`) deleted the REPLACEMENT server's documents. The
// editor is attached to a healthy new server, its documents vanish with
// diagnostics cleared, and the server still holds them open — nothing
// re-opens them until the editor remounts, so completions and diagnostics
// simply stop for a file that is on screen and fine.
//
// Driven against the real `discardServer` with two real record shapes,
// because the bug is precisely about telling two records with the same key
// apart.
// ---------------------------------------------------------------------------

type ServerLike = {
  key: string
  generation: string
  closed: boolean
  connection: { dispose: () => void }
  process: EventEmitter & { killed: boolean; kill: () => void }
}

type Internals = {
  docs: Map<string, Record<string, unknown>>
  serverDocuments: Map<string, Record<string, unknown>>
  servers: Map<string, unknown>
  documentIntentEpochs: Map<string, unknown>
  discardServer: (server: ServerLike, kill?: boolean) => void
}

function serverRecord(key: string, generation: string): ServerLike {
  const process = Object.assign(new EventEmitter(), { killed: false, kill: () => {} })
  return { key, generation, closed: false, connection: { dispose: () => {} }, process }
}

/** The two records a single open document occupies. */
function openDocument(internal: Internals, clientUri: string, server: ServerLike) {
  const serverUri = clientUri
  const sharedKey = `${server.key}\0${serverUri}`
  internal.serverDocuments.set(sharedKey, {
    key: sharedKey,
    serverKey: server.key,
    serverGeneration: server.generation,
    serverUri,
    language: 'typescript',
    version: 1,
    refs: 1,
    content: 'text',
    activeClientUri: clientUri,
  })
  internal.docs.set(clientUri, {
    clientUri,
    serverKey: server.key,
    serverGeneration: server.generation,
    serverUri,
    serverDocumentKey: sharedKey,
    version: 1,
    language: 'typescript',
    refs: 1,
    content: 'text',
    completionItems: new Map(),
  })
}

describe('a dead server never takes its replacement\'s documents (#921)', () => {
  it('leaves the replacement\'s documents alone', async () => {
    const manager = new LspManager()
    const internal = manager as unknown as Internals

    // The crash-and-respawn sequence: same key, different process.
    const dead = serverRecord('typescript\0/repo', 'gen-1')
    const live = serverRecord('typescript\0/repo', 'gen-2')
    internal.servers.set(live.key, live)
    openDocument(internal, 'file:///repo/live.ts', live)

    const cleared: string[] = []
    manager.on('diagnostics', (event: { clientUri: string }) => { cleared.push(event.clientUri) })

    // A late callback from the server that already died.
    internal.discardServer(dead, false)

    expect(internal.docs.has('file:///repo/live.ts')).toBe(true)
    expect(internal.serverDocuments.size).toBe(1)
    // …and the editor is not told its diagnostics are gone.
    expect(cleared).toEqual([])
    // The live server keeps the registry entry, because it owns the key now.
    expect(internal.servers.get(live.key)).toBe(live)
  })

  it('still disposes the DEAD server\'s own resources', async () => {
    // Fencing the shared records must not make the dead server immortal: its
    // connection and process are its own, and leaving them is a leak whoever
    // holds the key.
    const manager = new LspManager()
    const internal = manager as unknown as Internals
    const dead = serverRecord('typescript\0/repo', 'gen-1')
    const live = serverRecord('typescript\0/repo', 'gen-2')
    internal.servers.set(live.key, live)
    const dispose = vi.fn()
    const kill = vi.fn()
    dead.connection.dispose = dispose
    dead.process.kill = kill

    internal.discardServer(dead)

    expect(dispose).toHaveBeenCalledTimes(1)
    expect(kill).toHaveBeenCalledTimes(1)
    expect(dead.closed).toBe(true)
    // The live server is untouched.
    expect(live.closed).toBe(false)
  })

  it('DOES clean up its own documents when no replacement exists', async () => {
    // The behaviour that must survive: a server dying with its own documents
    // open still clears them and tells the editor, or the file keeps stale
    // diagnostics from a process that is gone.
    const manager = new LspManager()
    const internal = manager as unknown as Internals
    const dead = serverRecord('typescript\0/repo', 'gen-1')
    internal.servers.set(dead.key, dead)
    openDocument(internal, 'file:///repo/own.ts', dead)
    internal.documentIntentEpochs.set('file:///repo/own.ts', 1)

    const cleared: string[] = []
    manager.on('diagnostics', (event: { clientUri: string }) => { cleared.push(event.clientUri) })

    internal.discardServer(dead, false)

    expect(internal.docs.size).toBe(0)
    expect(internal.serverDocuments.size).toBe(0)
    expect(internal.documentIntentEpochs.size).toBe(0)
    expect(cleared).toEqual(['file:///repo/own.ts'])
    expect(internal.servers.has(dead.key)).toBe(false)
  })

  it('separates two generations\' documents in the same sweep', async () => {
    // Both servers have documents open under the same key. Only the dying
    // one's may go.
    const manager = new LspManager()
    const internal = manager as unknown as Internals
    const dead = serverRecord('typescript\0/repo', 'gen-1')
    const live = serverRecord('typescript\0/repo', 'gen-2')
    internal.servers.set(live.key, live)
    openDocument(internal, 'file:///repo/dead.ts', dead)
    openDocument(internal, 'file:///repo/live.ts', live)

    internal.discardServer(dead, false)

    expect([...internal.docs.keys()]).toEqual(['file:///repo/live.ts'])
    expect([...internal.serverDocuments.values()].map(doc => doc.serverGeneration))
      .toEqual(['gen-2'])
  })
})

describe('the fence is only as good as the generation', () => {
  it('never hands two servers the same identity', async () => {
    // The whole mechanism collapses if a replacement can share its
    // predecessor's generation — the fence would be back to matching on
    // something reusable, which is the bug. `createServer` cannot be driven
    // without spawning a real language server, so the invariant is pinned at
    // the one function that decides it.
    const { nextServerGeneration } = await import('./lspManager.js')
    const seen = new Set(Array.from({ length: 64 }, () => nextServerGeneration()))
    expect(seen.size).toBe(64)
  })
})

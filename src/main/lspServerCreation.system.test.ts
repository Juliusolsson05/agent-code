import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node'

// ---------------------------------------------------------------------------
// #921, at the site that actually decides it.
//
// The generation fence is only as good as the value `createServer` stamps on
// each `ServerRecord`. Review proved that mattered: with the record built as
// `generation: key` — the reusable `<root>::<spec>` composite — the fence
// degenerates to the pre-PR key comparison and the whole bug returns, with
// every main-process test green. An exported `nextServerGeneration` protected
// the FUNCTION and not its only call site.
//
// So this drives the real `createServer`. `spawn` is faked with a pair of
// pipes and a real vscode-jsonrpc peer on the far end answering `initialize`,
// because the thing under test is the record the real code builds — not a
// hand-written literal that can agree with itself.
// ---------------------------------------------------------------------------

type FakeChild = EventEmitter & {
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  killed: boolean
  kill: () => void
}

const spawned: FakeChild[] = []

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process')
  return {
    ...actual,
    spawn: () => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        killed: false,
        kill(): void { this.killed = true },
      }) as FakeChild
      spawned.push(child)
      // The far end of the pipes: a real JSON-RPC peer, so `initialize`
      // resolves the way it does against a real language server.
      const peer = createMessageConnection(
        new StreamMessageReader(child.stdin),
        new StreamMessageWriter(child.stdout),
      )
      peer.onRequest('initialize', () => ({ capabilities: {} }))
      peer.onNotification(() => {})
      peer.listen()
      return child
    },
  }
})

const { LspManager } = await import('./lspManager.js')

type Internals = {
  createServer: (rootAbs: string, key: string, spec: unknown) => Promise<{ key: string; generation: string } | null>
}

const spec = {
  id: 'typescript',
  languages: ['typescript'],
  resolveCommand: async () => ({ command: 'node', args: [], env: {} }),
}

afterEach(() => { spawned.length = 0 })

describe('every server process gets its own identity (#921)', () => {
  it('does not derive the generation from the reusable key', async () => {
    // THE REGRESSION. `<root>::<spec>` is reused by every replacement, so a
    // generation derived from it cannot tell a dead server from the live one
    // that took its place — which is the entire bug.
    const manager = new LspManager()
    const internal = manager as unknown as Internals
    const key = '/repo::typescript'
    const record = await internal.createServer('/repo', key, spec)

    expect(record).not.toBeNull()
    expect(record!.key).toBe(key)
    expect(record!.generation).not.toBe(key)
    expect(record!.generation).not.toBe(record!.key)
  })

  it('gives a replacement a different identity from its predecessor', async () => {
    // Same root, same spec, same key — which is exactly the crash-and-respawn
    // sequence. If these two ever matched, `discardServer` would sweep the
    // live server's documents again.
    const manager = new LspManager()
    const internal = manager as unknown as Internals
    const key = '/repo::typescript'
    const first = await internal.createServer('/repo', key, spec)
    const second = await internal.createServer('/repo', key, spec)

    expect(first!.generation).not.toBe(second!.generation)
    expect(first!.key).toBe(second!.key)
  })

  it('really spawned, so the assertions above are about the real record', async () => {
    // Without this, a `createServer` that bailed early would satisfy
    // "generations differ" vacuously.
    const manager = new LspManager()
    const internal = manager as unknown as Internals
    await internal.createServer('/repo', '/repo::typescript', spec)
    expect(spawned).toHaveLength(1)
  })
})

describe('initialized reaches the server that initialized (#1078 review, 4)', () => {
  it('does not hand it to whoever holds the key now', async () => {
    // The lookup was `this.servers.get(key)`, and the key is reused — so the
    // notification could land on a DIFFERENT process than the one that just
    // answered `initialize`. `record` is in scope one line below.
    const manager = new LspManager()
    const internal = manager as unknown as Internals & {
      sendNotificationIfOpen: (server: { generation: string }, method: string, params: unknown) => Promise<void>
      servers: Map<string, unknown>
    }
    const notified: string[] = []
    internal.sendNotificationIfOpen = async server => { notified.push(server.generation) }

    const key = '/repo::typescript'
    const first = await internal.createServer('/repo', key, spec)
    // A replacement takes the key, exactly as a crash-and-respawn does.
    const second = await internal.createServer('/repo', key, spec)
    internal.servers.set(key, second as unknown)

    await new Promise(resolve => setTimeout(resolve, 20))
    expect(notified).toEqual([first!.generation, second!.generation])
  })
})

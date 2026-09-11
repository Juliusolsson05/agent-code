import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakePty, ReplayServer } from 'opencode-terminal-headless/testing'

// Electron's node-pty cannot load under the Node runner. Only that process
// boundary is replaced; submission still crosses the real package and HTTP.
vi.mock('node-pty', () => ({ spawn: vi.fn() }))

import { OpencodeTerminalSession } from './opencodeTerminalSession.js'
import { deliverOpencodePrompt } from './promptDelivery.js'

class BootingPty extends FakePty {
  kill() { this.exit(0, 15) }
  // No paint: the old PTY grace could never complete in this boot state.
  onData() { return { dispose() {} } }
}

const SESSION = 'ses_prompt_delivery'
const PROMPT_PATH = `/session/${SESSION}/prompt_async`
const credentials = { username: 'opencode', password: 'prompt-replay' }
let dir = ''
let cleanups: Array<() => void | Promise<void>> = []
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oc-prompt-adapter-'))
  cleanups = [() => rmSync(dir, { recursive: true, force: true })]
})
afterEach(async () => {
  const failures: unknown[] = []
  for (const cleanup of cleanups.reverse()) {
    try { await cleanup() } catch (error) { failures.push(error) }
  }
  if (failures.length) throw new AggregateError(failures)
})

async function waitFor(predicate: () => boolean, label: string) {
  const deadline = performance.now() + 4_000
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(`Timed out: ${label}`)
    await new Promise(resolve => setImmediate(resolve))
  }
}

async function start(refusing = false) {
  const server = new ReplayServer(credentials)
  cleanups.push(() => server.close())
  await server.listen()
  server.setRefusing(refusing)
  const pty = new BootingPty()
  const session = new OpencodeTerminalSession({ cwd: dir, resumeSessionId: SESSION }, {
    spawnPty: (() => pty) as never,
    prepareLaunch: async opts => ({
      binary: opts.binary, args: [], env: opts.env, sessionID: SESSION,
      server: { url: server.url, ...credentials }, dbPath: null,
    }),
    headlessOptions: { heartbeatMs: 0, liveConnectDeadlineMs: 500, sseInitialBackoffMs: 10, sseMaxBackoffMs: 20 },
  })
  cleanups.push(() => session.stop())
  const readiness: boolean[] = []
  session.on('input-readiness', event => readiness.push(event.ready))
  await session.start()
  const deliver = (prompt: string) => deliverOpencodePrompt({ sessionId: 'pane', prompt, session, write: vi.fn() })
  return { server, pty, session, readiness, deliver }
}

describe('OpenCode terminal server-acknowledged prompt delivery', () => {
  it('posts the exact prompt while a booting TUI has not painted or armed its PTY grace', async () => {
    const { server, pty, readiness, deliver } = await start()
    await expect(deliver('one\ntwo')).resolves.toMatchObject({ ok: true, acceptance: { kind: 'transport' } })
    expect(server.calls.filter(call => call.method === 'POST')).toEqual([{
      method: 'POST', path: PROMPT_PATH, authorized: true,
      body: '{"parts":[{"type":"text","text":"one\\ntwo"}]}',
    }])
    expect(readiness).toEqual([false])
    expect(pty.writes).toEqual([])
  })

  it('waits through server startup without losing or duplicating the prompt', async () => {
    const { server, pty, deliver } = await start(true)
    let settled = false
    const pending = deliver('queued during boot').finally(() => { settled = true })
    await waitFor(() => server.calls.some(call => call.path === '/event'), 'connection attempt')
    expect(settled).toBe(false)
    expect(server.calls.filter(call => call.method === 'POST')).toEqual([])
    server.setRefusing(false)
    await expect(pending).resolves.toMatchObject({ ok: true })
    expect(server.calls.filter(call => call.method === 'POST')).toEqual([{
      method: 'POST', path: PROMPT_PATH, authorized: true,
      body: '{"parts":[{"type":"text","text":"queued during boot"}]}',
    }])
    expect(pty.writes).toEqual([])
  })

  it('reports an unreachable server as retry-safe without writing a prompt', async () => {
    const { server, pty, deliver } = await start(true)
    await expect(deliver('retry later')).resolves.toMatchObject({
      ok: false, code: 'not-ready', stage: 'before-write', retrySafe: true,
      disposition: 'retry-same-session', promptWritten: false, enterWritten: false,
    })
    expect(server.calls.filter(call => call.method === 'POST')).toEqual([])
    expect(pty.writes).toEqual([])
  })

  it('reports server rejection as non-retry-safe and submits only once', async () => {
    const { server, pty, deliver } = await start()
    server.setFailing(PROMPT_PATH, true)
    await expect(deliver('rejected prompt')).resolves.toMatchObject({
      ok: false, retrySafe: false, disposition: 'do-not-retry', message: expect.stringContaining('500'),
    })
    expect(server.calls.filter(call => call.method === 'POST')).toHaveLength(1)
    expect(pty.writes).toEqual([])
  })

  it('returns a retry-safe failure when the live channel stops during startup waiting', async () => {
    const { session, server, pty, deliver } = await start(true)
    const pending = deliver('cancelled while starting')
    await waitFor(() => server.calls.some(call => call.path === '/event'), 'startup connection attempt')
    await session.stop()
    await expect(pending).resolves.toMatchObject({ ok: false, code: 'not-ready', retrySafe: true, promptWritten: false })
    expect(server.calls.filter(call => call.method === 'POST')).toEqual([])
    expect(pty.writes).toEqual([])
  })

  it('reports a stopped instance as retry-safe without a PTY fallback', async () => {
    const { session, server, pty, deliver } = await start()
    await session.stop()
    await expect(deliver('after stop')).resolves.toMatchObject({ ok: false, code: 'not-ready', retrySafe: true, promptWritten: false })
    expect(server.calls.filter(call => call.method === 'POST')).toEqual([])
    expect(pty.writes).toEqual([])
  })
})

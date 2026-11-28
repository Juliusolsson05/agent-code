import { once } from 'node:events'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { AntigravityTerminalSession } from './antigravityTerminalSession.js'

// Exercise the two real process boundaries: a short-lived ACP stdio process allocates an
// identity, followed by an interactive child with a real PTY in the chosen working directory.
const requestedId = '11111111-1111-4111-8111-111111111111'
const agy = String.raw`#!/usr/bin/env node
const args = process.argv.slice(2)
if (args[0] === 'acp') {
  require('node:readline').createInterface({input:process.stdin}).on('line', line => {
    const req = JSON.parse(line)
    if (process.env.AGY_TEST_AUTH === 'hang') return
    const err = req.method === 'session/new' && process.env.AGY_TEST_AUTH === 'missing'
    console.log(JSON.stringify({jsonrpc:'2.0', id:req.id, ...(err
      ? {error:{code:-32000,message:'Authentication required'}}
      : {result:req.method === 'initialize' ? {protocolVersion:1} : {sessionId:'allocated-in-this-pane'}})}))
  })
} else {
  const log = args[1]
  if (args[0] !== '--log-file' || !require('node:fs').statSync(log).isFIFO()) process.exit(3)
  const fs = require('node:fs')
  const id = args[3]
  const record = (severity, text) => fs.appendFileSync(log, severity + '1127 18:00:58.732484    1235 ' + text + '\n')
  const stream = id => record('I', 'conversation_manager.go:1282] Streaming conversation ' + id)
  if (id) {
    fs.writeFileSync('launch-pipe-path', log)
    switch (process.env.AGY_TEST_ACK) {
      case 'hold': {
        // A listing mentioning the exact target also occurs for conversations merely browsed.
        record('I', 'server.go:3530] GetConversationDetail: found conversation ' + id + ' (active=false)')
        const timer = setInterval(() => {
          if (!fs.existsSync('confirm-resume')) return
          clearInterval(timer)
          stream(id)
        }, 10)
        break
      }
      case 'other': stream('00000000-0000-0000-0000-000000000004'); break
      case 'refused': record('W', 'projectresolve.go:74] Conversation ' + id + ' not found, ignoring --conversation flag'); break
      case 'exit': process.exit(3); break
      default: stream(id)
    }
  }
  process.stdin.setRawMode(true)
  process.stdout.write('TUI:' + JSON.stringify(args.slice(2)) + ':' + process.stdout.columns + 'x' + process.stdout.rows)
  process.stdout.on('resize', () => process.stdout.write('SIZE:' + process.stdout.columns + 'x' + process.stdout.rows))
  process.stdin.on('data', d => {
    if (d.toString() === 'q') return process.exit(0)
    if (d.toString() === 'n') {
      const prefix = 'I1127 18:00:58.732484    1235 '
      require('node:fs').appendFileSync(log, prefix + 'server.go:3530] GetConversationDetail: found conversation 00000000-0000-0000-0000-000000000001 (active=false)\n'
        + 'x'.repeat(300) + prefix + 'conversation_manager.go:1282] Streaming conversation 00000000-0000-0000-0000-000000000002\n'
        + prefix + 'conversation_manager.go:1282] Streaming conversation 00000000-0000-0000-0000-000000000003\n')
    }
    process.stdout.write('INPUT:' + d.toString())
  })
}`

let cwd: string
let binary: string
let session: AntigravityTerminalSession | undefined
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'agent-code-agy-terminal-'))
  binary = join(cwd, 'fake agy')
  await writeFile(binary, agy, { mode: 0o755 })
})
afterEach(async () => {
  await session?.stop()
  await rm(cwd, { recursive: true, force: true })
})

it.each([
  { resume: undefined, auth: 'present', id: 'allocated-in-this-pane' },
  { resume: requestedId, auth: 'missing', id: requestedId },
  { resume: undefined, auth: 'missing', id: null },
  { resume: undefined, auth: 'hang', id: null },
])('opens native agy with resume=$resume and auth=$auth', async ({ resume, auth, id }) => {
  const conversations = join(cwd, '.gemini', 'antigravity-cli', 'conversations')
  if (resume) {
    await mkdir(conversations, { recursive: true })
    await writeFile(join(conversations, resume + '.db'), '')
  }
  session = new AntigravityTerminalSession({ binary, cwd, resumeSessionId: resume, env: { GEMINI_CLI_HOME: cwd, AGY_TEST_AUTH: auth } }, { prepareTimeoutMs: auth === 'hang' ? 300 : 5000 })
  const changes: string[] = []
  session.on('provider-session-changed', event => changes.push(event.providerSessionId))
  let output = ''
  session.on('pty-data', chunk => { output += chunk })
  expect(session.write('x')).toBe(false)
  session.resize(90, 30)
  await session.start()
  await vi.waitFor(() => expect(output).toContain('TUI:' + JSON.stringify(id ? ['--conversation', id] : []) + ':90x30'))
  expect(session.getProviderSessionId()).toBe(id)
  expect(session.getProcessPid()).toBeGreaterThan(0)
  expect(session.write('x')).toBe(true)
  await vi.waitFor(() => expect(output).toContain('INPUT:x'))
  session.resize(101, 40)
  await vi.waitFor(() => expect(output).toContain('SIZE:101x40'))
  expect(changes).toEqual([])
  session.write('n')
  await vi.waitFor(() => expect(changes).toEqual(['00000000-0000-0000-0000-000000000003']))
  expect(session.getProviderSessionId()).toBe(changes[0])
  const exit = once(session, 'exit')
  session.write('q')
  expect(await exit).toMatchObject([{ exitCode: 0 }])
  expect(session.isExited()).toBe(true)
  expect(session.write('x')).toBe(false)
})

it('does not start a terminal when the pane closes during identity allocation', async () => {
  let finish!: (id: string) => void
  const allocate = vi.fn(() => new Promise<string>(resolve => { finish = resolve }))
  session = new AntigravityTerminalSession({ binary, cwd }, { allocate })
  const starting = session.start()
  await session.stop()
  finish('unused')
  await starting
  expect(session.getProcessPid()).toBeNull()
  expect(session.isExited()).toBe(true)
})


it('rejects a missing explicit conversation before creating its replacement terminal', async () => {
  const started = vi.fn()
  session = new AntigravityTerminalSession({ binary, cwd, resumeSessionId: 'removed', env: { GEMINI_CLI_HOME: cwd } })
  session.on('started', started)
  await expect(session.start()).rejects.toThrow('conversation is unavailable')
  expect(started).not.toHaveBeenCalled()
  expect(session.getProcessPid()).toBeNull()
  expect(session.getProviderSessionId()).toBeNull()
})


async function prepareExplicit(ack: string, resumeTimeoutMs: number) {
  const conversations = join(cwd, '.gemini', 'antigravity-cli', 'conversations')
  await mkdir(conversations, { recursive: true })
  await writeFile(join(conversations, requestedId + '.db'), '')
  session = new AntigravityTerminalSession({
    binary, cwd, resumeSessionId: requestedId,
    env: { GEMINI_CLI_HOME: cwd, AGY_TEST_ACK: ack },
  }, { resumeTimeoutMs })
  return session
}

it('waits for the exact native selection before publishing identity, readiness or started', async () => {
  const candidate = await prepareExplicit('hold', 3000)
  const start = vi.fn()
  const ready = vi.fn()
  candidate.on('started', start)
  candidate.on('input-readiness', input => { if (input.ready) ready() })
  const painted = once(candidate, 'pty-data')
  const completion = candidate.start()
  await painted
  expect(start).not.toHaveBeenCalled()
  expect(ready).not.toHaveBeenCalled()
  expect(candidate.getProviderSessionId()).toBeNull()
  await writeFile(join(cwd, 'confirm-resume'), '')
  await completion
  expect(start).toHaveBeenCalledOnce()
  expect(ready).toHaveBeenCalledOnce()
  expect(candidate.getProviderSessionId()).toBe(requestedId)
})

it.each([
  ['other', 'different conversation'],
  ['refused', 'unavailable'],
  ['exit', 'exited'],
  ['hold', 'timed out'],
  ['cancel', 'cancelled'],
])('disposes only the unconfirmed candidate on %s', async (mode, expected) => {
  const candidate = await prepareExplicit(mode === 'cancel' ? 'hold' : mode, mode === 'hold' ? 600 : 3000)
  const started = vi.fn()
  candidate.on('started', started)
  const painted = mode === 'cancel' ? once(candidate, 'pty-data') : null
  const outcome = candidate.start().then(() => 'started', error => (error as Error).message)
  if (painted) { await painted; await candidate.stop() }
  expect(await outcome).toContain(expected)
  expect(started).not.toHaveBeenCalled()
  expect(candidate.getProviderSessionId()).toBeNull()
  expect(candidate.getProcessPid()).toBeNull()
  const fifo = await readFile(join(cwd, 'launch-pipe-path'), 'utf8')
  await expect(access(fifo)).rejects.toMatchObject({ code: 'ENOENT' })
})

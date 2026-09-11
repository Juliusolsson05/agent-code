import { appendFileSync } from 'node:fs'
import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { IPty } from 'node-pty'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const spawn = vi.hoisted(() => vi.fn())
vi.mock('node-pty', () => ({ spawn }))

import { getProjectDirForCwd } from 'claude-code-headless'
import { loadInitialHistoryChunk } from '@main/sessions/historyLoader'
import { getHostTranscriptAdapter } from '@main/providerSwitch/transcriptEngine'
import { resolveTranscriptPaths } from '@main/sessions/transcriptPaths'
import { ClaudeSession } from './claudeSession'
import { deliverClaudePrompt } from './promptDelivery'

const ID = '22222222-2222-4222-8222-222222222222'
const PROMPT = 'Review the worktree changes'
const RULE = '─'.repeat(70)
let root: string
let cwd: string
let worktree: string
const sessions: ClaudeSession[] = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'claude-host-relocation-'))
  cwd = join(root, 'project'); worktree = join(cwd, '.worktrees', 'feature')
  await mkdir(worktree, { recursive: true })
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'claude-config'))
  spawn.mockReset()
})
afterEach(async () => {
  try { await Promise.all(sessions.splice(0).map(session => session.stop())) }
  finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) }
})
async function pathFor(directory: string): Promise<string> {
  const file = join(await getProjectDirForCwd(directory), `${ID}.jsonl`)
  await mkdir(dirname(file), { recursive: true }); return file
}
function user(uuid: string, text = PROMPT, timestamp = new Date(1_000).toISOString()): string {
  return JSON.stringify({ type: 'user', uuid, sessionId: ID, timestamp, message: { role: 'user', content: text } }) + '\n'
}
function relocated(): string {
  return JSON.stringify({ type: 'relocated', sessionId: ID, relocatedCwd: worktree }) + '\n'
}
async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 4_000
  while (!predicate() && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
  expect(predicate()).toBe(true)
}

// Only the OS/provider process boundary is simulated. The real ClaudeSession,
// headless package, disk tailer, screen parser and durable acceptance protocol
// run together. In particular, no test calls private acceptance methods or
// manufactures a successful delivery result, which would miss this regression.
function provider(getTranscript: () => string): IPty & { paint(): void; writes: string[] } {
  const listeners = new Set<(data: string) => void>()
  let draft = ''
  const writes: string[] = []
  const paint = () => {
    for (const listener of listeners) listener('\x1b[2J\x1b[H' + [RULE, `❯ ${draft}`, RULE].join('\r\n'))
  }
  return {
    pid: 98765, process: 'fixture', cols: 100, rows: 30, handleFlowControl: false, writes, paint,
    onData(listener) { listeners.add(listener); return { dispose: () => listeners.delete(listener) } },
    onExit: () => ({ dispose() {} }),
    write(input) {
      const data = typeof input === 'string' ? input : input.toString('utf8')
      writes.push(data)
      if (data === '\r') {
        appendFileSync(getTranscript(), user('new-user', draft, new Date().toISOString()))
        draft = ''
      } else draft += data.replace(/\x1b\[20[01]~/g, '')
      paint()
    },
    resize() {}, clear() {}, pause() {}, resume() {}, kill() {},
  }
}

describe('Claude worktree transcript host integration', () => {
  it('loads relocated history through the provider public resolver', async () => {
    await writeFile(await pathFor(worktree), relocated() + user('historical-user'))
    const result = await loadInitialHistoryChunk({ kind: 'claude', cwd, providerSessionId: ID, limit: 20 })
    expect(result.entries.filter(entry => entry.type === 'user').map(entry => entry.uuid)).toEqual(['historical-user'])
  })

  it('surfaces a missing resumed transcript instead of reporting healthy empty history', async () => {
    await expect(loadInitialHistoryChunk({ kind: 'claude', cwd, providerSessionId: ID, limit: 20 }))
      .rejects.toThrow(/transcript.*not found/i)
  })

  it('returns available transcripts when another active-tab transcript is missing', async () => {
    await writeFile(await pathFor(worktree), relocated() + user('historical-user'))
    const request = { kind: 'claude' as const, cwd, providerSessionId: ID, sessionId: 'available' }
    expect(await resolveTranscriptPaths([
      request,
      { ...request, sessionId: 'missing', providerSessionId: '33333333-3333-4333-8333-333333333333' },
    ])).toMatchObject([
      { sessionId: 'available', exists: true },
      { sessionId: 'missing', transcriptPath: null, exists: false },
    ])
  })

  it('loads and resumes legacy fork ancestry while accepting only a new live prompt', async () => {
    const file = await pathFor(cwd)
    const ancestor = { ...JSON.parse(user('ancestor')), sessionId: 'source-session' }
    const leaf = { ...JSON.parse(user('fork-leaf')), parentUuid: ancestor.uuid }
    await writeFile(file, JSON.stringify(ancestor) + '\n' + JSON.stringify(leaf) + '\n')
    const history = await loadInitialHistoryChunk({ kind: 'claude', cwd, providerSessionId: ID, limit: 20 })
    expect(history.entries.map(entry => entry.uuid)).toEqual(['ancestor', 'fork-leaf'])
    const pty = provider(() => file); spawn.mockReturnValue(pty)
    const session = new ClaudeSession({ cwd, resumeSessionId: ID, binary: 'fixture', useProxy: false, snapshotIntervalMs: 1 })
    sessions.push(session)
    const errors: unknown[] = []; session.on('jsonl-error', error => errors.push(error))
    await session.start(); pty.paint()
    await waitFor(() => session.isPromptAcceptanceReady())
    const result = await deliverClaudePrompt({
      sessionId: 'fork-app-session', session, prompt: PROMPT,
      write: data => { session.write(data); return true },
    })
    expect(result).toMatchObject({ ok: true, acceptance: { kind: 'user', entryId: 'new-user' } })
    expect(pty.writes.filter(write => write === '\r')).toHaveLength(1)
    expect(errors).toEqual([])
  })

  it('uses relocated history for rewind and provider-switch source reads', async () => {
    const destination = await pathFor(worktree)
    // Rewind deliberately excludes the first prompt: it needs a resumable
    // semantic prefix. Keep that real parser contract in this disk fixture.
    await writeFile(destination, relocated() + user('prefix-user', 'Initial context') + user('historical-user'))
    const adapter = getHostTranscriptAdapter('claude')
    expect(await adapter.locate!(cwd, ID)).toBe(destination)
    expect(await adapter.listPrompts(cwd, ID)).toMatchObject([
      { text: PROMPT, address: { sessionId: ID, uuid: 'historical-user' } },
    ])
  })

  it.each(['resume', 'live-move'] as const)('acknowledges only the new durable prompt after %s', async mode => {
    const original = await pathFor(cwd); const destination = await pathFor(worktree)
    let file = mode === 'resume' ? destination : original
    await writeFile(file, (mode === 'resume' ? relocated() : '') + user('historical-user'))
    const pty = provider(() => file)
    spawn.mockReturnValue(pty)
    const session = new ClaudeSession({ cwd, resumeSessionId: ID, binary: 'fixture', useProxy: false, snapshotIntervalMs: 1 })
    sessions.push(session)
    const committed: string[] = []
    session.on('jsonl-entry', entry => { if (entry.type === 'user') committed.push(String(entry.uuid)) })
    await session.start(); pty.paint()
    await waitFor(() => session.isPromptAcceptanceReady())
    expect(committed).toEqual(['historical-user'])
    if (mode === 'live-move') {
      await appendFile(original, relocated()); await rename(original, destination); file = destination
    }
    const result = await deliverClaudePrompt({
      sessionId: 'app-session', session, prompt: PROMPT,
      write: data => { session.write(data); return true },
    })
    expect(result).toMatchObject({ ok: true, acceptance: { kind: 'user', entryId: 'new-user' } })
    expect(pty.writes.filter(write => write === '\r')).toHaveLength(1)
    expect(committed).toEqual(['historical-user', 'new-user'])
    const history = await loadInitialHistoryChunk({ kind: 'claude', cwd, providerSessionId: ID, limit: 20 })
    expect(history.entries.filter(entry => entry.type === 'user').map(entry => entry.uuid))
      .toEqual(['historical-user', 'new-user'])
  })

  it('allows a fresh provider-assigned file to be absent at startup', async () => {
    const pty = provider(() => join(root, 'unused.jsonl')); spawn.mockReturnValue(pty)
    const session = new ClaudeSession({ cwd, binary: 'fixture', useProxy: false, snapshotIntervalMs: 1 })
    sessions.push(session); await session.start(); pty.paint()
    await waitFor(() => session.isPromptAcceptanceReady())
    expect(pty.writes).toEqual([])
  })
})

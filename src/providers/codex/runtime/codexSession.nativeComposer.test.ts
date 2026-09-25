import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node-pty', () => ({ spawn: vi.fn() }))

import { CodexHeadless } from 'codex-headless'
import { CodexSession } from './codexSession.js'
import { deliverCodexPrompt } from './promptDelivery.js'

// #800 / #1313, driven by a raw PTY recording of codex-cli 0.157.0 (idle,
// a typed draft, Ctrl+C), replayed through a REAL CodexHeadless so the cell
// attributes the decision rests on come from xterm's own parse of Codex's
// bytes. Recorded in codex-headless; see the fixture's `source`.
type Recording = { cols: number; rows: number; events: Array<{ t: number; dir: string; label?: string; data?: string }> }
const recording = JSON.parse(readFileSync(join(import.meta.dirname,
  '../../../../packages/codex-headless/testing/fixtures/composer-0157/idle-draft-ctrlc.json'), 'utf8')) as Recording
const at = (label: string) => recording.events.find(event => event.label === label)!.t

const headlesses: CodexHeadless[] = []
afterEach(() => { headlesses.splice(0) })

async function sessionAt(until: number): Promise<{ session: CodexSession; headless: CodexHeadless }> {
  const listeners = new Set<(data: string) => void>()
  const pty = {
    pid: 1, process: 'codex', cols: recording.cols, rows: recording.rows, handleFlowControl: false,
    write: vi.fn(), resize: vi.fn(), clear: vi.fn(), pause: vi.fn(), resume: vi.fn(), kill: vi.fn(),
    onData: (listener: (data: string) => void) => { listeners.add(listener); return { dispose: () => listeners.delete(listener) } },
    onExit: () => ({ dispose: () => undefined }),
  }
  const headless = new CodexHeadless({ pty: pty as never, cwd: '/tmp', cols: recording.cols, rows: recording.rows, snapshotIntervalMs: 1 })
  headlesses.push(headless)
  const terminal = (headless as unknown as { terminal: { attach(): void; snapshotComposerCells(): unknown } }).terminal
  terminal.attach()
  for (const event of recording.events) {
    if (event.dir === 'out' && event.t < until) for (const listener of listeners) listener(event.data!)
  }
  const deadline = Date.now() + 2000
  while (terminal.snapshotComposerCells() === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
  const session = new CodexSession()
  ;(session as unknown as { headless: unknown }).headless = headless
  return { session, headless }
}

describe('Codex native composer (0.157 recording)', () => {
  it('delivers a restart request into the recorded empty composer (#1313)', async () => {
    const { session, headless } = await sessionAt(at('type-draft'))
    expect(headless.getScreen()).toContain('› Ask Codex to do anything')
    const write = vi.fn(() => true)
    await expect(deliverCodexPrompt({ session, sessionId: 'agent', prompt: 'Restart the server', write, requireEmptyNativeComposer: true } as never))
      .resolves.toMatchObject({ ok: true })
    expect(write).toHaveBeenCalledExactlyOnceWith('\x1b[200~Restart the server\x1b[201~\r')
  })

  it('refuses to write a prompt after the recorded human draft (#800)', async () => {
    const { session, headless } = await sessionAt(at('ctrl-c-1'))
    expect(headless.getScreen()).toContain('› please review the draft')
    const write = vi.fn(() => true)
    const result = await deliverCodexPrompt({ session, sessionId: 'agent', prompt: 'Status?', write } as never)
    expect(result).toMatchObject({ ok: false, stage: 'before-write', disposition: 'retry-after-resolve', promptWritten: false })
    expect(write).not.toHaveBeenCalled()
  })

  it('publishes the draft as composer-occupied, and ready again once it is cleared (#800)', async () => {
    const readiness: Array<{ ready: boolean; reason?: string }> = []
    const drafted = await sessionAt(at('ctrl-c-1'))
    drafted.session.on('input-readiness', state => readiness.push(state))
    ;(drafted.session as unknown as { composerReady: boolean }).composerReady = true
    ;(drafted.session as unknown as { publishNativeComposer(): void }).publishNativeComposer()
    expect(readiness.at(-1)).toEqual({ ready: false, reason: 'composer-occupied' })

    const cleared = await sessionAt(at('ctrl-c-2'))
    ;(drafted.session as unknown as { headless: unknown }).headless = cleared.headless
    ;(drafted.session as unknown as { publishNativeComposer(): void }).publishNativeComposer()
    expect(readiness.at(-1)).toEqual({ ready: true, reason: 'ready' })
  })
})

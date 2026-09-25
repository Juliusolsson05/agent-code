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

async function sessionWith(bytes: string[]): Promise<{ session: CodexSession; headless: CodexHeadless }> {
  return sessionAt(Number.POSITIVE_INFINITY, bytes)
}

async function sessionAt(until: number, bytes?: string[]): Promise<{ session: CodexSession; headless: CodexHeadless }> {
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
  const chunks = bytes ?? recording.events.filter(event => event.dir === 'out' && event.t < until).map(event => event.data!)
  for (const chunk of chunks) for (const listener of listeners) listener(chunk)
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

  // Steering q40: a draft longer than the package's 12-row composer bound
  // reads `unknown`, while the legacy screen check still sees `›` over a
  // status row. `unknown` must not be ready: the paste would land in the
  // human's draft.
  const longDraft = ['\x1b[2J\x1b[H› ', ...Array.from({ length: 12 }, () => '  real draft'), '', '  GPT-6-Sol high fast · ~/p'].join('\r\n')

  it('does not write into a draft the composer reading cannot classify', async () => {
    const { session, headless } = await sessionWith([longDraft])
    expect(headless.getComposerState()).toBe('unknown')
    const write = vi.fn(() => true)
    expect(await deliverCodexPrompt({ session, sessionId: 'agent', prompt: 'Status?', write } as never))
      .toMatchObject({ ok: false, stage: 'before-write', disposition: 'retry-after-resolve', promptWritten: false })
    expect(write).not.toHaveBeenCalled()
  })

  it('withdraws ready when the composer becomes unclassifiable, without latching occupied', async () => {
    const readiness: Array<{ ready: boolean; reason?: string }> = []
    const idle = await sessionAt(at('type-draft'))
    const session = idle.session as unknown as { composerReady: boolean; headless: unknown; publishNativeComposer(): void; on: CodexSession['on'] }
    idle.session.on('input-readiness', state => readiness.push(state))
    session.composerReady = true
    session.publishNativeComposer()
    session.headless = (await sessionWith([longDraft])).headless
    session.publishNativeComposer()
    expect(readiness.at(-1)).toEqual({ ready: false, reason: 'provider-not-ready' })
    session.headless = idle.headless
    session.publishNativeComposer()
    expect(readiness.at(-1)).toEqual({ ready: true, reason: 'ready' })
  })
})

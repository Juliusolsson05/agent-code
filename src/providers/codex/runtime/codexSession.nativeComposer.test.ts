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

type Replayed = { session: CodexSession; headless: CodexHeadless; feed(chunks: string[]): Promise<void> }

async function sessionWith(bytes: string[]): Promise<Replayed> {
  return sessionAt(Number.POSITIVE_INFINITY, bytes)
}

async function sessionAt(until: number, bytes?: string[]): Promise<Replayed> {
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
  // One recorded chunk at a time, draining between them, as a PTY delivers
  // them (#1343 reviews A and B). A synchronous burst of ~630 events plus a
  // 2 s wall-clock wait returned a half-painted frame under load (the tall
  // draft stopped at line 10 or 18), and could leave pendingWrites stuck
  // (HeadlessTerminal's documented write-callback stall).
  const pending = () => (terminal as unknown as { pendingWrites: number }).pendingWrites
  const feed = async (more: string[]) => {
    for (const chunk of more) {
      for (const listener of listeners) listener(chunk)
      while (pending() !== 0) await new Promise(resolve => setImmediate(resolve))
    }
  }
  await feed(chunks)
  const session = new CodexSession()
  ;(session as unknown as { headless: unknown }).headless = headless
  return { session, headless, feed }
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

  // Steering q40: a draft the package cannot read (`unknown`) while the
  // legacy screen check still sees `›` over a status row must not be ready:
  // the paste would land in the human's draft. Since #1327 an UNBROKEN draft
  // past 12 rows reads `drafted` (see the tall-draft recording below), so the
  // unreadable shape is one with a blank line more than 12 rows up.
  const longDraft = ['\x1b[2J\x1b[H› ', '', ...Array.from({ length: 12 }, () => '  real draft'), '', '  GPT-6-Sol high fast · ~/p'].join('\r\n')

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

  // #1319 review round 2 B: 0.149.1 and narrow 0.157 panes show no shortcuts
  // hint, so the package says `unknown` even for an empty composer. Once a
  // draft there is cleared, the settled bare-marker text proof is what brings
  // the pane back to ready; without it the pane would wait forever. A settled
  // read of null (bytes unparsed) must not.
  it('publishes ready from a settled bare marker on a pane without the hint, and not while unsettled', async () => {
    const readiness: Array<{ ready: boolean; reason?: string }> = []
    const session = new CodexSession()
    let settled: string | null = null
    const internal = session as unknown as { composerReady: boolean; headless: unknown; publishNativeComposer(): void }
    internal.headless = {
      getScreen: () => '› \n\n  gpt-5.6-sol high · /tmp/x',
      getSettledScreen: () => settled,
      getComposerState: () => 'unknown',
      getConditionSnapshot: () => ({ provider: 'codex', conditions: {}, ts: Date.now() }),
    }
    session.on('input-readiness', state => readiness.push(state))
    internal.composerReady = true
    internal.publishNativeComposer()
    expect(readiness.at(-1)).toEqual({ ready: false, reason: 'provider-not-ready' })
    settled = '› \n\n  gpt-5.6-sol high · /tmp/x'
    internal.publishNativeComposer()
    expect(readiness.at(-1)).toEqual({ ready: true, reason: 'ready' })
  })

  // #1319 review A2: the text-only proof of empty reads the plain screen,
  // which can lag PTY bytes still being parsed (the cell reading is then
  // `unknown`). A single stale bare-marker read must not consent: a human who
  // just started typing would get the prompt pasted into the draft.
  it('does not consent on one stale bare-marker read', async () => {
    const session = new CodexSession()
    const screens = ['› \n\n  gpt-5.6-sol high · /tmp/x', '› half-typed human draft\n\n  gpt-5.6-sol high · /tmp/x']
    let reads = 0
    ;(session as unknown as { headless: unknown }).headless = {
      getScreen: () => screens[Math.min(reads++, 1)]!,
      getSettledScreen: () => screens[Math.min(reads, 1)]!,
      getComposerState: () => 'unknown',
      getConditionSnapshot: () => ({ provider: 'codex', conditions: {}, ts: Date.now() }),
    }
    const write = vi.fn(() => true)
    // A normal delivery: its only check is the readiness gate, so a stale
    // read there is the whole decision.
    const result = await deliverCodexPrompt({ session, sessionId: 'agent', prompt: 'Status?', write } as never)
    expect(result).toMatchObject({ ok: false, promptWritten: false })
    expect(write).not.toHaveBeenCalled()
  })

  // #1319 review round 2 A2: the parser can stay behind for longer than any
  // number of polls (synchronized output), and the plain screen then keeps
  // showing the bare marker from before the human's keystrokes. Only a
  // parsed frame may prove empty; with none, nothing is written.
  it('never consents on a bare marker that no parsed frame confirms', async () => {
    const session = new CodexSession()
    ;(session as unknown as { headless: unknown }).headless = {
      getScreen: () => '› \n\n  gpt-5.6-sol high · /tmp/x',
      getSettledScreen: () => null,
      getComposerState: () => 'unknown',
      getConditionSnapshot: () => ({ provider: 'codex', conditions: {}, ts: Date.now() }),
    }
    const readiness = await session.awaitReadyForPrompt({ timeoutMs: 400 } as never)
    expect(readiness.kind).not.toBe('ready')
    const write = vi.fn(() => true)
    const restart = await deliverCodexPrompt({
      session: { awaitReadyForPrompt: async () => ({ kind: 'ready', waitedMs: 0 }), nativeComposerState: () => 'unknown', settledScreen: () => null, snapshotScreen: () => '› \n\n  gpt-5.6-sol high · /tmp/x' },
      sessionId: 'agent', prompt: 'Restart the server', write, requireEmptyNativeComposer: true,
    } as never)
    expect(restart).toMatchObject({ ok: false, promptWritten: false })
    expect(write).not.toHaveBeenCalled()
  })

  // #1319 review B: the restart's final empty check must refuse on its own,
  // even when readiness has just said ready.
  it('refuses a restart when the final check reads a draft after readiness said ready', async () => {
    const session = {
      awaitReadyForPrompt: async () => ({ kind: 'ready', waitedMs: 0 }),
      nativeComposerState: () => 'drafted',
      snapshotScreen: () => '› typed just now\n\n  gpt-5.6-sol high · /tmp/x',
    }
    const write = vi.fn(() => true)
    const result = await deliverCodexPrompt({ session, sessionId: 'agent', prompt: 'Restart the server', write, requireEmptyNativeComposer: true } as never)
    expect(result).toMatchObject({ ok: false, promptWritten: false })
    expect(write).not.toHaveBeenCalled()
  })

  // #1327, on a raw recording of codex-cli 0.157.1 typing a 20-line draft
  // (codex-headless testing/fixtures/composer-0157/tall-draft-ctrlc.json).
  // It read `unknown` and published provider-not-ready, so the pane's own
  // Enter appended to it. It is a draft: occupied, and nothing is written.
  it('publishes a recorded 20-row draft as composer-occupied and refuses to write into it (#1327)', async () => {
    const tall = JSON.parse(readFileSync(join(import.meta.dirname,
      '../../../../packages/codex-headless/testing/fixtures/composer-0157/tall-draft-ctrlc.json'), 'utf8')) as Recording
    const typed = tall.events.find(event => event.label === 'draft-typed')!.t + 800
    const { session, headless, feed } = await sessionWith(tall.events.filter(event => event.dir === 'out' && event.t < typed).map(event => event.data!))
    expect(headless.getScreen()).toContain('  long draft line 20 with a few words')
    expect(headless.getComposerState()).toBe('drafted')
    const readiness: Array<{ ready: boolean; reason?: string }> = []
    session.on('input-readiness', state => readiness.push(state))
    ;(session as unknown as { composerReady: boolean }).composerReady = true
    ;(session as unknown as { publishNativeComposer(): void }).publishNativeComposer()
    expect(readiness.at(-1)).toEqual({ ready: false, reason: 'composer-occupied' })
    const write = vi.fn(() => true)
    expect(await deliverCodexPrompt({ session, sessionId: 'agent', prompt: 'Status?', write } as never))
      .toMatchObject({ ok: false, stage: 'before-write', disposition: 'retry-after-resolve', promptWritten: false })
    expect(write).not.toHaveBeenCalled()

    // #1343 review A: and once the human clears it (the recorded Ctrl+C), the
    // pane is ready again; occupied never latches.
    // The same pane, fed on to just after the recorded Ctrl+C.
    const cleared = tall.events.find(event => event.label === 'ctrl-c-1')!.t + 800
    await feed(tall.events.filter(event => event.dir === 'out' && event.t >= typed && event.t < cleared).map(event => event.data!))
    expect(headless.getComposerState()).toBe('empty')
    ;(session as unknown as { publishNativeComposer(): void }).publishNativeComposer()
    expect(readiness.at(-1)).toEqual({ ready: true, reason: 'ready' })
  })
})

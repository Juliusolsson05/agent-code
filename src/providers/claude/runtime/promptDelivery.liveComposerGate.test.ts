import type { IPty } from 'node-pty'
import { afterEach, expect, it, vi } from 'vitest'

import { HeadlessTerminal } from 'claude-code-headless/terminal/HeadlessTerminal'

import { deliverClaudePrompt } from './promptDelivery.js'
import type { PromptDeliveryIo } from '@shared/types/providerConfig.js'

// #1294: Claude delivery decided whether it may type from a CACHED composer
// reading. The package recomputes it only on its throttled screen event (which
// can stall behind pendingWrites), and it counts only plain cells as typed, so a
// one-character draft under the inverse cursor, or an [Image #1] chip, read as
// empty. Either way the agent's prompt could be typed into a human's draft and
// submitted with it. Frames here are painted through claude-code-headless's real
// HeadlessTerminal with genuine SGR (dim = 2, inverse = 7, as chalk emits), the
// same method as the package's own composer tests, so the attribute counts come
// from xterm's parse, not from a hand-built descriptor.
afterEach(() => { vi.useRealTimers() })

const RULE = '─'.repeat(40)
const DIM = (s: string): string => `\x1b[2m${s}\x1b[22m`
const INV = (s: string): string => `\x1b[7m${s}\x1b[27m`

function fakePty(): IPty {
  const disposable = { dispose: vi.fn() }
  return {
    pid: 1, process: 'claude', cols: 80, rows: 12, handleFlowControl: false,
    write: vi.fn(), resize: vi.fn(), clear: vi.fn(), pause: vi.fn(), resume: vi.fn(), kill: vi.fn(),
    onData: vi.fn(() => disposable), onExit: vi.fn(() => disposable),
  } as unknown as IPty
}

async function liveComposer(composerRow: string) {
  const term = new HeadlessTerminal({ pty: fakePty(), cols: 80, rows: 12 })
  await term.writeForTest([RULE, composerRow, RULE].join('\r\n'))
  return { screen: term.snapshotPlain(), attributes: term.snapshotComposerAttributes() }
}

async function deliver(live: { screen: string; attributes: unknown }) {
  vi.useFakeTimers()
  const writes: string[] = []
  const io = {
    sessionId: 's1',
    prompt: 'agent prompt',
    write: (data: string) => { writes.push(data); return true },
    record: () => {},
    session: {
      // The cached gate says ready: the stall (or the misread) this guards.
      awaitReadyForPrompt: async () => ({ kind: 'ready', waitedMs: 0 }),
      isPromptAcceptanceReady: () => true,
      snapshotScreen: () => live.screen,
      readComposer: () => live,
      armPromptAcceptance: () => ({ promise: new Promise(() => {}), cancel: vi.fn() }),
    },
  } as unknown as PromptDeliveryIo
  const delivery = deliverClaudePrompt(io)
  await vi.advanceTimersByTimeAsync(1_000)
  vi.useRealTimers()
  const result = await Promise.race([delivery, new Promise(resolve => setTimeout(() => resolve('still-running'), 50))])
  return { result, writes }
}

it.each([
  ['a plain human draft typed after the last screen event', '❯ half-written thought'],
  ['a one-character draft under the inverse cursor', `❯ ${INV('x')}`],
  ['an [Image #1]-only draft with the cursor at the chip start', `❯ ${INV('[Image #1]')}`],
])('refuses to write over %s', async (_name, row) => {
  const { result, writes } = await deliver(await liveComposer(row))
  expect(writes).toEqual([])
  expect(result).toMatchObject({ ok: false, stage: 'before-write', retrySafe: true, promptWritten: false })
})

it('still delivers over a dim prompt-suggestion placeholder', async () => {
  // Attributes were added to stop a suggestion reading as a draft; the live
  // guard must not bring that false 'drafted' back.
  const { writes } = await deliver(await liveComposer(`❯ ${INV(DIM('y'))}${DIM('es fix all 9')}`))
  expect(writes.join('')).toContain('agent prompt')
})

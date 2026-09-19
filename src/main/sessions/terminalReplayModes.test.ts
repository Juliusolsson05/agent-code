import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Terminal } from '@xterm/headless'
import { describe, expect, it } from 'vitest'

import { TerminalReplayBuffer } from './terminalReplayBuffer'

// #843: an OpenCode terminal pane that remounts can no longer scroll.
//
// The replay a remounted xterm is fed is the capped TAIL of the PTY stream,
// and OpenCode writes its alternate-screen and mouse modes only once at
// startup. Every case runs the bytes through a REAL xterm (headless build) and
// compares the replayed terminal with one that saw the whole live stream,
// which is the only ground truth that matters.
//
// The OpenCode bytes are the real 1.18.31 startup recording
// (testing/fixtures/terminal-replay-modes). Its first chunk is the preamble;
// the rest are full-frame repaints, repeated here until the cap evicts the
// preamble, as minutes of real repainting do.

const recording = JSON.parse(readFileSync(
  resolve(__dirname, '../../../testing/fixtures/terminal-replay-modes/opencode-1.18.31-startup.json'), 'utf8',
)) as Array<{ t: number; d: string }>
const preambleIndex = recording.findIndex(chunk => chunk.d.includes('\x1b[?1049h'))
const frames = recording.slice(preambleIndex + 1).map(chunk => chunk.d).filter(chunk => chunk.includes('\x1b[?2026h'))

async function terminalFed(data: string): Promise<Terminal> {
  const terminal = new Terminal({ cols: 120, rows: 36, allowProposedApi: true })
  await new Promise<void>(done => terminal.write(data, done))
  return terminal
}

function observable(terminal: Terminal) {
  return {
    buffer: terminal.buffer.active.type,
    mouse: terminal.modes.mouseTrackingMode,
    bracketedPaste: terminal.modes.bracketedPasteMode,
    applicationCursorKeys: terminal.modes.applicationCursorKeysMode,
  }
}

async function replayMatchesLive(stream: string[], cap: number, pieceSize?: number) {
  const buffer = new TerminalReplayBuffer(cap, pieceSize)
  for (const chunk of stream) buffer.append(chunk)
  const live = await terminalFed(stream.join(''))
  const replayed = await terminalFed(buffer.replay())
  return { live: observable(live), replayed: observable(replayed), buffer, liveTerminal: live, replayedTerminal: replayed }
}

describe('replay restores the terminal modes the cap evicted (#843)', () => {
  it('the recorded OpenCode session: after the preamble is evicted, the replay is on the alternate screen with any-event mouse tracking', async () => {
    expect(preambleIndex).toBeGreaterThanOrEqual(0)
    expect(frames.length).toBeGreaterThan(0)
    const stream = recording.slice(0, preambleIndex + 1).map(chunk => chunk.d)
    // A 16 KiB cap and enough recorded frames to push the preamble out many
    // times over, the same thing 512 KiB and minutes of 60 fps repaint do.
    while (stream.join('').length < 64 * 1024) stream.push(...frames)
    const { live, replayed, buffer } = await replayMatchesLive(stream, 16 * 1024)
    expect(buffer.read()).not.toContain('\x1b[?1049h')
    expect(live).toMatchObject({ buffer: 'alternate', mouse: 'any', bracketedPaste: true })
    // Without the prefix a remounted pane was on the NORMAL buffer with mouse
    // tracking off, so xterm never turned the wheel into mouse reports.
    expect(replayed).toEqual(live)
  })

  it('output written on the normal screen BEFORE a retained ?1049h stays on the normal screen', async () => {
    // The reverted first fix prefixed the CURRENT modes: the replayed shell
    // output then landed on the alternate buffer, and the retained ?1049h
    // wiped it, so the normal screen lost it. Only evicted bytes decide the
    // prefix.
    // The stream ENDS on the alternate screen: that is when the "current
    // modes" prefix is ?1049h and does the damage (the reviewed failure).
    const stream = [
      'x'.repeat(300),
      'shell line one\r\nshell line two\r\n',
      '\x1b[?1049h\x1b[?1003h\x1b[?1006h',
      'full screen app\r\n',
    ]
    const { live, replayed, liveTerminal, replayedTerminal } = await replayMatchesLive(stream, 200, 50)
    expect(replayed).toEqual(live)
    const lines = (terminal: Terminal) => Array.from({ length: terminal.buffer.normal.length }, (_, index) =>
      terminal.buffer.normal.getLine(index)?.translateToString(true) ?? '').filter(Boolean)
    // Both shell lines survive on the NORMAL buffer, as they did live. (The
    // line holding "shell line one" wraps differently, because the cap
    // evicted part of the x run before it.)
    for (const terminal of [liveTerminal, replayedTerminal]) {
      expect(lines(terminal)).toContain('shell line two')
      expect(lines(terminal).some(line => line.endsWith('shell line one'))).toBe(true)
    }
  })

  it.each([
    ['?1000h then ?1003h leaves any-event', '\x1b[?1000h\x1b[?1003h', 'any'],
    ['?1003h then ?1000h leaves vt200', '\x1b[?1003h\x1b[?1000h', 'vt200'],
    ['resetting ANY protocol code turns tracking off', '\x1b[?1000h\x1b[?1003h\x1b[?1000l', 'none'],
    ['ESC c resets everything', '\x1b[?1049h\x1b[?1003h\x1bc', 'none'],
  ])('mouse protocols are one exclusive state, as in xterm: %s', async (_label, modes, expected) => {
    const { live, replayed } = await replayMatchesLive([modes, 'y'.repeat(400)], 200, 50)
    expect(live.mouse).toBe(expected)
    expect(replayed).toEqual(live)
  })

  it('a mode sequence cut by an eviction boundary is still applied', async () => {
    // Pieces of 50 characters put the boundary inside `ESC [ ? 1 0 0 3 h`.
    const stream = ['z'.repeat(47) + '\x1b[?1003h', 'w'.repeat(400)]
    const { live, replayed } = await replayMatchesLive(stream, 200, 50)
    expect(live.mouse).toBe('any')
    expect(replayed).toEqual(live)
  })

  it('a mode sequence straddling the boundary is replayed whole, not printed as text', async () => {
    // Pieces of 50 put the boundary between `ESC [ ? 1 0` (evicted) and
    // `4 9 h` (kept). Without the held fragment the replay printed "49h".
    const stream = ['a'.repeat(46) + '\x1b[?10', '49h' + 'b'.repeat(47), 'c'.repeat(150)]
    const { live, replayed, replayedTerminal } = await replayMatchesLive(stream, 160, 50)
    expect(live.buffer).toBe('alternate')
    expect(replayed).toEqual(live)
    const text = Array.from({ length: replayedTerminal.buffer.active.length }, (_, index) => replayedTerminal.buffer.active.getLine(index)?.translateToString(true) ?? '').join('')
    expect(text).not.toContain('49h')
  })

  it('an ESC that cuts a mode sequence short starts the next one, as xterm parses it', async () => {
    const { live, replayed } = await replayMatchesLive(['\x1b[?10\x1b[?1003h', 'd'.repeat(400)], 200, 50)
    expect(live.mouse).toBe('any')
    expect(replayed).toEqual(live)
  })

  it('a session that never set a mode replays byte for byte as before', () => {
    const buffer = new TerminalReplayBuffer(100, 20)
    for (let index = 0; index < 20; index += 1) buffer.append(`plain line ${index}\r\n`)
    expect(buffer.replay()).toBe(buffer.read())
  })
})

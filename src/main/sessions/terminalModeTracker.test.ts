import { describe, expect, it } from 'vitest'

import { TerminalModeTracker } from './terminalModeTracker'

// The bug these pin, restated because it is invisible from the code alone:
//
// attachAgentPty replays the trailing bytes of a CAPPED buffer that evicts the
// oldest data. A TUI writes its alternate-screen and mouse-tracking preamble
// exactly once, at startup, so on any busy session those bytes are long gone
// by the time a renderer attaches. The fresh xterm then sits on the normal
// buffer with no mouse tracking while the application believes otherwise —
// which is why the mouse wheel did nothing at all in an OpenCode terminal
// pane, even though nothing was swallowing it.

const ESC = '\x1b'

describe('TerminalModeTracker', () => {
  it('restores nothing for a stream that set nothing', () => {
    const tracker = new TerminalModeTracker()
    tracker.observe('plain output with no escapes\r\n')
    expect(tracker.preamble()).toBe('')
  })

  it('captures a TUI startup preamble written as one sequence per mode', () => {
    const tracker = new TerminalModeTracker()
    tracker.observe(`${ESC}[?1049h${ESC}[?1000h${ESC}[?1002h${ESC}[?1003h${ESC}[?1006h`)
    expect(tracker.activeModes()).toEqual([1049, 1000, 1002, 1003, 1006])
  })

  it('captures modes combined into one semicolon-separated sequence', () => {
    const tracker = new TerminalModeTracker()
    tracker.observe(`${ESC}[?1000;1002;1006h`)
    expect(tracker.activeModes()).toEqual([1000, 1002, 1006])
  })

  it('puts the screen switch first regardless of the order it saw them', () => {
    // 1049 has to lead, or everything the replay paints lands on the normal
    // buffer and is abandoned the moment the switch happens.
    const tracker = new TerminalModeTracker()
    tracker.observe(`${ESC}[?1006h${ESC}[?1049h`)
    expect(tracker.preamble()).toBe(`${ESC}[?1049h${ESC}[?1006h`)
  })

  it('forgets a mode the application turned back off', () => {
    // A TUI that suspends for $EDITOR leaves the alternate screen. Replaying a
    // stale 1049h would put the pane on a buffer the application is not using.
    const tracker = new TerminalModeTracker()
    tracker.observe(`${ESC}[?1049h${ESC}[?1003h`)
    tracker.observe(`${ESC}[?1049l`)
    expect(tracker.activeModes()).toEqual([1003])
  })

  it('handles a reset that names several modes at once', () => {
    const tracker = new TerminalModeTracker()
    tracker.observe(`${ESC}[?1049h${ESC}[?1000h${ESC}[?1002h${ESC}[?1003h${ESC}[?1006h`)
    tracker.observe(`${ESC}[?1003l${ESC}[?1002l${ESC}[?1000l${ESC}[?1006l`)
    expect(tracker.activeModes()).toEqual([1049])
  })

  it('ignores private modes it is not responsible for', () => {
    // Cursor visibility, bracketed paste and focus reporting are re-asserted
    // by the next repaint, so restoring them would be noise at best.
    const tracker = new TerminalModeTracker()
    tracker.observe(`${ESC}[?25l${ESC}[?2004h${ESC}[?1004h${ESC}[?1049h`)
    expect(tracker.activeModes()).toEqual([1049])
  })

  it('is not fooled by the digits appearing in ordinary output', () => {
    const tracker = new TerminalModeTracker()
    tracker.observe('the value is 1049h and the mode is [?1049h-ish\r\n')
    expect(tracker.preamble()).toBe('')
  })

  it('survives being fed the same preamble twice', () => {
    // Reconnects and provider restarts re-emit it; the set must not grow or
    // reorder.
    const tracker = new TerminalModeTracker()
    const preamble = `${ESC}[?1049h${ESC}[?1003h${ESC}[?1006h`
    tracker.observe(preamble)
    tracker.observe(preamble)
    expect(tracker.preamble()).toBe(preamble)
  })

  it('keeps state across many chunks, which is how a real stream arrives', () => {
    const tracker = new TerminalModeTracker()
    tracker.observe(`${ESC}[?1049h`)
    for (let i = 0; i < 500; i += 1) tracker.observe(`frame ${i}\r\n`)
    tracker.observe(`${ESC}[?1003h`)
    for (let i = 0; i < 500; i += 1) tracker.observe(`frame ${i}\r\n`)
    // This is exactly the case the capped replay buffer loses: the first
    // sequence is thousands of bytes back and would have been evicted.
    expect(tracker.preamble()).toBe(`${ESC}[?1049h${ESC}[?1003h`)
  })
})

describe('sequences split across chunk boundaries', () => {
  it('applies a turn-ON split between two chunks', () => {
    const tracker = new TerminalModeTracker()
    tracker.observe(`${ESC}[?10`)
    tracker.observe('49h')
    expect(tracker.activeModes()).toEqual([1049])
  })

  it('applies a turn-OFF split between two chunks', () => {
    // The asymmetry that makes carrying state mandatory: missing a turn-ON
    // leaves today's behaviour, but missing a turn-OFF is WORSE than today —
    // the mode survives here and the next attach asserts a mode the
    // application has already left, putting a pane back on the alternate
    // screen after the TUI suspended for an editor.
    const tracker = new TerminalModeTracker()
    tracker.observe(`${ESC}[?1049h${ESC}[?1003h`)
    tracker.observe(`${ESC}[?104`)
    tracker.observe('9l')
    expect(tracker.activeModes()).toEqual([1003])
  })

  it('handles a split at the escape byte itself', () => {
    // A chunk can end at ANY byte. Requiring the whole `ESC [ ?` marker before
    // carrying anything meant a reset split here was still missed, which is
    // the direction that leaves a stale mode asserted at the next attach.
    const tracker = new TerminalModeTracker()
    tracker.observe(`output${ESC}`)
    tracker.observe('[?1006h')
    expect(tracker.activeModes()).toEqual([1006])
  })

  it('handles a split after the control sequence introducer', () => {
    const tracker = new TerminalModeTracker()
    tracker.observe(`output${ESC}[`)
    tracker.observe('?1049h')
    expect(tracker.activeModes()).toEqual([1049])
  })

  it('applies a RESET split at the escape byte, the worse direction', () => {
    const tracker = new TerminalModeTracker()
    tracker.observe(`${ESC}[?1049h${ESC}[?1003h`)
    tracker.observe(`frame${ESC}`)
    tracker.observe('[?1049l')
    expect(tracker.activeModes()).toEqual([1003])
  })

  it('applies a RESET split after the control sequence introducer', () => {
    const tracker = new TerminalModeTracker()
    tracker.observe(`${ESC}[?1049h${ESC}[?1003h`)
    tracker.observe(`frame${ESC}[`)
    tracker.observe('?1003l')
    expect(tracker.activeModes()).toEqual([1049])
  })

  it('does not carry an escape that begins some other sequence', () => {
    const tracker = new TerminalModeTracker()
    tracker.observe(`${ESC}[?1049h`)
    tracker.observe(`${ESC}`)
    tracker.observe('[2J clear screen')
    expect(tracker.activeModes()).toEqual([1049])
  })

  it('applies a multi-mode sequence split mid-parameter-list', () => {
    const tracker = new TerminalModeTracker()
    tracker.observe(`${ESC}[?1000;10`)
    tracker.observe('02;1006h')
    expect(tracker.activeModes()).toEqual([1000, 1002, 1006])
  })

  it('never applies a carried sequence twice', () => {
    const tracker = new TerminalModeTracker()
    tracker.observe(`${ESC}[?1049`)
    tracker.observe('h')
    tracker.observe('ordinary output')
    expect(tracker.activeModes()).toEqual([1049])
  })

  it('drops a carried fragment that turns out not to be a sequence', () => {
    const tracker = new TerminalModeTracker()
    tracker.observe(`${ESC}[?1049`)
    // A final byte that is not h or l ends the sequence as something else.
    tracker.observe('r rest of the line')
    expect(tracker.activeModes()).toEqual([])
    // And the tracker is not left holding anything.
    tracker.observe(`${ESC}[?1003h`)
    expect(tracker.activeModes()).toEqual([1003])
  })

  it('does not accumulate an unbounded fragment from a stream of digits', () => {
    const tracker = new TerminalModeTracker()
    tracker.observe(`${ESC}[?` + '1'.repeat(200))
    // Far past any real sequence, so it is dropped rather than carried, and a
    // following final byte must not resurrect it.
    tracker.observe('h')
    expect(tracker.activeModes()).toEqual([])
  })
})

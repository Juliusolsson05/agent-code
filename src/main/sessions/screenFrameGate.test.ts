import { describe, expect, it } from 'vitest'

import { ScreenFrameGate, normalizeVolatileScreenText } from './screenFrameGate.js'

// #746: frames that differ only in spinner chrome must not leave main;
// anything a user could act on must.

const CLAUDE_THINKING = [
  '> fix the flaky test',
  '',
  "✻ Beboppin'… (5s · ↓ 1.2k tokens · thinking…)",
  '',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents                          /rc connecting…',
].join('\n')

const CLAUDE_THINKING_NEXT_TICK = [
  '> fix the flaky test',
  '',
  "✽ Beboppin'… (6s · ↓ 1.3k tokens · thinking…)",
  '',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents                          /rc',
].join('\n')

const CODEX_WORKING = ['• Working (12s • esc to interrupt)', '', '› Ask Codex to do anything   '].join('\n')
const CODEX_WORKING_NEXT_TICK = ['• Working (13s • esc to interrupt)', '', '› Ask Codex to do anything'].join('\n')

describe('normalizeVolatileScreenText', () => {
  it('maps a spinner tick, timer, token counter and the rc blink to one key', () => {
    expect(normalizeVolatileScreenText(CLAUDE_THINKING)).toBe(
      normalizeVolatileScreenText(CLAUDE_THINKING_NEXT_TICK),
    )
    expect(normalizeVolatileScreenText(CODEX_WORKING)).toBe(
      normalizeVolatileScreenText(CODEX_WORKING_NEXT_TICK),
    )
  })

  it('leaves identifiers that merely end in s alone', () => {
    const line = 'k8s deploy s3://bucket v1.2s3 took 3 seconds'
    expect(normalizeVolatileScreenText(line)).toBe(line)
  })

  it('keeps the spinner verb and the done transition visible', () => {
    // The verb changes every few seconds and "done" is a state change;
    // neither is chrome, both must produce a different key.
    expect(normalizeVolatileScreenText("✻ Beboppin'… (5s)")).not.toBe(
      normalizeVolatileScreenText('✻ Ionizing… (5s)'),
    )
    expect(normalizeVolatileScreenText('✻ Cogitated for 1m 9s · done 2:03 PM')).not.toBe(
      normalizeVolatileScreenText("✻ Cogitating… (1m 9s · thinking…)"),
    )
  })
})

describe('ScreenFrameGate', () => {
  it('emits the first frame and drops the spinner ticks that follow', () => {
    const gate = new ScreenFrameGate()
    expect(gate.shouldEmit('s1', { plain: CLAUDE_THINKING, recent: CLAUDE_THINKING })).toBe(true)
    expect(gate.shouldEmit('s1', { plain: CLAUDE_THINKING_NEXT_TICK, recent: CLAUDE_THINKING_NEXT_TICK })).toBe(false)
    expect(gate.snapshotStats()).toEqual({ emitted: 1, dropped: 1 })
  })

  it('emits a composer keystroke and a new output line within a tick', () => {
    const gate = new ScreenFrameGate()
    gate.shouldEmit('s1', { plain: CODEX_WORKING, recent: CODEX_WORKING })
    const typed = CODEX_WORKING_NEXT_TICK.replace('› Ask Codex to do anything', '› g')
    expect(gate.shouldEmit('s1', { plain: typed, recent: typed })).toBe(true)
    const output = typed + '\n  Ran npm test'
    expect(gate.shouldEmit('s1', { plain: output, recent: output })).toBe(true)
  })

  it('compares recent independently when the provider has scrollback', () => {
    const gate = new ScreenFrameGate()
    gate.shouldEmit('s1', { plain: CODEX_WORKING, recent: 'older output\n' + CODEX_WORKING })
    // Same viewport, more scrollback: the wider window changed.
    expect(
      gate.shouldEmit('s1', { plain: CODEX_WORKING_NEXT_TICK, recent: 'even older\nolder output\n' + CODEX_WORKING_NEXT_TICK }),
    ).toBe(true)
  })

  it('keys state per session and forgets a removed one', () => {
    const gate = new ScreenFrameGate()
    gate.shouldEmit('s1', { plain: CLAUDE_THINKING, recent: CLAUDE_THINKING })
    expect(gate.shouldEmit('s2', { plain: CLAUDE_THINKING, recent: CLAUDE_THINKING })).toBe(true)
    gate.forget('s1')
    expect(gate.shouldEmit('s1', { plain: CLAUDE_THINKING_NEXT_TICK, recent: CLAUDE_THINKING_NEXT_TICK })).toBe(true)
  })

  it('emits again once the frame changes and drops the tick after that change', () => {
    const gate = new ScreenFrameGate()
    gate.shouldEmit('s1', { plain: CLAUDE_THINKING, recent: CLAUDE_THINKING })
    const changed = CLAUDE_THINKING_NEXT_TICK + '\n⏺ Read(README.md)'
    expect(gate.shouldEmit('s1', { plain: changed, recent: changed })).toBe(true)
    const tick = changed.replace('✽', '✶').replace('(6s', '(7s')
    expect(gate.shouldEmit('s1', { plain: tick, recent: tick })).toBe(false)
    expect(gate.shouldEmit('s1', { plain: tick.replace('(7s', '(8s'), recent: tick.replace('(7s', '(8s') })).toBe(false)
    expect(gate.droppedBeforeLastEmit('s1')).toBe(2)
    const next = tick + '\n⏺ Read(package.json)'
    expect(gate.shouldEmit('s1', { plain: next, recent: next })).toBe(true)
    expect(gate.droppedBeforeLastEmit('s1')).toBe(0)
  })
})

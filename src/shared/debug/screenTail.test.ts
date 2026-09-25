import { describe, expect, it } from 'vitest'

import { SCREEN_MAX_SAMPLES, SCREEN_TAIL_LINES, ScreenTailHistory } from './screenTail.js'

// The debug bundle's trace/screen/tail-samples.jsonl, now recorded in main
// (#762). Same contract as the renderer version it replaced: tail only,
// deduplicated, bounded, forgettable.
describe('ScreenTailHistory', () => {
  it('keeps the last lines of each distinct screen, once', () => {
    let now = 1_000
    const history = new ScreenTailHistory(() => now)
    const long = Array.from({ length: SCREEN_TAIL_LINES + 10 }, (_, i) => `line ${i}`).join('\n')
    history.record('s', `\u001b[31m${long}\u001b[0m   `)
    now += 1
    history.record('s', long)
    const [sample, ...rest] = history.samples('s')
    expect(rest).toEqual([])
    expect(sample!.lineCount).toBe(SCREEN_TAIL_LINES)
    expect(sample!.content.startsWith('line 10')).toBe(true)
    expect(sample!.content).not.toContain('\u001b')
  })

  it('caps the samples per session and forgets a closed session', () => {
    const history = new ScreenTailHistory(() => 0)
    for (let i = 0; i < SCREEN_MAX_SAMPLES + 5; i += 1) history.record('s', `frame ${i}`)
    const samples = history.samples('s')
    expect(samples).toHaveLength(SCREEN_MAX_SAMPLES)
    expect(samples[0]!.content).toBe('frame 5')
    history.forget('s')
    expect(history.samples('s')).toEqual([])
  })
})

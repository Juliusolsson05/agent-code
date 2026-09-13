import { describe, expect, it } from 'vitest'

import { suspendedMsWithin, workingSeconds } from '@shared/agentActivity/workingSeconds'

// Real intervals from docs/decomposition/agent-working-time.md §2.4:
//   case A turn: prompt 2026-08-31 20:57:09, clamshell sleep 23:43:59 → 08:01:40,
//                Claude's own turn_duration 39,888,429 ms written at 08:01:57.
//   case B sleep: 2026-09-02 01:11:14 → 10:25:02 (no turn open).

const PDT = (local: string): number => Date.parse(`${local}-07:00`)
const A_PROMPT = PDT('2026-08-31T20:57:09')
const A_SLEEP = { suspendedAt: PDT('2026-08-31T23:43:59'), resumedAt: PDT('2026-09-01T08:01:40') }
const A_TURN_DURATION_AT = PDT('2026-09-01T08:01:57')
const B_SLEEP = { suspendedAt: PDT('2026-09-02T01:11:14'), resumedAt: PDT('2026-09-02T10:25:02') }

describe('workingSeconds', () => {
  it('reports case A as the working time before the lid closed plus the 17 s after wake, not the 11 h Claude recorded', () => {
    const seconds = workingSeconds(A_PROMPT, [A_SLEEP], A_TURN_DURATION_AT)
    // Claude's own clock: 39,888 s. Working time: 20:57:09→23:43:59 plus 08:01:40→08:01:57.
    expect(seconds).toBe((A_SLEEP.suspendedAt - A_PROMPT + (A_TURN_DURATION_AT - A_SLEEP.resumedAt)) / 1000)
    expect(seconds).toBeLessThan(39_888_429 / 1000)
  })

  it('ignores sleeps that ended before the turn started or began after now', () => {
    const turnStart = PDT('2026-09-02T11:00:00')
    expect(workingSeconds(turnStart, [A_SLEEP, B_SLEEP], turnStart + 90_000)).toBe(90)
  })

  it('counts only the part of a suspension inside the window', () => {
    // A window that opens in the middle of the case B sleep.
    const from = PDT('2026-09-02T09:25:02')
    expect(suspendedMsWithin([B_SLEEP], from, from + 2 * 3_600_000)).toBe(3_600_000)
  })

  it('shows nothing when no turn clock is running', () => {
    expect(workingSeconds(null, [A_SLEEP], A_TURN_DURATION_AT)).toBeNull()
  })
})

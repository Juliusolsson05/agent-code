import { describe, expect, it } from 'vitest'

import { nextCrashDelay, pocketsToSleep } from './lifecycle'
import { DEFAULT_PARKED_SIZE, intersect, pickWinningSlot, resolvePlacement, slotRole, type SlotReport } from './resolvePlacement'

// PROVISIONAL FIXTURES (decomposition Stage 4). These sequences are derived
// from reading how the React tree mounts slots — MainSurface.tsx renders the
// Spotlight leaf as a SIBLING while the stage stays mounted under
// RetainedWorkspaceSurface(hidden), and lanes are keyed by index in
// TiledDispatchLayout.tsx. Stage 6 adds a dev-only placement trace; traces the
// user records in the real app replace these (U7).

const R = (x = 0, w = 400) => ({ x, y: 0, width: w, height: 300 })
const lane = (i: number, o: Partial<SlotReport> = {}): SlotReport => ({ slotKey: `lane:${i}`, surface: 'lane', laneIndex: i, focused: false, visible: true, dimmed: true, rect: R(i * 400), clip: R(i * 400), ...o })
const spot = (o: Partial<SlotReport> = {}): SlotReport => ({ slotKey: 'spotlight', surface: 'spotlight', laneIndex: null, focused: true, visible: true, dimmed: false, rect: R(0, 1200), clip: null, ...o })
const base = { alive: true, mustPaint: false, lastSize: { width: 400, height: 300 } }

describe('real mount sequences', () => {
  it('lane → Spotlight → back: one placement each step, never two', () => {
    // 1. Grid: the agent's lane is focused.
    let slots = [lane(1, { focused: true, dimmed: false })]
    expect(resolvePlacement({ ...base, slots })).toMatchObject({ mode: 'shown', slotKey: 'lane:1' })
    // 2. Alt+S: Spotlight mounts its own slot; the stage stays mounted but its
    //    visibility context flips to hidden — the lane slot is STILL registered.
    slots = [lane(1, { focused: true, dimmed: false, visible: false }), spot()]
    expect(resolvePlacement({ ...base, slots })).toMatchObject({ mode: 'shown', slotKey: 'spotlight' })
    // 3. Esc: Spotlight's slot unmounts, the stage becomes visible again.
    slots = [lane(1, { focused: true, dimmed: false })]
    expect(resolvePlacement({ ...base, slots })).toMatchObject({ mode: 'shown', slotKey: 'lane:1' })
  })

  it('Spotlight reports before the hidden stage updates (one frame of both visible): Spotlight still wins', () => {
    expect(pickWinningSlot([lane(1, { focused: true }), spot()])?.slotKey).toBe('spotlight')
  })

  it('Settings / Reader / Global Editor hide every slot: the guest is parked, not destroyed', () => {
    const slots = [lane(1, { visible: false })]
    expect(resolvePlacement({ ...base, slots })).toEqual({ mode: 'parked', size: { width: 400, height: 300 }, mustPaint: false })
  })

  it('a lane inserted to the left re-keys the slot but the pocket keeps one placement', () => {
    // Index-keyed lanes: the same session's slot unmounts as lane:1 and mounts
    // as lane:2. During that frame the registry may hold neither.
    expect(resolvePlacement({ ...base, slots: [] })).toMatchObject({ mode: 'parked' })
    expect(resolvePlacement({ ...base, slots: [lane(2, { focused: true })] })).toMatchObject({ mode: 'shown', slotKey: 'lane:2' })
  })
})

describe('mirrors and ties', () => {
  it('the focused lane beats a lower index; lower index breaks ties among unfocused', () => {
    expect(pickWinningSlot([lane(0), lane(3, { focused: true })])?.slotKey).toBe('lane:3')
    expect(pickWinningSlot([lane(5), lane(2)])?.slotKey).toBe('lane:2')
  })

  it('a visible losing slot is a mirror that knows where the page is', () => {
    const slots = [lane(0), lane(3, { focused: true })]
    expect(slotRole(slots, 'lane:0')).toEqual({ role: 'mirror', shownIn: slots[1] })
    expect(slotRole(slots, 'lane:3')).toEqual({ role: 'live' })
    expect(slotRole([lane(0, { visible: false })], 'lane:0')).toEqual({ role: 'hidden' })
  })

  it('zero-size slots (a collapsed row mid-animation) never win', () => {
    expect(pickWinningSlot([lane(0, { rect: { x: 0, y: 0, width: 0, height: 300 } })])).toBeNull()
  })
})

describe('never-shown pockets', () => {
  it('a restored pocket that is not visible creates no guest (zero cost until opened)', () => {
    expect(resolvePlacement({ slots: [], alive: false, mustPaint: false, lastSize: null })).toEqual({ mode: 'absent' })
  })

  it('an agent opening a collapsed pocket gets a painting guest at the default size, not a popped panel', () => {
    expect(resolvePlacement({ slots: [], alive: false, mustPaint: true, lastSize: null })).toEqual({ mode: 'parked', size: DEFAULT_PARKED_SIZE, mustPaint: true })
  })
})

it('clip is the intersection with the lane box', () => {
  expect(intersect({ x: 0, y: 0, width: 100, height: 100 }, { x: 50, y: 20, width: 100, height: 50 })).toEqual({ x: 50, y: 20, width: 50, height: 50 })
  expect(intersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 50, y: 50, width: 5, height: 5 })).toEqual({ x: 50, y: 50, width: 0, height: 0 })
})

describe('sleep policy', () => {
  const now = 1_000_000
  it('sleeps pockets hidden longer than 10 minutes', () => {
    expect(pocketsToSleep([{ pocketId: 'a', lastVisibleAt: now - 11 * 60_000, visible: false, agentLease: false }], now)).toEqual(['a'])
  })
  it('never sleeps a visible pocket or one an agent is using', () => {
    expect(pocketsToSleep([
      { pocketId: 'v', lastVisibleAt: 0, visible: true, agentLease: false },
      { pocketId: 'l', lastVisibleAt: 0, visible: false, agentLease: true },
    ], now)).toEqual([])
  })
  it('enforces the live cap, least recently visible first', () => {
    const ps = Array.from({ length: 8 }, (_, i) => ({ pocketId: `p${i}`, lastVisibleAt: now - i * 1000, visible: false, agentLease: false }))
    expect(pocketsToSleep(ps, now)).toEqual(['p7', 'p6'])
  })
})

describe('crash back-off', () => {
  it('backs off 250 ms × 2ⁿ and gives up after three crashes in 30 s', () => {
    expect(nextCrashDelay([], 0)).toBe(250)
    expect(nextCrashDelay([0], 1000)).toBe(500)
    expect(nextCrashDelay([0, 1000], 2000)).toBe(1000)
    expect(nextCrashDelay([0, 1000, 2000], 3000)).toBeNull()
    expect(nextCrashDelay([0, 1000, 2000], 40_000)).toBe(250)
  })
})

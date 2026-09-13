import { EventEmitter } from 'node:events'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SystemSuspension } from '@shared/types/systemSuspension'

import { parseSysctlTimeval } from './darwinWakeTime'
import { SystemSuspensionTracker } from './SystemSuspensionTracker'

// The single "machine was not running" signal every working-time consumer reads
// (#963). Times are the real sleeps on record in /var/log/powermanagement
// (docs/decomposition/agent-working-time.md §2.4):
//   case A: clamshell sleep 2026-08-31 23:43:59 → wake 2026-09-01 08:01:40 PDT
//   case B: clamshell sleep 2026-09-02 01:11:14 → wake 10:25:02 PDT
// A sleep is simulated the way it happens: the wall clock jumps and no timer runs
// in between, then the first timers fire after wake.

const PDT = (local: string): number => Date.parse(`${local}-07:00`)
const A_SLEEP = PDT('2026-08-31T23:43:59')
const A_WAKE = PDT('2026-09-01T08:01:40')
const B_SLEEP = PDT('2026-09-02T01:11:14')
const B_WAKE = PDT('2026-09-02T10:25:02')

class FakePowerMonitor extends EventEmitter {}

function mount(options: { lastWakeAt?: number | null } = {}) {
  const power = new FakePowerMonitor()
  const readLastWakeAt = vi.fn(async () => options.lastWakeAt ?? null)
  const tracker = new SystemSuspensionTracker({ power, readLastWakeAt })
  const suspensions: SystemSuspension[] = []
  const probe: string[] = []
  tracker.on('suspension', (suspension: SystemSuspension) => suspensions.push(suspension))
  tracker.on('suspend', () => probe.push('suspend'))
  tracker.on('resume', () => probe.push('resume'))
  tracker.start()
  return { power, tracker, suspensions, probe, readLastWakeAt }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('SystemSuspensionTracker', () => {
  it('records one power-monitor suspension for a suspend/resume pair, and no duplicate from the post-wake tick', async () => {
    vi.setSystemTime(A_SLEEP)
    const { power, tracker, suspensions, probe } = mount()

    power.emit('suspend')
    vi.setSystemTime(A_WAKE)
    power.emit('resume')
    // The first post-wake tick sees the frozen interval too.
    await vi.advanceTimersByTimeAsync(10_000)

    expect(suspensions).toEqual([{ suspendedAt: A_SLEEP, resumedAt: A_WAKE, source: 'power-monitor' }])
    // MainProbe's suppression evidence stays power-monitor only.
    expect(probe).toEqual(['suspend', 'resume'])
    expect(tracker.list()).toEqual(suspensions)
    tracker.stop()
  })

  it('uses the gap the first tick measured when the suspend event was missed and resume arrives during the grace period', async () => {
    vi.setSystemTime(A_SLEEP)
    const { power, tracker, suspensions } = mount({ lastWakeAt: A_WAKE })

    // Last healthy tick right before the lid closed.
    await vi.advanceTimersByTimeAsync(5_000)
    const lastTick = A_SLEEP + 5_000
    vi.setSystemTime(A_WAKE)
    // First post-wake tick measures the gap, then resume lands inside the grace.
    await vi.advanceTimersByTimeAsync(5_000)
    power.emit('resume')
    await vi.advanceTimersByTimeAsync(10_000)

    expect(suspensions).toEqual([{ suspendedAt: lastTick, resumedAt: A_WAKE + 5_000, source: 'power-monitor' }])
    tracker.stop()
  })

  it('records a tick-gap suspension when no power event arrives but the OS reports a wake inside the gap', async () => {
    vi.setSystemTime(B_SLEEP)
    const { tracker, suspensions, probe } = mount({ lastWakeAt: B_WAKE })

    await vi.advanceTimersByTimeAsync(5_000)
    const lastTick = B_SLEEP + 5_000
    vi.setSystemTime(B_WAKE)
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.advanceTimersByTimeAsync(5_000)

    expect(suspensions).toEqual([{ suspendedAt: lastTick, resumedAt: B_WAKE + 5_000, source: 'tick-gap' }])
    // Never fed to MainProbe: only Electron evidence may suppress stall readings.
    expect(probe).toEqual([])
    tracker.stop()
  })

  it('does not treat a main-thread stall as sleep: a long gap with no OS wake inside it records nothing', async () => {
    vi.setSystemTime(B_SLEEP)
    // The OS last woke long before this gap.
    const { tracker, suspensions, readLastWakeAt } = mount({ lastWakeAt: B_SLEEP - 3_600_000 })

    await vi.advanceTimersByTimeAsync(5_000)
    vi.setSystemTime(B_SLEEP + 5 * 60_000)
    await vi.advanceTimersByTimeAsync(10_000)

    expect(readLastWakeAt).toHaveBeenCalled()
    expect(suspensions).toEqual([])
    tracker.stop()
  })

  it('does not add a bogus short sleep when Electron resume lands seconds after post-wake ticks recorded the tick gap', async () => {
    vi.setSystemTime(B_SLEEP)
    const { power, tracker, suspensions } = mount({ lastWakeAt: B_WAKE })

    await vi.advanceTimersByTimeAsync(5_000)
    vi.setSystemTime(B_WAKE)
    // Post-wake ticks publish the tick gap after the grace period...
    await vi.advanceTimersByTimeAsync(10_000)
    // ...and resume arrives between two later ticks, 2 s after the last one.
    await vi.advanceTimersByTimeAsync(2_000)
    power.emit('resume')

    expect(suspensions.map(suspension => suspension.source)).toEqual(['tick-gap'])
    tracker.stop()
  })

  it('keeps separate sleeps as separate intervals, oldest first', async () => {
    vi.setSystemTime(A_SLEEP)
    const { power, tracker } = mount()

    power.emit('suspend')
    vi.setSystemTime(A_WAKE)
    power.emit('resume')
    vi.setSystemTime(B_SLEEP)
    power.emit('suspend')
    vi.setSystemTime(B_WAKE)
    power.emit('resume')

    expect(tracker.list()).toEqual([
      { suspendedAt: A_SLEEP, resumedAt: A_WAKE, source: 'power-monitor' },
      { suspendedAt: B_SLEEP, resumedAt: B_WAKE, source: 'power-monitor' },
    ])
    tracker.stop()
  })
})

describe('parseSysctlTimeval', () => {
  it('reads the kern.waketime format and treats the never-woke zero as unknown', () => {
    // Captured verbatim on this machine (no sleep since boot).
    expect(parseSysctlTimeval('{ sec = 0, usec = 0 } Wed Dec 31 16:00:00 1969\n')).toBeNull()
    expect(parseSysctlTimeval('{ sec = 1756738900, usec = 512345 } Mon Sep  1 08:01:40 2025\n')).toBe(1756738900512)
    expect(parseSysctlTimeval('sysctl: unknown oid')).toBeNull()
  })
})

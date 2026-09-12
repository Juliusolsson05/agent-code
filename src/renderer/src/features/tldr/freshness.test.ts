import { describe, expect, it } from 'vitest'
import { emptyRuntime } from '@renderer/session-runtime/state'
import { tldrActivity, tldrTime } from './freshness'

const now = new Date(2026, 8, 11, 12).getTime()
const minute = 60_000, day = 86_400_000

describe('TLDR freshness', () => {
  it.each([
    [0, 'just now'], [minute - 1, 'just now'], [minute, '1 minute ago'],
    [59 * minute, '59 minutes ago'], [60 * minute, '1 hour ago'],
    [23 * 60 * minute, '23 hours ago'], [day, '1 day ago'], [29 * day, '29 days ago'],
  ])('formats age %i without a seconds ticker', (age, expected) => {
    expect(tldrTime(now - age, now).text).toBe(expected)
  })
  it('switches to local dates at 30 days, adding a year across calendar years and retaining exact time', () => {
    const older = now - 30 * day, lastYear = new Date(2025, 11, 24, 12).getTime()
    expect(tldrTime(older, now)).toMatchObject({ text: `on ${new Date(older).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`, iso: new Date(older).toISOString(), exact: expect.any(String) })
    expect(tldrTime(lastYear, now).text).toContain('2025')
    expect(tldrTime(now + minute, now).text).toBe('just now')
    expect(tldrTime(NaN, now).text).toBe('Unknown')
    expect(tldrTime(null, now).text).toBe('Unknown')
  })
  it('uses observed work and producer timestamps without making reload itself activity', () => {
    const runtime = emptyRuntime()
    expect(tldrActivity(runtime)).toEqual({ active: false, timestamp: null })
    runtime.lastJsonlEntryAt = now - day
    expect(tldrActivity(runtime).timestamp).toBe(now - day)
    runtime.phaseChangedAt = now - minute
    expect(tldrActivity(runtime).timestamp).toBe(now - minute)
    runtime.sessionStatus = 'running'
    expect(tldrActivity(runtime).active).toBe(true)
    runtime.exited = 0
    expect(tldrActivity(runtime).active).toBe(false)
  })
})

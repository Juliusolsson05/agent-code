import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { __resetSystemSuspensionsForTests } from '@renderer/lib/systemSuspensions'
import type { SystemSuspension } from '@shared/types/systemSuspension'

import { WorkIndicator } from './WorkIndicator'

// The in-feed counter the user saw read `Thinking · 20h03m` (#963). It must show
// working time: the machine's suspensions, delivered by main over the preload
// bridge, are subtracted. Times are the real case A recording
// (docs/decomposition/agent-working-time.md §2.4): prompt 2026-08-31 20:57:09,
// clamshell sleep 23:43:59 → wake 2026-09-01 08:01:40.

const PDT = (local: string): number => Date.parse(`${local}-07:00`)
const PROMPT_AT = PDT('2026-08-31T20:57:09')
const SLEEP: SystemSuspension = {
  suspendedAt: PDT('2026-08-31T23:43:59'),
  resumedAt: PDT('2026-09-01T08:01:40'),
  source: 'power-monitor',
}

const originalApi = Object.getOwnPropertyDescriptor(window, 'api')

function installBridge(initial: SystemSuspension[]) {
  let push: ((suspension: SystemSuspension) => void) | null = null
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      listSystemSuspensions: vi.fn(async () => initial),
      onSystemSuspension: vi.fn((cb: (suspension: SystemSuspension) => void) => {
        push = cb
        return () => {}
      }),
    },
  })
  return { push: (suspension: SystemSuspension) => push?.(suspension) }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  __resetSystemSuspensionsForTests()
})

afterEach(() => {
  vi.useRealTimers()
  __resetSystemSuspensionsForTests()
  if (originalApi) Object.defineProperty(window, 'api', originalApi)
  else Reflect.deleteProperty(window, 'api')
})

describe('WorkIndicator working-time counter', () => {
  it('shows the time worked before the lid closed, not the night, when the window loads after wake', async () => {
    vi.setSystemTime(SLEEP.resumedAt)
    installBridge([SLEEP])

    render(<WorkIndicator phase="thinking" turnStartedAt={PROMPT_AT} toolName={null} toolHint={null} reducedMotion />)
    // The recent-suspension read resolves after mount.
    await act(async () => {})

    // 20:57:09 → 23:43:59 is 2h46m50s of work; the wall clock would say 11h04m.
    expect(screen.getByText('· 2h46m')).toBeTruthy()
  })

  it('drops the sleep from a counter that is already on screen when main broadcasts it on wake', async () => {
    vi.setSystemTime(SLEEP.resumedAt)
    const bridge = installBridge([])

    render(<WorkIndicator phase="thinking" turnStartedAt={PROMPT_AT} toolName={null} toolHint={null} reducedMotion />)
    await act(async () => {})
    expect(screen.getByText('· 11h04m')).toBeTruthy()

    act(() => bridge.push(SLEEP))
    expect(screen.getByText('· 2h46m')).toBeTruthy()
  })
})

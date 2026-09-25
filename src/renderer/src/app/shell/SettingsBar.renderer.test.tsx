import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useCaffeinateStore } from '@renderer/features/caffeinate/store'
import { SettingsBar } from '@renderer/app/shell/SettingsBar'

// The caffeinate toggle's state reaches assistive tech (ledger N18). The accent
// fill used to be its only on/off signal, under the label "caff".

const appState = vi.hoisted(() => ({
  settings: { usageHeaderEnabled: false },
  setSettings: vi.fn(),
  performancePanelOpen: false,
  togglePerformancePanel: vi.fn(),
  performancePanelRequest: null,
  consumePerformancePanelRequest: vi.fn(),
}))
vi.mock('@renderer/app-state/hooks', () => ({
  useAppStore: (selector: (state: typeof appState) => unknown) => selector(appState),
}))
// Chrome neighbours with their own tests; only the caffeinate button is under test.
vi.mock('@renderer/features/feed/AppearanceMenu', () => ({ AppearanceMenu: () => null }))
vi.mock('@renderer/features/usage/ui/UsageHeaderIndicator', () => ({ UsageHeaderIndicator: () => null }))
vi.mock('@renderer/features/performance-monitor/PerformanceMonitor', () => ({ PerformanceMonitor: () => null }))

describe('SettingsBar caffeinate toggle', () => {
  it('announces a real name and follows main s on/off status', () => {
    act(() => useCaffeinateStore.setState({ status: { supported: true, active: false } as never }))
    render(<SettingsBar />)
    const toggle = screen.getByRole('button', { name: 'Keep the machine awake (caffeinate)' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')

    act(() => useCaffeinateStore.setState({ status: { supported: true, active: true } as never }))
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
  })
})

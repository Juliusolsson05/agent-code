import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Workspace } from '@renderer/workspace/workspaceStore'
import { useCliUpdateStore } from '@renderer/features/cli-updates/store'
import { DEFAULT_CLI_UPDATE_SNAPSHOT } from '@shared/types/cliUpdate'

import { AppChrome } from './AppChrome'

// The window-chrome contract (AppChrome.tsx has the WHY): with
// `titleBarStyle: 'hiddenInset'` the macOS traffic lights are drawn over
// the top-left corner of the page, and only `-webkit-app-region: drag`
// elements move the window. TabBar reserves the traffic-light inset and is
// the drag strip, so it must be the window's FIRST row even while a banner
// shows. Banners used to render above it: the "CLI UPDATE Codex auto-update
// failed…" text sat under the red/yellow/green buttons and the window could
// not be dragged by its top edge.
//
// TabBar and CliUpdateBanner are REAL here — the bug was seen with exactly
// that pair. The other rows have their own tests and heavier dependencies
// (workspace context, IPC probes), so they are stand-ins that render a row
// unconditionally: the order contract must hold when EVERY banner shows.
vi.mock('@renderer/app/shell/SettingsBar', () => ({
  SettingsBar: () => <div data-testid="settings-bar" />,
}))
vi.mock('@renderer/app/shell/RestoreBanner', () => ({
  RestoreBanner: () => <div data-testid="restore-banner" />,
}))
vi.mock('@renderer/features/voice-dictation/ConfigureDictationCard', () => ({
  ConfigureDictationCard: () => <div data-testid="dictation-card" />,
}))

// What main pushes over `traffic-light-inset` (pos.x + 62, rounded up).
const MAIN_INSET = 78

const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
beforeEach(() => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      onTrafficLightInset: (cb: (insetPx: number) => void) => {
        cb(MAIN_INSET)
        return () => {}
      },
    },
  })
  // The failure seen live: a Codex auto-update that did not take.
  useCliUpdateStore.setState({
    snapshot: {
      ...DEFAULT_CLI_UPDATE_SNAPSHOT,
      codex: {
        kind: 'failed',
        cli: 'codex',
        from: '0.140.0',
        wantedLatest: '0.144.0',
        installMethod: 'npm',
        reason: 'version-unchanged',
        logPath: '/logs/codex-update.log',
        finishedAt: 1,
      },
    },
    dismissed: new Set(),
  })
})
afterEach(() => {
  cleanup()
  act(() => useCliUpdateStore.setState({ snapshot: DEFAULT_CLI_UPDATE_SNAPSHOT, dismissed: new Set() }))
  if (originalApi) Object.defineProperty(window, 'api', originalApi)
  else Reflect.deleteProperty(window, 'api')
})

function renderChrome() {
  const workspace = {
    state: {
      tabs: [{ id: 'a', title: 'app' }],
      activeTabId: 'a',
      sessions: {},
      stage: { lanes: [], rows: [], focusedLane: 0 },
      pinnedSessionIds: [],
    },
    activateTab: vi.fn(),
    closeTab: vi.fn(async () => undefined),
  } as unknown as Workspace
  // A flex column like App's, so `firstElementChild` is the window's top row.
  return render(
    <div data-testid="window-column">
      <AppChrome workspace={workspace} onNewTabRequest={vi.fn()} />
    </div>,
  )
}

function tabBarRoot(): HTMLElement {
  const root = screen.getByRole('tablist', { name: 'Project tabs' }).closest('[class*="-webkit-app-region:drag"]')
  if (!(root instanceof HTMLElement)) throw new Error('TabBar root drag region not found')
  return root
}

describe('AppChrome window chrome', () => {
  it('keeps the tab bar as the first row while a CLI update banner shows', () => {
    renderChrome()
    // The banner from the bug report is on screen…
    expect(screen.getByText(/Codex auto-update failed/)).toBeInTheDocument()
    // …and the top row of the window is still the tab bar, not the banner.
    expect(screen.getByTestId('window-column').firstElementChild).toBe(tabBarRoot())
  })

  it('leaves an empty, draggable strip under the traffic lights', () => {
    renderChrome()
    const bar = tabBarRoot()
    // The whole row is a drag region (no-drag is opted back in per tab and
    // button, see TabBar), so the window drags from its top edge…
    expect(bar.className).toContain('[-webkit-app-region:drag]')
    // …and its first child is the spacer as wide as main's inset: empty,
    // with no text or control under the buttons.
    const spacer = bar.firstElementChild as HTMLElement
    expect(spacer.style.width).toBe(`${MAIN_INSET}px`)
    expect(spacer.childElementCount).toBe(0)
    expect(spacer.textContent).toBe('')
  })

  it('renders every banner after the tab bar and the settings bar', () => {
    renderChrome()
    const rows = Array.from(screen.getByTestId('window-column').children)
    const cliBanner = screen.getByText(/Codex auto-update failed/).closest('[role="status"]')
    const order = [
      tabBarRoot(),
      screen.getByTestId('settings-bar'),
      screen.getByTestId('restore-banner'),
      cliBanner?.parentElement, // CliUpdateBanner's row container
      screen.getByTestId('dictation-card'),
    ].map(row => rows.indexOf(row as Element))
    // Every row is a direct child of the column (AppChrome is a fragment,
    // so each keeps its own flex-shrink-0 in App's column), in this order.
    expect(order).toEqual([0, 1, 2, 3, 4])
  })
})

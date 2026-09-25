import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SpotlightView } from '@renderer/features/spotlight/ui/SpotlightView'
import { dispatchSessionIdsForTab } from '@renderer/workspace/dispatch/dispatchSelectors'
import type { SessionId, WorkspaceState } from '@renderer/workspace/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { loadRecordedDispatchWorkspace } from '@renderer/workspace/testing/recordedDispatchWorkspace'

// Spotlight's header strip from the keyboard (plan K5/K7, ledger N5).
//
// Two gaps this pins:
// - the agent pills showed "which agent is spotlighted" only as an accent
//   fill, which a screen reader never hears;
// - the Split | Browser | Agent control announced itself as a radiogroup but
//   was three Tab stops with no arrow keys, so it lied about how to drive it.
//
// The recorded dispatch workspace supplies real tabs and sessions; only the
// leaf renderer (a full agent pane) is stubbed, because the header strip is
// what is under test.

const appState = vi.hoisted(() => ({ settings: { browserPocketEnabled: true } }))
vi.mock('@renderer/app-state/hooks', () => ({
  useAppStore: (selector: (state: typeof appState) => unknown) => selector(appState),
}))
vi.mock('@renderer/workspace/tile-tree/TileTree', () => ({
  renderWorkspaceLeaf: (sessionId: string) => <div data-testid="leaf" data-session-id={sessionId} />,
}))

const FIXTURE = loadRecordedDispatchWorkspace()

function renderSpotlight() {
  const tabId = FIXTURE.state.activeTabId
  const base: WorkspaceState = FIXTURE.state
  const sessionIds = dispatchSessionIdsForTab(base, tabId)
  expect(sessionIds.length).toBeGreaterThan(1)
  const focused = sessionIds[1]! as SessionId
  // Give the spotlighted agent a pocket so the layout control renders. The
  // 'open' view is "Split" unless Browser-only is on.
  const state: WorkspaceState = {
    ...base,
    sessions: {
      ...base.sessions,
      [focused]: { ...base.sessions[focused]!, browserPocket: { pocketId: 'p1', view: 'open', profile: 'lane' } },
    },
  }
  const setSpotlightSession = vi.fn()
  const updateBrowserPocket = vi.fn()
  const workspace = {
    state,
    spotlight: { tabId, focusedSessionId: focused },
    setSpotlightSession,
    updateBrowserPocket,
  } as unknown as Workspace
  const view = render(
    <SpotlightView
      workspace={workspace}
      agentViewMode="agent"
      showStatusMode={false}
      showWorktreeBadges={false}
    />,
  )
  return { ...view, focused, sessionIds, setSpotlightSession, updateBrowserPocket }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('SpotlightView header', () => {
  it('marks exactly the spotlighted agent pill as current', () => {
    const { container, focused, sessionIds } = renderSpotlight()
    const current = container.querySelectorAll('[aria-current="true"]')
    expect(current).toHaveLength(1)
    // It is the pill for the spotlighted agent (the fixture's SECOND session,
    // so a "mark the first pill" bug cannot pass), not merely one of them.
    const pills = [...container.querySelectorAll('button:not([role="radio"])')]
    expect(pills).toHaveLength(sessionIds.length)
    expect(pills[sessionIds.indexOf(focused)]).toBe(current[0])
  })

  it('walks the layout radios with arrows without choosing one', () => {
    const { getByRole, updateBrowserPocket } = renderSpotlight()
    const group = getByRole('radiogroup', { name: 'Spotlight layout' })
    const radios = within(group).getAllByRole('radio')
    expect(radios.map(radio => radio.textContent)).toEqual(['split', 'browser', 'agent'])

    // One Tab stop: the chosen layout.
    expect(radios.map(radio => radio.tabIndex)).toEqual([0, -1, -1])

    radios[0]!.focus()
    fireEvent.keyDown(radios[0]!, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(radios[1])
    // Moving never chose: the pocket was not rewritten.
    expect(updateBrowserPocket).not.toHaveBeenCalled()

    fireEvent.keyDown(radios[1]!, { key: 'End' })
    expect(document.activeElement).toBe(radios[2])
    // Wraps from the last back to the first, like every other radio group.
    fireEvent.keyDown(radios[2]!, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(radios[0])
    fireEvent.keyDown(radios[0]!, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(radios[2])

    // A modified arrow is an app chord (⌥↑↓ selects agents), never ours.
    fireEvent.keyDown(radios[2]!, { key: 'ArrowLeft', altKey: true })
    expect(document.activeElement).toBe(radios[2])
  })
})

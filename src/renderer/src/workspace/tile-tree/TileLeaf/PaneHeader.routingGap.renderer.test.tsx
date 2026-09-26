import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { useAppStore } from '@renderer/app-state/hooks'
import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import { PaneHeader } from './PaneHeader'

// The routing-gap notice a pane shows when live output could not be delivered
// to it (#935), and WHEN it still offers to repair itself.
//
// #935 Codex review: an automatic refresh acknowledges the main-process gap
// ticket and DELETES it. Any later press of the same button can only come back
// `stale`, and after an ordinary recovery mints a new ownership revision it
// does so forever — a dead control under a warning that is otherwise correct.

const originalStore = useAppStore.getState()
afterEach(() => { cleanup(); useAppStore.setState(originalStore, true) })

function paneWith(phase: 'refreshing' | 'refreshed' | 'unavailable') {
  const runtime: SessionRuntime = {
    ...emptyRuntime(),
    routingGap: { sessionId: 'pane', ownershipRevision: 2, gapRevision: 1, reason: 'queue_overflow' as never, missedEvents: 3, phase },
  }
  useAppStore.setState({ workspaceRuntimes: { pane: runtime } })
  render(
    <PaneHeader sessionId={'pane' as never} projectDir="/fixture" statusMode={false} isSessionLive />,
  )
}

describe('the routing-gap notice', () => {
  it('offers a repair while one is still possible', () => {
    paneWith('unavailable')
    // The ticket still exists in main, and the failure may be transient.
    expect(screen.getByRole('button', { name: 'Refresh View' })).toBeTruthy()
  })

  it('keeps the warning but drops the button once the refresh has happened', () => {
    paneWith('refreshed')
    expect(screen.getByText(/some earlier live output may be missing/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Refresh View' })).toBeNull()
  })

  it('disables the button while a repair is running', () => {
    paneWith('refreshing')
    expect(screen.getByRole('button', { name: 'Refresh View' })).toBeDisabled()
  })
})

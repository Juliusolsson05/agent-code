import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { useAppStore } from '@renderer/app-state/store'

import { PaneHeader } from './PaneHeader'

const original = useAppStore.getState()
afterEach(() => { cleanup(); useAppStore.setState(original, true) })

// WHAT THIS FILE USED TO PIN, because most of it was deleted on purpose
// (#992 stage 4). PaneHeader carried a related-agent chip strip — one row of
// mini-tabs for a parent's linked/orchestration children, fed by the tile
// tree's gridRelatedSelections. The tree died in stage 3 and the strip had no
// feeder; stage 4 decided between feeding it from the pool and deleting it,
// and deleted it: the per-row index already lists every child nested under
// its parent, so a pane-local second selector was a second surface answering
// a question the index answers with more space (and against U2, which says a
// lane shows one occupant the user names).
//
// Three chip cases went with it (store-coupled status dots, the keyless-store
// fallback). What survives is the case that was never about the chips: the
// phone. src/remote-client shares this header with a stubbed store, and a
// selector that reads a workspace key compiles against the real types and
// then throws on a device — reproducible nowhere else but here.
describe('PaneHeader phone coupling', () => {
  it('renders no agent name on a store with no workspace keys (phone stub shape)', () => {
    // src/remote-client aliases @renderer/app-state/hooks to a stub whose
    // state is `{ settings }` (vite.config.ts). tsconfig.web.json type-checks
    // that directory against the REAL hooks module, so a selector reading
    // state.workspaceState compiles and then throws on a device. Reproducing
    // the stub shape here is the only place that can catch it.
    useAppStore.setState({
      workspaceState: undefined as never,
      workspaceAgentNames: undefined as never,
    })
    const { container } = render(
      <PaneHeader
        sessionId="session"
        projectDir="/project"
        statusMode={false}
        isSessionLive={false}
      />,
    )
    // Degrade, never throw — and with no workspace there is no name to show,
    // so the title row stays absent exactly as it is on the phone today.
    expect(container.querySelector('[data-agent-name-badge="true"]')).toBeNull()
    expect(container.querySelector('[data-agent-title-header="true"]')).toBeNull()
  })
})

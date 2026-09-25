import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

import { emptyRuntime } from '@renderer/session-runtime/state'
import * as workspaceQueries from '@renderer/workspace/queries'
import type { Workspace } from '@renderer/workspace/workspaceStore'

import { AgentActivityView } from '@renderer/features/agent-activity/ui/AgentActivityView'
import { BulkProviderSwitchModal } from './BulkProviderSwitchModal'
import { CloseOldAgentsModal } from './CloseOldAgentsModal'
import { useProviderEnablementStore } from '@renderer/features/providers/store'
import { AGENT_PROVIDER_KINDS } from '@shared/types/providerKind'

// The bulk modal derives its directions from the shared enablement store;
// without a reset, an earlier test file in this worker could leave a
// restricted snapshot and empty every direction (fail-open = all kinds).
beforeEach(() => {
  useProviderEnablementStore.setState({ snapshot: null, enabledKinds: new Set(AGENT_PROVIDER_KINDS) })
})

const appActions = vi.hoisted(() => ({ openBuryPrompt: vi.fn() }))
vi.mock('@renderer/app-state/hooks', () => ({
  useAppStore: (selector: (state: typeof appActions) => unknown) => selector(appActions),
}))

afterEach(() => {
  vi.restoreAllMocks()
})

function workspaceFixture(): Workspace {
  // One old Codex agent is valid for all three modals: Activity shows its live
  // status, Close Old excludes it while running, and Switch's default direction
  // is Codex -> Claude. Keeping membership fixed makes runtime changes alone
  // responsible for invalidating the expensive row derivations.
  return {
    state: {
      activeTabId: 'project-tab',
      tabs: [{
        id: 'project-tab',
        title: 'Project tab',
      }],
      sessions: { agent: { cwd: '/projects/terminal-perf', kind: 'codex', projectId: 'project-tab', joinedAt: 0 } },
      // A WHOLE workspace, not just tabs + sessions. The Activity modal's Focus
      // action and lane column read the stage and pins since #992 (they used to
      // read the tile tree, which this fixture faked with a `root`). The
      // `as unknown as Workspace` below means the compiler will not say when
      // the next field goes missing — the runtime TypeError will.
      pinnedSessionIds: [],
      stage: { lanes: [{ selectedSessionId: 'agent' }], rows: [{ length: 1 }], focusedLane: 0 },
    },
    runtimes: {},
    focusSessionInTab: vi.fn(),
    closeSession: vi.fn(),
    closeAgentActivitySelection: vi.fn(),
    switchAgentsToProvider: vi.fn(),
    returnLastProviderSwitchBatch: vi.fn(),
  } as unknown as Workspace
}

function replaceRuntime(workspace: Workspace, running: boolean): Workspace {
  return {
    ...workspace,
    runtimes: {
      agent: {
        ...emptyRuntime(),
        turnStartedAt: Date.now() - 8 * 60 * 60 * 1000,
        sessionStatus: running ? 'running' : 'idle',
        streamPhase: running ? 'thinking' : 'idle',
      },
    },
  }
}

const modalCases = [
  {
    // The full-screen replacement (#1170) keeps the old modal's contract: it
    // stays mounted while closed, so its row model must not run then.
    name: 'AgentActivityView',
    Component: AgentActivityView,
    assertRunning: () => expect(screen.getByRole('region', { name: 'Working' })).toHaveTextContent('terminal-perf'),
    assertIdle: () => {
      expect(screen.queryByRole('region', { name: 'Working' })).not.toBeInTheDocument()
      expect(screen.getByRole('region', { name: 'Idle' })).toHaveTextContent('terminal-perf')
    },
  },
  {
    name: 'CloseOldAgentsModal',
    Component: CloseOldAgentsModal,
    assertRunning: () => expect(screen.getByText('No agents match the current filters.')).toBeInTheDocument(),
    assertIdle: () => expect(screen.getByText('1 agent will be closed.')).toBeInTheDocument(),
  },
  {
    name: 'BulkProviderSwitchModal',
    Component: BulkProviderSwitchModal,
    assertRunning: () => expect(screen.getByText(/1 of 1 are mid-turn and will be skipped/)).toBeInTheDocument(),
    assertIdle: () => {
      expect(screen.queryByText(/are mid-turn and will be skipped/)).not.toBeInTheDocument()
      expect(screen.getByText('Terminals are never switched.')).toBeInTheDocument()
    },
  },
]

describe('closed workspace modal derivations', () => {
  it.each(modalCases)(
    '$name skips hidden runtime updates and derives current rows whenever visible',
    ({ Component, assertRunning, assertIdle }) => {
      // Spy without replacing the resolver: visible assertions must still
      // exercise actual workspace membership, filtering, and row rendering.
      const enumerateSessions = vi.spyOn(workspaceQueries, 'resolveTabSessions')
      const onClose = vi.fn()
      let workspace = replaceRuntime(workspaceFixture(), false)
      const mounted = render(<Component open={false} workspace={workspace} onClose={onClose} />)
      expect(enumerateSessions).not.toHaveBeenCalled()

      for (const running of [true, false, true]) {
        workspace = replaceRuntime(workspace, running)
        mounted.rerender(<Component open={false} workspace={workspace} onClose={onClose} />)
      }
      expect(enumerateSessions).not.toHaveBeenCalled()
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

      // Open without changing runtime identity. Omitting `open` from a memo's
      // dependencies would leave its cached empty rows on screen indefinitely.
      mounted.rerender(<Component open workspace={workspace} onClose={onClose} />)
      expect(enumerateSessions).toHaveBeenCalled()
      assertRunning()

      enumerateSessions.mockClear()
      workspace = replaceRuntime(workspace, false)
      mounted.rerender(<Component open workspace={workspace} onClose={onClose} />)
      expect(enumerateSessions).toHaveBeenCalled()
      assertIdle()

      enumerateSessions.mockClear()
      mounted.rerender(<Component open={false} workspace={workspace} onClose={onClose} />)
      for (const running of [false, true, false, true]) {
        workspace = replaceRuntime(workspace, running)
        mounted.rerender(<Component open={false} workspace={workspace} onClose={onClose} />)
      }
      expect(enumerateSessions).not.toHaveBeenCalled()

      mounted.rerender(<Component open workspace={workspace} onClose={onClose} />)
      expect(enumerateSessions).toHaveBeenCalled()
      assertRunning()

      // This is strictly a preview/performance regression. It must neither
      // trigger destructive actions nor substitute for their existing latest-
      // snapshot revalidation tests.
      expect(workspace.closeSession).not.toHaveBeenCalled()
      expect(workspace.switchAgentsToProvider).not.toHaveBeenCalled()
      expect(onClose).not.toHaveBeenCalled()
      mounted.unmount()
    },
  )
})

describe('Agent Activity rows keep the keys on the highlighted row (#867 review)', () => {
  it('keeps the per-row close button out of the tab order and out of click focus', () => {
    // The keys act on the HIGHLIGHTED row from the list container. A row
    // button that could take focus would split "the row the keys act on" from
    // "the row the user sees" — the old modal's bug was Tab to row 2's close,
    // press Delete, and row 1 closed. `tabIndex={-1}` plus a cancelled
    // mousedown keeps focus where the keys are handled.
    const workspace = replaceRuntime(workspaceFixture(), false)
    const mounted = render(<AgentActivityView open workspace={workspace} onClose={vi.fn()} />)

    const close = screen.getByRole('button', { name: 'Close' })
    expect(close.getAttribute('tabindex')).toBe('-1')
    // `false` = the default was prevented, which is what stops a real browser
    // moving focus to the button on click.
    expect(fireEvent.mouseDown(close)).toBe(false)
    // And it still closes on an actual click — through the confirming bulk
    // flow, never a raw closeSession, even for one row.
    fireEvent.click(close)
    expect(workspace.closeAgentActivitySelection).toHaveBeenCalledWith([{ sessionId: 'agent', name: 'terminal-perf' }])
    expect(workspace.closeSession).not.toHaveBeenCalled()
    mounted.unmount()
  })
})

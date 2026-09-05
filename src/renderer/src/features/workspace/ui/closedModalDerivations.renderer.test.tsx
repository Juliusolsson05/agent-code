import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { emptyRuntime } from '@renderer/session-runtime/state'
import * as workspaceQueries from '@renderer/workspace/queries'
import type { Workspace } from '@renderer/workspace/workspaceStore'

import { AgentActivityModal } from './AgentActivityModal'
import { BulkProviderSwitchModal } from './BulkProviderSwitchModal'
import { CloseOldAgentsModal } from './CloseOldAgentsModal'

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
        focusedSessionId: 'agent',
        root: { type: 'leaf', sessionId: 'agent' },
      }],
      sessions: { agent: { cwd: '/projects/terminal-perf', kind: 'codex' } },
      detachedSessions: {},
    },
    runtimes: {},
    focusSessionInTab: vi.fn(),
    closeSession: vi.fn(),
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
    name: 'AgentActivityModal',
    Component: AgentActivityModal,
    assertRunning: () => expect(screen.getByText('Active now')).toBeInTheDocument(),
    assertIdle: () => {
      expect(screen.queryByText('Active now')).not.toBeInTheDocument()
      expect(screen.getByText('terminal-perf')).toBeInTheDocument()
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

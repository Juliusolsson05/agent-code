import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { emptyRuntime } from '@renderer/session-runtime/state'
import { AgentTerminalOwnershipProvider } from '@renderer/workspace/terminal/AgentTerminalOwnership'
import { DebugSurfacesImpl } from '@renderer/features/debug/surfaces/DebugSurfacesImpl'
import { MainSurface } from './MainSurface'

const harness = vi.hoisted(() => ({
  appState: {} as Record<string, unknown>,
  workspace: {} as Record<string, unknown>,
  // Pane terminal lifecycle, keyed by session: a takeover must HIDE the pane,
  // never unmount it (#752) — an unmount is a disposed xterm plus a full PTY
  // replay on the way back.
  paneMounts: {} as Record<string, number>,
  paneUnmounts: {} as Record<string, number>,
}))

vi.mock('@renderer/app-state/hooks', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector(harness.appState),
}))

vi.mock('@renderer/workspace/WorkspaceContext', () => ({
  useWorkspaceContext: () => harness.workspace,
  useWorkspaceLayoutContext: () => harness.workspace,
}))

vi.mock('@renderer/features/workspace/surfaces/usePlacementOverlay', () => ({
  usePlacementOverlay: () => ({
    open: false,
    close: vi.fn(),
    attachIntent: null,
    linkedAgentParentId: null,
    projectIntent: null,
  }),
}))

vi.mock('@renderer/features/settings/ui/SettingsPage', () => ({
  SettingsPage: () => <div data-testid="settings-page" />,
}))

vi.mock('@renderer/features/reader/ui/ReaderView', () => ({
  ReaderView: () => <div data-testid="reader-view" />,
}))

vi.mock('@renderer/features/global-editor/ui/GlobalEditorShell', () => ({
  GlobalEditorShell: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

// Unified layout (#992): MainSurface renders the lane stage — there is no
// tile-tree branch to mount panes anymore. The retention contracts this
// suite protects (takeovers HIDE the workspace, never unmount it; dimension
// ownership follows the actually-mounted terminal) are unchanged; what
// changed is the harness: sessions must be PLACED IN LANES for their panes
// to mount, exactly like the real app now works.
vi.mock('@renderer/workspace/dispatch/TiledDispatchLayout', async () => {
  const { useEffect } = await import('react')
  // The REAL ownership wrapper, not a fake: this suite's entire subject is
  // the dimension-claim handshake (register on visible, release on hidden),
  // so the stand-in lane must register exactly like a real pane terminal.
  const { MountedAgentTerminalOwner } = await import(
    '@renderer/workspace/terminal/AgentTerminalOwnership'
  )
  return {
    // A lane-shaped stand-in that mounts each lane's pane through the same
    // ownership wrapper the real layout uses. The real TiledDispatchLayout's
    // own behavior is covered by gridDispatchLayout.renderer.test.tsx; this
    // suite is about RetainedWorkspaceSurface + ownership across takeovers,
    // so the lane grid itself stays a thin mount point here.
    TiledDispatchLayout: ({ workspace }: { workspace: { state: { stage: { lanes: Array<{ selectedSessionId?: string }> } } } }) => {
      const lanes = workspace.state.stage.lanes
      return (
        <>
          {lanes.map((lane, index) =>
            lane.selectedSessionId ? (
            <LanePane key={index} sessionId={lane.selectedSessionId} />
            ) : null,
          )}
        </>
      )
    },
  }
  function LanePane({ sessionId }: { sessionId: string }) {
    useEffect(() => {
      harness.paneMounts[sessionId] = (harness.paneMounts[sessionId] ?? 0) + 1
      return () => {
        harness.paneUnmounts[sessionId] = (harness.paneUnmounts[sessionId] ?? 0) + 1
      }
    }, [sessionId])
    return (
      <MountedAgentTerminalOwner sessionId={sessionId}>
        <div data-testid={`pane-agent-terminal-${sessionId}`} />
      </MountedAgentTerminalOwner>
    )
  }
})

vi.mock('@renderer/features/workspace/ui/NewAgentPlacementOverlay', () => ({
  NewAgentPlacementOverlay: () => null,
}))

vi.mock('@renderer/workspace/tile-tree/AgentTerminalLeaf', async () => {
  const { useEffect } = await import('react')
  return {
    AgentTerminalLeaf: ({ sessionId }: { sessionId: string }) => {
      useEffect(() => {
        harness.paneMounts[sessionId] = (harness.paneMounts[sessionId] ?? 0) + 1
        return () => {
          harness.paneUnmounts[sessionId] = (harness.paneUnmounts[sessionId] ?? 0) + 1
        }
      }, [sessionId])
      return <div data-testid={`pane-agent-terminal-${sessionId}`} />
    },
  }
})

vi.mock('@renderer/features/debug/ui/AgentInlineTerminal', () => ({
  AgentInlineTerminal: () => <div data-testid="inline-agent-terminal" />,
}))

vi.mock('@renderer/features/debug/devDebugConfig', () => ({
  useDevDebugConfig: (selector: (state: { enabled: boolean }) => unknown) =>
    selector({ enabled: false }),
}))

describe('terminal dimension ownership across main-surface takeovers', () => {
  beforeEach(() => {
    harness.paneMounts = {}
    harness.paneUnmounts = {}
    const runtime = emptyRuntime()
    const activeTab = {
      id: 'tab-1',
      focusedSessionId: 'session-1',
      root: { type: 'leaf', sessionId: 'session-1' },
    }
    harness.appState = {
      workspaceRuntimes: {},
      debugPanelOpen: true,
      feedDebugPanelOpen: false,
      proxyDebugPanelOpen: false,
      htmlDebugPanelOpen: false,
      renderingDebugMode: false,
      devDebugPanelOpen: false,
      settingsPageOpen: false,
      closeSettingsPage: vi.fn(),
      setSettings: vi.fn(),
      resetSettings: vi.fn(),
      toggleDebugPanel: vi.fn(),
      toggleFeedDebugPanel: vi.fn(),
      toggleProxyDebugPanel: vi.fn(),
      toggleHtmlDebugPanel: vi.fn(),
      toggleRenderingDebugMode: vi.fn(),
      openDebugBundleNotePrompt: vi.fn(),
      toggleDevDebugPanel: vi.fn(),
      settings: { agentViewMode: 'agent' },
    }
    harness.workspace = {
      state: {
        activeTabId: 'tab-1',
        tabs: [activeTab],
        sessions: {
          'session-1': {
            kind: 'claude',
            agentViewModeOverride: 'terminal',
          },
        },
        detachedSessions: {},
        gridRelatedSelections: {},
        pinnedSessionIds: [],
        // The stage placing session-1 — the unified workspace's one mount
        // path. One row, one occupied lane, focused.
        stage: {
          lanes: [{ selectedSessionId: 'session-1' }],
          rows: [{ length: 1 }],
          focusedLane: 0,
        },
      },
      activeTab,
      readerMode: null,
      spotlight: null,
      getRuntime: () => runtime,
      focusSessionInTab: vi.fn(),
      showPaneToast: vi.fn(),
    }
  })

  afterEach(() => {
    cleanup()
  })

  it('hands dimension ownership to the inline terminal while Settings hides the retained pane terminal', async () => {
    const tree = () => (
      <AgentTerminalOwnershipProvider>
        <MainSurface onNewTabRequest={vi.fn()} />
        <DebugSurfacesImpl />
      </AgentTerminalOwnershipProvider>
    )
    const view = render(tree())

    expect(screen.getByTestId('pane-agent-terminal-session-1')).toBeTruthy()
    await waitFor(() => {
      expect(screen.getByText('raw screen (last 20 lines)')).toBeTruthy()
    })
    expect(screen.queryByTitle('Open inline raw PTY terminal')).toBeNull()

    harness.appState = { ...harness.appState, settingsPageOpen: true }
    view.rerender(tree())

    expect(screen.getByTestId('settings-page')).toBeTruthy()
    // Retained, not unmounted: the pane is still in the tree, hidden with
    // its whole workspace, and has released its dimension claim.
    expect(screen.getByTestId('pane-agent-terminal-session-1')).toBeTruthy()
    expect(screen.getByTestId('retained-workspace-surface').style.display).toBe('none')
    expect(harness.paneUnmounts['session-1'] ?? 0).toBe(0)
    const openInline = await screen.findByTitle('Open inline raw PTY terminal')
    fireEvent.click(openInline)
    expect(screen.getByTestId('inline-agent-terminal')).toBeTruthy()

    harness.appState = { ...harness.appState, settingsPageOpen: false }
    view.rerender(tree())

    expect(screen.getByTestId('pane-agent-terminal-session-1')).toBeTruthy()
    expect(screen.getByTestId('retained-workspace-surface').style.display).toBe('contents')
    expect(harness.paneMounts['session-1']).toBe(1)
    expect(harness.paneUnmounts['session-1'] ?? 0).toBe(0)
    await waitFor(() => {
      expect(screen.queryByTestId('inline-agent-terminal')).toBeNull()
      expect(screen.getByText('raw screen (last 20 lines)')).toBeTruthy()
    })
  })

  it('keeps every pane terminal mounted across entering and leaving Reader Mode', () => {
    const tree = () => (
      <AgentTerminalOwnershipProvider>
        <MainSurface onNewTabRequest={vi.fn()} />
      </AgentTerminalOwnershipProvider>
    )
    const view = render(tree())
    expect(screen.getByTestId('pane-agent-terminal-session-1')).toBeTruthy()
    expect(screen.getByTestId('retained-workspace-surface').style.display).toBe('contents')

    harness.workspace = {
      ...harness.workspace,
      readerMode: { tabId: 'tab-1', focusedSessionId: 'session-1' },
    }
    view.rerender(tree())
    expect(screen.getByTestId('reader-view')).toBeTruthy()
    expect(screen.getByTestId('pane-agent-terminal-session-1')).toBeTruthy()
    expect(screen.getByTestId('retained-workspace-surface').style.display).toBe('none')

    harness.workspace = { ...harness.workspace, readerMode: null }
    view.rerender(tree())
    expect(screen.queryByTestId('reader-view')).toBeNull()
    expect(screen.getByTestId('retained-workspace-surface').style.display).toBe('contents')
    // One mount for the whole round trip: no disposed xterm, no PTY replay.
    expect(harness.paneMounts['session-1']).toBe(1)
    expect(harness.paneUnmounts['session-1'] ?? 0).toBe(0)
  })

  it('guards the debug target by the terminal Spotlight actually mounted', async () => {
    // Unified layout: BOTH panes are lane occupants. session-2 is a pooled
    // (detached) member of tab-1 — the v2-consistent way to be on the stage
    // without being a tree leaf. Spotlight mounts its own leaf for
    // session-2 on top of the retained (hidden) stage, which still holds
    // both lanes.
    const tiled = {
      lanes: [{ selectedSessionId: 'session-1' }, { selectedSessionId: 'session-2' }],
      rows: [{ length: 2 }],
      focusedLane: 0,
    }
    harness.workspace = {
      ...harness.workspace,
      spotlight: { tabId: 'tab-1', focusedSessionId: 'session-2' },
      setSpotlightSession: vi.fn(),
      stage: tiled,
      state: {
        ...(harness.workspace.state as Record<string, unknown>),
        sessions: {
          ...((harness.workspace.state as { sessions: Record<string, unknown> }).sessions),
          'session-2': {
            kind: 'codex',
            agentViewModeOverride: 'terminal',
          },
        },
        detachedSessions: {
          'session-2': {
            sessionId: 'session-2',
            surface: 'dispatch',
            projectTabId: 'tab-1',
            projectTabTitle: 'Project',
            projectTabIndex: 0,
            detachedAt: 1,
          },
        },
        stage: tiled,
      },
    }

    render(
      <AgentTerminalOwnershipProvider>
        <MainSurface onNewTabRequest={vi.fn()} />
        <DebugSurfacesImpl />
      </AgentTerminalOwnershipProvider>,
    )

    // Spotlight mounts its own leaf for session-2 on top of the retained
    // (hidden) tile tree, which still holds both panes.
    expect(screen.getAllByTestId('pane-agent-terminal-session-2')).toHaveLength(2)
    expect(screen.getByTestId('pane-agent-terminal-session-1')).toBeTruthy()
    expect(screen.getByTestId('retained-workspace-surface').style.display).toBe('none')
    // The command/debug target intentionally remains session-1 while
    // Spotlight renders session-2. Both are Terminal-configured, but they own
    // different PTYs, so suppressing session-1's inline recovery terminal
    // would be policy-based overreach rather than dimension arbitration.
    await waitFor(() => {
      expect(screen.getByTitle('Open inline raw PTY terminal')).toBeTruthy()
    })
  })
})

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
}))

vi.mock('@renderer/app-state/hooks', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector(harness.appState),
}))

vi.mock('@renderer/workspace/WorkspaceContext', () => ({
  useWorkspaceContext: () => harness.workspace,
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

vi.mock('@renderer/features/tile-tabs/ui/TileTabsView', () => ({
  TileTabsView: () => null,
}))

vi.mock('@renderer/workspace/dispatch/DispatchLayout', () => ({
  DispatchLayout: () => null,
}))

vi.mock('@renderer/features/workspace/ui/NewAgentPlacementOverlay', () => ({
  NewAgentPlacementOverlay: () => null,
}))

vi.mock('@renderer/workspace/tile-tree/AgentTerminalLeaf', () => ({
  AgentTerminalLeaf: ({ sessionId }: { sessionId: string }) => (
    <div data-testid={`pane-agent-terminal-${sessionId}`} />
  ),
}))

vi.mock('@renderer/features/debug/ui/AgentInlineTerminal', () => ({
  AgentInlineTerminal: () => <div data-testid="inline-agent-terminal" />,
}))

vi.mock('@renderer/features/debug/devDebugConfig', () => ({
  useDevDebugConfig: (selector: (state: { enabled: boolean }) => unknown) =>
    selector({ enabled: false }),
}))

describe('terminal dimension ownership across main-surface takeovers', () => {
  beforeEach(() => {
    const runtime = emptyRuntime()
    const activeTab = {
      id: 'tab-1',
      focusedSessionId: 'session-1',
      root: { type: 'leaf', sessionId: 'session-1' },
    }
    harness.appState = {
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
        dispatchMode: null,
      },
      activeTab,
      dispatchMode: null,
      tileTabs: null,
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

  it('hands dimension ownership to the inline terminal only while Settings unmounts the pane terminal', async () => {
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
    expect(screen.queryByTestId('pane-agent-terminal-session-1')).toBeNull()
    const openInline = await screen.findByTitle('Open inline raw PTY terminal')
    fireEvent.click(openInline)
    expect(screen.getByTestId('inline-agent-terminal')).toBeTruthy()

    harness.appState = { ...harness.appState, settingsPageOpen: false }
    view.rerender(tree())

    expect(screen.getByTestId('pane-agent-terminal-session-1')).toBeTruthy()
    await waitFor(() => {
      expect(screen.queryByTestId('inline-agent-terminal')).toBeNull()
      expect(screen.getByText('raw screen (last 20 lines)')).toBeTruthy()
    })
  })

  it('guards the debug target by the terminal Spotlight actually mounted', async () => {
    const splitTab = {
      ...(harness.workspace.activeTab as Record<string, unknown>),
      root: {
        type: 'split',
        direction: 'vertical',
        ratio: 0.5,
        a: { type: 'leaf', sessionId: 'session-1' },
        b: { type: 'leaf', sessionId: 'session-2' },
      },
    }
    harness.workspace = {
      ...harness.workspace,
      activeTab: splitTab,
      spotlight: { tabId: 'tab-1', focusedSessionId: 'session-2' },
      setSpotlightSession: vi.fn(),
      state: {
        ...(harness.workspace.state as Record<string, unknown>),
        tabs: [splitTab],
        sessions: {
          ...((harness.workspace.state as { sessions: Record<string, unknown> }).sessions),
          'session-2': {
            kind: 'codex',
            agentViewModeOverride: 'terminal',
          },
        },
      },
    }

    render(
      <AgentTerminalOwnershipProvider>
        <MainSurface onNewTabRequest={vi.fn()} />
        <DebugSurfacesImpl />
      </AgentTerminalOwnershipProvider>,
    )

    expect(screen.getByTestId('pane-agent-terminal-session-2')).toBeTruthy()
    expect(screen.queryByTestId('pane-agent-terminal-session-1')).toBeNull()
    // The command/debug target intentionally remains session-1 while
    // Spotlight renders session-2. Both are Terminal-configured, but they own
    // different PTYs, so suppressing session-1's inline recovery terminal
    // would be policy-based overreach rather than dimension arbitration.
    await waitFor(() => {
      expect(screen.getByTitle('Open inline raw PTY terminal')).toBeTruthy()
    })
  })
})

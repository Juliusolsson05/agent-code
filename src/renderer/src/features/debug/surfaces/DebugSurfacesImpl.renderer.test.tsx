import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { emptyRuntime } from '@renderer/session-runtime/state'
import {
  AgentTerminalOwnershipProvider,
  AgentTerminalOwnerVisibilityProvider,
  MountedAgentTerminalOwner,
  useAgentTerminalDimensionActive,
  useHasAgentTerminalDimensionClaim,
} from '@renderer/workspace/terminal/AgentTerminalOwnership'
import { DebugSurfacesImpl } from './DebugSurfacesImpl'

const harness = vi.hoisted(() => ({
  appState: {} as Record<string, unknown>,
  devDebugState: { enabled: false } as Record<string, unknown>,
  workspace: {} as Record<string, unknown>,
  inlineRawTerminalDisabled: undefined as boolean | undefined,
  panePassiveParentClasses: [] as string[],
  handoffEvents: [] as string[],
}))

function PanePassiveResizeProbe() {
  const nodeRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    harness.panePassiveParentClasses.push(nodeRef.current?.parentElement?.className ?? '')
  }, [])

  return <div ref={nodeRef} data-testid="pane-passive-probe" />
}

function PaneDimensionWriterProbe() {
  const active = useAgentTerminalDimensionActive()

  useEffect(() => {
    if (active) harness.handoffEvents.push('pane-writer-active')
  }, [active])

  return null
}

function InlineDimensionOwnerProbe() {
  const paneClaimsDimensions = useHasAgentTerminalDimensionClaim('session-1')
  if (paneClaimsDimensions) return null
  return <InlineDimensionOwnerLifecycle />
}

function InlineDimensionOwnerLifecycle() {
  useEffect(() => {
    return () => {
      harness.handoffEvents.push('inline-owner-cleanup')
    }
  }, [])

  return null
}

vi.mock('@renderer/app-state/hooks', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector(harness.appState),
}))

vi.mock('@renderer/workspace/WorkspaceContext', () => ({
  useWorkspaceContext: () => harness.workspace,
}))

vi.mock('@renderer/features/debug/devDebugConfig', () => ({
  useDevDebugConfig: (selector: (state: Record<string, unknown>) => unknown) =>
    selector(harness.devDebugState),
}))

vi.mock('@renderer/workspace/hook/selectors/commandTargetSessionId', () => ({
  commandTargetSessionId: () => 'session-1',
}))

vi.mock('@renderer/features/debug/ui/DebugPanel', () => ({
  DebugPanel: (props: { inlineRawTerminalDisabled?: boolean }) => {
    harness.inlineRawTerminalDisabled = props.inlineRawTerminalDisabled
    return null
  },
}))

describe('DebugSurfacesImpl terminal ownership guard', () => {
  beforeEach(() => {
    harness.inlineRawTerminalDisabled = undefined
    harness.panePassiveParentClasses = []
    harness.handoffEvents = []
    harness.appState = {
      debugPanelOpen: true,
      feedDebugPanelOpen: false,
      proxyDebugPanelOpen: false,
      htmlDebugPanelOpen: false,
      renderingDebugMode: false,
      devDebugPanelOpen: false,
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
        sessions: {
          'session-1': {
            kind: 'claude',
            agentViewModeOverride: 'terminal',
          },
        },
      },
      getRuntime: () => emptyRuntime(),
      showPaneToast: vi.fn(),
    }
  })

  afterEach(() => {
    cleanup()
  })

  it('disables the inline debug xterm while that session has a mounted pane terminal', () => {
    render(
      <AgentTerminalOwnershipProvider>
        <MountedAgentTerminalOwner sessionId="session-1">
          <div />
        </MountedAgentTerminalOwner>
        <DebugSurfacesImpl />
      </AgentTerminalOwnershipProvider>,
    )

    // WHY assert the prop at this integration seam instead of predicting from
    // display settings: Settings and Reader can unmount the pane renderer while
    // leaving this side panel alive. The registry is the only fact that proves
    // another xterm can currently resize this PTY.
    expect(harness.inlineRawTerminalDisabled).toBe(true)
  })

  it('keeps a newly mounting pane layout-hidden until ownership has displaced the inline terminal', async () => {
    render(
      <AgentTerminalOwnershipProvider>
        <MountedAgentTerminalOwner sessionId="session-1">
          <PanePassiveResizeProbe />
        </MountedAgentTerminalOwner>
        <DebugSurfacesImpl />
      </AgentTerminalOwnershipProvider>,
    )

    // Recorded orchestration evidence showed that React may flush a newly
    // mounted pane's passive terminal effect before an already-open inline
    // terminal's passive cleanup. The pane therefore has to be zero-layout in
    // that first passive effect; relying on cleanup order recreates the resize
    // race even though the registry itself uses a layout effect.
    expect(harness.panePassiveParentClasses).toEqual(['hidden'])
    await waitFor(() => {
      expect(screen.getByTestId('pane-passive-probe').parentElement?.className).toBe('contents')
      expect(harness.inlineRawTerminalDisabled).toBe(true)
    })
  })

  it('releases a retained pane while its workspace is hidden and reclaims ownership before reveal', async () => {
    const tree = (visible: boolean) => (
      <AgentTerminalOwnershipProvider>
        <AgentTerminalOwnerVisibilityProvider visible={visible}>
          <MountedAgentTerminalOwner sessionId="session-1">
            <div data-testid="retained-pane-terminal" />
          </MountedAgentTerminalOwner>
        </AgentTerminalOwnerVisibilityProvider>
        <DebugSurfacesImpl />
      </AgentTerminalOwnershipProvider>
    )
    const view = render(tree(false))
    const retainedPane = screen.getByTestId('retained-pane-terminal')

    // Global Editor fullscreen uses display:none specifically to retain the
    // workspace/xterm state. Mounted is not sufficient dimension ownership:
    // the hidden pane cannot produce a positive viewport, so the debug terminal
    // must remain available while the DOM node itself stays mounted.
    expect(retainedPane.parentElement?.className).toBe('hidden')
    expect(harness.inlineRawTerminalDisabled).toBe(false)

    view.rerender(tree(true))
    await waitFor(() => {
      expect(screen.getByTestId('retained-pane-terminal')).toBe(retainedPane)
      expect(retainedPane.parentElement?.className).toBe('contents')
      expect(harness.inlineRawTerminalDisabled).toBe(true)
    })

    view.rerender(tree(false))
    await waitFor(() => {
      expect(screen.getByTestId('retained-pane-terminal')).toBe(retainedPane)
      expect(retainedPane.parentElement?.className).toBe('hidden')
      expect(harness.inlineRawTerminalDisabled).toBe(false)
    })
  })

  it('does not activate the pane dimension writer until the inline owner passive cleanup finishes', async () => {
    const tree = (visible: boolean) => (
      <AgentTerminalOwnershipProvider>
        <AgentTerminalOwnerVisibilityProvider visible={visible}>
          <MountedAgentTerminalOwner sessionId="session-1">
            <PaneDimensionWriterProbe />
          </MountedAgentTerminalOwner>
        </AgentTerminalOwnerVisibilityProvider>
        <InlineDimensionOwnerProbe />
      </AgentTerminalOwnershipProvider>
    )
    const view = render(tree(false))

    harness.handoffEvents = []
    view.rerender(tree(true))

    // The first gate recorded that sibling passive setup can run before
    // sibling cleanup. Ownership therefore uses a second render after the
    // registry/passive flush, rather than trusting component tree order. This
    // assertion pins the safety property itself: the old inline writer has
    // completed cleanup before the pane receives write capability.
    await waitFor(() => {
      expect(harness.handoffEvents).toEqual([
        'inline-owner-cleanup',
        'pane-writer-active',
      ])
    })
  })

  it('keeps the inline debug xterm available when policy says Terminal but no pane terminal is mounted', () => {
    render(
      <AgentTerminalOwnershipProvider>
        <DebugSurfacesImpl />
      </AgentTerminalOwnershipProvider>,
    )

    expect(harness.inlineRawTerminalDisabled).toBe(false)
  })
})

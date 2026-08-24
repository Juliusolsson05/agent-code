import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { emptyRuntime } from '@renderer/session-runtime/state'
import { DebugSurfacesImpl } from './DebugSurfacesImpl'

const harness = vi.hoisted(() => ({
  appState: {} as Record<string, unknown>,
  devDebugState: { enabled: false } as Record<string, unknown>,
  workspace: {} as Record<string, unknown>,
  inlineRawTerminalDisabled: undefined as boolean | undefined,
}))

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

  it('disables the inline debug xterm for a per-session Terminal override', () => {
    render(<DebugSurfacesImpl />)

    // WHY assert the prop at this integration seam instead of only testing the
    // shared selector: the regression was not incorrect policy math. It was a
    // call site that omitted durable session metadata while TileTree included
    // it. This assertion fails if DebugSurfacesImpl ever repeats that drift.
    expect(harness.inlineRawTerminalDisabled).toBe(true)
  })

  it('keeps the inline debug xterm available for an Agent override of a Terminal default', () => {
    harness.appState = {
      ...harness.appState,
      settings: { agentViewMode: 'terminal' },
    }
    harness.workspace = {
      ...harness.workspace,
      state: {
        sessions: {
          'session-1': {
            kind: 'codex',
            agentViewModeOverride: 'agent',
          },
        },
      },
    }

    render(<DebugSurfacesImpl />)

    expect(harness.inlineRawTerminalDisabled).toBe(false)
  })
})

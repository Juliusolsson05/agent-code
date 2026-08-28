import { fireEvent, render } from '@testing-library/react'
import type { ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { emptyRuntime } from '@renderer/session-runtime/state'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { useKeybinds } from './useKeybinds'

const harness = vi.hoisted(() => ({
  appState: {} as Record<string, unknown>,
}))

// useKeybinds reads the extension slice to fold contributed chords into the
// binding index. The harness builds `appState` by hand, so every slice the hook
// touches has to be present here or the mock stops resembling the real store —
// which is how this file started failing the moment extension keybindings landed.
// Empty is the honest value: these assertions are about first-party focus-mode
// ownership, and a contributed chord would be a different test.
const EXTENSION_SLICE = { installedExtensions: [], installedExtensionsLoaded: true }

vi.mock('@renderer/app-state/hooks', () => {
  const useAppStore = Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector(harness.appState),
    { getState: () => harness.appState },
  )
  return { useAppStore }
})

vi.mock('@renderer/features/global-editor/store', () => ({
  useGlobalEditorStore: Object.assign(
    () => undefined,
    { getState: () => ({ editorFullscreen: false }) },
  ),
}))

function KeyboardHarness({ workspace }: { workspace: Workspace }): ReactElement | null {
  useKeybinds(workspace)
  return <div data-testid="visible-focus-surface" tabIndex={-1} />
}

function makeWorkspace(
  focusMode: 'reader' | 'spotlight',
  layout: 'grid' | 'dispatch' | 'tiled-dispatch',
): {
  workspace: Workspace
  focusDispatchSession: ReturnType<typeof vi.fn>
  setTiledLaneSession: ReturnType<typeof vi.fn>
} {
  const runtime = emptyRuntime()
  const activeTab = {
    id: 'tab-1',
    title: 'Project',
    focusedSessionId: 'session-1',
    root: {
      type: 'split' as const,
      direction: 'horizontal' as const,
      ratio: 0.5,
      a: { type: 'leaf' as const, sessionId: 'session-1' },
      b: { type: 'leaf' as const, sessionId: 'session-2' },
    },
  }
  const dispatchMode = layout === 'grid'
    ? null
    : {
        scope: 'global' as const,
        focusedSessionId: 'session-1',
        ...(layout === 'tiled-dispatch'
          ? {
              tiled: {
                lanes: [
                  { selectedSessionId: 'session-1' },
                  { selectedSessionId: 'session-2' },
                ],
                focusedLane: 0,
              },
            }
          : {}),
      }
  const focusDispatchSession = vi.fn()
  const setTiledLaneSession = vi.fn()
  const state = {
    activeTabId: activeTab.id,
    tabs: [activeTab],
    sessions: {
      'session-1': { cwd: '/project', kind: 'claude' as const },
      'session-2': { cwd: '/project', kind: 'codex' as const },
    },
    detachedSessions: {},
    buried: [],
    pinnedSessionIds: [],
    gridRelatedSelections: {},
    dispatchMode,
  }

  const workspace = {
    state,
    activeTab,
    dispatchMode,
    tileTabs: null,
    readerMode: focusMode === 'reader'
      ? { tabId: activeTab.id, focusedSessionId: 'session-1' }
      : null,
    spotlight: focusMode === 'spotlight'
      ? { tabId: activeTab.id, focusedSessionId: 'session-1' }
      : null,
    runtimes: {
      'session-1': runtime,
      'session-2': runtime,
    },
    getRuntime: () => runtime,
    focusDispatchSession,
    setTiledLaneSession,
    navigate: vi.fn(),
    toggleReaderMode: vi.fn(),
    toggleSpotlight: vi.fn(),
  } as unknown as Workspace

  return { workspace, focusDispatchSession, setTiledLaneSession }
}

function pressOptionArrow(key: 'ArrowUp' | 'ArrowDown'): void {
  fireEvent.keyDown(document, { altKey: true, code: key, key })
}

describe('focus-mode keyboard ownership', () => {
  beforeEach(() => {
    harness.appState = {
      ...EXTENSION_SLICE,
      settingsPageOpen: false,
      requestCommandInvocation: vi.fn(),
      settings: {
        agentViewMode: 'agent',
        commandKeybindingOverrides: {},
      },
      globalEditorOpen: false,
      buryPromptSessionId: null,
      newAgentPlacementOpen: false,
      dispatchAttachIntent: null,
      linkedAgentParentId: null,
      reorderTabsOpen: false,
      pinAgentsOpen: false,
      closeSettingsPage: vi.fn(),
      closeBuryPrompt: vi.fn(),
      closeNewAgentPlacement: vi.fn(),
      closeDispatchAttach: vi.fn(),
      closeLinkedAgent: vi.fn(),
      closeReorderTabs: vi.fn(),
      closePinAgents: vi.fn(),
    }
  })

  it('does not move the hidden classic Dispatch selection while Reader navigates history', () => {
    const { workspace, focusDispatchSession } = makeWorkspace('reader', 'dispatch')
    render(<KeyboardHarness workspace={workspace} />)

    pressOptionArrow('ArrowDown')

    expect(focusDispatchSession).not.toHaveBeenCalled()
  })

  it('does not route Reader navigation into the hidden Grid command context', () => {
    const { workspace } = makeWorkspace('reader', 'grid')
    render(<KeyboardHarness workspace={workspace} />)

    pressOptionArrow('ArrowUp')

    expect(harness.appState.requestCommandInvocation).not.toHaveBeenCalled()
  })

  it('does not change a hidden Tiled Dispatch lane while Reader navigates history', () => {
    const { workspace, setTiledLaneSession } = makeWorkspace('reader', 'tiled-dispatch')
    render(<KeyboardHarness workspace={workspace} />)

    pressOptionArrow('ArrowDown')

    expect(setTiledLaneSession).not.toHaveBeenCalled()
  })

  it('does not move hidden Grid or Dispatch focus while Spotlight owns the screen', () => {
    const dispatch = makeWorkspace('spotlight', 'dispatch')
    const view = render(<KeyboardHarness workspace={dispatch.workspace} />)

    pressOptionArrow('ArrowDown')
    expect(dispatch.focusDispatchSession).not.toHaveBeenCalled()

    const grid = makeWorkspace('spotlight', 'grid')
    view.rerender(<KeyboardHarness workspace={grid.workspace} />)
    pressOptionArrow('ArrowUp')
    expect(harness.appState.requestCommandInvocation).not.toHaveBeenCalled()
  })

  it('keeps the Command Palette reachable from Reader, including through an override', () => {
    const reader = makeWorkspace('reader', 'dispatch')
    const view = render(<KeyboardHarness workspace={reader.workspace} />)

    fireEvent.keyDown(document, {
      metaKey: true,
      shiftKey: true,
      code: 'KeyP',
      key: 'P',
    })
    expect(harness.appState.requestCommandInvocation).toHaveBeenCalledWith(
      'open-command-palette',
      'keybinding',
    )

    view.unmount()
    const overriddenInvocation = vi.fn()
    harness.appState = {
      ...harness.appState,
      requestCommandInvocation: overriddenInvocation,
      settings: {
        agentViewMode: 'agent',
        commandKeybindingOverrides: {
          'open-command-palette': ['Cmd+Alt+P'],
        },
      },
    }
    render(<KeyboardHarness workspace={reader.workspace} />)

    fireEvent.keyDown(document, {
      metaKey: true,
      altKey: true,
      code: 'KeyP',
      key: 'π',
    })
    expect(overriddenInvocation).toHaveBeenCalledWith(
      'open-command-palette',
      'keybinding',
    )
  })

  it('keeps commands owned by the visible Spotlight session and feed available', () => {
    const spotlight = makeWorkspace('spotlight', 'dispatch')
    const view = render(<KeyboardHarness workspace={spotlight.workspace} />)

    fireEvent.keyDown(document, {
      altKey: true,
      code: 'KeyF',
      key: 'ƒ',
    })
    expect(harness.appState.requestCommandInvocation).toHaveBeenCalledWith(
      'toggle-tail',
      'keybinding',
    )

    fireEvent.keyDown(view.getByTestId('visible-focus-surface'), { code: 'End', key: 'End' })
    expect(harness.appState.requestCommandInvocation).toHaveBeenCalledWith(
      'jump-latest-message',
      'keybinding',
    )

    fireEvent.keyDown(document, {
      metaKey: true,
      shiftKey: true,
      code: 'KeyP',
      key: 'P',
    })
    expect(harness.appState.requestCommandInvocation).toHaveBeenCalledWith(
      'open-command-palette',
      'keybinding',
    )
    expect(spotlight.focusDispatchSession).not.toHaveBeenCalled()
  })

  it('still admits Escape and the configured toggle owned by each active focus mode', () => {
    const reader = makeWorkspace('reader', 'dispatch')
    const view = render(<KeyboardHarness workspace={reader.workspace} />)

    fireEvent.keyDown(document, { code: 'Escape', key: 'Escape' })
    expect(reader.workspace.toggleReaderMode).toHaveBeenCalledOnce()

    fireEvent.keyDown(document, { altKey: true, code: 'KeyR', key: '®' })
    expect(harness.appState.requestCommandInvocation).toHaveBeenCalledWith(
      'toggle-reader-mode',
      'keybinding',
    )

    const spotlight = makeWorkspace('spotlight', 'grid')
    view.rerender(<KeyboardHarness workspace={spotlight.workspace} />)

    fireEvent.keyDown(document, { code: 'Escape', key: 'Escape' })
    expect(spotlight.workspace.toggleSpotlight).toHaveBeenCalledOnce()

    fireEvent.keyDown(document, { altKey: true, code: 'KeyS', key: 'ß' })
    expect(harness.appState.requestCommandInvocation).toHaveBeenLastCalledWith(
      'toggle-spotlight',
      'keybinding',
    )
  })
})

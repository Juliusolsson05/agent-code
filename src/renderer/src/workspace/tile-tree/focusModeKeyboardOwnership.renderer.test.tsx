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

// The harness took a `layout` argument ('grid' | 'dispatch' | 'tiled-dispatch')
// until #992, and every ownership claim was asserted once per layout: a
// takeover must not move the hidden grid's focus, the hidden classic Dispatch
// selection, or a hidden tiled lane. There is one layout — the stage — so
// there is one hidden surface a takeover could leak keys into, and one set of
// cases.
function makeWorkspace(
  focusMode: 'reader' | 'spotlight',
): {
  workspace: Workspace
  selectTiledLaneSession: ReturnType<typeof vi.fn>
} {
  const runtime = emptyRuntime()
  // A project is `{ id, title }` (#992). This fixture carried a two-leaf tile
  // tree and a tree focus until the tree was deleted; the `as unknown as
  // Workspace` below is why it kept compiling with them. Nothing here ever
  // read them — the two sessions reach the keyboard through the LANES.
  const activeTab = { id: 'tab-1', title: 'Project' }
  const stage = {
    lanes: [
      { selectedSessionId: 'session-1' },
      { selectedSessionId: 'session-2' },
    ],
    rows: [{ length: 2 }],
    focusedLane: 0,
  }
  const selectTiledLaneSession = vi.fn()
  const state = {
    activeTabId: activeTab.id,
    tabs: [activeTab],
    sessions: {
      'session-1': { cwd: '/project', kind: 'claude' as const, projectId: 'tab-1', joinedAt: 0 },
      'session-2': { cwd: '/project', kind: 'codex' as const, projectId: 'tab-1', joinedAt: 1 },
    },
    pinnedSessionIds: [],
    stage,
  }

  const workspace = {
    state,
    activeTab,
    stage,
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
    selectTiledLaneSession,
    navigate: vi.fn(),
    toggleReaderMode: vi.fn(),
    toggleSpotlight: vi.fn(),
  } as unknown as Workspace

  return { workspace, selectTiledLaneSession }
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

  it('routes Alt+Backspace to Clear Lane when no text field owns the target', () => {
    // Clear Lane ships on ⌥⌫ (#992 §4.4). Outside text editing the chord is
    // the stage's to claim, and it must arrive as a COMMAND invocation —
    // rebindable, visible in the shortcuts surface — not as an inline branch.
    const { workspace } = makeWorkspace('reader' as const)
    // Reader/Spotlight would swallow the chord into their own admission
    // (above); Clear Lane is a workspace verb, so exercise the plain stage.
    const plain = { ...workspace, readerMode: null, spotlight: null } as typeof workspace
    const view = render(<KeyboardHarness workspace={plain} />)

    fireEvent.keyDown(document, { altKey: true, code: 'Backspace', key: 'Backspace' })

    expect(harness.appState.requestCommandInvocation).toHaveBeenCalledWith(
      'clear-focused-lane',
      'keybinding',
    )
    view.unmount()
  })

  it('yields Alt+Backspace to the text field instead of Clear Lane', () => {
    // The other half of the pairing (reservations.ts APPROVED_OVERLAPS):
    // ⌥⌫ is the OS's delete-word in every text field. A Clear Lane firing
    // from inside a composer would empty the pane mid-sentence — the exact
    // "command appears bound, breaks editing" failure the reservation table
    // exists to prevent, enforced at runtime by isMacosTextEditingChord.
    const { workspace } = makeWorkspace('reader' as const)
    const plain = { ...workspace, readerMode: null, spotlight: null } as typeof workspace
    const view = render(<KeyboardHarness workspace={plain} />)

    const composer = document.createElement('textarea')
    document.body.appendChild(composer)
    composer.focus()
    fireEvent.keyDown(composer, { altKey: true, code: 'Backspace', key: 'Backspace' })

    expect(harness.appState.requestCommandInvocation).not.toHaveBeenCalled()
    composer.remove()
    view.unmount()
  })

  it('does not change a hidden lane while Reader navigates history', () => {
    const { workspace, selectTiledLaneSession } = makeWorkspace('reader')
    render(<KeyboardHarness workspace={workspace} />)

    pressOptionArrow('ArrowDown')

    expect(selectTiledLaneSession).not.toHaveBeenCalled()
  })

  it('does not route Reader navigation into a hidden workspace command', () => {
    // ⌥↑ is Focus Row Above on the stage. Reader owns the screen, so the chord
    // must not reach the command router at all.
    const { workspace } = makeWorkspace('reader')
    render(<KeyboardHarness workspace={workspace} />)

    pressOptionArrow('ArrowUp')

    expect(harness.appState.requestCommandInvocation).not.toHaveBeenCalled()
  })

  it('does not move hidden lane selection or focus while Spotlight owns the screen', () => {
    const { workspace, selectTiledLaneSession } = makeWorkspace('spotlight')
    render(<KeyboardHarness workspace={workspace} />)

    pressOptionArrow('ArrowDown')
    expect(selectTiledLaneSession).not.toHaveBeenCalled()

    pressOptionArrow('ArrowUp')
    expect(harness.appState.requestCommandInvocation).not.toHaveBeenCalled()
  })

  it('keeps the Command Palette reachable from Reader, including through an override', () => {
    const reader = makeWorkspace('reader')
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
    const spotlight = makeWorkspace('spotlight')
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
    expect(spotlight.selectTiledLaneSession).not.toHaveBeenCalled()
  })

  it('still admits Escape and the configured toggle owned by each active focus mode', () => {
    const reader = makeWorkspace('reader')
    const view = render(<KeyboardHarness workspace={reader.workspace} />)

    fireEvent.keyDown(document, { code: 'Escape', key: 'Escape' })
    expect(reader.workspace.toggleReaderMode).toHaveBeenCalledOnce()

    fireEvent.keyDown(document, { altKey: true, code: 'KeyR', key: '®' })
    expect(harness.appState.requestCommandInvocation).toHaveBeenCalledWith(
      'toggle-reader-mode',
      'keybinding',
    )

    const spotlight = makeWorkspace('spotlight')
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

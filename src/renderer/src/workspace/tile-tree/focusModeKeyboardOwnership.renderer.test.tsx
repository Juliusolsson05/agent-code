import { fireEvent, render } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { emptyRuntime } from '@renderer/session-runtime/state'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { useKeybinds } from './useKeybinds'
import { coerceSettings } from '@renderer/app-state/settings/persistence'
import { useAppStore as useRealAppStore } from '@renderer/app-state/store'

const harness = vi.hoisted(() => ({
  appState: {} as Record<string, unknown>,
  editorFullscreen: false,
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
    { getState: () => ({ editorFullscreen: harness.editorFullscreen }) },
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

  it('while the Sidekick panel owns the keyboard, lane and layout chords do nothing (#1493 review round 1, F1)', () => {
    // ⌘⇧W used to close the focused LANE's project while the user typed in
    // the Sidekick panel, ⌥↓ moved a Dispatch row, Escape left Spotlight.
    // Lane and project grammar never crosses, and a refused chord is NOT
    // prevented: the sidekick's composer still gets it.
    //
    // ⌘W DOES cross since lane parity (#1493 follow-up): it is the agent's
    // own Close, routed as close-pane, which acts on the command target — the
    // sidekick — and asks to remove it (paneCommands). It no longer means the
    // lane agent behind the panel.
    harness.appState = { ...harness.appState, keyboardRegion: 'sidekick' }
    const { workspace } = makeWorkspace('spotlight' as const)
    const view = render(<KeyboardHarness workspace={workspace} />)

    const closeTab = new KeyboardEvent('keydown', { metaKey: true, shiftKey: true, code: 'KeyW', key: 'W', bubbles: true, cancelable: true })
    document.body.dispatchEvent(closeTab)
    pressOptionArrow('ArrowDown')
    const escape = new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true, cancelable: true })
    document.body.dispatchEvent(escape)
    fireEvent.keyDown(document, { metaKey: true, code: 'KeyJ', key: 'j' })
    fireEvent.keyDown(document, { metaKey: true, shiftKey: true, code: 'KeyP', key: 'P' })
    const closePane = new KeyboardEvent('keydown', { metaKey: true, code: 'KeyW', key: 'w', bubbles: true, cancelable: true })
    document.body.dispatchEvent(closePane)

    const invoked = (harness.appState.requestCommandInvocation as ReturnType<typeof vi.fn>).mock.calls.map(call => call[0])
    expect(invoked).toEqual(['sidekick-panel', 'open-command-palette', 'close-pane'])
    expect(closeTab.defaultPrevented).toBe(false)
    expect(escape.defaultPrevented).toBe(false)
    expect(workspace.toggleSpotlight).not.toHaveBeenCalled()
    view.unmount()
  })

  it('the Sidekick answers to a lane agent\'s chords: Reload, End (feed), and its own copy picker even under a lane Spotlight (lane parity)', () => {
    // The command target is read from the REAL store (the selector imports
    // it directly), the router's own state from the harness: set both.
    const realBefore = useRealAppStore.getState()
    useRealAppStore.setState({ keyboardRegion: 'sidekick', sidekickSpotlight: false, settingsPageOpen: false })
    harness.appState = { ...harness.appState, keyboardRegion: 'sidekick' }
    const { workspace } = makeWorkspace('spotlight' as const)
    const picker = { uuid: 'u', index: 0 }
    const sidekickRuntime = { ...emptyRuntime(), assistantPicker: picker }
    const pickerMove = vi.fn()
    const withSidekick = {
      ...workspace,
      state: {
        ...workspace.state,
        sessions: { ...workspace.state.sessions, sk: { cwd: '/home', kind: 'claude' as const, sidekickId: 'side' } },
        sidekickPanel: { open: true, width: 420, sidekickId: 'side' },
      },
      runtimes: { ...workspace.runtimes, sk: sidekickRuntime },
      pickerMove,
    } as unknown as Workspace
    const view = render(<KeyboardHarness workspace={withSidekick} />)

    fireEvent.keyDown(document, { altKey: true, shiftKey: true, code: 'KeyA', key: 'Å' })
    fireEvent.keyDown(document, { code: 'End', key: 'End' })
    // A creation chord spawns into a LANE: it stays a lane chord.
    fireEvent.keyDown(document, { altKey: true, code: 'KeyD', key: '∂' })
    fireEvent.keyDown(document, { code: 'ArrowUp', key: 'ArrowUp' })

    const invoked = (harness.appState.requestCommandInvocation as ReturnType<typeof vi.fn>).mock.calls.map(call => call[0])
    expect(invoked).toEqual(['reload-agent', 'jump-latest-message'])
    // The lane Spotlight is open, yet the sidekick's own picker moves: the
    // Sidekick column is on screen beside it.
    expect(pickerMove).toHaveBeenCalledWith('sk', -1)
    view.unmount()
    useRealAppStore.setState(realBefore, true)
  })

  it('a user-assigned chord for any agent command works in the Sidekick, and a fullscreen editor does not swallow ⌘W there (#1517 review)', () => {
    // The first cut admitted only an id allowlist, so Copy Assistant Message
    // bound by the user to ⌘⇧C did nothing in the Sidekick; and the
    // fullscreen-editor guard ate ⌘W before the Sidekick gate although the
    // Sidekick sits beside the editor, not under it.
    harness.editorFullscreen = true
    harness.appState = {
      ...harness.appState,
      keyboardRegion: 'sidekick',
      globalEditorOpen: true,
      settings: { agentViewMode: 'agent', commandKeybindingOverrides: { 'copy-assistant-message': ['Cmd+Shift+C'] } },
    }
    const { workspace } = makeWorkspace('spotlight' as const)
    const view = render(<KeyboardHarness workspace={workspace} />)

    fireEvent.keyDown(document, { metaKey: true, shiftKey: true, code: 'KeyC', key: 'C' })
    const closePane = new KeyboardEvent('keydown', { metaKey: true, code: 'KeyW', key: 'w', bubbles: true, cancelable: true })
    document.body.dispatchEvent(closePane)

    const invoked = (harness.appState.requestCommandInvocation as ReturnType<typeof vi.fn>).mock.calls.map(call => call[0])
    expect(invoked).toEqual(['copy-assistant-message', 'close-pane'])
    harness.editorFullscreen = false
    view.unmount()
  })

  it('Spotlight reaches the Sidekick: ⌥S is routed from its region and Esc leaves Sidekick Spotlight', () => {
    // The region gate above passes only listed commands, so before this the
    // Spotlight chord died there and Sidekick Spotlight had no keyboard exit.
    const setSidekickSpotlight = vi.fn()
    harness.appState = { ...harness.appState, keyboardRegion: 'sidekick', sidekickSpotlight: true, setSidekickSpotlight }
    const { workspace } = makeWorkspace('spotlight' as const)
    const view = render(<KeyboardHarness workspace={workspace} />)

    fireEvent.keyDown(document, { altKey: true, code: 'KeyS', key: 'ß' })
    const escape = new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true, cancelable: true })
    document.body.dispatchEvent(escape)

    const invoked = (harness.appState.requestCommandInvocation as ReturnType<typeof vi.fn>).mock.calls.map(call => call[0])
    expect(invoked).toEqual(['toggle-spotlight'])
    expect(setSidekickSpotlight).toHaveBeenCalledWith(false)
    expect(escape.defaultPrevented).toBe(true)
    // The lane Spotlight is never what Esc closes from the Sidekick.
    expect(workspace.toggleSpotlight).not.toHaveBeenCalled()
    view.unmount()
  })

  it('a spotlit Sidekick keeps the keyboard even when the region says workspace (#1513 review)', () => {
    // Clicking app chrome or leaving Settings could leave the region at
    // 'workspace' while the Sidekick still filled the window; ⌘W then closed
    // a hidden lane agent and Esc had no way out. A retained fullscreen
    // editor must not block that Esc either.
    const setSidekickSpotlight = vi.fn()
    harness.editorFullscreen = true
    harness.appState = { ...harness.appState, globalEditorOpen: true, keyboardRegion: 'workspace', sidekickSpotlight: true, setSidekickSpotlight }
    const { workspace } = makeWorkspace('spotlight' as const)
    const view = render(<KeyboardHarness workspace={workspace} />)

    const closePane = new KeyboardEvent('keydown', { metaKey: true, code: 'KeyW', key: 'w', bubbles: true, cancelable: true })
    document.body.dispatchEvent(closePane)
    const escape = new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true, cancelable: true })
    document.body.dispatchEvent(escape)

    // ⌘W reaches the SIDEKICK's Close since lane parity (#1517): close-pane
    // acts on the command target, which is the spotlit sidekick
    // (sidekickLaneParity tests pin that), and asks to remove it. What must
    // never happen — a hidden lane agent closing — is covered there.
    const invoked = (harness.appState.requestCommandInvocation as ReturnType<typeof vi.fn>).mock.calls.map(call => call[0])
    expect(invoked).toEqual(['close-pane'])
    expect(setSidekickSpotlight).toHaveBeenCalledWith(false)
    expect(workspace.toggleSpotlight).not.toHaveBeenCalled()
    harness.editorFullscreen = false
    view.unmount()
  })

  it('routes the bare lane arrows to the registered commands on the plain stage', () => {
    // #992 stage 5: the ⌥ grammar became commands. This is the end-to-end
    // proof the router (not a resurrected inline branch) delivers them.
    const { workspace } = makeWorkspace('reader' as const)
    const plain = { ...workspace, readerMode: null, spotlight: null } as typeof workspace
    const view = render(<KeyboardHarness workspace={plain} />)

    fireEvent.keyDown(document, { altKey: true, code: 'ArrowDown', key: 'ArrowDown' })
    fireEvent.keyDown(document, { altKey: true, code: 'ArrowLeft', key: 'ArrowLeft' })
    fireEvent.keyDown(document, { altKey: true, code: 'KeyK', key: '˚' })

    const invoked = (harness.appState.requestCommandInvocation as ReturnType<typeof vi.fn>).mock.calls
      .map(call => call[0])
    expect(invoked).toContain('dispatch-select-next-agent')
    expect(invoked).toContain('dispatch-focus-lane-left')
    expect(invoked).toContain('dispatch-select-previous-agent')
    view.unmount()
  })

  it('a saved override for a retired grid command no longer swallows the lane chords', () => {
    // #1013 review B, MAJOR. A user who once rebound grid navigation has
    // `nav-left: ['Alt+H', 'Alt+Left']` in their saved settings. The binding
    // index puts customized entries first and gives an unknown id the global
    // context, so that stale override won ⌥H/⌥← over Focus Lane Left, and the
    // gateway then answered `unknown`: the chord did nothing at all. The saved
    // blob goes through the real settings decoder, as on every launch.
    const saved = { commandKeybindingOverrides: { 'nav-left': ['Alt+H', 'Alt+Left'], 'dispatch-mode': ['Cmd+Shift+M'] } }
    harness.appState = {
      ...harness.appState,
      settings: { agentViewMode: 'agent', commandKeybindingOverrides: coerceSettings(saved).commandKeybindingOverrides },
    }
    const { workspace } = makeWorkspace('reader' as const)
    const plain = { ...workspace, readerMode: null, spotlight: null } as typeof workspace
    const view = render(<KeyboardHarness workspace={plain} />)

    fireEvent.keyDown(document, { altKey: true, code: 'ArrowLeft', key: 'ArrowLeft' })
    fireEvent.keyDown(document, { altKey: true, code: 'KeyH', key: '˙' })

    const invoked = (harness.appState.requestCommandInvocation as ReturnType<typeof vi.fn>).mock.calls
      .map(call => call[0])
    expect(invoked).toEqual(['dispatch-focus-lane-left', 'dispatch-focus-lane-left'])
    view.unmount()
  })

  it('never clears the hidden lane on ⌥⌫ while the fullscreen Global Editor owns the window', () => {
    // #1013 review B. Fullscreen hides the stage, but the capture router stays
    // mounted. ⌥⌫ was missing from the owned-chord list the fullscreen guard
    // uses, so with focus in app chrome it fell through and emptied the
    // focused lane the user could not see.
    harness.editorFullscreen = true
    harness.appState = { ...harness.appState, globalEditorOpen: true }
    const { workspace } = makeWorkspace('reader' as const)
    const plain = { ...workspace, readerMode: null, spotlight: null } as typeof workspace
    const view = render(<KeyboardHarness workspace={plain} />)
    const event = new KeyboardEvent('keydown', { altKey: true, code: 'Backspace', key: 'Backspace', bubbles: true, cancelable: true })
    document.body.dispatchEvent(event)
    expect(harness.appState.requestCommandInvocation).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)
    view.unmount()
    harness.editorFullscreen = false
  })

  it('does not ask main to capture OS text-editing chords inside extension frames', async () => {
    // #1013 review B. A forwarded chord is captured natively and re-dispatched
    // with the <iframe> as its target, so the text-field yield cannot apply.
    // ⌥⌫ in an extension's input cleared the lane instead of deleting a word.
    const setInputBindings = vi.fn(async () => undefined)
    const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
    Object.defineProperty(window, 'api', { configurable: true, value: { extensionsSetInputBindings: setInputBindings } })
    harness.appState = { ...harness.appState, installedExtensions: [{ manifest: { id: 'timer' }, present: true }] }
    const { workspace } = makeWorkspace('reader' as const)
    const plain = { ...workspace, readerMode: null, spotlight: null } as typeof workspace
    const view = render(<KeyboardHarness workspace={plain} />)
    const [config] = setInputBindings.mock.calls[0] as unknown as [{ pane: string[] }]
    // The lane arrows are still forwarded (they are not text chords).
    expect(config.pane).toContain('Alt+Left')
    expect(config.pane).not.toContain('Alt+Backspace')
    view.unmount()
    if (originalApi) Object.defineProperty(window, 'api', originalApi)
    else Reflect.deleteProperty(window, 'api')
  })

  // #1307: Radix focuses the modal's DialogContent while the extension iframe
  // is still loading, or before its document takes focus. The palette chord
  // then targets the HOST shell, not the iframe, and main forwards nothing
  // (the focused frame is the host). The ownership gate dropped the chord, so
  // no palette opened until the user clicked into the extension. The DOM here
  // is AppHostSurface's: an owner-marked DialogContent holding the modal
  // iframe (viewBridge's `data-extension-shell="modal"`).
  // Removed after every test, pass or fail: a leftover owner marker gates every
  // later test in this file behind the app-ownership branch.
  const mountedDialogs: HTMLElement[] = []
  afterEach(() => { mountedDialogs.splice(0).forEach(element => element.remove()) })

  function mountOwnedDialog(withExtensionFrame: boolean): { content: HTMLElement; frame: HTMLIFrameElement | null; remove: () => void } {
    const content = document.createElement('div')
    content.setAttribute('data-agent-code-interaction-owner', 'app')
    content.tabIndex = -1
    let frame: HTMLIFrameElement | null = null
    if (withExtensionFrame) {
      frame = document.createElement('iframe')
      frame.dataset.extensionShell = 'modal'
      const wrapper = document.createElement('div')
      wrapper.appendChild(frame)
      content.appendChild(wrapper)
    }
    document.body.appendChild(content)
    mountedDialogs.push(content)
    return { content, frame, remove: () => content.remove() }
  }

  it('opens the palette from an extension modal whose iframe has not taken focus', () => {
    const { workspace } = makeWorkspace('reader' as const)
    const plain = { ...workspace, readerMode: null, spotlight: null } as typeof workspace
    const view = render(<KeyboardHarness workspace={plain} />)
    const dialog = mountOwnedDialog(true)

    fireEvent.keyDown(dialog.content, { metaKey: true, shiftKey: true, code: 'KeyP', key: 'P' })

    expect(harness.appState.requestCommandInvocation).toHaveBeenCalledWith('open-command-palette', 'keybinding')
    dialog.remove()
    view.unmount()
  })

  it('closes the extension modal, not the pane beneath it, on ⌘W from the host shell', () => {
    const { workspace } = makeWorkspace('reader' as const)
    const plain = { ...workspace, readerMode: null, spotlight: null } as typeof workspace
    const view = render(<KeyboardHarness workspace={plain} />)
    const dialog = mountOwnedDialog(true)
    const closed = vi.fn()
    dialog.frame!.addEventListener('agent-code-extension-close', closed)

    const event = new KeyboardEvent('keydown', { metaKey: true, code: 'KeyW', key: 'w', bubbles: true, cancelable: true })
    dialog.content.dispatchEvent(event)

    expect(closed).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
    expect(harness.appState.requestCommandInvocation).not.toHaveBeenCalled()
    dialog.remove()
    view.unmount()
  })

  it('still drops the palette chord in an ordinary app dialog', () => {
    // The exemption is for the extension's shell only. Any other owned dialog
    // keeps the gate: the palette must not open over it.
    const { workspace } = makeWorkspace('reader' as const)
    const plain = { ...workspace, readerMode: null, spotlight: null } as typeof workspace
    const view = render(<KeyboardHarness workspace={plain} />)
    const dialog = mountOwnedDialog(false)

    fireEvent.keyDown(dialog.content, { metaKey: true, shiftKey: true, code: 'KeyP', key: 'P' })

    expect(harness.appState.requestCommandInvocation).not.toHaveBeenCalled()
    dialog.remove()
    view.unmount()
  })

  it('leaves both chords to a dialog stacked above the extension modal', () => {
    // #1394 review a: the lookup is scoped to the TARGET's own owner element.
    // A confirmation or the palette portals a separate owner next to the
    // extension modal. A document-wide lookup would open the palette over it,
    // or close the covered extension, from a key aimed at the upper dialog.
    const { workspace } = makeWorkspace('reader' as const)
    const plain = { ...workspace, readerMode: null, spotlight: null } as typeof workspace
    const view = render(<KeyboardHarness workspace={plain} />)
    const extension = mountOwnedDialog(true)
    const upper = mountOwnedDialog(false)
    const closed = vi.fn()
    extension.frame!.addEventListener('agent-code-extension-close', closed)

    fireEvent.keyDown(upper.content, { metaKey: true, shiftKey: true, code: 'KeyP', key: 'P' })
    upper.content.dispatchEvent(new KeyboardEvent('keydown', { metaKey: true, code: 'KeyW', key: 'w', bubbles: true, cancelable: true }))

    expect(harness.appState.requestCommandInvocation).not.toHaveBeenCalled()
    expect(closed).not.toHaveBeenCalled()
    view.unmount()
  })

  // #1394 review b: closing the palette (a controlled Radix Dialog with no
  // trigger) over the extension modal leaves focus on <body>. The chords must
  // still reach the modal that owns the screen.
  it('routes both chords to the extension modal when focus fell to the body', () => {
    const { workspace } = makeWorkspace('reader' as const)
    const plain = { ...workspace, readerMode: null, spotlight: null } as typeof workspace
    const view = render(<KeyboardHarness workspace={plain} />)
    const extension = mountOwnedDialog(true)
    const palette = mountOwnedDialog(false)
    palette.remove()
    const closed = vi.fn()
    extension.frame!.addEventListener('agent-code-extension-close', closed)

    fireEvent.keyDown(document.body, { metaKey: true, shiftKey: true, code: 'KeyP', key: 'P' })
    document.body.dispatchEvent(new KeyboardEvent('keydown', { metaKey: true, code: 'KeyW', key: 'w', bubbles: true, cancelable: true }))

    expect(harness.appState.requestCommandInvocation).toHaveBeenCalledWith('open-command-palette', 'keybinding')
    expect(closed).toHaveBeenCalledTimes(1)
    view.unmount()
  })

  it('keeps a body-targeted chord from reaching an extension covered by a stacked dialog', () => {
    const { workspace } = makeWorkspace('reader' as const)
    const plain = { ...workspace, readerMode: null, spotlight: null } as typeof workspace
    const view = render(<KeyboardHarness workspace={plain} />)
    const extension = mountOwnedDialog(true)
    mountOwnedDialog(false)
    const closed = vi.fn()
    extension.frame!.addEventListener('agent-code-extension-close', closed)

    fireEvent.keyDown(document.body, { metaKey: true, shiftKey: true, code: 'KeyP', key: 'P' })
    document.body.dispatchEvent(new KeyboardEvent('keydown', { metaKey: true, code: 'KeyW', key: 'w', bubbles: true, cancelable: true }))

    expect(harness.appState.requestCommandInvocation).not.toHaveBeenCalled()
    expect(closed).not.toHaveBeenCalled()
    view.unmount()
  })

  // #1394 review c (F1): a key aimed INSIDE a lower owner is judged by that
  // owner, not by whichever owner is topmost. Radix's focus trap makes this
  // state hard to reach, so the `closest()` scope is defense in depth; without
  // this case, "always use the topmost owner" survived every test.
  it('judges a key aimed at the extension shell by that shell, even with another owner mounted', () => {
    const { workspace } = makeWorkspace('reader' as const)
    const plain = { ...workspace, readerMode: null, spotlight: null } as typeof workspace
    const view = render(<KeyboardHarness workspace={plain} />)
    const extension = mountOwnedDialog(true)
    mountOwnedDialog(false)

    fireEvent.keyDown(extension.content, { metaKey: true, shiftKey: true, code: 'KeyP', key: 'P' })

    expect(harness.appState.requestCommandInvocation).toHaveBeenCalledWith('open-command-palette', 'keybinding')
    view.unmount()
  })

  it('⌘ digits fill the focused lane by row label, and a second held digit reaches rows 10–99', () => {
    // The two-digit grammar had no behavioural test (#1013 review B, finding
    // 14). ⌘1 places row 1 and remembers the 1; ⌘2 inside the window makes
    // it row 12, in digit order; ⌘0 only continues a pending digit.
    const ids = Array.from({ length: 12 }, (_, i) => `s${i + 1}`)
    const selectTiledLaneSession = vi.fn()
    const stage = { lanes: [{ selectedSessionId: 's1' }], rows: [{ length: 1 }], focusedLane: 0 }
    const state = {
      activeTabId: 'p', tabs: [{ id: 'p', title: 'Project' }], pinnedSessionIds: [], stage,
      sessions: Object.fromEntries(ids.map((id, i) => [id, { cwd: '/p', kind: 'claude' as const, projectId: 'p', joinedAt: i }])),
    }
    const workspace = {
      state, stage, readerMode: null, spotlight: null, runtimes: {},
      getRuntime: () => emptyRuntime(), selectTiledLaneSession, navigate: vi.fn(),
      toggleReaderMode: vi.fn(), toggleSpotlight: vi.fn(),
    } as unknown as Workspace
    const view = render(<KeyboardHarness workspace={workspace} />)
    const press = (digit: number) => fireEvent.keyDown(document, { metaKey: true, code: `Digit${digit}`, key: String(digit) })

    press(1)
    press(2)
    expect(selectTiledLaneSession.mock.calls).toEqual([[0, 's1'], [0, 's12']])

    selectTiledLaneSession.mockClear()
    press(1)
    press(0)
    expect(selectTiledLaneSession.mock.calls).toEqual([[0, 's1'], [0, 's10']])

    // With no pending digit, ⌘0 addresses nothing.
    selectTiledLaneSession.mockClear()
    press(0)
    expect(selectTiledLaneSession).not.toHaveBeenCalled()
    view.unmount()
  })

  it('yields Alt+Shift+Arrow to the OS instead of treating it as a lane arrow', () => {
    // The inline branch this grammar replaced tested `alt && !cmd` without a
    // shift check, so ⌥⇧↓ ran the index walk while the user was trying to
    // select by word (#992 stage 5 record, useKeybinds). The binding grammar
    // is exact-match, so the shifted chord matches nothing and stays native.
    const { workspace } = makeWorkspace('reader' as const)
    const plain = { ...workspace, readerMode: null, spotlight: null } as typeof workspace
    const view = render(<KeyboardHarness workspace={plain} />)

    fireEvent.keyDown(document, { altKey: true, shiftKey: true, code: 'ArrowDown', key: 'ArrowDown' })
    fireEvent.keyDown(document, { altKey: true, shiftKey: true, code: 'ArrowLeft', key: 'ArrowLeft' })

    expect(harness.appState.requestCommandInvocation).not.toHaveBeenCalled()
    view.unmount()
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

  // #1286 review A: the palette can open New Agent… under Reader, where the
  // overlay is retained but renders nothing. The placement gate keyed on the
  // store flag alone ate the Escape that leaves Reader (closing an overlay
  // the user never saw) and dropped the palette chord.
  it('lets Escape leave Reader and the palette open while New Agent… is open but not on screen', () => {
    harness.appState = { ...harness.appState, newAgentPlacementOpen: true }
    const { workspace } = makeWorkspace('reader')
    const view = render(<KeyboardHarness workspace={workspace} />)
    fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' })
    expect(workspace.toggleReaderMode).toHaveBeenCalled()
    expect(harness.appState.closeNewAgentPlacement).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: 'p', code: 'KeyP', metaKey: true, shiftKey: true })
    expect(harness.appState.requestCommandInvocation).toHaveBeenCalledWith('open-command-palette', 'keybinding')
    view.unmount()
  })

  it('still gives Escape to New Agent… when the overlay is on screen', () => {
    harness.appState = { ...harness.appState, newAgentPlacementOpen: true }
    const { workspace } = makeWorkspace('reader')
    const overlay = document.createElement('div')
    overlay.setAttribute('data-new-agent-overlay', '')
    document.body.appendChild(overlay)
    const view = render(<KeyboardHarness workspace={workspace} />)
    fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' })
    expect(harness.appState.closeNewAgentPlacement).toHaveBeenCalled()
    expect(workspace.toggleReaderMode).not.toHaveBeenCalled()
    view.unmount()
    overlay.remove()
  })
})

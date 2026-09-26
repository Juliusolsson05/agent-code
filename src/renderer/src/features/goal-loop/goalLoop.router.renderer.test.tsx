import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GoalLoopState } from '@shared/types/goalLoop'
import { emptyRuntime } from '@renderer/session-runtime/state'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { useKeybinds } from '@renderer/workspace/tile-tree/useKeybinds'
import { RetainedWorkspaceSurface } from '@renderer/app/shell/RetainedWorkspaceSurface'
import { GoalLoopPane } from './GoalLoopPane'
import { goalLoopCommands } from './commands'
import { dismissGoalLoop, toggleGoalLoop, useGoalLoopView } from './viewState'

// The latched overlay claims app interaction ownership, so the router's
// ownership branch admits nothing (goal-loop-preview is not in
// SURFACE_OWNER_FLAGS — its latch lives in a feature store, not uiShell).
// Without the dedicated gate in useKeybinds, the overlay is a mouse-only trap
// that kills every app shortcut while latched. These tests drive the REAL
// keyboard router, mirroring tldr.renderer.test.tsx's harness.

const harness = vi.hoisted(() => ({ appState: {} as Record<string, unknown> }))
vi.mock('@renderer/app-state/hooks', () => ({
  useAppStore: Object.assign((selector: (state: Record<string, unknown>) => unknown) => selector(harness.appState), { getState: () => harness.appState }),
}))
vi.mock('@renderer/features/global-editor/store', () => ({
  useGlobalEditorStore: Object.assign(() => undefined, { getState: () => ({ editorFullscreen: false }) }),
}))

const loop = (): GoalLoopState => ({
  sessionId: 'a', goal: 'Migrate tests.', loopPrompt: 'Keep migrating.', phase: 'active',
  pauseReason: null, endReason: null, completionSummary: null, maxContinuations: 25,
  continuationsDelivered: 3, consecutiveDeliveryFailures: 0,
  startedAt: '2026-09-18T00:00:00.000Z', updatedAt: '2026-09-18T00:00:00.000Z',
})
const api = {
  readGoalLoops: vi.fn(async (ids: string[]) => Object.fromEntries(ids.map(id => [id, loop()]))),
  controlGoalLoop: vi.fn(async () => loop()),
  onGoalLoopChanged: vi.fn((_listener: () => void) => () => {}),
}

function workspace(): Workspace {
  const runtime = emptyRuntime()
  const tab = { id: 'tab', title: 'Project', focusedSessionId: 'a', root: { type: 'leaf', sessionId: 'a' } }
  return {
    state: { activeTabId: 'tab', tabs: [tab], sessions: { a: { kind: 'claude', cwd: '/project' } }, detachedSessions: {}, buried: [], pinnedSessionIds: [] },
    activeTab: tab, dispatchMode: null, tileTabs: null, spotlight: null, readerMode: null,
    runtimes: { a: runtime }, getRuntime: () => runtime,
  } as unknown as Workspace
}
function Harness({ model }: { model: Workspace }) {
  useKeybinds(model)
  return (
    <>
      {/* A composer-like focus target, as in the tldr router harness. */}
      <input aria-label="Composer" />
      {/* Editor chrome, with the marker the router reads to decide that Monaco
          owns the target. The real global editor stamps it the same way. */}
      <div data-global-editor-input-owner data-global-editor-monaco>
        <textarea aria-label="Editor" />
      </div>
      {/* A transcript code block: a real Monaco instance with NO global-editor
          marker, which is what lib/code/CodeBlock.tsx mounts in the feed. */}
      <div className="monaco-editor">
        <textarea aria-label="Code block" />
      </div>
    </>
  )
}
function keyDown(options: Record<string, unknown>) {
  return fireEvent.keyDown(document.activeElement ?? document.body, options)
}

beforeEach(() => {
  vi.clearAllMocks()
  dismissGoalLoop()
  Object.assign(window, { api })
  harness.appState = {
    requestCommandInvocation: vi.fn(), settings: { agentViewMode: 'agent', commandKeybindingOverrides: {} },
    settingsPageOpen: false, globalEditorOpen: false, newAgentPlacementOpen: false,
    dispatchAttachIntent: null, linkedAgentParentId: null, reorderTabsOpen: false, pinAgentsOpen: false,
    closeSettingsPage: vi.fn(), closeBuryPrompt: vi.fn(), closeNewAgentPlacement: vi.fn(),
    closeDispatchAttach: vi.fn(), closeLinkedAgent: vi.fn(), closeReorderTabs: vi.fn(), closePinAgents: vi.fn(),
    installedExtensions: [],
  }
})
afterEach(() => { cleanup(); dismissGoalLoop() })

describe('goal loop overlay keyboard dismissal', () => {
  it('Escape dismisses the latched overlay through the router gate', async () => {
    toggleGoalLoop()
    render(<><Harness model={workspace()} /><GoalLoopPane sessionId="a" /></>)
    expect(await screen.findByRole('dialog')).toBeTruthy()
    keyDown({ key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('the Cmd+Shift+G toggle chord dismisses the latched overlay', async () => {
    toggleGoalLoop()
    render(<><Harness model={workspace()} /><GoalLoopPane sessionId="a" /></>)
    expect(await screen.findByRole('dialog')).toBeTruthy()
    keyDown({ key: 'g', code: 'KeyG', metaKey: true, shiftKey: true })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

// K2-1: the overlay's controls were unreachable from the keyboard. The gate
// above consumed every key in capture phase, Tab and Enter included, so a
// keyboard user could see Pause / Stop / Close and press none of them.
describe('goal loop overlay controls from the keyboard (K2-1)', () => {
  let frames: FrameRequestCallback[] = []
  beforeEach(() => {
    frames = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })
  afterEach(() => vi.unstubAllGlobals())
  const flush = () => act(() => { frames.splice(0).forEach(frame => frame(performance.now())) })

  it('focuses the first action, lets Tab/Enter reach the buttons, and wraps Tab inside', async () => {
    render(<><Harness model={workspace()} /><GoalLoopPane sessionId="a" /></>)
    screen.getByLabelText('Composer').focus()
    act(() => { toggleGoalLoop() })
    // The loop is read asynchronously; wait for its overlay (the brief
    // "no loop" overlay before it is a different mount).
    await screen.findByText('Goal loop · active')
    const dialog = screen.getByRole('dialog')
    flush()
    const pause = screen.getAllByRole('button', { name: 'Pause' }).find(button => dialog.contains(button))!
    expect(document.activeElement).toBe(pause)

    // Enter reaches the focused button: the router neither prevents nor stops it.
    expect(keyDown({ key: 'Enter' })).toBe(true)
    // Tab is admitted too; the overlay's own handler moves and wraps focus.
    const inside = [...dialog.querySelectorAll('button')]
    keyDown({ key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(inside[inside.length - 1])
    keyDown({ key: 'Tab' })
    expect(document.activeElement).toBe(inside[0])

    // Letters are still consumed: nothing types into the composer below.
    expect(keyDown({ key: 'x', code: 'KeyX' })).toBe(false)
  })

  it('with two panes, only the ACTIVE pane s overlay takes focus (review A1)', async () => {
    // The latch is app-wide, so both visible panes mount an overlay. Before
    // the fix each pulled focus and the LATER one won: Enter then paused the
    // other agent. Pane A is active and renders first, B renders second.
    render(<>
      <Harness model={workspace()} />
      <div data-testid="pane-a"><GoalLoopPane sessionId="a" focused /></div>
      <div data-testid="pane-b"><GoalLoopPane sessionId="b" focused={false} /></div>
    </>)
    screen.getByLabelText('Composer').focus()
    act(() => { toggleGoalLoop() })
    await waitFor(() => expect(screen.getAllByText('Goal loop · active')).toHaveLength(2))
    flush()
    const paneA = screen.getByTestId('pane-a')
    const focused = document.activeElement as HTMLElement
    expect(paneA.contains(focused)).toBe(true)
    fireEvent.click(focused)
    expect(api.controlGoalLoop).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'a' }))
  })

  it('returns focus to the composer when the overlay closes', async () => {
    render(<><Harness model={workspace()} /><GoalLoopPane sessionId="a" /></>)
    const composer = screen.getByLabelText('Composer')
    composer.focus()
    act(() => { toggleGoalLoop() })
    await screen.findByText('Goal loop · active')
    flush()
    keyDown({ key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(composer)
  })
})

// #1021: the owner ran "Goal Loop" and the whole app stopped taking input.
// The focused agent had no loop, which is the NORMAL case: only an agent starts
// a loop, through goal_loop_start. The latch was set and the router gate
// swallowed every key, but the pane rendered nothing, so nothing on screen
// explained it. Every case below runs with NO loop, which is the input the
// earlier tests never used (they stubbed a loop for every session). The
// invariant under test comes from lib/interaction-ownership.ts: input
// ownership follows the mounted DOM, never a store flag.
describe('goal loop command with no loop on the session (#1021)', () => {
  // Runs the real CommandDef exactly as the palette does.
  const runGoalLoopCommand = () => {
    goalLoopCommands.find(command => command.id === 'goal-loop-preview')!.run({ ui: { closePalette: vi.fn() } } as never)
  }
  beforeEach(() => { api.readGoalLoops.mockImplementation(async () => ({})) })

  it('never swallows input when no goal loop overlay is mounted (terminal-only or empty tab)', () => {
    render(<Harness model={workspace()} />)
    const composer = screen.getByLabelText('Composer')
    composer.focus()
    runGoalLoopCommand()
    expect(useGoalLoopView.getState().latched).toBe(true)
    // fireEvent returns false when a listener called preventDefault.
    expect(fireEvent.keyDown(composer, { key: 'a', code: 'KeyA' })).toBe(true)
    // The stale latch is dropped rather than left armed for the next surface.
    expect(useGoalLoopView.getState().latched).toBe(false)
    fireEvent.keyDown(composer, { key: 'p', code: 'KeyP', metaKey: true, shiftKey: true })
    expect(harness.appState.requestCommandInvocation).toHaveBeenCalledWith('open-command-palette', 'keybinding')
  })

  it('shows a visible empty state on an agent pane without a loop, and Escape closes it', async () => {
    render(<><Harness model={workspace()} /><GoalLoopPane sessionId="a" /></>)
    runGoalLoopCommand()
    expect(await screen.findByText('No goal loop on this agent')).toBeTruthy()
    expect(screen.getByRole('dialog')).toBeTruthy()
    // Plan M7: the exit is a real (shared) button carrying the ⎋ it honours.
    const close = screen.getByRole('button', { name: 'Close' })
    expect(close).toHaveAttribute('data-slot', 'button')
    expect(close.querySelector('[data-slot="kbd"]')?.textContent).toBe('⎋')
    keyDown({ key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(useGoalLoopView.getState().latched).toBe(false)
  })

  it('window blur dismisses the latch, like the TLDR latch', async () => {
    render(<><Harness model={workspace()} /><GoalLoopPane sessionId="a" /></>)
    runGoalLoopCommand()
    expect(await screen.findByRole('dialog')).toBeTruthy()
    fireEvent.blur(window)
    expect(useGoalLoopView.getState().latched).toBe(false)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  // Review round 2: "mounted" is not "visible". Reader, Spotlight, Settings and
  // the fullscreen editor keep the workspace mounted under display:none via
  // the REAL RetainedWorkspaceSurface used here, so an overlay there sat in the
  // DOM, passed the gate's check, and swallowed every key unseen.
  it('does not trap input when the agent pane is inside a hidden retained workspace (Reader/Spotlight/Settings)', async () => {
    render(<><Harness model={workspace()} /><RetainedWorkspaceSurface hidden><GoalLoopPane sessionId="a" /></RetainedWorkspaceSurface></>)
    const composer = screen.getByLabelText('Composer')
    composer.focus()
    runGoalLoopCommand()
    // Let React commit the latch change first. Firing the key before the
    // overlay could mount would pass for the WRONG reason: the first draft of
    // this test did exactly that, and passed on the unfixed code too.
    await act(async () => { await Promise.resolve() })
    expect(document.querySelector('[data-goal-loop-overlay]')).toBeNull()
    expect(fireEvent.keyDown(composer, { key: 'a', code: 'KeyA' })).toBe(true)
    expect(useGoalLoopView.getState().latched).toBe(false)
  })

  it('the toggle chord on a stale latch turns it off instead of re-arming it', () => {
    // A terminal-only tab: no pane can render an overlay. Before the fix, each
    // press re-ran the command and re-armed an invisible latch.
    render(<Harness model={workspace()} />)
    runGoalLoopCommand()
    keyDown({ key: 'g', code: 'KeyG', metaKey: true, shiftKey: true })
    expect(useGoalLoopView.getState().latched).toBe(false)
    expect(harness.appState.requestCommandInvocation).not.toHaveBeenCalled()
  })

  it('drops a latch that no visible pane rendered, so it cannot pop an overlay into a later tab', async () => {
    render(<Harness model={workspace()} />)
    runGoalLoopCommand()
    expect(useGoalLoopView.getState().latched).toBe(true)
    await new Promise(resolve => window.requestAnimationFrame(() => resolve(undefined)))
    expect(useGoalLoopView.getState().latched).toBe(false)
  })

  it('keeps the latch when a visible pane did render the overlay', async () => {
    render(<><Harness model={workspace()} /><GoalLoopPane sessionId="a" /></>)
    runGoalLoopCommand()
    expect(await screen.findByRole('dialog')).toBeTruthy()
    await new Promise(resolve => window.requestAnimationFrame(() => resolve(undefined)))
    expect(useGoalLoopView.getState().latched).toBe(true)
  })

  it('a rebound goal-loop-preview chord still dismisses the overlay', async () => {
    // #1007 moved the default chord off Cmd+Shift+Y. Before #1021's fix the
    // dismissal was a hardcoded Meta+Shift+KeyY check, so any rebind would
    // have left Escape as the only keyboard exit.
    harness.appState = { ...harness.appState, settings: { agentViewMode: 'agent', commandKeybindingOverrides: { 'goal-loop-preview': ['Cmd+Ctrl+J'] } } }
    render(<><Harness model={workspace()} /><GoalLoopPane sessionId="a" /></>)
    runGoalLoopCommand()
    expect(await screen.findByRole('dialog')).toBeTruthy()
    keyDown({ key: 'j', code: 'KeyJ', metaKey: true, ctrlKey: true })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens on the new Cmd+Shift+G chord (#1007)', () => {
    render(<Harness model={workspace()} />)
    keyDown({ key: 'g', code: 'KeyG', metaKey: true, shiftKey: true })
    expect(harness.appState.requestCommandInvocation).toHaveBeenCalledWith('goal-loop-preview', 'keybinding')
  })

  it('yields Cmd+Shift+G to the editor, which owns it as Find Previous (#1045 review)', () => {
    // Reproduced by review: the router latched the overlay on top of Monaco's
    // own Find Previous, and the latch gate then swallowed every keystroke
    // until Escape. Monaco's dispatcher does not check defaultPrevented, so
    // both ran. The router must not consume the chord here at all.
    render(<Harness model={workspace()} />)
    const editor = screen.getByLabelText('Editor')
    editor.focus()
    expect(fireEvent.keyDown(editor, { key: 'g', code: 'KeyG', metaKey: true, shiftKey: true })).toBe(true)
    expect(harness.appState.requestCommandInvocation).not.toHaveBeenCalled()
    expect(useGoalLoopView.getState().latched).toBe(false)
  })

  it('yields Cmd+Shift+G to a transcript code block too (#1045 Codex review)', () => {
    // Code blocks in the ordinary feed are Monaco editors without the global
    // editor's marker, and Monaco binds Find Previous on read-only editors.
    // A guard that knew only the global editor let the overlay latch over a
    // code block and swallow every key after it.
    render(<Harness model={workspace()} />)
    const code = screen.getByLabelText('Code block')
    code.focus()
    expect(fireEvent.keyDown(code, { key: 'g', code: 'KeyG', metaKey: true, shiftKey: true })).toBe(true)
    expect(harness.appState.requestCommandInvocation).not.toHaveBeenCalled()
    expect(useGoalLoopView.getState().latched).toBe(false)
  })

  it('a stale latch does not cost the editor a Find Previous either (#1045 review)', () => {
    // The stale-latch branch runs before the routed path. It must still drop
    // the latch, but it may not consume the chord while the editor owns it.
    render(<Harness model={workspace()} />)
    runGoalLoopCommand()
    expect(useGoalLoopView.getState().latched).toBe(true)
    const editor = screen.getByLabelText('Editor')
    editor.focus()
    expect(fireEvent.keyDown(editor, { key: 'g', code: 'KeyG', metaKey: true, shiftKey: true })).toBe(true)
    expect(useGoalLoopView.getState().latched).toBe(false)
  })

  it('the old Cmd+Shift+Y no longer opens the goal loop (#1007: macOS New Sticky Note)', () => {
    render(<Harness model={workspace()} />)
    keyDown({ key: 'y', code: 'KeyY', metaKey: true, shiftKey: true })
    expect(harness.appState.requestCommandInvocation).not.toHaveBeenCalledWith('goal-loop-preview', expect.anything())
  })
})

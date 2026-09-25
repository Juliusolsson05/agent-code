import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppStore } from '@renderer/app-state/store'
import type { SessionMenuRequest } from '@renderer/app-state/uiShell/types'
import { dispatchPendingInvocation } from '@renderer/features/command-palette/dispatchPendingInvocation'
import { __resetInFlightForTests } from '@renderer/features/command-palette/executeCommand'
import { AGENT_GONE_MESSAGE } from '@renderer/features/command-palette/targetedCommandContext'
import type { CommandContext } from '@renderer/features/command-palette/types'
import { emptyRuntime } from '@renderer/session-runtime/state'
import { DispatchAgentList } from '@renderer/workspace/dispatch/DispatchAgentList'
import type { DispatchAgentRow } from '@renderer/workspace/dispatch/dispatchSelectors'
import { loadRecordedDispatchWorkspace } from '@renderer/workspace/testing/recordedDispatchWorkspace'
import type { SessionId, WorkspaceState } from '@renderer/workspace/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import type { PopupMenuItem, PopupMenuRequest } from '@shared/types/popupMenu'

import { useSessionMenuHost } from './useSessionMenuHost'

// The Sessions row menu end to end (#1180), in three hops, each driven through
// its real entry point with the REAL app store:
//   row      right-click / Shift+F10 on the real DispatchAgentList
//   host     useSessionMenuHost — builds the template from the real catalog,
//            shows it (`window.api.showPopupMenu`, the process edge, stubbed),
//            routes the pick
//   dispatch dispatchPendingInvocation — what the palette host runs for the
//            queued pick, through the real execution gateway
// The workspace is the recorded 24-agent layout; see
// commandTarget.renderer.test.ts for why, and for the provider-id edit.

const FOCUSED = 'session-17' as SessionId // focused lane 1, Codex
const TARGET = 'session-23' as SessionId // Claude, in no lane

function recordedState(): WorkspaceState {
  const recorded = loadRecordedDispatchWorkspace().state
  return {
    ...recorded,
    sessions: {
      ...recorded.sessions,
      [TARGET]: { ...recorded.sessions[TARGET]!, providerSessionId: 'provider-target' },
    },
  }
}

const initialStore = useAppStore.getState()
const originalApi = Object.getOwnPropertyDescriptor(window, 'api')

function installApi(showPopupMenu: (request: PopupMenuRequest) => Promise<string | null>) {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      showPopupMenu: vi.fn(showPopupMenu),
      // The list reads goal loops once per index; none are running here.
      readGoalLoops: async () => ({}),
      onGoalLoopChanged: () => () => {},
    },
  })
  return window.api.showPopupMenu as unknown as ReturnType<typeof vi.fn>
}

beforeEach(() => {
  __resetInFlightForTests()
  useAppStore.setState({
    workspaceState: recordedState(),
    workspaceSpotlight: null,
    workspaceReaderMode: null,
    sessionMenuRequest: null,
    sessionMenuOpenFor: null,
    pendingCommandInvocation: null,
  })
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initialStore, true)
  if (originalApi) Object.defineProperty(window, 'api', originalApi)
})

describe('Sessions row', () => {
  const row = (sessionId: SessionId, index: number): DispatchAgentRow => ({
    key: `project:${sessionId}`, label: `A${index}`, globalIndex: index,
    tabId: 'project', tabTitle: 'Project', tabIndex: 0, sessionId,
    kind: 'claude', title: sessionId, depth: 0,
  })
  const renderList = (options: { disabled?: SessionId[] } = {}) => {
    const focusSessionInTab = vi.fn()
    for (const id of [FOCUSED, TARGET]) {
      useAppStore.setState(state => ({ workspaceRuntimes: { ...state.workspaceRuntimes, [id]: emptyRuntime() } }))
    }
    render(<DispatchAgentList
      groups={[{ tab: { id: 'project', title: 'Project' }, tabIndex: 0, rows: [row(FOCUSED, 1), row(TARGET, 2)] }]}
      pinnedRows={[]}
      activeSessionId={FOCUSED}
      focusSessionInTab={focusSessionInTab}
      showWorktreeBadges={false}
      targetLaneIndex={1}
      disabledSessionIds={new Set(options.disabled)}
    />)
    return { focusSessionInTab, button: (id: SessionId) => screen.getByText(id).closest('button')! }
  }

  beforeEach(() => { installApi(async () => null) })

  it('asks for the menu without selecting the row', () => {
    const { focusSessionInTab, button } = renderList()
    const event = fireEvent.contextMenu(button(TARGET))

    // `false` = default prevented: Chromium's own menu must not open too.
    expect(event).toBe(false)
    expect(focusSessionInTab).not.toHaveBeenCalled()
    const request = useAppStore.getState().sessionMenuRequest!
    expect(request).toMatchObject({ sessionId: TARGET, goalLoopLive: false, showInLane: { label: 'Lane 2' } })
    // "Show in Lane 2" IS the row's left click.
    request.showInLane!.run()
    expect(focusSessionInTab).toHaveBeenCalledWith('project', TARGET)
  })

  it('opens a disabled row\'s menu too, without Show in Lane', () => {
    const { focusSessionInTab, button } = renderList({ disabled: [TARGET] })
    fireEvent.click(button(TARGET))
    expect(focusSessionInTab).not.toHaveBeenCalled()
    // aria-disabled (so the right-click arrives) without joining the Tab
    // order, which `disabled` used to keep it out of.
    expect(button(TARGET).getAttribute('aria-disabled')).toBe('true')
    expect(button(TARGET).tabIndex).toBe(-1)
    expect(button(FOCUSED).tabIndex).toBe(0)

    fireEvent.contextMenu(button(TARGET))
    const request = useAppStore.getState().sessionMenuRequest!
    expect(request.sessionId).toBe(TARGET)
    expect(request.showInLane).toBeUndefined()
  })

  it('opens from the keyboard, anchored to the row', () => {
    const { button } = renderList()
    fireEvent.keyDown(button(TARGET), { key: 'F10', shiftKey: true })
    expect(useAppStore.getState().sessionMenuRequest).toMatchObject({ sessionId: TARGET, x: expect.any(Number), y: expect.any(Number) })

    useAppStore.setState({ sessionMenuRequest: null })
    fireEvent.keyDown(button(TARGET), { key: 'F10' })
    expect(useAppStore.getState().sessionMenuRequest).toBeNull()
  })

  it('marks the row whose menu is open', () => {
    const { button } = renderList()
    act(() => { useAppStore.getState().setSessionMenuOpenFor(TARGET) })
    expect(button(TARGET).dataset.menuOpen).toBe('true')
    expect(button(FOCUSED).dataset.menuOpen).toBeUndefined()
  })
})

describe('menu host', () => {
  const commandContext = (): CommandContext => ({
    workspace: {
      state: useAppStore.getState().workspaceState,
      getRuntime: () => emptyRuntime(),
      setSpotlightTarget: vi.fn(),
    } as unknown as Workspace,
    ui: {},
    flags: { commandKeybindingOverrides: {}, agentViewMode: 'rendered' },
  } as unknown as CommandContext)

  const request = (overrides: Partial<SessionMenuRequest> = {}): SessionMenuRequest => ({
    sessionId: TARGET, goalLoopLive: false, showInLane: { label: 'Lane 2', run: vi.fn() }, ...overrides,
  })

  function host(pick: (items: PopupMenuItem[]) => Promise<string | null>) {
    const showToast = vi.fn()
    const ctx = commandContext()
    const showPopupMenu = installApi(({ items }) => pick(items))
    renderHook(() => useSessionMenuHost({ commandContext: ctx, showToast }))
    return { showToast, showPopupMenu, ctx }
  }

  it('shows the clicked agent\'s menu, marks the row, and queues the pick against it', async () => {
    let openFor: SessionId | null = null
    const { showPopupMenu } = host(async () => {
      openFor = useAppStore.getState().sessionMenuOpenFor
      return 'command:close-pane'
    })
    act(() => { useAppStore.getState().requestSessionMenu(request()) })

    await waitFor(() => { expect(useAppStore.getState().pendingCommandInvocation).not.toBeNull() })
    const labels = (showPopupMenu.mock.calls[0]![0] as PopupMenuRequest).items
      .flatMap(item => (item.type === 'item' ? [item.label] : []))
    // Built for TARGET (Claude, with a provider id), not for FOCUSED.
    expect(labels).toContain('Reload Agent')
    expect(labels).toContain('Close Agent')
    expect(openFor).toBe(TARGET)
    expect(useAppStore.getState().sessionMenuOpenFor).toBeNull()
    expect(useAppStore.getState().sessionMenuRequest).toBeNull()
    expect(useAppStore.getState().pendingCommandInvocation).toMatchObject({
      id: 'close-pane', source: 'context-menu', target: TARGET,
    })
  })

  it('applies a colour flag and Spotlight directly', async () => {
    const picks = ['flag:red', 'spotlight']
    const { ctx } = host(async () => picks.shift() ?? null)
    act(() => { useAppStore.getState().requestSessionMenu(request()) })
    await waitFor(() => { expect(useAppStore.getState().settings.dispatchColorFlags[TARGET]).toBe('red') })

    act(() => { useAppStore.getState().requestSessionMenu(request()) })
    await waitFor(() => { expect(ctx.workspace.setSpotlightTarget).toHaveBeenCalledWith(TARGET) })
  })

  it('drops a pick for an agent that closed while the menu was open', async () => {
    const { showToast } = host(async () => {
      // The agent exits while the user reads the menu.
      useAppStore.setState(state => {
        const sessions = { ...state.workspaceState.sessions }
        delete sessions[TARGET]
        return { workspaceState: { ...state.workspaceState, sessions } }
      })
      return 'flag:red'
    })
    act(() => { useAppStore.getState().requestSessionMenu(request()) })

    await waitFor(() => { expect(showToast).toHaveBeenCalledWith(AGENT_GONE_MESSAGE, 3000) })
    expect(useAppStore.getState().settings.dispatchColorFlags[TARGET]).toBeUndefined()
  })

  it('opens ONE menu when the request is what mounts the host, even under StrictMode', async () => {
    // The app's real order: the row queues the request, and that request is
    // what mounts the (otherwise closed) host. StrictMode replays a fresh
    // mount's layout effects with the same captured request; that replay
    // opened a second native menu (#1180 review).
    const ctx = commandContext()
    const showPopupMenu = installApi(async () => null)
    act(() => { useAppStore.getState().requestSessionMenu(request()) })
    renderHook(() => useSessionMenuHost({ commandContext: ctx, showToast: vi.fn() }), { reactStrictMode: true })

    await waitFor(() => { expect(useAppStore.getState().sessionMenuOpenFor).toBeNull() })
    expect(showPopupMenu).toHaveBeenCalledTimes(1)
  })

  it('runs Show in Lane through the row\'s own click', async () => {
    const run = vi.fn()
    host(async () => 'show-in-lane')
    act(() => { useAppStore.getState().requestSessionMenu(request({ showInLane: { label: 'Lane 2', run } })) })
    await waitFor(() => { expect(run).toHaveBeenCalledOnce() })
  })
})

describe('queued pick', () => {
  function context() {
    const closeSession = vi.fn(async () => {})
    const closeFocused = vi.fn()
    const ctx = {
      workspace: {
        state: useAppStore.getState().workspaceState,
        getRuntime: () => emptyRuntime(),
        closeSession,
        closeFocused,
        showPaneToast: vi.fn(),
      } as unknown as Workspace,
      ui: {},
      flags: { commandKeybindingOverrides: {}, agentViewMode: 'rendered' },
    } as unknown as CommandContext
    return { ctx, closeSession, closeFocused }
  }

  it('closes the clicked agent, not the focused one', async () => {
    const { ctx, closeSession, closeFocused } = context()
    const outcome = await dispatchPendingInvocation({
      pending: { id: 'close-pane', source: 'context-menu', target: TARGET, closeAfterRun: true },
      commandContext: ctx,
      showToast: vi.fn(),
    })
    expect(outcome.status).toBe('ran')
    expect(closeSession).toHaveBeenCalledWith(TARGET, { killCaller: 'close.context-menu' })
    expect(closeFocused).not.toHaveBeenCalled()
  })

  it('says the agent is gone instead of closing another one', async () => {
    const { ctx, closeSession, closeFocused } = context()
    const state = ctx.workspace.state
    delete state.sessions[TARGET]
    useAppStore.setState({ workspaceState: state })
    const showToast = vi.fn()

    const outcome = await dispatchPendingInvocation({
      pending: { id: 'close-pane', source: 'context-menu', target: TARGET, closeAfterRun: true },
      commandContext: ctx,
      showToast,
    })
    expect(outcome.status).toBe('unavailable')
    expect(showToast).toHaveBeenCalledWith(AGENT_GONE_MESSAGE, 4000)
    expect(closeSession).not.toHaveBeenCalled()
    expect(closeFocused).not.toHaveBeenCalled()
  })

  it('keeps a keybinding refusal silent, as before', async () => {
    const { ctx } = context()
    const showToast = vi.fn()
    // No focused agent anywhere → Reload refuses. A chord pressed in the
    // wrong context is common; it has never toasted and still does not.
    useAppStore.setState({ workspaceState: { ...ctx.workspace.state, stage: { ...ctx.workspace.state.stage, lanes: [] } } })
    ;(ctx.workspace as { state: WorkspaceState }).state = useAppStore.getState().workspaceState
    const outcome = await dispatchPendingInvocation({
      pending: { id: 'reload-agent', source: 'keybinding', closeAfterRun: true },
      commandContext: ctx,
      showToast,
    })
    expect(outcome.status).toBe('unavailable')
    expect(showToast).not.toHaveBeenCalled()
  })
})

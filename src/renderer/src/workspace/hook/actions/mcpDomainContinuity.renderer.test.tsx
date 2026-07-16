import { act } from 'react'
import type { MutableRefObject } from 'react'
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { UndoCloseStack } from '@renderer/lib/undoClose'
import type { SessionActions } from '@renderer/workspace/hook/actions/session'
import { usePaneActions } from '@renderer/workspace/hook/actions/pane'
import { useUndoCloseAction } from '@renderer/workspace/hook/actions/undoClose'
import type {
  WorkspaceSetRuntimes,
  WorkspaceSetSpotlight,
  WorkspaceSetState,
  WorkspaceSetTileTabs,
} from '@renderer/workspace/hook/context'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import type { DispatchModeState, WorkspaceState } from '@renderer/workspace/types'

function makeState(dispatchMode: DispatchModeState | null): WorkspaceState {
  return {
    tabs: [{
      id: 'tab-parent',
      title: 'parent',
      root: { type: 'leaf', sessionId: 'parent' },
      focusedSessionId: 'parent',
    }],
    activeTabId: 'tab-parent',
    dispatchMode,
    sessions: {
      parent: { cwd: '/projects/parent', kind: 'codex' },
    },
    detachedSessions: {},
    buried: [],
    pinnedSessionIds: [],
  } as WorkspaceState
}

function makeRefs(state: WorkspaceState): WorkspaceRefs {
  const ref = <T,>(value: T): MutableRefObject<T> => ({ current: value })
  return {
    stateRef: ref(state),
    latestStateRef: ref(state),
    latestRuntimesRef: ref({}),
    latestTileTabsRef: ref(null),
    dangerousAgentsRef: ref(false),
    useProxyStreamingRef: ref(false),
    seenUuidsRef: ref({}),
    latestScreenRef: ref({}),
    undoStackRef: ref(new UndoCloseStack()),
    bootstrapTimersRef: ref(new Map()),
    persistedFeedDebugIdRef: ref({}),
    inFlightFeedDebugIdRef: ref({}),
    paneToastTimers: ref({}),
    saveTimerRef: ref(null),
    bootRef: ref(false),
  }
}

function stateWriter(
  initialState: WorkspaceState,
  refs: WorkspaceRefs,
): { getState: () => WorkspaceState; setState: WorkspaceSetState } {
  let state = initialState
  return {
    getState: () => state,
    setState: next => {
      state = typeof next === 'function' ? next(state) : next
      refs.stateRef.current = state
      refs.latestStateRef.current = state
    },
  }
}

function sessionActionsWithSpawn(spawn: ReturnType<typeof vi.fn>): SessionActions {
  return {
    spawn,
    ensureSessionLive: vi.fn(),
    killSession: vi.fn().mockResolvedValue(undefined),
    replaceSession: vi.fn(),
    reloadAgentSessions: vi.fn(),
    softReloadAgentView: vi.fn(),
  } as unknown as SessionActions
}

function mountPaneActions(initialState: WorkspaceState) {
  const refs = makeRefs(initialState)
  const writer = stateWriter(initialState, refs)
  const spawn = vi.fn().mockResolvedValue('clone')
  let actions!: ReturnType<typeof usePaneActions>

  function Harness(): React.JSX.Element {
    actions = usePaneActions(
      initialState,
      writer.setState,
      (() => undefined) as WorkspaceSetRuntimes,
      (() => undefined) as WorkspaceSetSpotlight,
      (() => undefined) as WorkspaceSetTileTabs,
      refs,
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      sessionActionsWithSpawn(spawn),
    )
    return <div />
  }

  const mounted = render(<Harness />)
  return { actions, mounted, spawn, getState: writer.getState }
}

describe('built-in MCP continuity at session resurrection boundaries', () => {
  it('scopes a normal split clone to the selected source cwd, not its physical parent', async () => {
    const harness = mountPaneActions(makeState(null))

    await act(async () => {
      await harness.actions.splitFocused('vertical', 'codex', {
        resumeSessionId: 'provider-clone',
        builtInMcpDomains: ['workflows'],
        cwd: '/projects/related-child',
      })
    })

    // WHY this deliberately disagrees with the parent fixture cwd: related agents can render as
    // tabs inside a parent pane while running in another worktree. The spawn boundary is where an
    // incorrect fallback would become a valid-but-wrong project-scoped bearer credential.
    expect(harness.spawn).toHaveBeenCalledWith('/projects/related-child', {
      kind: 'codex',
      resumeSessionId: 'provider-clone',
      builtInMcpDomains: ['workflows'],
    })
    harness.mounted.unmount()
  })

  it('keeps the explicit source cwd when Dispatch turns a split into a detached clone', async () => {
    const harness = mountPaneActions(makeState({
      scope: 'project',
      focusedSessionId: 'parent',
    }))

    await act(async () => {
      await harness.actions.splitFocused('vertical', 'codex', {
        resumeSessionId: 'provider-clone',
        builtInMcpDomains: ['workflows'],
        cwd: '/projects/related-child',
      })
    })

    expect(harness.spawn).toHaveBeenCalledWith('/projects/related-child', {
      kind: 'codex',
      resumeSessionId: 'provider-clone',
      builtInMcpDomains: ['workflows'],
    })
    harness.mounted.unmount()
  })

  it('restores a closed pane with fresh credentials derived from its captured domains', async () => {
    const state = makeState(null)
    const refs = makeRefs(state)
    const writer = stateWriter(state, refs)
    const spawn = vi.fn().mockResolvedValue('restored-pane')
    refs.undoStackRef.current.push({
      type: 'pane',
      closedAt: Date.now(),
      tabId: 'tab-parent',
      sessionMeta: {
        cwd: '/projects/related-child',
        kind: 'codex',
        providerSessionId: 'provider-old',
        builtInMcpDomains: ['workflows'],
      },
      direction: 'vertical',
      ratio: 0.5,
      side: 'a',
      siblingLeafId: 'parent',
    })
    let actions!: ReturnType<typeof useUndoCloseAction>

    function Harness(): React.JSX.Element {
      actions = useUndoCloseAction(state, writer.setState, refs, sessionActionsWithSpawn(spawn))
      return <div />
    }

    const mounted = render(<Harness />)
    await act(async () => {
      await actions.undoClose()
    })

    expect(spawn).toHaveBeenCalledWith('/projects/related-child', {
      kind: 'codex',
      resumeSessionId: 'provider-old',
      recoverTmuxName: undefined,
      builtInMcpDomains: ['workflows'],
    })
    mounted.unmount()
  })

  it('restores both grid and detached tab agents with their own domain metadata', async () => {
    const state = { ...makeState(null), tabs: [], sessions: {} } as WorkspaceState
    const refs = makeRefs(state)
    const writer = stateWriter(state, refs)
    const spawn = vi.fn()
      .mockResolvedValueOnce('restored-grid')
      .mockResolvedValueOnce('restored-detached')
    refs.undoStackRef.current.push({
      type: 'tab',
      closedAt: Date.now(),
      tab: {
        id: 'closed-tab',
        title: 'closed',
        root: { type: 'leaf', sessionId: 'old-grid' },
        focusedSessionId: 'old-grid',
      },
      tabIndex: 0,
      sessionMetas: {
        'old-grid': {
          cwd: '/projects/grid',
          kind: 'codex',
          providerSessionId: 'provider-grid',
          builtInMcpDomains: ['workflows'],
        },
      },
      detachedEntries: [{
        meta: {
          cwd: '/projects/detached',
          kind: 'claude',
          providerSessionId: 'provider-detached',
          builtInMcpDomains: ['workflows'],
        },
        detachedAt: 10,
      }],
    })
    let actions!: ReturnType<typeof useUndoCloseAction>

    function Harness(): React.JSX.Element {
      actions = useUndoCloseAction(state, writer.setState, refs, sessionActionsWithSpawn(spawn))
      return <div />
    }

    const mounted = render(<Harness />)
    await act(async () => {
      await actions.undoClose()
    })

    expect(spawn).toHaveBeenNthCalledWith(1, '/projects/grid', {
      kind: 'codex',
      resumeSessionId: 'provider-grid',
      recoverTmuxName: undefined,
      builtInMcpDomains: ['workflows'],
    })
    expect(spawn).toHaveBeenNthCalledWith(2, '/projects/detached', {
      kind: 'claude',
      resumeSessionId: 'provider-detached',
      recoverTmuxName: undefined,
      builtInMcpDomains: ['workflows'],
    })
    mounted.unmount()
  })
})

import type { MutableRefObject } from 'react'
import { render } from '@testing-library/react'
import { vi } from 'vitest'

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
import type { WorkspaceState } from '@renderer/workspace/types'

// Shared mounting harness for the pane/undo action hooks.
//
// WHY this is a real module rather than copy-pasted setup in each spec:
// `usePaneActions` takes eleven positional arguments and `WorkspaceRefs` has
// sixteen fields, so a per-file copy drifts the moment either signature moves —
// and a drifted harness fails in a way that looks like a product bug. It also
// makes the difference between two specs be the SCENARIO rather than a hundred
// lines of scaffolding.
//
// The important property these tests rely on: `stateWriter` applies functional
// updates SYNCHRONOUSLY and writes the result straight back into `stateRef`,
// which is exactly what the real zustand store setter does
// (app-state/workspace/slice.ts). Action code that reads a flag set inside a
// `setState` updater is therefore exercised here the same way it runs in the
// app; a harness that deferred the update would silently pass code that is
// broken in production.

export function makeRefs(state: WorkspaceState): WorkspaceRefs {
  const ref = <T,>(value: T): MutableRefObject<T> => ({ current: value })
  return {
    stateRef: ref(state),
    latestStateRef: ref(state),
    latestRuntimesRef: ref({}),
    latestTileTabsRef: ref(null),
    dangerousAgentsRef: ref(false),
    useProxyStreamingRef: ref(false),
    defaultBuiltInMcpDomainsRef: ref([]),
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

export function stateWriter(
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

export function sessionActionsWithSpawn(
  spawn: ReturnType<typeof vi.fn>,
  overrides: Partial<SessionActions> = {},
): SessionActions {
  return {
    spawn,
    ensureSessionLive: vi.fn(),
    killSession: vi.fn().mockResolvedValue(undefined),
    replaceSession: vi.fn(),
    reloadAgentSessions: vi.fn(),
    softReloadAgentView: vi.fn(),
    ...overrides,
  } as unknown as SessionActions
}

export function mountPaneActions(
  initialState: WorkspaceState,
  options: {
    spawn?: ReturnType<typeof vi.fn>
    /**
     * Id the default spawn resolves to. The default spawn also REGISTERS
     * `sessions[id]`, because the real `sessionActions.spawn` does
     * (session.ts writes SessionMeta into workspace state itself). A mock that
     * only returns an id leaves the new session invisible to every selector
     * that filters on `state.sessions[...] !== undefined` — including
     * `buildDispatchGroups` — so placement assertions would silently pass
     * against a session that never actually appeared.
     */
    spawnSessionId?: string
    refs?: WorkspaceRefs
    showToast?: (message: string, durationMs?: number) => void
  } = {},
) {
  const refs = options.refs ?? makeRefs(initialState)
  const writer = stateWriter(initialState, refs)
  const spawnId = options.spawnSessionId ?? 'clone'
  const spawn = options.spawn ?? vi.fn(async (cwd: string, opts?: { kind?: string }) => {
    writer.setState(prev => ({
      ...prev,
      sessions: {
        ...prev.sessions,
        [spawnId]: { cwd, kind: (opts?.kind ?? 'claude') as never },
      },
    }))
    return spawnId
  })
  const showToast = options.showToast ?? (vi.fn() as (message: string, durationMs?: number) => void)
  const sessionActions = sessionActionsWithSpawn(spawn)
  let actions!: ReturnType<typeof usePaneActions>

  function Harness(): React.JSX.Element {
    actions = usePaneActions(
      initialState,
      writer.setState,
      (() => undefined) as WorkspaceSetRuntimes,
      (() => undefined) as WorkspaceSetSpotlight,
      (() => undefined) as WorkspaceSetTileTabs,
      refs,
      showToast,
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      sessionActions,
    )
    return <div />
  }

  const mounted = render(<Harness />)
  return { actions, mounted, spawn, showToast, refs, sessionActions, getState: writer.getState }
}

export function mountUndoCloseAction(
  initialState: WorkspaceState,
  refs: WorkspaceRefs,
  spawn: ReturnType<typeof vi.fn>,
  overrides: Partial<SessionActions> = {},
) {
  const writer = stateWriter(initialState, refs)
  const sessionActions = sessionActionsWithSpawn(spawn, overrides)
  let actions!: ReturnType<typeof useUndoCloseAction>

  function Harness(): React.JSX.Element {
    actions = useUndoCloseAction(initialState, writer.setState, refs, sessionActions)
    return <div />
  }

  const mounted = render(<Harness />)
  return { actions, mounted, spawn, sessionActions, getState: writer.getState }
}

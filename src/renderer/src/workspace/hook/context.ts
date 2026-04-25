import type { Dispatch, MutableRefObject, SetStateAction } from 'react'

import type { UndoCloseStack } from '@renderer/lib/undoClose'
import type {
  ReaderModeState,
  SessionRuntime,
  SpotlightState,
  TileTabsState,
} from '@renderer/workspace/workspaceState'
import type { SessionId, WorkspaceState } from '@renderer/workspace/types'
import type { FeedDebugInput } from '@renderer/workspace/runtime/feedDebug'

// -----------------------------------------------------------------------------
// WorkspaceHookContext
// -----------------------------------------------------------------------------
//
// Bundle of state, setters, refs, and cross-cutting helpers that every
// sub-hook under ./actions, ./ipc, ./persistence, and ./invalidation
// consumes. Instead of threading 15+ individual arguments through every
// action, we pack them into one object so the sub-hook signatures stay
// manageable.
//
// IDENTITY STABILITY — critical for useCallback deps:
//   - All setters (setState, setRuntimes, setSpotlight, …) come from
//     zustand slice factories and are stable across renders by design.
//   - All refs are useRef outputs — their identity never changes.
//   - `updateRuntime`, `appendFeedDebug`, `showPaneToast` are
//     useCallback-wrapped with stable deps, also identity-stable.
//   - `showToast` comes from GlobalToast context (stable).
//
// The context OBJECT itself is also memoized so `[ctx]` as a useCallback
// dep is equivalent to listing every stable field individually. Live
// zustand slice values (state, runtimes, spotlight, …) are NOT in the
// context — sub-hooks read them through `ctx.stateRef.current` and
// friends. Putting live slice values in ctx would rebuild ctx on every
// render and invalidate every useCallback.

export type WorkspaceSetState = (
  next: WorkspaceState | ((prev: WorkspaceState) => WorkspaceState),
) => void

export type WorkspaceSetRuntimes = (
  next:
    | Record<SessionId, SessionRuntime>
    | ((prev: Record<SessionId, SessionRuntime>) => Record<SessionId, SessionRuntime>),
) => void

export type WorkspaceSetSpotlight = (
  next:
    | SpotlightState
    | null
    | ((prev: SpotlightState | null) => SpotlightState | null),
) => void

export type WorkspaceSetTileTabs = (
  next:
    | TileTabsState
    | null
    | ((prev: TileTabsState | null) => TileTabsState | null),
) => void

export type WorkspaceSetReaderMode = (
  next:
    | ReaderModeState
    | null
    | ((prev: ReaderModeState | null) => ReaderModeState | null),
) => void

export type WorkspaceHookContext = {
  // --- Zustand setters (identity-stable) ---
  setState: WorkspaceSetState
  setRuntimes: WorkspaceSetRuntimes
  setSpotlight: WorkspaceSetSpotlight
  setTileTabs: WorkspaceSetTileTabs
  setReaderMode: WorkspaceSetReaderMode

  // --- UI shell slice actions (identity-stable) ---
  openBuryPrompt: (sessionId: SessionId) => void
  closeBuryPrompt: () => void
  openNewAgentPlacement: () => void
  closeNewAgentPlacement: () => void

  // --- Global toast ---
  showToast: (message: string, durationMs?: number) => void

  // --- State mirror refs (state values are live; read via .current) ---
  stateRef: MutableRefObject<WorkspaceState>
  latestStateRef: MutableRefObject<WorkspaceState>
  latestRuntimesRef: MutableRefObject<Record<SessionId, SessionRuntime>>
  latestTileTabsRef: MutableRefObject<TileTabsState | null>

  // --- Settings mirror refs ---
  dangerousAgentsRef: MutableRefObject<boolean>
  useProxyStreamingRef: MutableRefObject<boolean>

  // --- Session bookkeeping refs ---
  seenUuidsRef: MutableRefObject<Record<SessionId, Set<string>>>
  latestScreenRef: MutableRefObject<Record<SessionId, string>>
  undoStackRef: MutableRefObject<UndoCloseStack>
  bootstrapTimersRef: MutableRefObject<Map<SessionId, ReturnType<typeof setTimeout>>>
  persistedFeedDebugIdRef: MutableRefObject<Record<SessionId, number>>

  // --- Timer refs ---
  paneToastTimers: MutableRefObject<Record<SessionId, ReturnType<typeof setTimeout>>>
  saveTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>

  // --- Once-only guards ---
  bootRef: MutableRefObject<boolean>

  // --- Cross-cutting runtime helpers ---
  updateRuntime: (sessionId: SessionId, patch: Partial<SessionRuntime>) => void
  appendFeedDebug: (sessionId: SessionId, input: FeedDebugInput) => void

  // --- Draft version counter (bumped to trigger debounced save) ---
  setDraftVersion: Dispatch<SetStateAction<number>>
}

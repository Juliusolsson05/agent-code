import { useMemo, useRef, type MutableRefObject } from 'react'

import { UndoCloseStack } from '@renderer/lib/undoClose'
import type {
  ReaderModeState,
  SessionRuntime,
  SpotlightState,
  TileTabsState,
} from '@renderer/workspace/workspaceState'
import type { SessionId, WorkspaceState } from '@renderer/workspace/types'

// -----------------------------------------------------------------------------
// Ref factory for the workspace hook.
//
// Every ref the useWorkspace hook maintained inline is declared here.
// The factory returns ALL of them in one call so the hook body doesn't
// need 15 separate useRef lines. Ref identity is stable across renders
// (useRef contract), so putting them together doesn't cost anything.
//
// NOTE: this hook updates `stateRef.current = state` style mirrors in
// the caller's render body (not here) — the mirrors are per-render
// writes, not per-action. That's what lets IPC callbacks close over
// stale React state and still read the live value via .current.
// -----------------------------------------------------------------------------

export type WorkspaceRefs = {
  stateRef: MutableRefObject<WorkspaceState>
  latestStateRef: MutableRefObject<WorkspaceState>
  latestRuntimesRef: MutableRefObject<Record<SessionId, SessionRuntime>>
  latestTileTabsRef: MutableRefObject<TileTabsState | null>
  dangerousAgentsRef: MutableRefObject<boolean>
  useProxyStreamingRef: MutableRefObject<boolean>
  seenUuidsRef: MutableRefObject<Record<SessionId, Set<string>>>
  latestScreenRef: MutableRefObject<Record<SessionId, string>>
  undoStackRef: MutableRefObject<UndoCloseStack>
  bootstrapTimersRef: MutableRefObject<Map<SessionId, ReturnType<typeof setTimeout>>>
  persistedFeedDebugIdRef: MutableRefObject<Record<SessionId, number>>
  inFlightFeedDebugIdRef: MutableRefObject<Record<SessionId, number>>
  paneToastTimers: MutableRefObject<Record<SessionId, ReturnType<typeof setTimeout>>>
  saveTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>
  bootRef: MutableRefObject<boolean>
}

export function useWorkspaceRefs(
  initialState: WorkspaceState,
  initialRuntimes: Record<SessionId, SessionRuntime>,
  initialTileTabs: TileTabsState | null,
  dangerousAgentsEnabled: boolean,
  useProxyStreaming: boolean,
): WorkspaceRefs {
  // Each `useRef(...)` already hands back a stable ref OBJECT across
  // renders. But the surrounding `{ ... }` literal does NOT — without
  // memoization this factory returns a fresh object every render, so
  // any sub-hook that lists `refs` in a useEffect / useCallback dep
  // array (notably useIpcSubscriptions) would tear down + re-attach
  // its subscriptions on every workspace re-render. The IPC effect's
  // cleanup specifically does:
  //
  //   for (const t of refs.bootstrapTimersRef.current.values()) clearTimeout(t)
  //   refs.bootstrapTimersRef.current.clear()
  //
  // …so the constant teardown was actively killing the 150 ms
  // debounce timer that flips `bootstrapping` back to false. With an
  // active session re-rendering faster than 150 ms, the timer never
  // fired, `bootstrapping` stayed pinned to true, and Feed's
  // auto-scroll + LazyEntry observers stayed gated forever. The
  // user-visible result was the resume "starts above the eager tail
  // and scrolling up never lazy-loads" regression.
  //
  // The pre-decomposition god-hook had this same effect with
  // `useEffect(..., [updateRuntime])` (a stable callback), so it
  // never tripped. Memoizing the wrapper restores stable identity
  // for the new sub-hook composition without touching every
  // downstream dep array.
  const stateRef = useRef(initialState)
  const latestStateRef = useRef(initialState)
  const latestRuntimesRef = useRef(initialRuntimes)
  const latestTileTabsRef = useRef(initialTileTabs)
  const dangerousAgentsRef = useRef(dangerousAgentsEnabled)
  const useProxyStreamingRef = useRef(useProxyStreaming)
  const seenUuidsRef = useRef<Record<SessionId, Set<string>>>({})
  const latestScreenRef = useRef<Record<SessionId, string>>({})
  const undoStackRef = useRef(new UndoCloseStack())
  const bootstrapTimersRef = useRef<Map<SessionId, ReturnType<typeof setTimeout>>>(new Map())
  const persistedFeedDebugIdRef = useRef<Record<SessionId, number>>({})
  const inFlightFeedDebugIdRef = useRef<Record<SessionId, number>>({})
  const paneToastTimers = useRef<Record<SessionId, ReturnType<typeof setTimeout>>>({})
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const bootRef = useRef(false)
  return useMemo<WorkspaceRefs>(
    () => ({
    // Ref mirror of state so IPC callbacks (which close over stale
    // state) can read the current session metadata (e.g. kind)
    // without causing re-subscriptions on every state change.
    stateRef,
    // Parallel to stateRef; the name `latestStateRef` is kept because
    // the save-to-disk path refers to it explicitly. Both point at
    // the same zustand slice but the caller updates them separately
    // so downstream readers can opt into whichever name is clearer.
    latestStateRef,
    // Ref mirror of runtimes so the debounced save callback can read
    // current drafts without re-creating the callback on every render.
    latestRuntimesRef,
    latestTileTabsRef,

    // Settings mirror refs. Ref-mirrored so the spawn callbacks read
    // the live value without having to subscribe per-call.
    dangerousAgentsRef,
    useProxyStreamingRef,

    // Seen uuids per session, for JSONL dedup. Refs because we never
    // render against them — they're bookkeeping.
    seenUuidsRef,

    // Latest screen per session — mirrored from state into a ref so
    // the Enter handler in TileLeaf can capture a baseline
    // synchronously.
    latestScreenRef,

    // Undo-close stack — mutable ref because the stack is imperative
    // (push/pop) and we don't want React re-renders on every close.
    // The undoClose action reads it and the command palette peeks at
    // .length to show/hide the command.
    undoStackRef,

    // Per-session setTimeout ids used to debounce the `bootstrapping`
    // flag back to false after a bulk jsonl-entries burst. Keyed by
    // sessionId; cleared in the IPC-effect cleanup and in killSession.
    // Ref (not state) because the timer handle is irrelevant to
    // rendering — we just need it alive across the hook's ticks.
    bootstrapTimersRef,

    // Tracks the largest feed-debug entry id we've shipped to main
    // per session. Prevents re-shipping entries we've already written.
    persistedFeedDebugIdRef,
    // Tracks the largest feed-debug entry id currently owned by an
    // unresolved append IPC. This is intentionally separate from the
    // persisted cursor above: advancing `persisted` optimistically
    // would drop logs if the disk write failed, but NOT reserving an
    // in-flight range lets every high-frequency runtime update send
    // the same pending window again while the first IPC waits behind
    // main-process disk work. The main writer still dedupes by id as
    // a durability guard; this ref prevents duplicate work from
    // reaching main in the first place.
    inFlightFeedDebugIdRef,

    // Per-session pane toast timers. Single-slot per session — a
    // second toast replaces the first and resets this timer.
    paneToastTimers,

    // Debounced workspace-save timer. `setTimeout(flushSave, 400)` on
    // every mutation; the beforeunload handler cancels this and
    // flushes synchronously.
    saveTimerRef,

    // Guard for the once-only bootstrap effect. Under React 18
    // StrictMode the effect runs twice; the ref makes the second
    // pass a no-op.
    bootRef,
    }),
    // Empty deps — every property is a ref whose identity never
    // changes across renders, so the wrapper object can be frozen
    // at first render too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )
}

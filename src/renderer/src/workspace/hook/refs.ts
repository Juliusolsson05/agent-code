import { useRef, type MutableRefObject } from 'react'

import { UndoCloseStack } from '../../lib/undoClose'
import type {
  ReaderModeState,
  SessionRuntime,
  SpotlightState,
  TileTabsState,
} from '../workspaceState'
import type { SessionId, WorkspaceState } from '../types'

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
  return {
    // Ref mirror of state so IPC callbacks (which close over stale
    // state) can read the current session metadata (e.g. kind)
    // without causing re-subscriptions on every state change.
    stateRef: useRef(initialState),
    // Parallel to stateRef; the name `latestStateRef` is kept because
    // the save-to-disk path refers to it explicitly. Both point at
    // the same zustand slice but the caller updates them separately
    // so downstream readers can opt into whichever name is clearer.
    latestStateRef: useRef(initialState),
    // Ref mirror of runtimes so the debounced save callback can read
    // current drafts without re-creating the callback on every render.
    latestRuntimesRef: useRef(initialRuntimes),
    latestTileTabsRef: useRef(initialTileTabs),

    // Settings mirror refs. Ref-mirrored so the spawn callbacks read
    // the live value without having to subscribe per-call.
    dangerousAgentsRef: useRef(dangerousAgentsEnabled),
    useProxyStreamingRef: useRef(useProxyStreaming),

    // Seen uuids per session, for JSONL dedup. Refs because we never
    // render against them — they're bookkeeping.
    seenUuidsRef: useRef<Record<SessionId, Set<string>>>({}),

    // Latest screen per session — mirrored from state into a ref so
    // the Enter handler in TileLeaf can capture a baseline
    // synchronously.
    latestScreenRef: useRef<Record<SessionId, string>>({}),

    // Undo-close stack — mutable ref because the stack is imperative
    // (push/pop) and we don't want React re-renders on every close.
    // The undoClose action reads it and the command palette peeks at
    // .length to show/hide the command.
    undoStackRef: useRef(new UndoCloseStack()),

    // Per-session setTimeout ids used to debounce the `bootstrapping`
    // flag back to false after a bulk jsonl-entries burst. Keyed by
    // sessionId; cleared in the IPC-effect cleanup and in killSession.
    // Ref (not state) because the timer handle is irrelevant to
    // rendering — we just need it alive across the hook's ticks.
    bootstrapTimersRef: useRef<Map<SessionId, ReturnType<typeof setTimeout>>>(new Map()),

    // Tracks the largest feed-debug entry id we've shipped to main
    // per session. Prevents re-shipping entries we've already written.
    persistedFeedDebugIdRef: useRef<Record<SessionId, number>>({}),

    // Per-session pane toast timers. Single-slot per session — a
    // second toast replaces the first and resets this timer.
    paneToastTimers: useRef<Record<SessionId, ReturnType<typeof setTimeout>>>({}),

    // Debounced workspace-save timer. `setTimeout(flushSave, 400)` on
    // every mutation; the beforeunload handler cancels this and
    // flushes synchronously.
    saveTimerRef: useRef<ReturnType<typeof setTimeout> | null>(null),

    // Guard for the once-only bootstrap effect. Under React 18
    // StrictMode the effect runs twice; the ref makes the second
    // pass a no-op.
    bootRef: useRef(false),
  }
}

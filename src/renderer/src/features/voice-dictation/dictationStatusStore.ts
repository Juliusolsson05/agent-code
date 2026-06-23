import { useSyncExternalStore } from 'react'

// dictationStatusStore — process-wide source of truth for the terminal-mode
// floating voice-dictation overlay (VoiceDictationOverlay).
//
// WHY this is a module-level store, not a Zustand slice or React context:
//
//   Rendered Agent mode keeps the existing inline composer affordance inside
//   ComposerInput. This store is only for AgentTerminalLeaf, where there is no
//   composer DOM to host the mic meter. The terminal hook writes transient
//   lifecycle state here; the App-root overlay reads it via useSyncExternalStore.
//   That avoids threading terminal-only UI state through TileTree just to paint
//   one floating chip over the raw xterm surface.
//
//   This is also why the store is NOT a discriminated union: callers update
//   fields independently (status flips, levels stream every ~16ms during
//   recording, preview text trickles in) and forcing them into one shape
//   would mean either republishing the full state on every level update
//   (cache thrash) or modeling each field as its own emitter (5x the
//   subscription cost in the overlay). Flat object + identity-based
//   equality check is the right cost/clarity trade.
//
// What the overlay needs to render:
//   - status: which lifecycle phase the chip should depict (idle hides it).
//   - levels: 7-band live mic energy for the animated bars during 'recording'.
//   - targetSessionId: shown as a discreet "writing into <pane>" hint so
//     users with multiple panes can tell which raw terminal owns the press.
//   - previewText: provider interim transcript text, refreshed as Deepgram
//     emits revisions. Always cleared on press start; never persisted past
//     the idle transition.
//   - errorMessage: short human-readable failure text during the brief
//     'error' window before the chip auto-dismisses.

export type DictationOverlayStatus =
  | 'idle'
  | 'starting'
  | 'recording'
  | 'stopping'
  | 'error'

export type DictationOverlayState = {
  status: DictationOverlayStatus
  // Always length 7 — one per VOICE_BANDS_HZ slot in useComposerDictation.
  // Zero array outside the 'recording' phase. Identity-stable across
  // unchanged frames so the overlay's render-equality check works.
  levels: number[]
  // Session that will receive the transcript on release. Null only when
  // status is 'idle' — every other phase has a captured target from the
  // press event so a focus change mid-hold cannot redirect the paste.
  targetSessionId: string | null
  // Short human-readable failure text. Mirrors the main-process error
  // verbatim (truncated by the overlay for display). Non-null only during
  // the brief 'error' window.
  errorMessage: string | null
  // Provider interim transcript text. Cleared on press start, updated by
  // every interim event from main, replaced by the final wrapped text on
  // stop. We deliberately store the RAW provider text (no <stt> tag) here
  // because the overlay shows it as a preview, not the value that gets
  // pasted — the wrap-with-stt happens on the paste path inside main.
  previewText: string
}

// Shared frozen idle state so the equality short-circuit in
// setDictationOverlayState can early-exit cheaply when nothing has changed.
const EMPTY_LEVELS: number[] = Object.freeze([0, 0, 0, 0, 0, 0, 0]) as number[]

const IDLE_STATE: DictationOverlayState = Object.freeze({
  status: 'idle',
  levels: EMPTY_LEVELS,
  targetSessionId: null,
  errorMessage: null,
  previewText: '',
}) as DictationOverlayState

let state: DictationOverlayState = IDLE_STATE
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function getDictationOverlayState(): DictationOverlayState {
  return state
}

export function subscribeDictationOverlay(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

// Single setter for every field. Callers pass either a partial patch or a
// reducer-style function. The shallow-equality short-circuit avoids spurious
// re-renders during the meter tick when the levels array reference has not
// changed (we replace the array per frame on real updates).
export function setDictationOverlayState(
  next:
    | Partial<DictationOverlayState>
    | ((prev: DictationOverlayState) => DictationOverlayState),
): void {
  const computed: DictationOverlayState =
    typeof next === 'function' ? next(state) : { ...state, ...next }
  if (
    computed.status === state.status &&
    computed.levels === state.levels &&
    computed.targetSessionId === state.targetSessionId &&
    computed.errorMessage === state.errorMessage &&
    computed.previewText === state.previewText
  ) {
    return
  }
  state = computed
  emit()
}

export function resetDictationOverlay(): void {
  setDictationOverlayState(IDLE_STATE)
}

export function useDictationOverlayState(): DictationOverlayState {
  // useSyncExternalStore handles tearing/concurrent-mode correctness so the
  // overlay always renders with a consistent snapshot even if the hook
  // updates state during an in-flight React render.
  return useSyncExternalStore(
    subscribeDictationOverlay,
    getDictationOverlayState,
    getDictationOverlayState,
  )
}

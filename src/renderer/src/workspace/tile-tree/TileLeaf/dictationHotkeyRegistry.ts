// Single shared dispatcher for the native dictation hotkey.
//
// Why this module exists at all:
// useComposerDictation used to subscribe to onDictationHotkeyDown/Up directly.
// Each TileLeaf created its own subscription, and the down handler was gated on
// `focusedRef.current`. On a fresh app launch, no composer has focus yet, so
// every subscriber bailed and the press was a silent no-op. The user pressed
// Fn, nothing happened, and they had to click into a composer before dictation
// would respond. The 30-second "doesn't work after launch" report turned out
// to be exactly that: the helper was ready in <1s, but the renderer had no
// focused composer to consume the event.
//
// Two architectural pieces moved here:
//   1. ONE process-wide subscription to the native hotkey IPC. Multiple
//      subscribers were redundant: only one composer can record at a time.
//   2. A "currently active dictation target" picker that prefers the focused
//      composer but falls back to the most-recently-focused one. This is the
//      thing that actually makes Fn work after launch even when the input
//      isn't focused yet.
//
// Each useComposerDictation hook calls registerDictationTarget() when it
// mounts/updates and unregisters on cleanup. The registry owns the IPC
// subscription so the cost is constant in the number of tiles open.

export type DictationTargetHandle = {
  enabled: boolean
  // True iff the leaf's input element currently has DOM focus.
  focused: boolean
  // Last wall-clock timestamp that this target was focused. Updated on every
  // focused=true register call so the fallback picks the genuinely most
  // recent target, not just whichever happens to iterate first.
  lastFocusedAt: number
  // start/stop are wrapped in refs by the caller so identity is stable.
  start: () => void
  stop: () => void
  // Lifecycle predicates so the dispatcher can decide whether a release
  // should call stop() (recording in progress) or be ignored.
  isStarting: () => boolean
  isActive: () => boolean
}

type Subscriptions = {
  offDown: () => void
  offUp: () => void
}

const targets = new Set<DictationTargetHandle>()
let dispatcherSubs: Subscriptions | null = null
// Captured at down time so the up event always reaches the same target —
// even if focus moved or another composer mounted between press and release.
let activeTargetForKeyHold: DictationTargetHandle | null = null

const ensureDispatcher = (): void => {
  if (dispatcherSubs) return
  dispatcherSubs = {
    offDown: window.api.onDictationHotkeyDown(() => {
      const target = pickTarget()
      if (!target) return
      activeTargetForKeyHold = target
      target.start()
    }),
    offUp: window.api.onDictationHotkeyUp(() => {
      // Hand the release to whatever target consumed the press, even if it
      // is no longer the focused leaf. A user can press Fn, click somewhere
      // else, then release — the release must still stop the original
      // recording. If no target took ownership of the press (e.g. the
      // hotkey fired with zero registered tiles), look up the current best
      // target as a fallback to drain any latent starting state.
      const target = activeTargetForKeyHold ?? pickTarget()
      activeTargetForKeyHold = null
      if (!target) return
      if (target.isActive() || target.isStarting()) target.stop()
    }),
  }
}

const teardownDispatcherIfIdle = (): void => {
  if (!dispatcherSubs) return
  if (targets.size > 0) return
  dispatcherSubs.offDown()
  dispatcherSubs.offUp()
  dispatcherSubs = null
}

const pickTarget = (): DictationTargetHandle | null => {
  let best: DictationTargetHandle | null = null
  for (const t of targets) {
    if (!t.enabled) continue
    // Currently-focused composer always wins. This matches user intent: if
    // they are typing into composer A, Fn should record there, full stop.
    if (t.focused) return t
    if (!best || t.lastFocusedAt > best.lastFocusedAt) best = t
  }
  return best
}

export const registerDictationTarget = (
  handle: DictationTargetHandle,
): (() => void) => {
  targets.add(handle)
  ensureDispatcher()
  return () => {
    targets.delete(handle)
    if (activeTargetForKeyHold === handle) activeTargetForKeyHold = null
    teardownDispatcherIfIdle()
  }
}

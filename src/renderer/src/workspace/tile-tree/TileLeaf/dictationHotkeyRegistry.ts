import { hasAppInteractionOwner } from '@renderer/lib/interaction-ownership'

// Single shared dispatcher for every dictation hold, whatever triggered it.
//
// Two trigger sources feed this module today: the native keyboard hotkey
// (main-process IPC, global reach) and the in-app mouse button
// (features/voice-dictation/useDictationMouseTrigger.ts, renderer DOM,
// focused-app reach). They share `beginDictationHold`/`endDictationHold`
// below rather than each implementing target selection — a second copy of
// that policy would drift, and the failure mode is the ugly one: two
// sources each believing they own the same recording.
//
// Why this module exists at all:
// useComposerDictation used to subscribe to onDictationHotkeyDown/Up directly.
// Each pane created its own subscription, and the down handler was gated on
// `focusedRef.current`. On a fresh app launch, no target had focus yet, so
// every subscriber bailed and the press was a silent no-op. The user pressed
// Fn, nothing happened, and they had to click into a pane before dictation
// would respond. The 30-second "doesn't work after launch" report turned out
// to be exactly that: the helper was ready in <1s, but the renderer had no
// focused target to consume the event.
//
// Two architectural pieces moved here:
//   1. ONE process-wide subscription to the native hotkey IPC. Multiple
//      subscribers were redundant: only one composer can record at a time.
//   2. A "currently active dictation target" picker that prefers the focused
//      pane but falls back to the most-recently-focused one. This is the
//      thing that actually makes Fn work after launch even when the input
//      isn't focused yet.
//
// Each useComposerDictation hook calls registerDictationTarget() when it
// mounts/updates and unregisters on cleanup. Composer-mode targets render the
// inline mic affordance; terminal-mode targets render the floating overlay.
// The registry owns the IPC subscription so the cost is constant in the number
// of tiles open.

export type DictationTargetHandle = {
  enabled: boolean
  // True iff this target's pane/input currently has focus.
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
// Captured at press time so the release always reaches the same target —
// even if focus moved or another composer mounted between press and release.
// Shared by BOTH trigger sources (native keyboard hotkey and the in-app
// mouse button) on purpose: only one dictation can be live at a time, so a
// single ownership slot is the correct model. Non-null means a hold is
// outstanding, which is what makes the re-entrancy guard in
// beginDictationHold below possible — see the WHY there, it is load-bearing.
let activeTargetForHold: DictationTargetHandle | null = null

/**
 * Whether the trigger that owns the CURRENT hold is a true press-and-hold or
 * a press-again-to-stop toggle. The overlay needs this to tell the user how
 * to finish ("release" vs "press again"), and it cannot be derived from
 * settings: `dictationShortcut` alone does not determine it (a bare `Cmd`
 * binding is a native hold and contains no "Fn"), and with a mouse button
 * also bound there is no single setting that identifies which trigger is
 * live. The trigger itself is the only thing that knows.
 */
export type DictationHoldStyle = 'hold' | 'toggle'
let activeHoldStyle: DictationHoldStyle = 'toggle'

/** Which input produced the hold. The mouse is always a true hold (pointer
 *  events carry real down/up edges); the keyboard depends on which
 *  main-process path registered the binding, hence `keyboardHoldStyle`. */
export type DictationTriggerSource = 'keyboard' | 'mouse'

// Set by useDictationHotkeySync from the main-process configure result:
// `native: true` means the Accessibility-gated CGEventTap helper owns the
// binding and emits real press/release edges, while the quiet Electron
// globalShortcut path can only toggle (it has no key-up callback).
let keyboardHoldStyle: DictationHoldStyle = 'toggle'

export const setKeyboardDictationHoldStyle = (style: DictationHoldStyle): void => {
  keyboardHoldStyle = style
}

/** Read by useComposerDictation when it publishes overlay state, so the
 *  floating chip's instruction matches the gesture actually in use. */
export const getActiveDictationHoldStyle = (): DictationHoldStyle => activeHoldStyle

/** The composer mic button and the in-composer keydown fallback both toggle
 *  rather than hold, and neither goes through this registry. They mark the
 *  style directly so the overlay stays truthful for those paths too. */
export const markDictationToggleStyle = (): void => {
  activeHoldStyle = 'toggle'
}

/**
 * Begin a dictation hold from any trigger source.
 *
 * WHY this is exported rather than inlined in the IPC callback: the in-app
 * mouse trigger must make the SAME decisions — the interaction-owner gate,
 * the focused-else-most-recently-focused target pick, and the ownership
 * capture below. One decision point, two callers.
 */
export const beginDictationHold = (source: DictationTriggerSource = 'keyboard'): void => {
  // RE-ENTRANCY GUARD. Do not remove — two separate stuck-state bugs live here.
  //
  // Before the mouse trigger existed this was unreachable: the native helper
  // only ever emits paired down/up, so a second begin could not arrive while
  // a hold was outstanding. With two independent triggers it can, and the
  // unguarded version failed two ways:
  //
  //  1. ORPHANED RECORDER. pickTarget() prefers the *currently focused* pane.
  //     Hold the keyboard trigger over pane A, click into pane B, then press
  //     the mouse button: the second begin captured B, started a second
  //     recorder, and overwrote the ownership slot. Releasing the mouse
  //     stopped B and cleared the slot; releasing the keyboard then found
  //     nothing to stop. A's microphone, MediaRecorder and meter ran on with
  //     no remaining path to stop them — the exact failure this subsystem
  //     treats as unacceptable.
  //
  //  2. DISCARDED DICTATION. `handle.start()` resets the hold clock
  //     (hotkeyDownAtRef) even when it does not start a new recording. A
  //     stray ~60ms click during a live 20-second dictation reset that clock,
  //     and the click's release measured as a sub-180ms accidental tap and
  //     cancelled the whole recording, silently restoring the composer.
  //
  // One hold at a time. A second trigger is ignored until the first releases,
  // which is safe because every release path clears the slot unconditionally.
  if (activeTargetForHold) return
  // Trigger events bypass the DOM's focus model entirely, so a focus trap or
  // a pointer-inert overlay cannot protect the composer. Consult the same
  // synchronous ownership contract as DOM input before choosing a target.
  if (hasAppInteractionOwner()) return
  const target = pickTarget()
  if (!target) return
  activeTargetForHold = target
  activeHoldStyle = source === 'mouse' ? 'hold' : keyboardHoldStyle
  target.start()
}


/**
 * End a dictation hold from any trigger source.
 *
 * Deliberately does NOT consult `hasAppInteractionOwner()`. If a dialog opens
 * while the user is mid-hold, the release must still stop the recording that
 * already took ownership of the press — otherwise the mic stays open with no
 * surface able to close it. Every release path in this subsystem biases
 * toward stopping for that reason.
 */
export const endDictationHold = (): void => {
  // Hand the release to whatever target consumed the press, even if it is no
  // longer the focused leaf. A user can press, click somewhere else, then
  // release — the release must still stop the original recording. If no
  // target took ownership of the press (e.g. the trigger fired with zero
  // registered tiles), look up the current best target as a fallback to
  // drain any latent starting state.
  const target = activeTargetForHold ?? pickTarget()
  activeTargetForHold = null
  if (!target) return
  if (target.isActive() || target.isStarting()) target.stop()
}

const ensureDispatcher = (): void => {
  if (dispatcherSubs) return
  dispatcherSubs = {
    // Wrapped, not passed by reference: the IPC handler is invoked with the
    // `{ binding }` payload, which would arrive as beginDictationHold's
    // `source` argument and silently misreport the trigger.
    offDown: window.api.onDictationHotkeyDown(() => beginDictationHold('keyboard')),
    offUp: window.api.onDictationHotkeyUp(() => endDictationHold()),
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
    // Currently-focused target always wins. This matches user intent: if
    // they are typing into pane A, Fn should record there, full stop.
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
    if (activeTargetForHold === handle) activeTargetForHold = null
    teardownDispatcherIfIdle()
  }
}

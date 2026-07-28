// The single owner of window-level mouse gestures in the renderer.
//
// WHY THIS MODULE EXISTS — read before adding a second window mouse listener.
//
// Two features want global mouse gestures: hold-to-talk dictation (one button,
// press and release) and the command-palette chord (two buttons at once). The
// obvious implementation is two independent `window` capture listeners, one per
// feature. That does not work, and the failure is silent:
//
//   Window capture listeners fire in REGISTRATION ORDER. The dictation hook
//   mounts at App root and calls stopPropagation() on the bound button's
//   mousedown. A chord listener registered afterwards never sees that press at
//   all. The chord would simply never fire whenever the user had bound the same
//   button to dictation — with no error, no warning, and nothing in the DOM to
//   explain it.
//
// This is the same argument dictationHotkeyRegistry.ts makes for having ONE
// dictation dispatcher rather than one per pane: when two sources both believe
// they own an input, the bug is not that one wins — it is that which one wins
// depends on mount order, which is invisible at the call site.
//
// So: one module owns every listener, tracks the button bitmask itself, and
// hands resolved gestures to consumers. Adding a third gesture means adding a
// consumer here, never another addEventListener elsewhere.
//
// ---------------------------------------------------------------------------
// THE EVENT MODEL, which is not the obvious one
//
// For a mouse there is exactly ONE pointer. Consequently:
//   - `pointerdown` fires only on the 0 -> non-zero buttons transition
//   - `pointerup`   fires only on the non-zero -> 0 transition, and carries
//     whichever button happened to be released LAST
//   - every intermediate press or release emits `mousedown`/`mouseup` ONLY
//
// Two consequences, both of which have already cost a real bug:
//
//   1. A chord's second button emits NO pointer event. Chord detection must
//      listen to `mousedown`. (Silver lining: every `pointerdown` consumer in
//      the app — Radix dialog dismissal, Feed, ComposerInput, TileTabsView —
//      therefore sits chords out for free. Only `mousedown` consumers need
//      suppressing.)
//   2. Release must be decided from the `buttons` BITMASK, never
//      `event.button`. "Hold middle, click left, release middle, release left"
//      emits no pointerup for middle and one pointerup reporting button 0.
//      Matching on `event.button` drops that release and leaves a hold running
//      forever — this shipped once as a stuck microphone and was found by
//      hardware probing after two code reviews missed it.
//
// See lib/mouseBinding.ts for the button/buttons encoding tables. They are
// different encodings and middle/right are swapped between them.

import { MOUSE_BUTTON_MASKS } from '@renderer/lib/mouseBinding'

export type HoldConsumer = {
  /** `buttons` bitmask of the single button this consumer holds. */
  mask: number
  onPress: () => void
  onRelease: () => void
  /**
   * Called instead of `onRelease` when a chord claimed the gesture. The
   * consumer must DISCARD whatever the press started rather than completing
   * it — for dictation that means throwing the recording away without
   * contacting the provider.
   */
  onCancel: () => void
}

export type ChordConsumer = {
  /** Full `buttons` bitmask of the chord, e.g. middle|right = 6. */
  mask: number
  /** Bitmask of the anchor button — the one whose hold opens the window in
   *  which the completing press counts. */
  anchorMask: number
  onFire: () => void
}

const holdConsumers = new Set<HoldConsumer>()
const chordConsumers = new Set<ChordConsumer>()

// Which hold is currently pressed, if any. Module state rather than a closure
// variable because down and up arrive as separate DOM events that can land in
// the same frame; anything React-scheduled would not be visible in time.
let activeHold: HoldConsumer | null = null
// Set when a chord fires, cleared when every button is released. While true,
// the anchor's release must NOT be delivered as a normal release — the hold it
// would have completed was already cancelled.
let chordClaimedGesture = false
let listenersInstalled = false

/**
 * Every button mask any consumer cares about. Used to decide whether an event
 * is ours at all — we suppress ONLY on a real match, never speculatively,
 * because suppression here is genuinely expensive: xterm in mouse-reporting
 * mode forwards buttons 0/1/2 straight to the child process, so a speculative
 * stopPropagation() would silently break an agent TUI that is using the mouse.
 */
function isTrackedButton(button: number): boolean {
  const mask = buttonToMask(button)
  if (mask === 0) return false
  for (const consumer of holdConsumers) if (consumer.mask === mask) return true
  for (const consumer of chordConsumers) if ((consumer.mask & mask) !== 0) return true
  return false
}

/** `MouseEvent.button` -> `MouseEvent.buttons` bit. NOT `1 << button`: the two
 *  encodings swap middle and right. See mouseBinding.ts. */
function buttonToMask(button: number): number {
  if (button === 0) return 1
  if (button === 1) return MOUSE_BUTTON_MASKS.Middle
  if (button === 2) return 2
  if (button === 3) return MOUSE_BUTTON_MASKS.Back
  if (button === 4) return MOUSE_BUTTON_MASKS.Forward
  return 0
}

function suppress(event: Event): void {
  event.preventDefault()
  // stopPropagation, NOT stopImmediatePropagation: other listeners on this same
  // node must still run. MouseButtonInput's settings capture listener sits on
  // window too, and without it the user could never re-bind a button that is
  // already bound.
  event.stopPropagation()
}

function cancelActiveHold(): void {
  if (!activeHold) return
  const consumer = activeHold
  activeHold = null
  consumer.onCancel()
}

function releaseActiveHold(): void {
  if (!activeHold) return
  const consumer = activeHold
  activeHold = null
  consumer.onRelease()
}

function onDown(event: MouseEvent): void {
  if (!isTrackedButton(event.button)) return
  const mask = buttonToMask(event.button)

  // Chord first: a completing press must beat the hold that its own anchor
  // started. `event.buttons` on a mousedown already includes the button being
  // pressed, so a full chord match here means both are physically down.
  for (const consumer of chordConsumers) {
    if ((event.buttons & consumer.mask) !== consumer.mask) continue
    suppress(event)
    // The anchor press already optimistically started a hold (we cannot see
    // the future). Discard it rather than letting it complete — otherwise
    // every palette open would also transcribe a fragment of audio.
    cancelActiveHold()
    chordClaimedGesture = true
    consumer.onFire()
    return
  }

  for (const consumer of holdConsumers) {
    if (consumer.mask !== mask) continue
    suppress(event)
    if (activeHold) return
    activeHold = consumer
    consumer.onPress()
    return
  }

  // A tracked button that is only a chord ANCHOR (not a hold, not a complete
  // chord yet) still gets suppressed, so the anchor press does not close an
  // editor tab or open a markdown link on its way to becoming a chord.
  for (const consumer of chordConsumers) {
    if ((consumer.anchorMask & mask) === 0) continue
    suppress(event)
    return
  }
}

function onUp(event: MouseEvent): void {
  // Decided on the bitmask, never event.button — see the header.
  if (chordClaimedGesture) {
    if (event.buttons === 0) chordClaimedGesture = false
    // Suppress the trailing releases of a chord so the completing button's
    // click/auxclick never reaches the app.
    if (isTrackedButton(event.button)) suppress(event)
    return
  }
  if (!activeHold) return
  if ((event.buttons & activeHold.mask) !== 0) return
  releaseActiveHold()
}

function onAuxClick(event: MouseEvent): void {
  // auxclick fires for non-primary buttons after the pointer pair and is what
  // Chromium routes to history navigation and open-in-new-tab. Cancelling
  // pointerdown does not reliably suppress it, so it gets its own pass.
  if (!isTrackedButton(event.button)) return
  suppress(event)
}

function onContextMenu(event: Event): void {
  // Only while a chord anchor is held. Suppressing contextmenu unconditionally
  // would cost Monaco's editor menu and the Explorer's file menu permanently;
  // scoping it to the anchor hold makes the cost last only as long as the
  // gesture. (There is no native Electron context menu in this app — those two
  // are the entire blast radius.)
  if (!anchorHeld) return
  event.preventDefault()
  event.stopPropagation()
}

// Tracked separately from `activeHold` because a chord anchor may not be bound
// to any hold consumer at all — the user can bind the chord without binding
// dictation.
let anchorHeld = false

function trackAnchor(event: MouseEvent): void {
  const mask = buttonToMask(event.button)
  if (mask === 0) return
  let matchesAnchor = false
  for (const consumer of chordConsumers) {
    if ((consumer.anchorMask & mask) !== 0) matchesAnchor = true
  }
  if (!matchesAnchor) return
  anchorHeld = (event.buttons & mask) !== 0
}

function releaseEverything(): void {
  // Window blur / tab hide: we will never see the up edge, so end the gesture
  // now. Biasing toward ending is deliberate — an interrupted dictation is
  // recoverable, a recording that never stops is not.
  cancelOrReleasePending()
  chordClaimedGesture = false
  anchorHeld = false
}

function cancelOrReleasePending(): void {
  // A blur mid-hold is a real release from the user's point of view: they said
  // their piece and switched away. Complete it rather than discarding it.
  releaseActiveHold()
}

function installListeners(): void {
  if (listenersInstalled) return
  listenersInstalled = true
  // Down needs BOTH pointerdown and mousedown: pointerdown fires only on the
  // 0 -> non-zero transition, so a button pressed while another is already held
  // emits mousedown alone. `activeHold`/`chordClaimedGesture` make the handler
  // idempotent when both fire for the same press.
  window.addEventListener('pointerdown', onDownTracked, true)
  window.addEventListener('mousedown', onDownTracked, true)
  window.addEventListener('pointerup', onUpTracked, true)
  window.addEventListener('mouseup', onUpTracked, true)
  window.addEventListener('pointercancel', releaseEverything, true)
  window.addEventListener('auxclick', onAuxClick, true)
  window.addEventListener('contextmenu', onContextMenu, true)
  window.addEventListener('blur', releaseEverything)
  document.addEventListener('visibilitychange', onVisibilityChange)
}

function removeListeners(): void {
  if (!listenersInstalled) return
  listenersInstalled = false
  window.removeEventListener('pointerdown', onDownTracked, true)
  window.removeEventListener('mousedown', onDownTracked, true)
  window.removeEventListener('pointerup', onUpTracked, true)
  window.removeEventListener('mouseup', onUpTracked, true)
  window.removeEventListener('pointercancel', releaseEverything, true)
  window.removeEventListener('auxclick', onAuxClick, true)
  window.removeEventListener('contextmenu', onContextMenu, true)
  window.removeEventListener('blur', releaseEverything)
  document.removeEventListener('visibilitychange', onVisibilityChange)
}

function onDownTracked(event: MouseEvent): void {
  trackAnchor(event)
  onDown(event)
}

function onUpTracked(event: MouseEvent): void {
  onUp(event)
  trackAnchor(event)
}

function onVisibilityChange(): void {
  if (document.visibilityState === 'hidden') releaseEverything()
}

function syncListeners(): void {
  if (holdConsumers.size === 0 && chordConsumers.size === 0) {
    removeListeners()
    return
  }
  installListeners()
}

export function registerHoldConsumer(consumer: HoldConsumer): () => void {
  holdConsumers.add(consumer)
  syncListeners()
  return () => {
    holdConsumers.delete(consumer)
    // Drain before unregistering. If the binding changes mid-hold, the up edge
    // for the OLD binding will never reach anyone.
    if (activeHold === consumer) {
      activeHold = null
      consumer.onRelease()
    }
    syncListeners()
  }
}

export function registerChordConsumer(consumer: ChordConsumer): () => void {
  chordConsumers.add(consumer)
  syncListeners()
  return () => {
    chordConsumers.delete(consumer)
    syncListeners()
  }
}

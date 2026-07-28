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
//
//      This is ALSO why `suppress()` refuses to preventDefault a pointerdown:
//      doing so sets Chromium's PREVENT MOUSE EVENT flag for the whole pointer
//      and drops the compat mousedown/mouseup stream the chord depends on. The
//      captured probe data shows exactly that — a middle press whose
//      pointerdown was cancelled produced pointerdown/pointerup/auxclick and
//      NO mousedown at all.
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
 * is ours at all: an untracked button is never touched.
 *
 * BE HONEST ABOUT THE COST, because it is easy to misread this as cheaper than
 * it is. A *bound* button is suppressed on EVERY press, not only when a gesture
 * completes — the anchor of a chord has to be swallowed the moment it goes
 * down, since we cannot know whether the second button is coming. So binding
 * the chord kills plain middle-click app-wide: middle-click-to-close in the
 * editor tab strip, middle-click-to-open on rendered markdown links, and
 * middle/right forwarding to any xterm pane whose child process has enabled
 * mouse reporting (an agent TUI using the mouse will not see those buttons).
 *
 * That is a deliberate shipping decision, not an oversight, and it is the
 * reason both bindings default to off. What we do NOT do is touch buttons no
 * consumer asked for.
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
  // NEVER preventDefault a `pointerdown`. Cancelling it sets Chromium's
  // PREVENT MOUSE EVENT flag for the whole pointer, which drops the compat
  // `mousedown`/`mouseup` stream for the REST of the gesture — including the
  // chord's completing press, which arrives only as a `mousedown`. Suppressing
  // the anchor that way would make the chord undetectable, silently, exactly
  // when the anchor is also a bound button.
  //
  // stopPropagation alone is enough on pointerdown: it keeps the event away
  // from every app handler without touching the compat stream. The default
  // action (which is what we actually need to cancel — history navigation,
  // middle-click-to-close) is cancelled on the `mousedown` that follows.
  if (event.type !== 'pointerdown') event.preventDefault()
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

  // A chord already owns this gesture; ignore every further press until every
  // button is up. Two distinct bugs live here without this guard:
  //   1. Tapping the completing button again while the anchor stays held
  //      re-matches the full mask and fires the chord a second time, which
  //      also resets an open palette sub-mode.
  //   2. A THIRD tracked button could start a hold whose release `onUp` then
  //      swallows (it returns early while the flag is set), leaving a
  //      recording running with `activeHold` pinned — after which the guard
  //      at the hold branch rejects every future press forever.
  if (chordClaimedGesture) {
    suppress(event)
    return
  }

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
    // Suppress the trailing releases of a chord so the completing button's
    // click/auxclick never reaches the app. Note both `pointerup` and the
    // `mouseup` behind it are suppressed: clearing the flag on the first and
    // returning would let the second escape, and a mouse-reporting xterm
    // would see a release whose press it never saw.
    if (isTrackedButton(event.button)) suppress(event)
    if (event.buttons === 0) chordClaimedGesture = false
    // Deliberately NO early return — fall through to the hold check below.
    // Returning here was a real stuck-microphone path: a hold started while
    // the flag was set would never see its own release.
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
  // Recomputed from `event.buttons` on EVERY mouse event, not only on an
  // anchor's own down/up. Deriving it solely from anchor transitions desynced
  // after a blur: `releaseEverything` clears the flag, and if the user came
  // back still holding the anchor, nothing ever set it true again — so the
  // chord would fire while `onContextMenu` believed no anchor was held and let
  // the native menu through.
  let held = false
  for (const consumer of chordConsumers) {
    if ((event.buttons & consumer.anchorMask) !== 0) held = true
  }
  anchorHeld = held
}

function releaseEverything(): void {
  // Window blur / tab hide: we will never see the up edge, so end the gesture
  // now. Biasing toward ending is deliberate — an interrupted dictation is
  // recoverable, a recording that never stops is not.
  //
  // A blur mid-hold is a real release from the user's point of view: they said
  // their piece and switched away. Complete it rather than discarding it.
  releaseActiveHold()
  chordClaimedGesture = false
  anchorHeld = false
}

function abortEverything(): void {
  // `pointercancel` is not a release — the input stream was torn away, so
  // whatever the user was mid-way through saying is not something to finalize
  // and paste. Discard instead. (Blur above is the opposite case and
  // deliberately completes.)
  cancelActiveHold()
  chordClaimedGesture = false
  anchorHeld = false
}

function installListeners(): void {
  if (listenersInstalled) return
  listenersInstalled = true
  // Down needs BOTH pointerdown and mousedown: pointerdown fires only on the
  // 0 -> non-zero transition, so a button pressed while another is already
  // held emits mousedown alone.
  //
  // Both CAN fire for the same first press (we no longer cancel pointerdown,
  // so the compat mousedown survives), and `activeHold`/`chordClaimedGesture`
  // make the second one a no-op. What must not be assumed is the reverse — the
  // probe data shows a cancelled pointerdown produces no mousedown at all,
  // which is precisely the behaviour `suppress()` now avoids triggering.
  window.addEventListener('pointerdown', onDownTracked, true)
  window.addEventListener('mousedown', onDownTracked, true)
  window.addEventListener('pointerup', onUpTracked, true)
  window.addEventListener('mouseup', onUpTracked, true)
  window.addEventListener('pointercancel', abortEverything, true)
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
  window.removeEventListener('pointercancel', abortEverything, true)
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

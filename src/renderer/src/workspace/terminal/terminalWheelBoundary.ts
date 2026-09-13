/**
 * Keep an exhausted terminal scroll gesture from moving its surrounding panel.
 *
 * WHY a bubbling native listener, not capture or a custom xterm wheel handler:
 * xterm must get first refusal. Normal scrollback consumes the gesture itself;
 * alternate-screen programs may translate it into arrows or mouse reports.
 * Intercepting before xterm would break those protocols. At a scroll boundary,
 * however, xterm's custom scrollbar leaves the event unconsumed and Chromium
 * scrolls the nearest native ancestor (notably the inline terminal's debug
 * panel).
 *
 * WHY not CSS `overscroll-behavior-y: contain` on the host (considered, never
 * probed): the first version of this comment rejected CSS because
 * `overscroll-behavior` "only applies to native scroll containers". That was
 * the pre-Chrome-144 rule. Since Chrome 144 it applies to every scroll
 * container, including a non-scrollable `overflow: hidden` one
 * (https://developer.chrome.com/release-notes/144), and Electron 43.1.1 ships
 * Chrome 150. All three terminal hosts are already `overflow-hidden`, so a
 * one-class CSS rule MIGHT contain the chaining with no JS at all. Nobody has
 * tried it in a real browser, and agents cannot (it needs Electron). The JS
 * path stays because every claim below is verified against the pinned xterm's
 * wheel handling, and because it cancels only what xterm and the provider
 * already refused, so their first refusal is preserved by construction. Swap
 * to CSS only after a user-run variant of scripts/smoke-terminal-wheel.mjs
 * (host styled `overscroll-behavior-y: contain`, this helper not attached)
 * shows ALL of: the parent stays at 0px at the boundary for plain and Alt
 * wheel; plain and Alt fast scrollback still move the terminal; output
 * appended while scrolled keeps the viewed line; alternate-screen wheel still
 * sends arrows; SGR mouse reports still arrive. Then delete this file rather
 * than keeping both owners of the same decision.
 *
 * WHY this is still needed on the pinned @xterm/xterm 6.1.0-beta.304 (#873),
 * re-verified against its shipped bundle, not just the sources (2026-09-12):
 * - Ordering. Every xterm wheel listener sits at or below the `.xterm` element
 *   that `open()` appends to this host: the viewport's scrollable wrapper
 *   (src/browser/scrollable/scrollableElement.ts `_setListeningToMouseWheel`)
 *   and MouseService's handlers on `.xterm` (src/browser/services/
 *   MouseService.ts `bindMouse`). A bubbling host listener therefore always
 *   runs last, after xterm has decided.
 * - Scrollback. `_handleMouseWheel` consumes (preventDefault+stopPropagation)
 *   only when it actually moved, or when `alwaysConsumeMouseWheel` /
 *   `consumeMouseWheelIfScrollbarIsNeeded` are set. Both default to false and
 *   src/browser/Viewport.ts sets neither, so a wheel past the top or bottom
 *   bubbles out uncanceled. That is exactly the leak this helper closes.
 * - Alternate screen / mouse reporting. MouseService `_handlePassiveWheel`
 *   turns wheel into arrow keys only when `!buffer.hasScrollback` (alt buffer)
 *   and `_handleWheel` sends mouse-protocol reports; both consume the event, so
 *   `defaultPrevented` below already hands those gestures back to xterm.
 * WHEN BUMPING XTERM (or @xterm/addon-webgl, or Electron): if Viewport starts
 * passing either consume option, or the listeners stop living under `.xterm`,
 * re-check this file. With a consume option on, this helper is redundant:
 * delete it rather than stacking two owners of the same decision. Then have
 * the user run `node scripts/smoke-terminal-wheel.mjs` and
 * `node scripts/smoke-terminal-wheel.mjs --control`; that probe is the only
 * check in the repo that exercises native Chromium scroll chaining against
 * the real xterm, and agents never launch it themselves.
 *
 * WHY Alt is NOT exempt while Ctrl, Meta and Shift are: Alt+wheel is xterm's
 * own fast-scroll gesture, not a browser one. `_handleMouseWheel` multiplies
 * both deltas by `fastScrollSensitivity` while Alt is held (typings/xterm.d.ts
 * "used for fast scrolling when `Alt` is held", default 5), and at a boundary
 * it leaves that event unconsumed exactly like a plain wheel. The first
 * version of this helper exempted Alt as a "browser gesture", so a fast
 * scroll that reached the top or bottom went on to move the debug panel: the
 * #791 symptom for Alt users (PR #792 review). Alt never reaches this listener
 * in the alt buffer or under mouse reporting, because MouseService consumes it
 * there like any other wheel.
 * Ctrl and Meta are a POLICY choice, not xterm behavior. xterm does not filter
 * either one: while the viewport can move, `_handleMouseWheel` consumes a Ctrl
 * or Meta wheel as ordinary scrollback before this listener runs. Only an
 * unconsumed Ctrl/Meta wheel reaches the helper, and the helper deliberately
 * leaves that one to the browser: Ctrl+wheel is Chromium's pinch/zoom channel
 * and Meta+wheel belongs to platform navigation/zoom.
 * Shift is exempt by policy too, as horizontal intent this boundary does not
 * own. Off macOS, xterm's `shiftConvert` turns a Shift wheel horizontal. On
 * macOS it does not, and the OS normally converts Shift+mouse-wheel into
 * horizontal deltas, which the axis check passes anyway. A macOS Shift wheel
 * that still arrives vertical (possibly from a trackpad) is scrolled
 * vertically by xterm, so at a boundary it CAN chain to the parent exactly as
 * Alt used to. That residual gap is unverified; do not narrow the Shift bail
 * without probe evidence. The horizontal-delta check matches xterm's
 * predominant-axis rule, where a tie counts as vertical.
 *
 * WHY `!event.cancelable` bails instead of fighting: Chromium latches a wheel
 * scroll sequence to one target, and "with latching enabled only the first
 * wheel event of a scrolling sequence is cancellable"; if that first event is
 * not canceled, the rest of the sequence arrives non-cancelable
 * (https://github.com/sahel-sh/Wheel-scroll-latching-and-async-wheel-events/blob/master/Explainer.md).
 * A gesture that started on the parent panel keeps scrolling the parent; only
 * gestures that begin over the terminal are ours. This path is reasoned from
 * Chromium's documented behavior, NOT probe-verified: the smoke probe sends
 * discrete synthetic wheel events without gesture phases, so it never builds a
 * latched sequence.
 *
 * Cancel only that remaining browser default. Do not synthesize input, move the
 * viewport, refresh the renderer, stop application engagement listeners, or
 * schedule React work. This boundary owns ordinary vertical terminal
 * scrolling (plain or Alt-accelerated), not every gesture made over the pane.
 */
export function attachTerminalWheelBoundary(container: HTMLElement): { dispose(): void } {
  const onWheel = (event: WheelEvent): void => {
    if (event.defaultPrevented || !event.cancelable) return
    if (event.ctrlKey || event.metaKey || event.shiftKey) return
    if (event.deltaY === 0 || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return
    event.preventDefault()
  }
  container.addEventListener('wheel', onWheel, { passive: false })
  return { dispose: () => container.removeEventListener('wheel', onWheel) }
}

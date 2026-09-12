/**
 * Keep an exhausted terminal scroll gesture from moving its surrounding panel.
 *
 * WHY a bubbling native listener, not capture or a custom xterm wheel handler:
 * xterm must get first refusal. Normal scrollback consumes the gesture itself;
 * alternate-screen programs may translate it into arrows or mouse reports.
 * Intercepting before xterm would break those protocols. At a scroll boundary,
 * however, xterm's custom scrollbar leaves the event unconsumed and Chromium
 * scrolls the nearest native ancestor (notably the inline terminal's debug
 * panel). CSS overscroll rules on the host do not govern that custom scrollbar:
 * `overscroll-behavior` only applies to native scroll containers, and xterm's
 * viewport scrolls itself without being one.
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
 * WHEN BUMPING XTERM: if Viewport starts passing either consume option, or the
 * listeners stop living under `.xterm`, re-check this file. With a consume
 * option on, this helper is redundant: delete it rather than stacking two
 * owners of the same decision.
 *
 * WHY `!event.cancelable` bails instead of fighting: Chromium delivers the rest
 * of a wheel gesture non-cancelable once its first event went uncanceled
 * (latched async wheel). A gesture that started on the parent panel keeps
 * scrolling the parent; only gestures that begin over the terminal are ours.
 *
 * Cancel only that remaining browser default. Do not synthesize input, move the
 * viewport, refresh the renderer, stop application engagement listeners, or
 * schedule React work. Horizontal and modified gestures remain available for
 * browser/platform navigation and zoom; this boundary owns ordinary vertical
 * terminal scrolling, not every gesture made over the pane.
 */
export function attachTerminalWheelBoundary(container: HTMLElement): { dispose(): void } {
  const onWheel = (event: WheelEvent): void => {
    if (event.defaultPrevented || !event.cancelable) return
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
    if (event.deltaY === 0 || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return
    event.preventDefault()
  }
  container.addEventListener('wheel', onWheel, { passive: false })
  return { dispose: () => container.removeEventListener('wheel', onWheel) }
}

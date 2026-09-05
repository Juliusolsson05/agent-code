/**
 * Keep an exhausted terminal scroll gesture from moving its surrounding panel.
 *
 * WHY a bubbling native listener, not capture or a custom xterm wheel handler:
 * xterm must get first refusal. Normal scrollback consumes the gesture itself;
 * alternate-screen programs may translate it into arrows or mouse reports.
 * Intercepting before xterm would break those protocols. At a scroll boundary,
 * however, xterm's custom scrollbar leaves the event unconsumed and Chromium
 * scrolls the nearest native ancestor (notably the inline terminal's debug
 * panel). CSS overscroll rules on the host do not govern that custom scrollbar.
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

// A split is useful only when BOTH panes have room. The old aspect-ratio
// heuristic stacked short lanes and its strip fallback made Open a no-op.
// User preference is left/right only: narrow surfaces show the browser at
// full size, with an explicit return to the still-mounted agent.
export const MIN_AGENT_WIDTH = 280
export const MIN_BROWSER_WIDTH = 320
export const SPLITTER_WIDTH = 4
export const MIN_SPLIT_WIDTH = MIN_AGENT_WIDTH + MIN_BROWSER_WIDTH + SPLITTER_WIDTH
export const MIN_SPLIT_HEIGHT = 180
export type PocketLayout = 'side' | 'browser' | 'strip'

export function pocketLayout(size: { width: number; height: number }, view: 'open' | 'collapsed', _surface: 'lane' | 'spotlight'): PocketLayout {
  if (view === 'collapsed') return 'strip'
  return size.width >= MIN_SPLIT_WIDTH && size.height >= MIN_SPLIT_HEIGHT ? 'side' : 'browser'
}

/** Use pixels after measurement; percentages otherwise let the divider steal
 * space from the minimums. Clamp the displayed size without overwriting the
 * user's preferred fraction when a window temporarily becomes narrower. */
export function pocketSplitWidth(width: number, fraction = 0.5): number {
  const available = Math.max(0, width - SPLITTER_WIDTH)
  return Math.max(MIN_BROWSER_WIDTH, Math.min(available - MIN_AGENT_WIDTH, available * fraction))
}

/**
 * Where the page sits inside its slot when a device viewport is emulated: the
 * guest is sized to the device's CSS viewport and scaled DOWN to fit (never
 * up), centred. Sizing the element itself — instead of CDP device-metrics
 * emulation — keeps the page's own layout width real, so the user and the
 * agent see the same breakpoints (T3 Code's resize bugs #3712/#8469 came from
 * the two disagreeing).
 */
export function fitViewport(slot: { width: number; height: number }, viewport: { width: number; height: number } | null): { width: number; height: number; scale: number; offsetX: number; offsetY: number } {
  if (!viewport) return { width: slot.width, height: slot.height, scale: 1, offsetX: 0, offsetY: 0 }
  const scale = Math.min(1, slot.width / viewport.width, slot.height / viewport.height)
  const shownW = viewport.width * scale
  const shownH = viewport.height * scale
  return { width: viewport.width, height: viewport.height, scale, offsetX: Math.max(0, (slot.width - shownW) / 2), offsetY: Math.max(0, (slot.height - shownH) / 2) }
}

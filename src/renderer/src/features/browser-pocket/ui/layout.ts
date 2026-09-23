// How an open pocket shares a lane with its agent (spec §4.1/§4.2).
//
// A lane can be a tenth of a row. Forcing a split there gives two useless
// panes — Cursor's most repeated browser complaint was a ~200 px browser
// panel. Below the threshold the lane keeps the strip; Spotlight always splits.

export const MIN_SPLIT_WIDTH = 520
export const MIN_SPLIT_HEIGHT = 420
/** Wider than 1.3× its height ⇒ side by side; otherwise stacked. */
export const SIDE_BY_SIDE_ASPECT = 1.3

export type PocketLayout = 'side' | 'stacked' | 'strip'

export function pocketLayout(size: { width: number; height: number }, view: 'open' | 'collapsed', surface: 'lane' | 'spotlight'): PocketLayout {
  if (view === 'collapsed') return 'strip'
  if (surface === 'spotlight') return 'side'
  // Before the first measurement (0×0) show the strip rather than flash a split.
  if (size.width < MIN_SPLIT_WIDTH && size.height < MIN_SPLIT_HEIGHT) return 'strip'
  if (size.width < MIN_SPLIT_WIDTH) return 'stacked'
  if (size.height < MIN_SPLIT_HEIGHT) return 'side'
  return size.width > size.height * SIDE_BY_SIDE_ASPECT ? 'side' : 'stacked'
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

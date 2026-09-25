// Placement reconciliation: many slots → one placement per pocket
// (decomposition Stage 4, the isolated hard part #1).
//
// WHY this is its own layer: a pocket can be wanted in several places at once —
// its lane, a mirrored second lane showing the same agent, and Spotlight, which
// renders a SECOND leaf while the whole stage stays mounted under display:none
// (MainSurface.tsx). If each of those consumers decided for itself whether to
// show the page, the bugs would look like rendering bugs (two guests, a page
// that "randomly" reloads, flicker on Spotlight toggle) while actually being
// ownership bugs. Exactly one function decides; slots only REPORT, the host
// only APPLIES.
//
// Allowed importers: placement/*, ui/BrowserPocketHost.tsx (resolve side),
// ui/PocketSlot.tsx (report side). Nothing else — see placement.isolation.test.ts.

export type SlotSurface = 'spotlight' | 'lane'
export type Rect = { x: number; y: number; width: number; height: number }

export type SlotReport = {
  slotKey: string
  surface: SlotSurface
  /** Lane index for lane slots; null in Spotlight. Tie-break only. */
  laneIndex: number | null
  /** The lane is the focused lane (or this is Spotlight). */
  focused: boolean
  /** Composed visibility: false inside the hidden stage, Global Editor, etc. */
  visible: boolean
  /** Unfocused lanes are dimmed by an overlay the guest does not sit under. */
  dimmed: boolean
  rect: Rect | null
  /** The nearest clipping ancestor (the lane box). The guest is fixed-position
   * in the host layer, so it cannot inherit the lane's overflow:hidden. */
  clip: Rect | null
}

export type Placement =
  | { mode: 'shown'; slotKey: string; rect: Rect; clip: Rect | null; dimmed: boolean }
  /** Alive but not visible. `mustPaint` = an agent or a screenshot needs the
   * page to keep compositing, so the host parks it INSIDE the window behind the
   * app; otherwise far off-screen. `size` is the last shown size so the page
   * does not reflow to a different width while parked. */
  | { mode: 'parked'; size: { width: number; height: number }; mustPaint: boolean }
  /** No guest at all (never shown yet, or slept by the sleep policy). */
  | { mode: 'absent' }

export type PlacementInput = {
  slots: SlotReport[]
  /** True once the guest exists. A pocket that was never visible has none. */
  alive: boolean
  /** An agent action / screenshot / picker is in flight. */
  mustPaint: boolean
  lastSize: { width: number; height: number } | null
}

/** Default size for a guest that must paint before it has ever been shown
 * (agent opened a collapsed pocket). 1280×800 matches T3's hidden default and
 * a common laptop viewport, so layout-sensitive snapshots look normal. */
export const DEFAULT_PARKED_SIZE = { width: 1280, height: 800 }

export function pickWinningSlot(slots: SlotReport[]): SlotReport | null {
  let best: SlotReport | null = null
  for (const slot of slots) {
    if (!slot.visible || !slot.rect || slot.rect.width < 1 || slot.rect.height < 1) continue
    if (!best || rank(slot) < rank(best) || (rank(slot) === rank(best) && (slot.laneIndex ?? 0) < (best.laneIndex ?? 0))) best = slot
  }
  return best
}

// Spotlight first: when it is open the stage is hidden anyway, and it is the
// place the user asked to look. Then the focused lane. Then the lowest lane
// index, so a mirrored pair resolves the same way on every render.
function rank(slot: SlotReport): number {
  return slot.surface === 'spotlight' ? 0 : slot.focused ? 1 : 2
}

export function resolvePlacement(input: PlacementInput): Placement {
  const winner = pickWinningSlot(input.slots)
  if (winner) return { mode: 'shown', slotKey: winner.slotKey, rect: winner.rect!, clip: winner.clip, dimmed: winner.dimmed }
  // Nothing visible. An agent may still need a painting guest even if the
  // user never opened the pocket: that is how browser_open works on a
  // collapsed pocket without popping a panel over the user's work.
  if (input.alive || input.mustPaint) {
    return { mode: 'parked', size: input.lastSize ?? DEFAULT_PARKED_SIZE, mustPaint: input.mustPaint }
  }
  return { mode: 'absent' }
}

/** What a given slot should draw: the live page lands over it, or it is a
 * visible mirror of a page shown elsewhere (placeholder), or it is hidden. */
export function slotRole(slots: SlotReport[], slotKey: string): { role: 'live' } | { role: 'mirror'; shownIn: SlotReport } | { role: 'hidden' } {
  const self = slots.find(s => s.slotKey === slotKey)
  if (!self || !self.visible) return { role: 'hidden' }
  const winner = pickWinningSlot(slots)
  if (!winner || winner.slotKey === slotKey) return { role: 'live' }
  return { role: 'mirror', shownIn: winner }
}

/** Intersection used as the guest's clip; null when the slot has no clip. */
export function intersect(a: Rect, b: Rect | null): Rect | null {
  if (!b) return null
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const r = Math.min(a.x + a.width, b.x + b.width)
  const btm = Math.min(a.y + a.height, b.y + b.height)
  return { x, y, width: Math.max(0, r - x), height: Math.max(0, btm - y) }
}

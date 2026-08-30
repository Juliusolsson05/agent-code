import { screen } from 'electron'

import type { WindowBounds } from '@main/storage/workspaceFile.js'
import type { WindowGeometry } from '@main/storage/workspaceFileStore.js'
import { getBrowserWindow } from '@main/window/windowRegistry.js'

// Deciding whether persisted window bounds are still usable.
//
// WHY this validation exists at all: the entire point of the feature is that a
// window lives on a second monitor, which makes "that monitor is not attached
// right now" the COMMON case rather than an edge case — laptops get undocked
// every day. Restoring saved bounds blindly puts the window at coordinates no
// display covers, and macOS will happily place it there: invisible, unfocusable
// by mouse, and indistinguishable from the app failing to launch.
//
// The rule is deliberately permissive rather than "must be fully on-screen". A
// window the user deliberately parked half off the edge should come back where
// they left it; only a window with no meaningful visible area is relocated.

/** Minimum overlap, in CSS pixels, on BOTH axes for bounds to count as usable.
 *  Roughly a title bar plus the traffic lights — enough to grab and drag. */
const MIN_VISIBLE_OVERLAP_PX = 80

export type WorkArea = { x: number; y: number; width: number; height: number }

function overlap(a: WindowBounds, b: WorkArea): { x: number; y: number } {
  return {
    x: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
    y: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
  }
}

/**
 * Pure core: are these bounds visible enough on at least one of these work
 * areas to restore verbatim?
 *
 * Split from the Electron lookup so the display-change behavior is testable
 * without a real `screen` module — the failure this guards against only ever
 * reproduces with a monitor unplugged, which no deterministic suite can stage.
 */
export function boundsAreUsable(
  bounds: WindowBounds,
  workAreas: readonly WorkArea[],
): boolean {
  return workAreas.some(area => {
    const { x, y } = overlap(bounds, area)
    return x >= MIN_VISIBLE_OVERLAP_PX && y >= MIN_VISIBLE_OVERLAP_PX
  })
}

/**
 * Persisted bounds if they still land on an attached display, else null —
 * which lets Electron place the window with its default centering rather than
 * inventing a position here.
 */
export function restorableBounds(bounds: WindowBounds | null): WindowBounds | null {
  if (!bounds) return null
  const workAreas = screen.getAllDisplays().map(display => display.workArea)
  return boundsAreUsable(bounds, workAreas) ? bounds : null
}

/**
 * Read a window's current geometry for persistence.
 *
 * WHY `getNormalBounds` and not `getBounds`: a maximized or full-screened
 * window reports screen-sized bounds, and restoring those on a smaller display
 * would strand it off-screen. The normal bounds are what "put it back where it
 * was" actually means, and `fullScreen` is recorded separately so the state is
 * restored without the geometry lying about it.
 */
export function captureWindowGeometry(windowId: string): WindowGeometry {
  const window = getBrowserWindow(windowId)
  if (!window) return { bounds: null, displayId: null, fullScreen: false }
  const bounds = window.getNormalBounds()
  let displayId: number | null = null
  try {
    displayId = screen.getDisplayMatching(bounds).id
  } catch {
    // The display list can be momentarily unavailable during a monitor change.
    // Restore validates against attached displays anyway, so a null hint costs
    // nothing.
  }
  return { bounds, displayId, fullScreen: window.isFullScreen() }
}

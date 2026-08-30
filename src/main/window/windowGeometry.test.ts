import { describe, expect, it, vi } from 'vitest'

// The module reaches Electron for the live display list and the registry for
// the window handle; neither is involved in the pure predicate under test.
vi.mock('electron', () => ({ screen: { getAllDisplays: () => [], getDisplayMatching: () => ({ id: 0 }) } }))
vi.mock('@main/window/windowRegistry.js', () => ({ getBrowserWindow: () => null }))

const { boundsAreUsable } = await import('@main/window/windowGeometry.js')

// Restoring a window onto a display that is no longer attached puts it at
// coordinates nothing covers: invisible, unfocusable by mouse, and
// indistinguishable from the app failing to launch. For a feature whose entire
// point is a window on a second monitor, an undocked laptop is the common case.

const LAPTOP = { x: 0, y: 0, width: 1512, height: 916 }
const EXTERNAL = { x: 1512, y: 0, width: 2560, height: 1440 }

describe('restorable window bounds', () => {
  it('accepts bounds on a still-attached display', () => {
    expect(boundsAreUsable({ x: 1600, y: 100, width: 1400, height: 900 }, [LAPTOP, EXTERNAL]))
      .toBe(true)
  })

  it('rejects bounds whose display is gone', () => {
    // Same window, external monitor unplugged. Everything about the saved
    // bounds is still valid-looking; only the display list changed.
    expect(boundsAreUsable({ x: 1600, y: 100, width: 1400, height: 900 }, [LAPTOP]))
      .toBe(false)
  })

  it('keeps a window the user deliberately parked half off the edge', () => {
    // The rule is "enough visible to grab", not "fully on-screen": a window
    // hanging off the right edge is a placement someone chose, and relocating it
    // on every launch would be its own bug.
    expect(boundsAreUsable({ x: 1300, y: 100, width: 1400, height: 900 }, [LAPTOP]))
      .toBe(true)
  })

  it('rejects a sliver too small to grab', () => {
    // 12px of overlap is not a window the user can drag back into view.
    expect(boundsAreUsable({ x: 1500, y: 100, width: 1400, height: 900 }, [LAPTOP]))
      .toBe(false)
  })

  it('rejects a window that is horizontally visible but vertically off-screen', () => {
    // Both axes have to clear the threshold. Checking area, or either axis,
    // would accept a window whose title bar sits below the dock.
    expect(boundsAreUsable({ x: 100, y: 900, width: 1400, height: 900 }, [LAPTOP]))
      .toBe(false)
  })

  it('rejects everything when no display is attached', () => {
    expect(boundsAreUsable(LAPTOP, [])).toBe(false)
  })
})

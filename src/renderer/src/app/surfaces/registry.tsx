import type { SurfaceEntry } from './types'
import { CaffeinateToastSurface } from '@renderer/features/caffeinate/surfaces/CaffeinateToastSurface'

// The surface registry (issue #494). Adding a surface = write a wrapper
// in the owning feature's surfaces/ folder + add ONE import + ONE array
// entry here. App.tsx is never edited.
//
// ORDER MATTERS within each array: it is the DOM sibling order, which
// decides paint order when z-indexes tie. The order below is the exact
// order App.tsx rendered these surfaces before the extraction — keep new
// entries at the END unless you have a stacking reason and write it down.

/** Rendered at the app root, after the overlays. */
export const modalSurfaces: SurfaceEntry[] = []

/** Rendered at the app root, after the main row, before the modals. */
export const overlaySurfaces: SurfaceEntry[] = [
  { id: 'caffeinate-toast', Component: CaffeinateToastSurface },
]

/** Rendered INSIDE the main flex row, as siblings after <main>. */
export const sidePanelSurfaces: SurfaceEntry[] = []

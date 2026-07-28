import { modalSurfaces } from './registry'
import { sortSurfacesByLayer } from './types'

export function GlobalModals() {
  // Sorted by layer before render. First-party entries omit `layer`, so the stable
  // sort leaves their documented order untouched; an extension-contributed surface
  // (EXTENSION_SURFACE_LAYER) is lifted into its own band above the first-party
  // stack instead of tie-breaking into it. See SurfaceEntry.layer.
  return (
    <>
      {sortSurfacesByLayer(modalSurfaces).map(entry => (
        <entry.Component key={entry.id} />
      ))}
    </>
  )
}

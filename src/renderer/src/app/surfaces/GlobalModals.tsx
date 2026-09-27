import { modalSurfaces } from './registry'
import { sortSurfacesByLayer } from './types'

export function GlobalModals() {
  // Sorted by layer before render. First-party entries omit `layer`, so the stable
  // sort leaves their documented order untouched. This orders RENDER only:
  // dialogs paint by open order within LAYERS.dialog (see SurfaceEntry.layer).
  return (
    <>
      {sortSurfacesByLayer(modalSurfaces).map(entry => (
        <entry.Component key={entry.id} />
      ))}
    </>
  )
}

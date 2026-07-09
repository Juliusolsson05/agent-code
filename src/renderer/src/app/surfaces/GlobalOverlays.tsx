import { overlaySurfaces } from './registry'

export function GlobalOverlays() {
  return (
    <>
      {overlaySurfaces.map(entry => (
        <entry.Component key={entry.id} />
      ))}
    </>
  )
}

import { modalSurfaces } from './registry'

export function GlobalModals() {
  return (
    <>
      {modalSurfaces.map(entry => (
        <entry.Component key={entry.id} />
      ))}
    </>
  )
}

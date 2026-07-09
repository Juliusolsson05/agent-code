import { sidePanelSurfaces } from './registry'

export function SidePanels() {
  return (
    <>
      {sidePanelSurfaces.map(entry => (
        <entry.Component key={entry.id} />
      ))}
    </>
  )
}

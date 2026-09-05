import { useEffect, useRef, useSyncExternalStore } from 'react'
import { paletteRequests } from '../paletteRequests'

export function usePaletteRequest(ui: {
  visible: boolean; mode: string; query: string; selectedIndex: number
  commandIds: Array<string | null>; setQuery(value: string): void; setSelectedIndex(index: number): void
}) {
  const pending = useSyncExternalStore(paletteRequests.subscribe, paletteRequests.snapshot)
  const applied = useRef<string | null>(null)
  useEffect(() => {
    if (!pending || !ui.visible || ui.mode !== 'commands') return
    if (applied.current !== pending.id) {
      applied.current = pending.id
      ui.setQuery(pending.query)
      ui.setSelectedIndex(0)
      if (ui.query !== pending.query || ui.selectedIndex !== 0) return
    }
    if (ui.query !== pending.query) return
    const requested = pending.commandId ? ui.commandIds.indexOf(pending.commandId) : 0
    const index = Math.max(0, requested)
    if (ui.selectedIndex !== index) { ui.setSelectedIndex(index); return }
    // A scheduled frame is canceled if the query/rows/visibility change. The
    // result describes the committed list, never just a request to open it.
    const frame = requestAnimationFrame(() => paletteRequests.acknowledge(pending.id, {
      query: ui.query, selectedCommandId: ui.commandIds[index] ?? null,
      requestedSelectionFound: !pending.commandId || requested >= 0, visibleRows: ui.commandIds.length,
    }))
    return () => cancelAnimationFrame(frame)
  }, [pending, ui])
}

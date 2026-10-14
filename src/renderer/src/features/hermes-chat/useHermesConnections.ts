import { useEffect, useState } from 'react'

import type { HermesConnectionInfo } from '@shared/hermes/types'

/**
 * The Hermes connections as main reports them, live (#1482). Main broadcasts
 * every change to every window (src/main/ipc/hermes.ts), so Settings and every
 * pane header agree without polling. Null until the first answer.
 *
 * `enabled: false` subscribes to nothing: TileLeaf calls this for every agent
 * pane (hooks cannot be conditional), and only Hermes panes need the list.
 */
export function useHermesConnections(enabled = true): HermesConnectionInfo[] | null {
  const [connections, setConnections] = useState<HermesConnectionInfo[] | null>(null)
  useEffect(() => {
    if (!enabled) return
    let alive = true
    const unsubscribe = window.api.onHermesConnectionsChanged((next) => {
      if (alive) setConnections(next)
    })
    void window.api.hermesList().then((next) => {
      if (alive) setConnections((current) => current ?? next)
    }).catch(() => {
      if (alive) setConnections((current) => current ?? [])
    })
    return () => {
      alive = false
      unsubscribe()
    }
  }, [enabled])
  return connections
}

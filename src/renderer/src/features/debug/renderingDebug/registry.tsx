import {
  createContext,
  useContext,
  useId,
  useLayoutEffect,
  type ReactNode,
} from 'react'

import type { RenderDebugSnapshot } from './types'

// Render inputs can be large and sensitive, so this registry is intentionally
// renderer-memory-only. Nothing is persisted, sent through IPC, or copied until
// the developer explicitly presses a copy button in the inspector. Entries are
// tied to mounted boundaries and disappear on unmount or when the mode turns
// off, preventing old sessions from accumulating payload references forever.
const snapshots = new Map<string, RenderDebugSnapshot>()

export const RenderingDebugEnabledContext = createContext(false)

export function RenderingDebugProvider({
  enabled,
  children,
}: {
  enabled: boolean
  children: ReactNode
}) {
  return (
    <RenderingDebugEnabledContext.Provider value={enabled}>
      {children}
    </RenderingDebugEnabledContext.Provider>
  )
}

export function renderDebugSnapshot(id: string): RenderDebugSnapshot | null {
  return snapshots.get(id) ?? null
}

export function RenderDebugBoundary({
  snapshot,
  children,
}: {
  snapshot: RenderDebugSnapshot
  children: ReactNode
}) {
  const enabled = useContext(RenderingDebugEnabledContext)
  const reactId = useId()
  // React ids contain punctuation that is legal in an attribute but awkward in
  // selectors and copied DOM paths. The registry id is diagnostic identity,
  // not render identity, so a local alphanumeric normalization is sufficient.
  const id = `render-debug-${reactId.replace(/[^A-Za-z0-9_-]/g, '')}`

  useLayoutEffect(() => {
    if (!enabled) return
    snapshots.set(id, snapshot)
    return () => {
      snapshots.delete(id)
    }
  }, [enabled, id, snapshot])

  if (!enabled) return children

  // display:contents gives the inspector an ancestor carrying provenance
  // without introducing a box, spacing, flex child, or visual regression into
  // the feed. The red outline targets the exact clicked descendant via a fixed
  // overlay, so this metadata carrier never needs layout of its own. This is a
  // div rather than a span because feed renderers legitimately return block
  // content; using an inline metadata carrier would create invalid HTML around
  // those rows even though CSS removes the carrier's layout box.
  return (
    <div data-render-debug-id={id} style={{ display: 'contents' }}>
      {children}
    </div>
  )
}

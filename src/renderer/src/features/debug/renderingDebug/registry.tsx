import {
  Fragment,
  createContext,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from 'react'

import type { RenderDebugSnapshot } from './types'

// Render inputs can be large and sensitive, so this registry is intentionally
// renderer-memory-only. Nothing is persisted, sent through IPC, or copied until
// the developer explicitly presses a copy button in the inspector. Entries are
// tied to mounted boundaries and disappear on unmount or when the mode turns
// off, preventing old sessions from accumulating payload references forever.
type RegisteredBoundary = {
  snapshot: RenderDebugSnapshot
  start: HTMLSpanElement
  end: HTMLSpanElement
}

const boundaries = new Map<string, RegisteredBoundary>()

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

export function renderDebugBoundaryForElement(element: Element): {
  id: string
  snapshot: RenderDebugSnapshot
  html: string
} | null {
  const parent = element.parentNode
  if (!parent) return null
  const index = [...parent.childNodes].indexOf(element)
  if (index < 0) return null

  let winner: { id: string; boundary: RegisteredBoundary; range: Range } | null = null
  for (const [id, boundary] of boundaries) {
    if (!boundary.start.isConnected || !boundary.end.isConnected) continue
    const range = document.createRange()
    range.setStartAfter(boundary.start)
    range.setEndBefore(boundary.end)
    // `intersectsNode` is too broad here: clicking an outer row that CONTAINS
    // several nested boundaries would make every descendant look like a match.
    // Both node-boundary points must be inside the candidate range, which is
    // the marker-pair equivalent of the old `element.closest(boundary)` rule.
    if (range.comparePoint(parent, index) !== 0) continue
    if (range.comparePoint(parent, index + 1) !== 0) continue

    // Proper renderer boundaries nest rather than overlap. The candidate with
    // the latest start marker is therefore the innermost owner of the clicked
    // element, matching nearest-ancestor semantics without wrapping content.
    if (
      !winner ||
      (winner.boundary.start.compareDocumentPosition(boundary.start) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    ) {
      winner = { id, boundary, range }
    }
  }
  if (!winner) return null

  const container = document.createElement('div')
  container.append(winner.range.cloneContents())
  // Nested marker pairs are inspector implementation detail, not renderer
  // output. Removing them makes boundaryHtml the exact rendered subtree an
  // operator expects to save or paste, while boundaryId carries provenance.
  for (const marker of container.querySelectorAll(
    '[data-render-debug-start], [data-render-debug-end]',
  )) {
    marker.remove()
  }
  return {
    id: winner.id,
    snapshot: winner.boundary.snapshot,
    html: container.innerHTML,
  }
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
  const startRef = useRef<HTMLSpanElement>(null)
  const endRef = useRef<HTMLSpanElement>(null)
  // React ids contain punctuation that is legal in an attribute but awkward in
  // selectors and copied DOM paths. The registry id is diagnostic identity,
  // not render identity, so a local alphanumeric normalization is sufficient.
  const id = `render-debug-${reactId.replace(/[^A-Za-z0-9_-]/g, '')}`

  useLayoutEffect(() => {
    if (!enabled) return
    const start = startRef.current
    const end = endRef.current
    if (!start || !end) return
    boundaries.set(id, { snapshot, start, end })
    return () => {
      boundaries.delete(id)
    }
  }, [enabled, id, snapshot])

  // The keyed content Fragment is present in both modes. Toggling only the two
  // hidden sibling markers preserves every row subtree, so expanded details,
  // LazyEntry measurements, and scroll geometry survive entering the debugger.
  // When disabled, both markers are null and Fragments emit no DOM at all — the
  // normal renderer keeps its zero-metadata, zero-wrapper contract.
  return (
    <>
      {enabled ? <span ref={startRef} data-render-debug-start={id} hidden /> : null}
      <Fragment key="render-debug-content">{children}</Fragment>
      {enabled ? <span ref={endRef} data-render-debug-end={id} hidden /> : null}
    </>
  )
}

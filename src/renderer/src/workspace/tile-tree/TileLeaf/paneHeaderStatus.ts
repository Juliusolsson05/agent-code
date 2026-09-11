/**
 * The one rule for "the pane header's status strip is painted". PaneHeader
 * uses it for the fill and the `data-status-lit` hook. Callers that style slot
 * content by lit state (TAIL's `text-accent` would vanish on the accent fill)
 * call this same function. A caller recomputing `statusMode && isSessionLive`
 * inline would be the same kind of silent copy that caused #851, so any future
 * gating goes here and reaches both at once.
 *
 * WHY a module of its own rather than an export from PaneHeader.tsx: Vite's
 * React plugin only Fast Refreshes files that export nothing but components.
 * A helper exported beside PaneHeader would turn every header edit into a
 * full reload in dev.
 */
export function paneHeaderStatusLit(statusMode: boolean, isSessionLive: boolean): boolean {
  return statusMode && isSessionLive
}

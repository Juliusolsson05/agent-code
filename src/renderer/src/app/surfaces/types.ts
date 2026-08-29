import type { ComponentType } from 'react'

// One global modal / overlay / side panel (issue #494). Entries are
// aggregated in app/surfaces/registry.tsx — the same
// per-feature-file + one-aggregate-array shape as the command registry
// (features/command-palette/registry.ts), chosen over side-effect
// self-registration because an explicit import list is grep-able and
// compiler-checked.
//
// WHY there is no `when(state)` gate here (deviation from the issue's
// sketch): mount semantics are load-bearing and differ per surface.
// Most modals are ALWAYS mounted and receive `open` as a prop (internal
// state — e.g. a half-typed search query — survives close/reopen);
// panels are conditionally mounted. A registry-level `when` would force
// unmount-on-close onto every surface and silently reset that state.
// Each wrapper owns its own gating, replicating exactly what App.tsx
// did before the extraction.
export type SurfaceEntry = {
  /** Stable id — React key + grep handle. */
  id: string
  /**
   * Fully self-contained: reads its own open-flag/actions from
   * useAppStore and the workspace from useWorkspaceContext(). Takes no
   * props by design — props would put App back in the wiring business.
   */
  Component: ComponentType
  /**
   * Paint band. Entries are stably sorted by `layer` (default 0) before render,
   * so within a band the array order still decides sibling/paint order exactly as
   * before — every first-party entry omits `layer` and keeps its documented
   * position. The field exists so a NON-first-party surface (an extension one,
   * WS7) can be given a distinct band it cannot escape: it can never tie-break
   * into the first-party z-50 stack and silently reorder it, which is the exact
   * class of bug PR #505 hit. First-party entries should not set it.
   */
  layer?: number
}

/**
 * The band all extension-contributed surfaces sit in — above the first-party stack,
 * so an extension surface always paints over app chrome (it is user-initiated and
 * awaiting input) but cannot reorder first-party surfaces among themselves.
 */
export const EXTENSION_SURFACE_LAYER = 100

/** Stable sort by layer. First-party entries (layer undefined → 0) keep their exact
 *  authored order; only cross-band ordering is imposed. */
export function sortSurfacesByLayer(entries: readonly SurfaceEntry[]): SurfaceEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => (a.entry.layer ?? 0) - (b.entry.layer ?? 0) || a.index - b.index)
    .map(({ entry }) => entry)
}

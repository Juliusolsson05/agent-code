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
   * RENDER band, not a paint band. Entries are stably sorted by `layer`
   * (default 0) before render, which fixes their React render order and
   * nothing else. Corrected in #512's review: every modal is a Radix Dialog
   * in LAYERS.dialog that portals into <body> when it OPENS, so between open
   * dialogs the one opened last paints on top whatever its `layer`. A surface
   * that must really sit above the first-party dialogs needs its own z layer
   * in ui/layers.ts, and no entry has one today (EXTENSION_SURFACE_LAYER has
   * no consumer). First-party entries should not set this.
   */
  layer?: number
}

/**
 * The render band reserved for extension-contributed surfaces. It orders their
 * React render after the first-party entries; it does NOT make them paint
 * above an open first-party dialog (see SurfaceEntry.layer). No surface uses
 * it yet; giving extension surfaces a real paint band means adding a layer to
 * ui/layers.ts when the first one lands.
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

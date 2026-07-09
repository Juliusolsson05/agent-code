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
}

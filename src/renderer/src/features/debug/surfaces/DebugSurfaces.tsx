import { Suspense, lazy } from 'react'
import { useAppStore } from '@renderer/app-state/hooks'

// Issue #494 wants debug surfaces "out of the production render tree."
// We deliberately did NOT adopt the issue's stricter sketch (gate all
// debug panels on the dev-debug config): today debugPanelOpen /
// feedDebugPanelOpen / proxyDebugPanelOpen / htmlDebugPanelOpen open
// WITHOUT dev-debug (only DevDebugPanel requires it), and this refactor
// is behavior-preserving. Instead the whole group is a lazy chunk that
// is not even fetched until a panel flag first turns on — debug code
// leaves the prod tree AND the initial bundle, and users keep the exact
// panel access they have today. If a hard dev-debug gate is ever
// wanted, it is one `useDevDebugConfig` check added right here.
const DebugSurfacesImpl = lazy(() =>
  import('./DebugSurfacesImpl').then(m => ({ default: m.DebugSurfacesImpl })),
)

export function DebugSurfaces() {
  const anyOpen = useAppStore(
    state =>
      state.debugPanelOpen ||
      state.feedDebugPanelOpen ||
      state.proxyDebugPanelOpen ||
      state.htmlDebugPanelOpen ||
      state.renderingDebugMode ||
      state.devDebugPanelOpen,
  )
  if (!anyOpen) return null
  // fallback={null}: these are side panels; a flash of nothing for one
  // frame while the chunk loads is invisible next to the panel's own
  // data fetch.
  return (
    <Suspense fallback={null}>
      <DebugSurfacesImpl />
    </Suspense>
  )
}

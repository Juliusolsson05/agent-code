import type { AgentViewMode } from '@renderer/app-state/settings/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { TiledDispatchLayout } from '@renderer/workspace/dispatch/TiledDispatchLayout'

type Props = {
  workspace: Workspace
  agentViewMode: AgentViewMode
  showStatusMode: boolean
  showWorktreeBadges: boolean
}

// The workspace stage (#992): ragged rows of lanes, always. This used to be
// the render fork between classic Dispatch (sidebar + one agent view) and
// Tiled Dispatch; the unified layout promotes the tiled stage to THE
// workspace and the classic view — like the grid tree before it — is
// deleted rather than reconciled.
//
// Kept as a named wrapper (rather than importing TiledDispatchLayout at the
// call sites) because MainSurface, tests, and the placement-overlay
// composition already speak "DispatchLayout" — the seam stays stable while
// what it renders became the whole workspace.
export function DispatchLayout(props: Props) {
  return <TiledDispatchLayout {...props} />
}

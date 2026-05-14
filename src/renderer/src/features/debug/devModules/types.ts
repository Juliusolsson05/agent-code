import type { Workspace } from '@renderer/workspace/workspaceStore'
import type { SessionRuntime } from '@renderer/workspace/workspaceState'

export type DevDebugModuleProps = {
  workspace: Workspace
  sessionId: string
  runtime: SessionRuntime
  kind: string
}

export type DevDebugModule = {
  id: string
  title: string
  description?: string
  // WHY the contract stops at "render this component":
  // debug investigations are not predictable product surfaces. One
  // module may need a regex workbench, another may need IPC polling,
  // another may need a graph or a custom event buffer. Forcing a
  // shared schema or lifecycle API now would make the first weird bug
  // fight the host. The panel owns discovery and visibility only; the
  // module owns everything specific to its investigation.
  Component: React.ComponentType<DevDebugModuleProps>
}

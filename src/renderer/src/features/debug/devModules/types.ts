import type { Workspace } from '@renderer/workspace/workspaceStore'
import type { SessionRuntime } from '@renderer/workspace/workspaceState'

export type DevDebugModuleProps = {
  workspace: Workspace
  sessionId: string
  runtime: SessionRuntime
  kind: string
}

export type DevDebugCopyMode = 'useful' | 'full'

export type DevDebugModule = {
  id: string
  title: string
  description?: string
  // WHY copy serialization is part of the module contract, even though the
  // visual component could theoretically expose its own copy buttons:
  // investigation state is most useful when it can be pasted into an issue or
  // another agent verbatim. The host can provide consistent "copy useful/full"
  // controls for every module, but each module knows which data is signal and
  // which data is just megabytes of repeated runtime state. `useful` should trim
  // obvious bulk; `full` should include every relevant raw input the module can
  // reasonably expose without needing component-local UI state.
  buildCopyText?: (props: DevDebugModuleProps, mode: DevDebugCopyMode) => string
  // WHY the contract stops at "render this component":
  // debug investigations are not predictable product surfaces. One
  // module may need a regex workbench, another may need IPC polling,
  // another may need a graph or a custom event buffer. Forcing a
  // shared schema or lifecycle API now would make the first weird bug
  // fight the host. The panel owns discovery and visibility only; the
  // module owns everything specific to its investigation.
  Component: React.ComponentType<DevDebugModuleProps>
}

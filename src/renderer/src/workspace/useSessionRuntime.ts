import { useAppStore } from '@renderer/app-state/hooks'
import type { Workspace } from '@renderer/workspace/hook'

/** Subscribe only to this session. The fallback keeps supplied workspaces
 * usable in isolated render tests; production runtimes live in app-state. */
export function useSessionRuntime(workspace: Workspace, sessionId: string) {
  const runtime = useAppStore(state => state.workspaceRuntimes[sessionId])
  return runtime ?? workspace.getRuntime(sessionId)
}

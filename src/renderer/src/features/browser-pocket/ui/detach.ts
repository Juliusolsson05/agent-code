import type { Workspace } from '@renderer/workspace/workspaceStore'
import type { SessionId } from '@renderer/workspace/types'

import { detachPocket } from '../actions'

/**
 * Detach a pocket AND delete its own cookie jar.
 *
 * WHY clear on detach: the jar is named after the pocketId, and detaching
 * drops the pocketId — after that nothing in the app can reach the jar again,
 * so every detach leaked a persisted partition, and re-attaching made a new
 * empty one (review B #11). A 'project' jar is shared with other pockets and
 * is left alone. Closing a SESSION does not clear the jar: undo-close brings
 * the same pocketId back, logged in.
 */
export function detachAndForget(workspace: Workspace, sessionId: SessionId): void {
  const meta = workspace.state.sessions[sessionId]
  const pocket = meta?.browserPocket
  if (!pocket) return
  if (pocket.profile === 'lane') {
    void window.api.clearPocketStorage({ pocketId: pocket.pocketId, profile: 'lane' }).catch(() => {})
  }
  workspace.updateBrowserPocket(s => detachPocket(s, sessionId))
}

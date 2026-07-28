import { useMemo } from 'react'

import { useAppStore } from '@renderer/app-state/hooks'
import { createAppHostApi } from '@renderer/apps/api/createAppHostApi'
import { useExtensionHost } from '@renderer/apps/host/ExtensionHostProvider'
import { viewComponentFor } from '@renderer/apps/host/viewBridge'
import { useGlobalToast } from '@renderer/ui/GlobalToast'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import type { SessionId } from '@renderer/workspace/types'

/**
 * A contributed extension view mounted as a grid/dispatch PANE (WS6).
 *
 * The same frame the modal path uses (viewBridge → iframe sandbox), only the host
 * container is a tile leaf instead of a dialog. That reuse is the whole payoff of the
 * DOM-level ViewMount contract: an extension view is location-agnostic, so "in a
 * modal" and "in a pane" differ by their surrounding chrome and nothing else.
 *
 * The pane's `SessionMeta.extensionViewId` names which view to render. storage/close
 * are keyed by EXTENSION id (the part before the dot), matching AppHostSurface, so a
 * pane and a modal of the same extension share state; `ui.close()` closes THIS pane.
 *
 * RUNTIME NOTE: this only renders once something spawns an extension-view session —
 * the creation path (main-minted session + the panel command) is the deep,
 * runtime-gated remainder of WS6. This is the render seam that receives it.
 */
type Props = {
  sessionId: SessionId
  paneLabel?: string
  focused: boolean
  onFocusRequest: () => void
  workspace: Workspace
}

export function ExtensionViewLeaf({ sessionId, workspace }: Props) {
  const installedExtensions = useAppStore(state => state.installedExtensions)
  const host = useExtensionHost()
  const { showToast } = useGlobalToast()

  const viewId = workspace.state.sessions[sessionId]?.extensionViewId
  const extensionId = viewId ? (viewId.split('.')[0] ?? viewId) : undefined
  const entry = extensionId
    ? installedExtensions.find(candidate => candidate.manifest.id === extensionId)
    : undefined

  const api = useMemo(
    () =>
      extensionId
        ? createAppHostApi({
            extensionId,
            showToast,
            // Closing the extension's own view closes the pane it lives in.
            closeSurface: () => workspace.closeSession(sessionId),
          })
        : null,
    [extensionId, showToast, workspace, sessionId],
  )

  const View = useMemo(
    // fill=true: a pane is a fixed tile, so the view fills it rather than sizing to
    // its own content the way the floating modal does.
    () => (host && entry && viewId ? viewComponentFor(host, entry, viewId, true) : null),
    [host, entry, viewId],
  )

  if (!viewId || !entry || !host || !View || !api) {
    // The pane persists (its SessionMeta is kept) but the owning extension is not
    // installed, or the host is not ready. A dead-but-closable leaf, mirroring the
    // unknown-kind rehydrate policy, rather than a blank pane with no explanation.
    return (
      <div
        className="flex h-full w-full items-center justify-center bg-canvas px-6 text-center"
        onMouseDown={onFocusRequestGuard}
      >
        <div className="text-[12px] text-muted">
          {viewId
            ? `Extension "${extensionId}" is not installed. Install it to restore this pane.`
            : 'This pane is not backed by an extension view.'}
        </div>
      </div>
    )
  }

  return (
    <div className="h-full w-full bg-canvas">
      <View api={api} />
    </div>
  )
}

// A no-op kept separate so the dead-leaf branch reads cleanly; focus on a dead pane
// is meaningless but the container should still swallow the event.
function onFocusRequestGuard() {}

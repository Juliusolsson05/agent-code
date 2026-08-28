import { useMemo } from 'react'

import { useAppStore } from '@renderer/app-state/hooks'
import { createAppHostApi } from '@renderer/apps/api/createAppHostApi'
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
// `paneLabel` and `focused` are deliberately NOT props here, unlike every sibling
// leaf. An extension owns its whole rectangle — the host draws no header strip over
// it — so there is no chrome to label and no focus ring to paint. They were accepted
// and then discarded (`focused` reached a `${focused ? '' : ''}` template), which
// reads as "focus styling exists" to anyone scanning the file.
type Props = {
  sessionId: SessionId
  onFocusRequest: () => void
  workspace: Workspace
}

export function ExtensionViewLeaf({ sessionId, workspace, onFocusRequest }: Props) {
  const installedExtensions = useAppStore(state => state.installedExtensions)
  const installedExtensionsLoaded = useAppStore(state => state.installedExtensionsLoaded)
  const { showToast } = useGlobalToast()

  const persistedViewId = workspace.state.sessions[sessionId]?.extensionViewId
  const extensionId = persistedViewId ? (persistedViewId.split('.')[0] ?? persistedViewId) : undefined
  const entry = extensionId
    ? installedExtensions.find(candidate => candidate.manifest.id === extensionId)
    : undefined

  // ── THE PERSISTED VIEW ID MUST BE ONE THE MANIFEST DECLARES ──
  // extensionViewId is an unconstrained string on SessionMeta, restored from
  // workspace.json. Deriving the extension from `split('.')[0]` and then trusting the
  // rest means any persisted "victim.anything" mounts a live broker for victim. It also
  // used to flow unchecked into the frame document, where it was an injection sink.
  // Accept it only if the extension actually contributes that view.
  const viewId =
    persistedViewId && (entry?.manifest.contributes?.views ?? []).some(v => v.id === persistedViewId)
      ? persistedViewId
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
    //
    // Depends on the IDS, not on `entry`. `entry` is a fresh object every time the
    // installed list is refetched, so depending on it re-ran this memo on every
    // install/remove. viewComponentFor caches by identity so the returned component
    // is stable either way, but keeping the dep list to the ids says so locally —
    // and stops this memo from being the thing that reintroduces the remount if the
    // cache is ever removed.
    () => (entry && viewId ? viewComponentFor(entry, viewId, true) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [extensionId, viewId],
  )

  if (!viewId || !entry || !View || !api) {
    // ── DO NOT CLAIM "NOT INSTALLED" BEFORE THE LIST HAS LOADED ──
    // installedExtensions starts [] and is filled by an async IPC whose failure path
    // deliberately leaves the store untouched. Collapsing "still loading" into "not
    // installed" flashed a false message on every reload, and one failed
    // extensionsList() made it permanent — sending the user to uninstall and reinstall
    // an extension that was fine.
    const stillLoading = !installedExtensionsLoaded
    return (
      <div
        className="flex h-full w-full items-center justify-center bg-canvas px-6 text-center"
        onMouseDown={onFocusRequest}
      >
        <div className="text-[12px] text-muted">
          {stillLoading
            ? 'Loading…'
            : persistedViewId
              ? `Extension "${extensionId}" is not installed. Install it to restore this pane.`
              : 'This pane is not backed by an extension view.'}
        </div>
      </div>
    )
  }

  return (
    // onMouseDown wires pane focus, which every sibling leaf does and this one did not:
    // clicking an extension pane left focus on the previously focused pane, so Cmd+W
    // then closed the WRONG pane. The cross-origin iframe swallows mousedown over its
    // own content, so this catches the surrounding gutter — partial, but strictly
    // better than a pane that can never be focused by pointer at all.
    <div className="h-full w-full bg-canvas" onMouseDown={onFocusRequest}>
      <View api={api} />
    </div>
  )
}

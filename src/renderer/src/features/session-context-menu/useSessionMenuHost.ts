import { useLayoutEffect } from 'react'

import { useAppStore } from '@renderer/app-state/store'
import type { SessionMenuRequest } from '@renderer/app-state/uiShell/types'
import { AGENT_GONE_MESSAGE } from '@renderer/features/command-palette/targetedCommandContext'
import type { CommandContext } from '@renderer/features/command-palette/types'
import type { PopupMenuItem } from '@shared/types/popupMenu'

import { buildSessionContextMenu, parseSessionMenuChoice, type SessionMenuChoice } from './buildSessionContextMenu'

/**
 * Serve a pending Sessions row menu (#1180). Called from the command palette
 * host, because that is the one component holding a live CommandContext.
 *
 * Shape of one request:
 *   1. build the template NOW, against the clicked agent (`target`), with the
 *      same admission check the pick will face;
 *   2. clear the request at once — the host may unmount while the native menu
 *      is up (it is mounted only because of this request), and nothing below
 *      needs it mounted;
 *   3. mark the row, show the menu, unmark it whatever happens;
 *   4. route the pick. Commands go back through `requestCommandInvocation`
 *      with the target, which remounts the host with a FRESH context and
 *      re-runs admission — so an agent that exited or reloaded while the menu
 *      was open is refused there, never retargeted to focus.
 */
export function useSessionMenuHost(options: {
  commandContext: CommandContext
  showToast: (message: string, durationMs?: number) => void
}): void {
  const { commandContext, showToast } = options
  const request = useAppStore(state => state.sessionMenuRequest)

  useLayoutEffect(() => {
    if (!request) return
    const store = useAppStore.getState()
    // Claim the request: act only if it is STILL the pending one. A request
    // mounts this host, and React StrictMode replays a fresh mount's layout
    // effects with the same captured `request` — without this check the
    // replay opened a second native menu for one right-click (#1180 review),
    // and either menu closing cleared the row mark while the other was up.
    // Store identity is the one thing the replay cannot fake: the first run
    // cleared it.
    if (store.sessionMenuRequest !== request) return
    store.clearSessionMenuRequest()
    // The row can outlive its agent by a render (the list re-renders after
    // the session map changes); a menu for a vanished agent would be built
    // from `when` predicates that all say no.
    if (!store.workspaceState.sessions[request.sessionId]) {
      showToast(AGENT_GONE_MESSAGE, 3000)
      return
    }
    const items = buildSessionContextMenu({
      request,
      ctx: { ...commandContext, target: request.sessionId },
      colorFlag: store.settings.dispatchColorFlags?.[request.sessionId],
      spotlightSessionId: store.workspaceSpotlight?.focusedSessionId ?? null,
    })
    void showSessionMenu(request, items, commandContext, showToast)
  }, [commandContext, request, showToast])
}

async function showSessionMenu(
  request: SessionMenuRequest,
  items: PopupMenuItem[],
  commandContext: CommandContext,
  showToast: (message: string, durationMs?: number) => void,
): Promise<void> {
  const store = useAppStore.getState()
  store.setSessionMenuOpenFor(request.sessionId)
  let picked: string | null
  try {
    picked = await window.api.showPopupMenu({ items, x: request.x, y: request.y })
  } catch (error) {
    // A rejected invoke is a template bug (main validates and throws). Say
    // so rather than leaving a right-click that silently did nothing.
    // eslint-disable-next-line no-console
    console.warn('[session-context-menu] popup failed', error)
    showToast('Could not open the agent menu.', 4000)
    return
  } finally {
    // Only clear OUR mark: never another row's, should one ever be set in
    // between (a native menu is modal, so today this is belt and braces).
    if (useAppStore.getState().sessionMenuOpenFor === request.sessionId) {
      useAppStore.getState().setSessionMenuOpenFor(null)
    }
  }
  const choice = picked === null ? null : parseSessionMenuChoice(picked)
  if (choice) applySessionMenuChoice(request, choice, commandContext, showToast)
}

/** Exported for tests: the routing half, without the native menu. */
export function applySessionMenuChoice(
  request: SessionMenuRequest,
  choice: SessionMenuChoice,
  commandContext: CommandContext,
  showToast: (message: string, durationMs?: number) => void,
): void {
  const store = useAppStore.getState()
  if (choice.kind === 'command') {
    // Admission (and the "no longer open" toast) happens in the host's
    // pending-invocation effect, against state as it is NOW.
    store.requestCommandInvocation(choice.commandId, 'context-menu', request.sessionId)
    return
  }
  // The non-command items act immediately, so the stale check is here: the
  // user may have looked at the menu for a while, and a reload mints a new
  // session id (D5). Dropping is the only safe answer — applying a flag or a
  // lane placement to "whatever is there now" is the silent re-address #816
  // is about.
  if (!store.workspaceState.sessions[request.sessionId]) {
    showToast(AGENT_GONE_MESSAGE, 3000)
    return
  }
  switch (choice.kind) {
    case 'show-in-lane':
      request.showInLane?.run()
      return
    case 'spotlight':
      commandContext.workspace.setSpotlightTarget(request.sessionId)
      return
    case 'flag':
      store.setDispatchColorFlag(request.sessionId, choice.flag)
      return
  }
}

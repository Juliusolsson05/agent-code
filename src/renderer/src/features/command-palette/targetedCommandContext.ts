import type { ReaderModeState, SessionId, SpotlightState, WorkspaceState } from '@renderer/workspace/types'

import type { CommandContext } from './types'

/** What the user is told when the agent a menu was opened for is gone by the
 *  time they pick an item (#1180, plan D5). One string for every path that
 *  can notice it: the menu host, and admission refusing a targeted command. */
export const AGENT_GONE_MESSAGE = 'That agent is no longer open.'

/**
 * Is this agent's view on screen right now, so a pane toast on it would be
 * seen?
 *
 * Source of truth for "on screen": a stage lane's `selectedSessionId`, or the
 * focus takeover (Reader wins over Spotlight, but either one covering the stage
 * means ITS agent is the only one visible). Takeover is passed in rather than
 * read from the store so this stays a pure function the tests can drive.
 */
export function isSessionOnScreen(
  state: WorkspaceState,
  sessionId: SessionId,
  takeover: ReaderModeState | SpotlightState | null,
): boolean {
  if (takeover) return takeover.focusedSessionId === sessionId
  return state.stage.lanes.some(lane => lane.selectedSessionId === sessionId)
}

/**
 * The CommandContext a right-click invocation runs with: the live context plus
 * the explicit target, with pane toasts made visible.
 *
 * WHY toasts need rerouting at all: commands report their outcome through
 * `workspace.showPaneToast(sessionId, …)` ("copied resume command", "copy
 * failed", "Copied to clipboard"). That writes `runtime.paneToast` on the
 * TARGET's runtime, which only renders inside the target's own agent view.
 * From the palette the target is the focused agent, so it is always visible.
 * From the Sessions list the whole point is that the clicked agent is usually
 * NOT in a lane — so every such message would land on an unrendered view and
 * the user would see a menu click do nothing. Copy Last Response failing
 * silently is exactly the "clicked into nothing" outcome the execution gateway
 * exists to prevent.
 *
 * WHY wrap the context instead of changing the commands: every command that
 * toasts would otherwise need to learn about "is my target visible", and the
 * next command to opt into the menu would forget. The host is the one place
 * that knows the invocation came from off-screen.
 *
 * The pane toast is still written too: if the target is dragged into a lane a
 * moment later, its own view shows the message the way it always has.
 *
 * WHY a shallow spread of `workspace` is safe: the workspace object is the
 * hook's return value — a bag of closures over refs, not a class — so no method
 * depends on `this` being the original object.
 */
export function targetedCommandContext(options: {
  ctx: CommandContext
  target: SessionId
  /** Live reads, not snapshots — see the comment at the call below. The host
   *  passes store getters; tests pass fixtures. */
  getState: () => WorkspaceState
  getTakeover: () => ReaderModeState | SpotlightState | null
  showGlobalToast: (message: string, durationMs?: number) => void
}): CommandContext {
  const { ctx, target, getState, getTakeover, showGlobalToast } = options
  const workspace = ctx.workspace
  return {
    ...ctx,
    target,
    workspace: {
      ...workspace,
      showPaneToast: (sessionId, message, durationMs) => {
        workspace.showPaneToast(sessionId, message, durationMs)
        // Read state at toast time, not menu time: an async command (Copy
        // Last Response awaits the clipboard, Reload awaits a respawn) may
        // finish after the user has already brought the agent into a lane or
        // opened Spotlight on it. `workspace.state` is the render snapshot the
        // context was built from, so it cannot answer that.
        if (!isSessionOnScreen(getState(), sessionId, getTakeover())) {
          showGlobalToast(message, durationMs)
        }
      },
    },
  }
}

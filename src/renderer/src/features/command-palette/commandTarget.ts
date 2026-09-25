import { commandTargetSessionId } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import type { SessionId } from '@renderer/workspace/types'

import type { CommandContext } from './types'

/**
 * The agent a command acts on: the caller's explicit `ctx.target` when there
 * is one (#1180, the Sessions list right-click menu), otherwise the focused
 * agent (`commandTargetSessionId`, unchanged for the palette, keybindings and
 * the app menu).
 *
 * WHY a vanished explicit target resolves to null and NEVER falls back to
 * focus: the user right-clicked a specific agent. If it closed or was
 * replaced (a reload mints a new session id) before the command ran, acting on
 * whichever agent happens to be focused instead is the silent re-addressing
 * #816 is about — worse than doing nothing. Null makes `when` hide the command
 * and makes admission refuse it with a reason the menu host can show.
 */
export function commandTarget(ctx: Pick<CommandContext, 'workspace' | 'target'>): SessionId | null {
  if (ctx.target !== undefined) {
    return ctx.workspace.state.sessions[ctx.target] ? ctx.target : null
  }
  return commandTargetSessionId(ctx.workspace)
}

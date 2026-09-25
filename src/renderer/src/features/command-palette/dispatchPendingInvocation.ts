import { useAppStore } from '@renderer/app-state/store'
import type { PendingCommandInvocation } from '@renderer/app-state/uiShell/types'

import { dispatchCommand, type CommandDispatchOutcome } from './executeCommand'
import { AGENT_GONE_MESSAGE, targetedCommandContext } from './targetedCommandContext'
import type { CommandContext, CommandDef } from './types'

/**
 * Run one store-queued invocation (native menu, keybinding, or a Sessions row
 * menu pick) through the gateway. Lifted out of CommandPalette's layout effect
 * so the targeted path is testable without mounting the palette.
 */
export function dispatchPendingInvocation(options: {
  pending: PendingCommandInvocation
  commandContext: CommandContext
  showToast: (message: string, durationMs?: number) => void
  extraCommands?: readonly CommandDef[]
}): Promise<CommandDispatchOutcome> {
  const { pending, commandContext, showToast, extraCommands } = options
  const target = pending.target
  // An explicit target (#1180) runs the command against the clicked agent
  // rather than the focused one, with its pane toasts made visible — see
  // targetedCommandContext for why the toasts need help.
  const ctx = target === undefined
    ? commandContext
    : targetedCommandContext({
      ctx: commandContext,
      target,
      getState: () => useAppStore.getState().workspaceState,
      getTakeover: () => {
        const store = useAppStore.getState()
        return store.workspaceReaderMode ?? store.workspaceSpotlight
      },
      showGlobalToast: showToast,
    })
  return dispatchCommand({
    // The SOURCE travels with the request, so a chord is recorded as a
    // keybinding invocation and a File-menu click as a native-menu one. A
    // hardcoded source here would have made every keyboard invocation look
    // like a menu click in personalized history.
    id: pending.id,
    source: pending.source,
    ctx,
    reportError: message => showToast(message, 6000),
    extraCommands,
  }).then(outcome => {
    // A right-click menu is built from a snapshot and the pick arrives after
    // the user has been looking at the menu for a while; the agent may have
    // exited or been reloaded under a new id meanwhile. Fresh admission
    // refuses that (commandTarget never falls back to focus), and the user
    // deserves to hear why the click did nothing. Keybindings and the File
    // menu keep their existing silent refusal — a chord pressed in the wrong
    // context is common and not worth a toast.
    if (target !== undefined && outcome.status === 'unavailable') {
      const gone = !useAppStore.getState().workspaceState.sessions[target]
      showToast(gone ? AGENT_GONE_MESSAGE : outcome.reason, 4000)
    }
    // The same command is still running for this same agent (single-flight
    // is per agent, see flightKey). From a menu the second click otherwise
    // looks ignored.
    if (target !== undefined && outcome.status === 'in-flight') {
      showToast('Already running for this agent.', 3000)
    }
    return outcome
  })
}

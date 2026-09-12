import { useLayoutEffect } from 'react'
import { useAppStore } from '@renderer/app-state/store'
import { hasAppInteractionOwner } from '@renderer/lib/interaction-ownership'
import { commandTargetSessionId } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import { commandExecutionRequests, type CommandExecutionRequest } from '../commandExecutionRequests'
import { commandOwnsOpenSurface } from '../surfaceOwnership'
import { dispatchCommand } from '../executeCommand'
import type { CommandContext } from '../types'

export function useCommandExecutionRequest(request: CommandExecutionRequest | null, context: CommandContext) {
  useLayoutEffect(() => {
    if (!request || !commandExecutionRequests.claim(request.token)) return
    const unavailable = (reason: string) => commandExecutionRequests.complete(request.token,
      { status: 'unavailable', id: request.commandId, source: 'programmatic', reason })
    // A native invocation has priority over a concurrent external request. Both
    // hosts would otherwise act on the same render's context even if the first
    // invocation changes selection or opens a modal before the second runs.
    if (useAppStore.getState().pendingCommandInvocation) {
      unavailable('A menu or keyboard command is pending; observe again after it finishes'); return
    }
    // Recheck at actual dispatch, after lazy mounting and window focus changes.
    // The observation the caller used may have been true before React loaded
    // this context but false now; never reinterpret it as the new active agent.
    if (request.expectedSessionId && commandTargetSessionId(context.workspace) !== request.expectedSessionId) {
      unavailable('The selected agent changed before dispatch; observe again'); return
    }
    if (hasAppInteractionOwner() && !commandOwnsOpenSurface(request.commandId, useAppStore.getState())) {
      unavailable('Another surface owns input; inspect or dismiss it first'); return
    }
    void dispatchCommand({ id: request.commandId, source: 'programmatic', ctx: context })
      .then(result => commandExecutionRequests.complete(request.token, result), error =>
        commandExecutionRequests.complete(request.token, { status: 'failed', id: request.commandId, source: 'programmatic', error }))
    // A rerender/StrictMode repeat cannot claim the token twice. Async domain
    // work retains its ordinary lifetime; unmount does not undo its effects.
  }, [request, context])
}

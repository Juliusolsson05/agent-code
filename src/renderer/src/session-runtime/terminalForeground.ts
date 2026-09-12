import type { TerminalForegroundState } from '@shared/types/terminalForeground'
import { withDerivedSessionStatus } from '@renderer/session-runtime/semantic/helpers'
import type { SessionRuntime } from './state'
import { withUnread } from './unread'

/**
 * Fold one terminal foreground observation into a runtime (#865).
 *
 * WHY it drives processActive/activityStatus instead of a terminal-only status
 * field: deriveSessionStatus already turns processActive into `running`, and
 * every consumer (Status Mode, tab counts, the close confirmation, Dispatch)
 * reads sessionStatus. Feeding the existing input lights all of them for shells
 * with zero terminal branches downstream.
 *
 * WHY busy→idle marks unread: that transition is "your command finished", the
 * shell equivalent of an agent turn completing. Terminal clicks/keys already
 * acknowledge through TerminalLeaf, so a user watching the pane clears it by
 * typing the next command.
 */
export function applyTerminalForeground(
  runtime: SessionRuntime,
  state: TerminalForegroundState,
  now: number,
): SessionRuntime {
  const previous = runtime.terminalForeground
  if (
    previous &&
    previous.busy === state.busy &&
    previous.command === state.command &&
    previous.cwd === state.cwd
  ) {
    // Identity-preserving: the store would otherwise re-render every
    // subscriber for an observation that changes nothing.
    return runtime
  }
  const next = withDerivedSessionStatus({
    ...runtime,
    terminalForeground: { ...state, changedAt: now },
    processActive: state.busy,
    activityStatus: state.busy ? state.command : null,
  })
  return previous?.busy === true && !state.busy ? withUnread(next, 'output', now) : next
}

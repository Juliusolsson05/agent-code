// Single source of truth for "which session is the user currently
// commanding?".
//
// WHY this is its own file:
//
//   Focus used to live in two fields (the grid's Tab.focusedSessionId and
//   Dispatch's dispatchMode.focusedSessionId), and reading either one directly
//   silently ignored the other surface. Both are gone with #992. The answer
//   now has two parts: an open focus takeover (Spotlight or Reader) is what
//   the user is commanding, and otherwise it is the focused lane's occupant.
//   Reading `stage.lanes[focusedLane]` directly is the new version of the old
//   mistake: it ignores Spotlight.
//
//   Importing this helper documents the intent. Don't fold it into
//   useWorkspace as a derived getter that everything reads automatically;
//   the explicit import is the documentation.

import { useAppStore } from '@renderer/app-state/store'
import { resolveStrictDispatchCommandTarget } from '@renderer/workspace/dispatch/dispatchTarget'
import type { ReaderModeState, SessionId, SpotlightState, WorkspaceState } from '@renderer/workspace/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'

export function commandTargetSessionId(workspace: Workspace): string | null {
  return commandTargetSessionIdForState(workspace.state)
}

/** The focus takeover on screen right now, if any. Reader wins over Spotlight
 * for the same reason `control.ts` orders them that way: Reader is opened from
 * inside Spotlight and covers it. */
function currentFocusTakeover(): ReaderModeState | SpotlightState | null {
  const store = useAppStore.getState()
  return store.workspaceReaderMode ?? store.workspaceSpotlight
}

export function commandTargetSessionIdForState(
  state: WorkspaceState,
  // WHY a default that reads the store, instead of a required argument (#1013
  // parity review, MAJOR): about twenty call sites pass only
  // `refs.stateRef.current` or `workspace.state`. A required parameter would
  // make each of them choose, and the next caller that forgets would bring
  // the bug back. Tests pass it explicitly.
  takeover: ReaderModeState | SpotlightState | null = currentFocusTakeover(),
): SessionId | null {
  // WHY an open Spotlight/Reader answers first (#1013 parity review, MAJOR):
  // while a takeover is up, the only agent on screen is the takeover's, so
  // that is the one being commanded. Picking another agent inside Spotlight
  // deliberately leaves the stage lanes alone (spotlight.ts, U2/#681); main
  // did that by mirroring the pick into the tree or Dispatch focus that this
  // function read. With both fields gone, a lane-only answer meant Tail, Jump
  // Latest, Close Focused Session, Stop Goal Loop, reload and provider switch
  // all acted on the lane agent HIDDEN behind Spotlight. `control.ts` already
  // reported the takeover as the focused session; this makes the commands
  // agree with it. A takeover whose session is gone (the sanity hooks clear
  // it a render later) falls through to the lane instead of naming a dead id.
  if (takeover && state.sessions[takeover.focusedSessionId]) return takeover.focusedSessionId

  // A grid branch lived here until #992: with no Dispatch state it read the
  // active tab's focused tile leaf (through the related-agent selection). The
  // stage is the only workspace, so the focused lane is the only target.

  // WHY strict Dispatch targeting is used here:
  // commandTargetSessionIdForState is consumed by lifecycle and destructive
  // commands (close, reload, provider switch, bury, debug inspectors). In
  // Tiled Dispatch an empty/stale focused lane visually means "no agent is
  // selected in this lane"; falling back to classic focus, grid focus, or the
  // first visible row would make a command act on a session the user is not
  // looking at. Spawn helpers deliberately use a different fallback-friendly
  // resolver because "where should a new agent go?" is not the same question.
  return resolveStrictDispatchCommandTarget(state)?.row.sessionId ?? null
}

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
import { sidekickCommandTarget } from '@renderer/workspace/sidekickPanel'

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

/**
 * Flags that pin the answer to LANE semantics: the external operator surface
 * (workspace/control.ts, commands.run) never addresses a sidekick — it filters
 * sidekick rows out of the sessions it publishes, so reporting one as the
 * focused session would name an agent the operator cannot see.
 */
export const WORKSPACE_KEYBOARD_FLAGS: Parameters<typeof sidekickCommandTarget>[1] = Object.freeze({
  keyboardRegion: 'workspace',
  sidekickSpotlight: false,
  settingsPageOpen: false,
})

/** The keyboard-ownership flags the Sidekick answer depends on, read live. */
function currentSidekickFlags(): Parameters<typeof sidekickCommandTarget>[1] {
  const store = useAppStore.getState()
  return {
    keyboardRegion: store.keyboardRegion,
    sidekickSpotlight: store.sidekickSpotlight,
    settingsPageOpen: store.settingsPageOpen,
  }
}

export function commandTargetSessionIdForState(
  state: WorkspaceState,
  // WHY a default that reads the store, instead of a required argument (#1013
  // parity review, MAJOR): about twenty call sites pass only
  // `refs.stateRef.current` or `workspace.state`. A required parameter would
  // make each of them choose, and the next caller that forgets would bring
  // the bug back. Tests pass it explicitly.
  takeover: ReaderModeState | SpotlightState | null = currentFocusTakeover(),
  // Same default-reads-the-store shape as `takeover`, for the same reason.
  // Callers that must keep LANE semantics whatever the keyboard is doing (the
  // external operator projection in control.ts) pass a workspace-region flag
  // set explicitly.
  sidekickFlags: Parameters<typeof sidekickCommandTarget>[1] = currentSidekickFlags(),
): SessionId | null {
  // WHY the Sidekick answers FIRST, before an open Spotlight/Reader (#1493
  // follow-up — the v1 ruling "palette commands never target a sidekick" is
  // retired: the owner wants every lane feature on the sidekick): the Sidekick
  // column stays on screen beside a lane Spotlight or Reader, and when the
  // keyboard is in it, it is the agent being commanded. Checked after the
  // takeover, Copy Assistant / Reload / Rewind would keep hitting the
  // Spotlight agent while the user types in the Sidekick.
  //
  // The commands that only make sense for a lane or project agent (Close Tab,
  // Pin, Reader, Linked Agent, Duplicate, Resume, Browser Pocket) refuse a
  // sidekick target in their own `when`, through isSidekickSession — this
  // selector answers "who", each command answers "does it apply".
  const sidekick = sidekickCommandTarget(state, sidekickFlags)
  if (sidekick.owns) return sidekick.sessionId

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

/**
 * Subscribe a component to the inputs of the Sidekick answer above.
 *
 * WHY: those inputs live in uiShell (keyboardRegion, sidekickSpotlight,
 * settingsPageOpen), not WorkspaceState. A surface that reads
 * commandTargetSessionId during render re-rendered on workspace changes only,
 * so moving the keyboard into the Sidekick left the Git bar, worktrees bar,
 * debug panels, Agent Status and the editor's cwd showing the LANE agent until
 * something unrelated re-rendered them. Call this next to the read (or put the
 * returned key in a memo's deps).
 */
export function useCommandTargetInputs(): string {
  return useAppStore(state => `${state.keyboardRegion}:${state.sidekickSpotlight}:${state.settingsPageOpen}`)
}

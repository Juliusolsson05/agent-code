import type { SessionId, SessionMeta, WorkspaceState } from '@renderer/workspace/types'

// ---------------------------------------------------------------------------
// When a terminal was last USED (#1178).
//
// A shell has no transcript and no turn clock, so the only "last active" it
// had was `runtime.terminalForeground.changedAt`. That value is in memory and
// is stamped `Date.now()` on the first foreground observation after any
// attach — and every restart pulls a foreground snapshot into an empty runtime
// (useTerminalForeground). So after a restart every terminal read "active just
// now", and Close Old Agents could never find the shell nobody had touched in
// three days, which is the one it exists to find. A command that starts and
// ends inside the 1 s poll, and plain typing, never counted at all.
//
// The fix is a DURABLE record on SessionMeta, persisted with the workspace,
// that moves only on real use:
//   - the user typing or pasting into the terminal;
//   - a real foreground transition (a command started or finished, a `cd`),
//     never the first observation after an attach;
//   - the first sighting of a terminal with no record yet, as a floor.
//
// WHY a floor at first sighting and not "unknown until used": a terminal that
// nobody touches after this ships would otherwise stay "unknown activity"
// forever, and Close Old Agents skips unknown rows — so the forgotten shell,
// the exact case this fixes, could never be closed as old. The floor makes a
// true claim: "not used since at least this moment".
//
// WHY not tmux's own `session_activity`: it covers only tmux-backed shells (a
// direct PTY has none), and it counts OUTPUT as activity, so a prompt clock or
// a `tail -f` would keep a forgotten shell "in use" forever.
//
// `changedAt` keeps its other jobs — the busy→idle unread mark and the live
// status — which really are about the latest observation.
// ---------------------------------------------------------------------------

/**
 * How stale a record may get before a new use is written.
 *
 * WHY throttle at all: SessionMeta is persisted, and autosave keys off state
 * identity, so an unthrottled stamp would schedule a workspace write on every
 * keystroke. A minute is finer than any threshold Close Old Agents offers
 * (its smallest unit is minutes), so nothing it can ask is answered wrongly.
 */
export const TERMINAL_LAST_USED_RESOLUTION_MS = 60_000

/**
 * Record a use of `sessionId` at `at`. Returns the SAME state object when
 * nothing changes — not a terminal, gone, or used within the resolution — so
 * a keystroke inside the window costs no re-render and no disk write.
 */
export function withTerminalLastUsed(
  state: WorkspaceState,
  sessionId: SessionId,
  at: number,
): WorkspaceState {
  const meta = state.sessions[sessionId]
  if (!meta || meta.kind !== 'terminal') return state
  const previous = meta.lastUsedAt
  // `at <= previous` guards a clock that stepped backwards (NTP, sleep):
  // the record only ever moves forward, like the transcript watermark.
  if (typeof previous === 'number' && (at <= previous || at - previous < TERMINAL_LAST_USED_RESOLUTION_MS)) return state
  return {
    ...state,
    sessions: { ...state.sessions, [sessionId]: { ...meta, lastUsedAt: at } },
  }
}

/**
 * Give a terminal its floor record if it has none. Never moves an existing
 * record: a restart is not a use.
 */
export function withTerminalLastUsedFloor(
  state: WorkspaceState,
  sessionId: SessionId,
  at: number,
): WorkspaceState {
  const meta = state.sessions[sessionId]
  if (!meta || meta.kind !== 'terminal' || typeof meta.lastUsedAt === 'number') return state
  return {
    ...state,
    sessions: { ...state.sessions, [sessionId]: { ...meta, lastUsedAt: at } },
  }
}

/** The terminal's last use, for "how long has this been idle" readers. */
export function terminalLastUsedAt(meta: Pick<SessionMeta, 'lastUsedAt'> | undefined): number | null {
  const at = meta?.lastUsedAt
  return typeof at === 'number' && Number.isFinite(at) ? at : null
}

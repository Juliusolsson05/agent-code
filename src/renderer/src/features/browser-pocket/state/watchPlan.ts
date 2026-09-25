import type { PortWatchSession } from '@shared/browserPocket/types'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import type { SessionId, WorkspaceState } from '@renderer/workspace/types'

import { canHavePocket } from '../actions'

/**
 * Which sessions main should scan for dev servers, and which terminals belong
 * to which agent's lane (decomposition Stage 7).
 *
 * Watched: every agent shown in a lane of the stage, the Spotlight agent, and
 * every agent with a pocket. Nothing else — the scan costs a `ps` and an
 * `lsof`, and a lane nobody can see does not need its chip.
 *
 * Terminal attribution: terminals are NOT linked to agents in the data model
 * (a New Terminal only inherits the focused lane's cwd), so the rule is
 * containment: a terminal in the same project whose live cwd (tmux reports it)
 * or spawn cwd is inside the agent's worktree belongs to that lane. Two agents
 * in the same directory both get the terminal; the chip lists what both see
 * rather than guessing an owner.
 */
export function buildWatchPlan(input: {
  state: WorkspaceState
  runtimes: Record<string, SessionRuntime | undefined>
  spotlightSessionId: SessionId | null
}): PortWatchSession[] {
  const { state, runtimes } = input
  const watched = new Set<SessionId>()
  for (const lane of state.stage.lanes) if (lane.selectedSessionId) watched.add(lane.selectedSessionId)
  if (input.spotlightSessionId) watched.add(input.spotlightSessionId)
  for (const [id, meta] of Object.entries(state.sessions)) if (meta.browserPocket) watched.add(id as SessionId)

  const terminals = Object.entries(state.sessions).filter(([, meta]) => meta.kind === 'terminal')
  const plan: PortWatchSession[] = []
  for (const id of watched) {
    const meta = state.sessions[id]
    if (!meta || !canHavePocket(state, id)) continue
    const runtime = runtimes[id]
    const root = normalise(runtime?.workContext?.worktreePath ?? runtime?.projectDir ?? meta.cwd)
    const tmuxNames: string[] = []
    const terminalSessionIds: string[] = []
    if (root) {
      for (const [termId, term] of terminals) {
        if (term.projectId !== meta.projectId) continue
        const cwd = normalise(runtimes[termId]?.terminalForeground?.cwd ?? term.cwd)
        if (!cwd || !isInside(cwd, root)) continue
        if (term.tmuxName) tmuxNames.push(term.tmuxName)
        else terminalSessionIds.push(termId)
      }
    }
    plan.push({ sessionId: id, tmuxNames, terminalSessionIds })
  }
  return plan.sort((a, b) => a.sessionId.localeCompare(b.sessionId))
}

function normalise(path: string | null | undefined): string | null {
  if (!path) return null
  return path.length > 1 ? path.replace(/\/+$/, '') : path
}

/** Path containment on segment boundaries: /w/app does not contain /w/app2. */
export function isInside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`)
}

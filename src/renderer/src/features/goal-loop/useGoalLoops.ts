import { useEffect, useState } from 'react'

import type { GoalLoopState } from '@shared/types/goalLoop'

/**
 * Every listed agent's goal loop, for surfaces that show MANY agents at once
 * (#1031 item 2).
 *
 * ── WHY THIS EXISTS BESIDE GoalLoopPane'S OWN SUBSCRIPTION ──
 * `GoalLoopPane` is mounted only by `TileTree`, i.e. only for a session that
 * occupies a lane. A loop running on a POOLED agent therefore had no surface
 * at all: nothing showed it, and `commandTargetSessionId` resolves the focused
 * lane's occupant, so Stop Goal Loop could not reach it either. Orchestration
 * children always land in the pool, so this is the common case, not an edge.
 *
 * ── WHY ONE SUBSCRIPTION FOR THE WHOLE LIST ──
 * `goal-loop:changed` is a payload-free ping by design, so every reader
 * re-reads on every ping. One hook per ROW would multiply that by the number
 * of agents in the index — dozens of IPC round trips per loop event, for a
 * chip. `readGoalLoops` already takes an id array, so the list reads once and
 * hands each row its own answer.
 *
 * ── WHY THE READ IS KEYED ON A JOINED STRING ──
 * The caller builds its id array inside a render, so the array identity
 * changes every time. Depending on it directly would re-subscribe on every
 * render; depending on the joined string re-subscribes only when the SET of
 * listed agents actually changes.
 */
export function useGoalLoops(sessionIds: readonly string[]): Record<string, GoalLoopState> {
  const [loops, setLoops] = useState<Record<string, GoalLoopState>>({})
  const key = sessionIds.join('\u0000')

  useEffect(() => {
    // Guard: tests stub window.api partially, and an index that crashes over a
    // missing IPC method is far worse than one that shows no loop chips.
    // Production always has both — GoalLoopPane makes the same call.
    if (!window.api?.onGoalLoopChanged || !window.api?.readGoalLoops) return
    const ids = key.length === 0 ? [] : key.split('\u0000')
    if (ids.length === 0) {
      setLoops({})
      return
    }
    let current = true
    const read = () => {
      void window.api.readGoalLoops(ids).then(next => {
        if (current) setLoops(next)
      }).catch(() => {})
    }
    const unsubscribe = window.api.onGoalLoopChanged(read)
    read()
    return () => { current = false; unsubscribe() }
  }, [key])

  return loops
}

/**
 * Is this loop worth a chip in the index?
 *
 * An `ended` loop is not: the pane strip keeps an ended loop around so the
 * user can read why it stopped, but that is a detail of the surface they are
 * already looking at. In a list of twenty agents it would be stale noise that
 * never clears, and the index's job is to answer "what is happening now".
 */
export function isLiveGoalLoop(loop: GoalLoopState | undefined): loop is GoalLoopState {
  return loop !== undefined && loop.phase !== 'ended'
}

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
    // WHY reads are SEQUENCED, not just guarded by `current` (review finding
    // 2): pings arrive faster than the IPC resolves, so two reads are easily
    // in flight at once and nothing makes them resolve in order. An older read
    // landing last wrote a stale answer — 9/25 reverting to 8/25 — and after a
    // loop's FINAL ping there is no later read to correct it, so the index
    // could show a live chip for a loop that had ended, indefinitely. A
    // monotonic ticket makes a late arrival discard itself.
    let issued = 0
    let applied = 0
    const read = () => {
      const ticket = ++issued
      void window.api.readGoalLoops(ids).then(next => {
        if (!current || ticket <= applied) return
        applied = ticket
        setLoops(next)
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
 * Active and paused loops, yes: they are live state the user cannot otherwise
 * see on a pooled agent.
 *
 * An ended loop, normally no — the pane strip keeps one so the user can read
 * why it stopped, but in a list of twenty agents that is stale noise that
 * never clears, and the index's job is to answer "what is happening now".
 *
 * EXCEPT `blocked` (review finding 3). That is the agent calling
 * `goal_loop_complete` with outcome "blocked": it stopped BECAUSE it needs the
 * user. Hiding it makes the index silent about the one loop state that is
 * actually a request for attention — an agent waiting for you, looking exactly
 * like an agent that finished.
 */
export function isShownGoalLoop(loop: GoalLoopState | undefined): loop is GoalLoopState {
  if (loop === undefined) return false
  return loop.phase !== 'ended' || loop.endReason === 'blocked'
}

/** The chip's text: short enough for a dense row, specific enough to act on. */
export function goalLoopChipLabel(loop: GoalLoopState): string {
  if (loop.phase === 'ended') return 'loop blocked'
  // WHY the pause REASON is on the chip (review finding 4): "paused" alone
  // does not say whether the loop hit its cap (raise it), errored (look), was
  // paused by the user (resume), or was interrupted. Those are four different
  // next actions, and the row is where the user decides whether to open it.
  if (loop.phase === 'paused') return loop.pauseReason ? `loop paused · ${loop.pauseReason}` : 'loop paused'
  return `loop ${loop.continuationsDelivered}/${loop.maxContinuations}`
}

/** The chip's tooltip: what this state means and what can be done about it. */
export function goalLoopChipTitle(loop: GoalLoopState): string {
  const budget = `continuation ${loop.continuationsDelivered} of ${loop.maxContinuations}`
  // Only name controls that EXIST for this phase (review finding 4): offering
  // "pause" on an ended loop, or "raise its cap" on one that did not hit the
  // cap, tells the user to look for a button that is not there.
  if (loop.phase === 'ended') {
    return `Goal loop stopped and needs you — the agent reported it is blocked (${budget}). Select this agent to read its goal.`
  }
  if (loop.phase === 'paused') {
    const action = loop.pauseReason === 'cap'
      ? 'Select this agent to raise its cap, resume or stop it.'
      : 'Select this agent to resume or stop it.'
    return `Goal loop paused${loop.pauseReason ? ` (${loop.pauseReason})` : ''} at ${budget}. ${action}`
  }
  return `Goal loop running — ${budget}. Select this agent to pause, raise its cap or stop it.`
}

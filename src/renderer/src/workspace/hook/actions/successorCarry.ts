/*
 * What follows a pane to the new session id it gets when it is replaced
 * (reload, provider switch, rewind, MCP toggle), reloaded with Reload Agents,
 * or restored by Undo Close: main keys goal loops and workflow runs by session
 * id and cannot see the swap, so the renderer tells it at the commit.
 *
 * WHY its own module: replacement, Reload Agents (session.ts) and Undo
 * Close (undoClose.ts) all hand a pane over, and Undo Close only imports types
 * from session.ts. A value import there would tie the two action modules
 * together for these few helpers, and a second copy of the goal-loop rule in
 * undoClose.ts is how Undo Close was missed in the first place (#1320).
 */

/**
 * Tell main that each replaced pane's workflow runs now belong to its
 * successor (#1280), so its workflow cards and Active navigation survive the
 * swap and a restart.
 *
 *
 * Fire-and-forget like carryGoalLoops: a failed carry leaves the runs where
 * they were (the pre-#1280 behaviour) and never blocks the swap. Main records
 * the alias even when the pane has no runs yet, because a run the pane's MCP
 * started just before the swap can register after it (#1325 review A1).
 */
export function carryWorkflowRuns(idMap: ReadonlyMap<string, string>): void {
  const carry = window.api?.carryWorkflowRuns
  if (!carry) return
  for (const [oldId, newId] of idMap) {
    void carry(oldId, newId).catch(error => {
      console.warn('[workflows] carry to the replacement session failed:', error)
    })
  }
}

/** End the loop of each replaced pane that did NOT get it carried (#1287
 *  review A2): its old id is gone from the workspace, so no pane could ever
 *  resume or stop it, and a successor without goal_loop could not complete
 *  it. Same rule AgentMcpServersModal applies before its own reload. Runs
 *  after the commit, so a replacement that failed keeps its loop. A pane
 *  with no loop gets a harmless null back. */
export function stopGoalLoops(oldIds: readonly string[]): void {
  const control = window.api?.controlGoalLoop
  if (!control) return
  for (const sessionId of oldIds) {
    void control({ sessionId, action: 'stop' }).catch(error => {
      console.warn('[goal-loop] stopping the replaced pane\'s loop failed:', error)
    })
  }
}

/** Tell main that each replaced pane's goal loop now belongs to its
 *  successor (#1279). Callers pass only successors that continue the SAME
 *  conversation with Goal Loop tools; every other replaced pane's loop is
 *  ended by stopGoalLoops above (#1287 review A2), never left behind. Main
 *  keys loops by session id and cannot see the swap; this is the same
 *  old -> new map the commit just applied to pins, lanes and relationships.
 *  Fire-and-forget: a failed carry leaves the loop where it was (the
 *  pre-#1279 behaviour), never blocks the swap, and main refuses to overwrite
 *  a loop the successor already has. */
export function carryGoalLoops(idMap: ReadonlyMap<string, string>): void {
  const carry = window.api?.carryGoalLoop
  if (!carry) return
  for (const [oldId, newId] of idMap) {
    void carry(oldId, newId).catch(error => {
      console.warn('[goal-loop] carry to the replacement session failed:', error)
    })
  }
}

/**
 * The one goal-loop rule for a pane that continues the SAME conversation
 * under new ids (#1287, #1320): a successor with Goal Loop tools takes the
 * loop over (main pauses it on carry); any other successor could never call
 * goal_loop_complete, so the old loop is ended rather than left under an id
 * no pane has. Call it after the commit, so a replacement or restore that
 * bailed keeps its loop where it was.
 *
 * Reload Agents (session.ts reloadAgentSessions) still spells this rule out
 * inline. It should call this helper, but #1324 and #1326 are rewriting that
 * function's commit right now, and a third edit there would only add merge
 * work; switch it once they land.
 */
export function handOverGoalLoops(
  idMap: ReadonlyMap<string, string>,
  capable: (newId: string) => boolean,
): void {
  const pairs = [...idMap]
  carryGoalLoops(new Map(pairs.filter(([, newId]) => capable(newId))))
  stopGoalLoops(pairs.filter(([, newId]) => !capable(newId)).map(([oldId]) => oldId))
}

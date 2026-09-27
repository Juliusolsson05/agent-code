/**
 * Tell main that each replaced pane's workflow runs now belong to its
 * successor (#1280), so its workflow cards and Active navigation survive the
 * swap and a restart.
 *
 * WHY its own module: replacement and Reload Agents (session.ts) and Undo
 * Close (undoClose.ts) all hand a pane's runs to a new session id, and Undo
 * Close only imports types from session.ts. A shared value import there would
 * tie the two action modules together for one ten-line helper.
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

// The loop's contract types live in shared/ because three processes touch
// them: main owns the service, the MCP runtime validates tool input, and the
// renderer renders snapshots. A Goal Loop is keyed by SESSION id (not the
// tldrIdentity the goal/tldr stores use) because the loop's only actuator is
// `deliverPromptToAgent(sessionId, ...)`: a conversation that survives a
// reload keeps working, but a session that is gone cannot be prompted, and
// the spec pauses the loop on provider switch anyway.
export const GOAL_LOOP_DEFAULT_MAX_CONTINUATIONS = 25
export const GOAL_LOOP_MAX_CONTINUATIONS_CEILING = 200
export const GOAL_LOOP_MAX_GOAL_CHARACTERS = 800
export const GOAL_LOOP_MAX_PROMPT_CHARACTERS = 4000
export const GOAL_LOOP_MAX_SUMMARY_CHARACTERS = 2000

export type GoalLoopPhase = 'active' | 'paused' | 'ended'
export type GoalLoopPauseReason = 'cap' | 'error' | 'user' | 'interrupted'
export type GoalLoopEndReason = 'done' | 'blocked' | 'cancelled'

export type GoalLoopState = {
  sessionId: string
  goal: string
  loopPrompt: string
  phase: GoalLoopPhase
  pauseReason: GoalLoopPauseReason | null
  endReason: GoalLoopEndReason | null
  completionSummary: string | null
  maxContinuations: number
  continuationsDelivered: number
  consecutiveDeliveryFailures: number
  startedAt: string
  updatedAt: string
}

export const GOAL_LOOP_INSTRUCTIONS = `When Goal Loop MCP is available in this session, use goal_loop_start only when the user explicitly asks you to run a loop, keep going, or work autonomously toward an outcome. Write loopPrompt yourself as a complete, self-contained instruction: it is re-sent to you every time you stop before the goal is done, so it must restate the goal and tell you to reassess remaining work and continue from where you left off. Optionally pass maxContinuations (default 25) when the user asks for a different budget.

Call goal_loop_complete only when the goal is completely and utterly satisfied — every requirement verified, nothing merely started or promised. Never call it to escape difficulty or uncertainty; if you genuinely need the user (missing input, impossible constraint), call it with outcome "blocked" and say exactly what you need. While a loop is active, keep working toward the goal on every continuation instead of asking whether to continue.

Only control your own session's loop through the available tools. If this session has no Goal Loop MCP capability, this skill is inactive: do not try to create files, contact another session, or invent a substitute tool.`

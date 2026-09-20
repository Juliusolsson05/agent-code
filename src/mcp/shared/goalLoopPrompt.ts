export type GoalLoopContinuationPromptOptions = {
  goal: string
  loopPrompt: string
  iteration: number
  maxContinuations: number
}

/** WHY a user-visible prompt rather than hidden state: the loop's only
 * cross-provider instruction channel is the text we submit through the send
 * interface (same reasoning as buildOrchestrationBootstrapPrompt — Claude,
 * Codex and OpenCode share no richer per-turn side channel). The header
 * carries what changes per iteration; the agent-written loopPrompt stays
 * verbatim so the loop's own contract cannot drift between continuations. */
export function buildGoalLoopContinuationPrompt({
  goal, loopPrompt, iteration, maxContinuations,
}: GoalLoopContinuationPromptOptions): string {
  return [
    '<goal-loop-continuation>',
    `Agent Code goal loop, continuation ${iteration} of ${maxContinuations}.`,
    `Goal: ${goal.trim()}`,
    'You stopped before this goal was complete. Reassess what remains, then keep working.',
    'Call goal_loop_complete with outcome "done" ONLY when the goal is completely and utterly satisfied; call it with outcome "blocked" if you need the user. Otherwise continue working.',
    '</goal-loop-continuation>',
    '',
    '<loop-instruction>',
    loopPrompt.trim(),
    '</loop-instruction>',
  ].join('\n')
}

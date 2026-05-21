export type OrchestrationBootstrapPromptOptions = {
  task: string
}

/**
 * Wrap the first prompt sent to an orchestration child.
 *
 * WHY a user-visible prompt instead of hidden metadata:
 * Claude and Codex only reliably share one cross-provider instruction channel:
 * the text we submit to the child composer. Context inheritance used to clone
 * or translate the parent's transcript before sending this handoff, but that
 * path proved too unstable: children could inherit stale identity, provider
 * resume edges differed between Claude and Codex, and orchestration reads then
 * needed fragile transcript cut points to recover the child's real output. For
 * now the child always starts from a clean provider conversation. Keep the
 * handoff anyway because it is still the explicit, model-visible boundary that
 * says this pane is an orchestration worker and the task below is the active
 * instruction.
 */
export function buildOrchestrationBootstrapPrompt({
  task,
}: OrchestrationBootstrapPromptOptions): string {
  const trimmedTask = task.trim()

  return [
    '<orchestration-handoff>',
    'You are now an orchestrated child agent in Agent Code.',
    'You were started from a clean conversation because inherited parent transcript context is temporarily disabled.',
    'Do not assume you can see the parent conversation unless the task below includes the relevant context explicitly.',
    'Follow only the new task and instructions below.',
    '</orchestration-handoff>',
    '',
    '<task>',
    trimmedTask,
    '</task>',
  ].join('\n')
}

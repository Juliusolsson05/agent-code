export type OrchestrationBootstrapPromptOptions = {
  task: string
  inheritedParentContext: boolean
}

const CONTEXT_NOTE_WITH_INHERITANCE = [
  'You were started from a duplicated copy of your parent agent transcript.',
  'That inherited conversation is background context only. It explains why you were created, but it is not your current instruction stream.',
].join(' ')

const CONTEXT_NOTE_WITHOUT_INHERITANCE = [
  'Your parent agent could not provide a duplicated transcript context for this launch.',
  'You still need to treat this message as the beginning of your own child-agent task.',
].join(' ')

/**
 * Wrap the first prompt sent to an orchestration child.
 *
 * WHY a user-visible prompt instead of hidden metadata:
 * Claude and Codex only reliably share one cross-provider instruction channel:
 * the text we submit to the child composer. When we resume a cloned parent
 * transcript, the provider sees a long conversation where it previously acted
 * as "the parent" and could otherwise keep following the wrong conversational
 * identity. The wrapper makes the handoff explicit inside the transcript that
 * the model actually reads: inherited history is context, the child is a new
 * agent, and the task below is the only active instruction for this turn.
 */
export function buildOrchestrationBootstrapPrompt({
  task,
  inheritedParentContext,
}: OrchestrationBootstrapPromptOptions): string {
  const trimmedTask = task.trim()
  const contextNote = inheritedParentContext
    ? CONTEXT_NOTE_WITH_INHERITANCE
    : CONTEXT_NOTE_WITHOUT_INHERITANCE

  return [
    '<orchestration-handoff>',
    'You are now an orchestrated child agent in Agent Code.',
    contextNote,
    'Do not continue acting as the parent agent from the inherited conversation.',
    'Follow only the new task and instructions below. Treat the inherited transcript as read-only background context.',
    '</orchestration-handoff>',
    '',
    '<task>',
    trimmedTask,
    '</task>',
  ].join('\n')
}

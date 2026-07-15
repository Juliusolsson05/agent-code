import type {
  WorkflowAgentState,
  WorkflowContentReference,
} from '../model/workflowState'

import { WorkflowActivityRow } from './WorkflowActivityRow'

function referenceText(reference: WorkflowContentReference | undefined): string | null {
  if (!reference) return null
  // WHY this check precedes JSON.stringify: legacy workflow snapshots can retain enormous command
  // output objects. `max-height` only clips paint; it does not prevent serialization, text-node
  // creation, or layout. The preview is the contract specifically intended for this list/detail UI.
  if (reference.truncated) return reference.preview || null
  if (typeof reference.content === 'string') return reference.content
  if (reference.content !== undefined) {
    try {
      return JSON.stringify(reference.content, null, 2)
    } catch {
      return reference.preview
    }
  }
  return reference.preview || null
}

function DetailSlab({
  label,
  value,
  tone = 'normal',
}: {
  label: string
  value: string
  tone?: 'normal' | 'danger'
}): React.JSX.Element {
  return (
    <section>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
        {label}
      </div>
      <pre
        className={`m-0 max-h-[320px] overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-surface px-2.5 py-2 font-code text-[11px] leading-[1.55] ${
          tone === 'danger' ? 'text-danger' : 'text-ink-dim'
        }`}
      >
        {value}
      </pre>
    </section>
  )
}

export function WorkflowAgentDetails({
  agent,
}: {
  agent: WorkflowAgentState
}): React.JSX.Element {
  const prompt = referenceText(agent.prompt)
  const outcome = referenceText(agent.outcome?.result)
  const activities = agent.attempts.flatMap(attempt =>
    attempt.activities.map(activity => ({ attemptId: attempt.id, activity })),
  )

  return (
    <div className="ml-5 mt-1.5 space-y-3 border-l border-border pl-3 pb-2">
      {prompt ? <DetailSlab label="Prompt" value={prompt} /> : null}

      <section>
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
          Activity · {activities.length} {activities.length === 1 ? 'event' : 'events'}
        </div>
        {activities.length > 0 ? (
          <div className="divide-y divide-border">
            {activities.map(({ attemptId, activity }) => (
              <WorkflowActivityRow
                key={`${agent.id}:${attemptId}:${activity.activityId}`}
                activity={activity}
              />
            ))}
          </div>
        ) : (
          <div className="text-[11px] italic text-muted">
            {agent.status === 'running' || agent.status === 'queued'
              ? 'Waiting for provider activity…'
              : 'No activity was recorded.'}
          </div>
        )}
      </section>

      {outcome ? <DetailSlab label="Outcome" value={outcome} /> : null}
      {agent.error ? (
        <DetailSlab label="Error" value={agent.error.message} tone="danger" />
      ) : null}
      {agent.skippedReason ? (
        <DetailSlab label="Skipped" value={agent.skippedReason} />
      ) : null}
      {agent.cancelledReason ? (
        <DetailSlab label="Cancelled" value={agent.cancelledReason} />
      ) : null}
    </div>
  )
}

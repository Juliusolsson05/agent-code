import { useState } from 'react'

import type {
  WorkflowAgentState,
  WorkflowContentReference,
} from '../model/workflowState'

import { WorkflowActivityRow } from './WorkflowActivityRow'
import { boundedJsonPreview } from '@renderer/lib/text/boundedJson'
import { PagedTextViewer } from '@renderer/lib/text/PagedTextViewer'

const ACTIVITY_WINDOW = 100

function referenceText(reference: WorkflowContentReference | undefined): string | null {
  if (!reference) return null
  // WHY this check precedes JSON.stringify: legacy workflow snapshots can retain enormous command
  // output objects. `max-height` only clips paint; it does not prevent serialization, text-node
  // creation, or layout. The preview is the contract specifically intended for this list/detail UI.
  if (reference.truncated) return reference.preview || null
  if (typeof reference.content === 'string') return reference.content
  if (reference.content !== undefined) {
    return boundedJsonPreview(reference.content) ?? reference.preview
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
      <div
        className={`rounded border border-border bg-surface px-2.5 py-2 ${
          tone === 'danger' ? 'text-danger' : 'text-ink-dim'
        }`}
      >
        <PagedTextViewer source={value} isError={tone === 'danger'} />
      </div>
    </section>
  )
}

export function WorkflowAgentDetails({
  agent,
}: {
  agent: WorkflowAgentState
}): React.JSX.Element {
  const [visibleActivityCount, setVisibleActivityCount] = useState(ACTIVITY_WINDOW)
  const [activityWindowEnd, setActivityWindowEnd] = useState<number | null>(null)
  const prompt = referenceText(agent.prompt)
  const outcome = referenceText(agent.outcome?.result)
  const totalActivities = agent.attempts.reduce(
    (total, attempt) => total + attempt.activities.length,
    0,
  )
  const lastVisibleActivity = Math.min(activityWindowEnd ?? totalActivities, totalActivities)
  const firstVisibleActivity = Math.max(0, lastVisibleActivity - visibleActivityCount)
  const newerActivityCount = totalActivities - lastVisibleActivity
  const activities: Array<{
    attemptId: string
    activity: WorkflowAgentState['attempts'][number]['activities'][number]
  }> = []
  let activityOffset = 0
  for (const attempt of agent.attempts) {
    const attemptEnd = activityOffset + attempt.activities.length
    if (attemptEnd > firstVisibleActivity && activityOffset < lastVisibleActivity) {
      const localStart = Math.max(0, firstVisibleActivity - activityOffset)
      const localEnd = Math.min(attempt.activities.length, lastVisibleActivity - activityOffset)
      for (let index = localStart; index < localEnd; index += 1) {
        const activity = attempt.activities[index]
        if (activity) activities.push({ attemptId: attempt.id, activity })
      }
    }
    activityOffset = attemptEnd
  }

  return (
    <div className="ml-5 mt-1.5 space-y-3 border-l border-border pl-3 pb-2">
      {prompt ? <DetailSlab label="Prompt" value={prompt} /> : null}

      <section>
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
          Activity · {totalActivities} {totalActivities === 1 ? 'event' : 'events'}
        </div>
        {totalActivities > 0 ? (
          <div>
            {firstVisibleActivity > 0 ? (
              <button
                type="button"
                className="mb-1 w-full rounded py-1 text-center text-[10px] text-muted hover:bg-surface-hi hover:text-ink"
                onClick={() => {
                  // WHY the right edge freezes on first history expansion: otherwise every live
                  // append shifts the tail window and silently evicts the oldest row the user just
                  // asked to inspect, taking focus/disclosure state with it.
                  setActivityWindowEnd(current => current ?? totalActivities)
                  setVisibleActivityCount(current => current + ACTIVITY_WINDOW)
                }}
              >
                Show {Math.min(ACTIVITY_WINDOW, firstVisibleActivity)} earlier activities
              </button>
            ) : null}
            {newerActivityCount > 0 ? (
              <button
                type="button"
                className="mb-1 w-full rounded py-1 text-center text-[10px] text-muted hover:bg-surface-hi hover:text-ink"
                onClick={() => {
                  setActivityWindowEnd(null)
                  setVisibleActivityCount(ACTIVITY_WINDOW)
                }}
              >
                Show latest {Math.min(ACTIVITY_WINDOW, totalActivities)} activities · {newerActivityCount} new
              </button>
            ) : null}
            {/* WHY only a tail window has React elements: an active agent can
                accumulate hundreds of activity updates. Memoized children still
                require the parent to allocate and reconcile every element on
                every live event. The full immutable arrays remain in state;
                explicit paging admits at most 100 more rows per interaction. */}
            <div className="divide-y divide-border">
            {activities.map(({ attemptId, activity }) => (
              <WorkflowActivityRow
                key={`${agent.id}:${attemptId}:${activity.activityId}`}
                activity={activity}
              />
            ))}
            </div>
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

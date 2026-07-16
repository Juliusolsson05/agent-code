import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@renderer/components/ui/button'

import type { WorkflowRunReference } from '../client/WorkflowClient'
import { useWorkflowClient } from '../client/WorkflowClientContext'
import { mergeWorkflowLineage } from '../model/workflowLineage'
import { useWorkflowRun } from '../model/workflowRunStore'
import { WorkflowPhaseSection } from './WorkflowPhaseSection'

function runStatusLabel(status: string): string {
  return status.replace(/_/g, ' ').replace(/^./, first => first.toUpperCase())
}

function elapsedLabel(startedAt: string | undefined, completedAt: string | undefined, now: number): string {
  if (!startedAt) return ''
  const start = Date.parse(startedAt)
  const end = completedAt ? Date.parse(completedAt) : now
  if (!Number.isFinite(start) || !Number.isFinite(end)) return ''
  const total = Math.max(0, Math.round((end - start) / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = String(total % 60).padStart(2, '0')
  return minutes > 0 ? `${minutes}m${seconds}s` : `${seconds}s`
}

function useRunClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active])
  return now
}

/**
 * Full-pane workflow inspector selected from the session's view rows.
 *
 * WHY this no longer wraps MarkerRow: workflow execution is a sibling view of Main, not transcript
 * content. The session shell owns selection and swaps this component into the feed-sized viewport;
 * the composer and view rows remain mounted below it.
 */
export function WorkflowRunView({
  reference,
  cwd,
  onReferenceChange,
}: {
  reference: WorkflowRunReference
  cwd: string
  onReferenceChange: (reference: WorkflowRunReference) => void
}): React.JSX.Element {
  const client = useWorkflowClient()
  const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null)
  const [action, setAction] = useState<'cancel' | 'resume' | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const resumeKey = useRef(`renderer-resume:${reference.runId}:${Date.now()}`)

  useEffect(() => {
    setExpandedAgentId(null)
    resumeKey.current = `renderer-resume:${reference.runId}:${Date.now()}`
  }, [reference.runId])

  const effectiveCwd = reference.cwd ?? cwd
  const scope = useMemo(
    () => ({ cwd: effectiveCwd, runId: reference.runId }),
    [effectiveCwd, reference.runId],
  )
  const { view, store } = useWorkflowRun(client, scope)
  const snapshot = view.snapshot
  const displaySnapshot = useMemo(
    () => mergeWorkflowLineage(view.history, snapshot),
    [view.history, snapshot],
  )
  const status = view.phase !== 'ready' && view.cursor === 0
    ? reference.status ?? snapshot.status
    : snapshot.status
  const active = status === 'pending' || status === 'running' || status === 'cancellation_requested'
  const now = useRunClock(active)
  const elapsed = elapsedLabel(snapshot.startedAt, snapshot.completedAt, now)
  const workflow = snapshot.workflow ?? reference.workflow

  const agentsByPhase = useMemo(() => {
    const map = new Map<string, typeof displaySnapshot.agents>()
    for (const phase of displaySnapshot.phases) map.set(phase.id, [])
    map.set('__unassigned__', [])
    for (const agent of displaySnapshot.agents) {
      const key = agent.phaseId && map.has(agent.phaseId) ? agent.phaseId : '__unassigned__'
      map.get(key)!.push(agent)
    }
    return map
  }, [displaySnapshot.agents, displaySnapshot.phases])

  const toggleAgent = useCallback((agentId: string): void => {
    // Exactly one expanded agent keeps a 76-agent workflow readable: expansion replaces the
    // selected detail in place instead of turning every row into an independently growing panel.
    setExpandedAgentId(current => current === agentId ? null : agentId)
  }, [])

  const cancel = async (): Promise<void> => {
    setAction('cancel')
    setActionError(null)
    try {
      await client.cancel({ ...scope, reason: 'Cancelled from Agent Code workflow inspector' })
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setAction(null)
    }
  }

  const resume = async (): Promise<void> => {
    setAction('resume')
    setActionError(null)
    try {
      const next = await client.resume({ ...scope, idempotencyKey: resumeKey.current })
      // Resume creates a new durable run instead of appending impossible post-terminal events to
      // the old run. The session shell retains this replacement against the original navigation
      // slot so switching to Main and back does not silently return to the terminal parent run.
      onReferenceChange({ ...next, resumedFromRunId: scope.runId })
      setExpandedAgentId(null)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setAction(null)
    }
  }

  const unassigned = agentsByPhase.get('__unassigned__') ?? []
  const canResume = ['failed', 'cancelled', 'interrupted'].includes(status)

  return (
    <div
      data-workflow-run-id={reference.runId}
      className="h-full min-h-0 overflow-y-auto bg-canvas"
    >
      <article
        className="mx-auto min-w-0 max-w-4xl px-4 py-4"
      >
        <header className="flex min-w-0 items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="truncate text-[13px] font-semibold text-ink">
                {workflow?.title ?? workflow?.name ?? 'Workflow'}
              </span>
              <span className="text-[10px] uppercase tracking-wider text-muted">
                {runStatusLabel(status)}
              </span>
            </div>
            {workflow?.description ? (
              <div className="mt-0.5 line-clamp-2 text-[11px] leading-[1.45] text-ink-dim">
                {workflow.description}
              </div>
            ) : null}
            <div className="mt-1 flex flex-wrap gap-x-2 text-[10px] text-muted">
              <span>{displaySnapshot.counts.completed}/{displaySnapshot.counts.total} agents</span>
              {displaySnapshot.counts.running > 0 ? <span>{displaySnapshot.counts.running} running</span> : null}
              {displaySnapshot.counts.failed > 0 ? (
                <span className="text-danger">{displaySnapshot.counts.failed} failed</span>
              ) : null}
              {displaySnapshot.counts.reused > 0 ? <span>{displaySnapshot.counts.reused} cached</span> : null}
              {elapsed ? <span>{elapsed}</span> : null}
            </div>
          </div>
          {client.available && effectiveCwd ? (
            <div className="flex shrink-0 gap-1">
              {/* These are ordinary feature actions, so they deliberately use
                  the shared Button primitive introduced after this workflow
                  surface was built. The row/tab/disclosure buttons elsewhere
                  in this feature keep their native specialized layouts: they
                  are navigation widgets, not generic action controls, and
                  forcing them through Button would erase their ARIA/layout
                  semantics merely for visual uniformity. */}
              {active ? (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={action !== null}
                  onClick={() => void cancel()}
                >
                  {action === 'cancel' ? 'Cancelling…' : 'Cancel'}
                </Button>
              ) : null}
              {canResume ? (
                <Button
                  type="button"
                  size="xs"
                  disabled={action !== null}
                  onClick={() => void resume()}
                >
                  {action === 'resume' ? 'Resuming…' : 'Resume'}
                </Button>
              ) : null}
            </div>
          ) : null}
        </header>

        {reference.resumedFromRunId ? (
          <div className="mt-2 text-[10px] text-muted">
            Resumed from {reference.resumedFromRunId}
          </div>
        ) : null}

        {view.phase === 'loading' ? (
          <div className="mt-3 text-[11px] text-muted">Loading workflow activity…</div>
        ) : null}
        {view.phase === 'unavailable' || !effectiveCwd ? (
          <div className="mt-3 text-[11px] text-muted">
            Live workflow details are unavailable in this client.
          </div>
        ) : null}
        {view.phase === 'error' ? (
          <div className="mt-3 flex items-center gap-2 text-[11px] text-danger">
            <span>{view.error}</span>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => store.retry()}
              className="border-danger/40 text-danger hover:border-danger hover:text-danger"
            >
              Retry
            </Button>
          </div>
        ) : null}
        {actionError ? <div className="mt-2 text-[11px] text-danger">{actionError}</div> : null}

        {displaySnapshot.phases.length > 0 || displaySnapshot.agents.length > 0 ? (
          <div className="mt-3 flex flex-col gap-2">
            {displaySnapshot.phases.map(phase => (
              <WorkflowPhaseSection
                key={phase.id}
                phase={phase}
                agents={agentsByPhase.get(phase.id) ?? []}
                expandedAgentId={expandedAgentId}
                onToggleAgent={toggleAgent}
              />
            ))}
            {unassigned.length > 0 ? (
              <WorkflowPhaseSection
                phase={{ id: '__unassigned__', title: 'Agents', complete: !active }}
                agents={unassigned}
                expandedAgentId={expandedAgentId}
                onToggleAgent={toggleAgent}
              />
            ) : null}
          </div>
        ) : null}
      </article>
    </div>
  )
}

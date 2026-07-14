import { useContext, useEffect, useMemo, useRef, useState } from 'react'

import { CodeRenderContext } from '@renderer/features/feed/context'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'

import type { WorkflowRunReference } from '../client/WorkflowClient'
import { useWorkflowClient } from '../client/WorkflowClientContext'
import { useWorkflowRun } from '../model/workflowRunStore'
import { WorkflowPhaseSection } from './WorkflowPhaseSection'

function runGlyph(status: string): string {
  if (status === 'completed') return '✓'
  if (status === 'failed') return '✗'
  if (status === 'cancelled' || status === 'interrupted') return '■'
  if (status === 'pending') return '◌'
  return '◉'
}

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

export function WorkflowLaunchPendingRow(): React.JSX.Element {
  return (
    <MarkerRow marker="◉">
      <div className="flex items-baseline gap-2 text-[13px]">
        <span className="font-semibold text-ink">Workflow</span>
        <span className="text-[11px] text-muted">starting…</span>
      </div>
    </MarkerRow>
  )
}

/**
 * The workflow inspector is deliberately a feed leaf, not a second feed implementation.
 *
 * The transcript ledger still decides whether and where the MCP tool call appears. This component
 * only follows the clean runId that tool returned and projects the workflow service's own event
 * stream. Keeping those ownership planes separate prevents workflow activity from being re-parsed
 * as chat transcript content or reordered around user prompts.
 */
export function WorkflowRunRow({
  reference,
}: {
  reference: WorkflowRunReference
}): React.JSX.Element {
  const client = useWorkflowClient()
  const { workspaceRoot } = useContext(CodeRenderContext)
  const [activeReference, setActiveReference] = useState(reference)
  const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null)
  const [action, setAction] = useState<'cancel' | 'resume' | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const resumeKey = useRef(`renderer-resume:${reference.runId}:${Date.now()}`)

  useEffect(() => {
    setActiveReference(reference)
    setExpandedAgentId(null)
    resumeKey.current = `renderer-resume:${reference.runId}:${Date.now()}`
  }, [reference.runId])

  const cwd = activeReference.cwd ?? workspaceRoot ?? ''
  const scope = useMemo(
    () => ({ cwd, runId: activeReference.runId }),
    [cwd, activeReference.runId],
  )
  const { view, store } = useWorkflowRun(client, scope)
  const snapshot = view.snapshot
  const status = view.phase !== 'ready' && view.cursor === 0
    ? activeReference.status ?? snapshot.status
    : snapshot.status
  const active = status === 'pending' || status === 'running' || status === 'cancellation_requested'
  const now = useRunClock(active)
  const elapsed = elapsedLabel(snapshot.startedAt, snapshot.completedAt, now)
  const workflow = snapshot.workflow ?? activeReference.workflow

  const agentsByPhase = useMemo(() => {
    const map = new Map<string, typeof snapshot.agents>()
    for (const phase of snapshot.phases) map.set(phase.id, [])
    map.set('__unassigned__', [])
    for (const agent of snapshot.agents) {
      const key = agent.phaseId && map.has(agent.phaseId) ? agent.phaseId : '__unassigned__'
      map.get(key)!.push(agent)
    }
    return map
  }, [snapshot.agents, snapshot.phases])

  const toggleAgent = (agentId: string): void => {
    // Exactly one expanded agent keeps a 76-agent workflow readable: expansion replaces the
    // selected detail in place instead of turning every row into an independently growing panel.
    setExpandedAgentId(current => current === agentId ? null : agentId)
  }

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
      // the old run. Following the returned run in this same card preserves the user's place while
      // retaining `resumedFromRunId` as an explicit lineage label.
      setActiveReference({ ...next, resumedFromRunId: scope.runId })
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
    <MarkerRow marker={runGlyph(status)}>
      <article
        data-workflow-run-id={activeReference.runId}
        className="min-w-0 rounded-md border border-border bg-surface-hi/40 px-3 py-2.5"
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
              <span>{snapshot.counts.completed}/{snapshot.counts.total} agents</span>
              {snapshot.counts.running > 0 ? <span>{snapshot.counts.running} running</span> : null}
              {snapshot.counts.failed > 0 ? (
                <span className="text-danger">{snapshot.counts.failed} failed</span>
              ) : null}
              {snapshot.counts.reused > 0 ? <span>{snapshot.counts.reused} cached</span> : null}
              {elapsed ? <span>{elapsed}</span> : null}
            </div>
          </div>
          {client.available && cwd ? (
            <div className="flex shrink-0 gap-1">
              {active ? (
                <button
                  type="button"
                  disabled={action !== null}
                  onClick={() => void cancel()}
                  className="rounded border border-border px-2 py-1 text-[10px] text-muted hover:text-ink disabled:opacity-50"
                >
                  {action === 'cancel' ? 'Cancelling…' : 'Cancel'}
                </button>
              ) : null}
              {canResume ? (
                <button
                  type="button"
                  disabled={action !== null}
                  onClick={() => void resume()}
                  className="rounded border border-border px-2 py-1 text-[10px] text-accent hover:bg-surface-hi disabled:opacity-50"
                >
                  {action === 'resume' ? 'Resuming…' : 'Resume'}
                </button>
              ) : null}
            </div>
          ) : null}
        </header>

        {activeReference.resumedFromRunId ? (
          <div className="mt-2 text-[10px] text-muted">
            Resumed from {activeReference.resumedFromRunId}
          </div>
        ) : null}

        {view.phase === 'loading' ? (
          <div className="mt-3 text-[11px] text-muted">Loading workflow activity…</div>
        ) : null}
        {view.phase === 'unavailable' || !cwd ? (
          <div className="mt-3 text-[11px] text-muted">
            Live workflow details are unavailable in this client.
          </div>
        ) : null}
        {view.phase === 'error' ? (
          <div className="mt-3 flex items-center gap-2 text-[11px] text-danger">
            <span>{view.error}</span>
            <button
              type="button"
              onClick={() => store.retry()}
              className="rounded border border-danger/40 px-1.5 py-0.5"
            >
              Retry
            </button>
          </div>
        ) : null}
        {actionError ? <div className="mt-2 text-[11px] text-danger">{actionError}</div> : null}

        {snapshot.phases.length > 0 || snapshot.agents.length > 0 ? (
          <div className="mt-3 flex flex-col gap-2">
            {snapshot.phases.map(phase => (
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
    </MarkerRow>
  )
}

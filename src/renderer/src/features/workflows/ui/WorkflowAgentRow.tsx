import { memo } from 'react'

import type { WorkflowAgentState } from '../model/workflowState'

import { WorkflowAgentDetails } from './WorkflowAgentDetails'

function statusGlyph(status: WorkflowAgentState['status']): string {
  switch (status) {
    case 'completed': return '✓'
    case 'failed': return '✗'
    case 'running': return '◉'
    case 'queued': return '◌'
    case 'cancelled': return '■'
    case 'skipped': return '–'
    default: return '○'
  }
}

function agentRightLabel(agent: WorkflowAgentState): string {
  if (agent.outcome?.source === 'journal') return 'Completed · cached'
  if (agent.outcome?.source === 'provider-resume') return 'Completed · resumed'
  if (agent.status === 'running') {
    const toolCount = agent.attempts.reduce((count, attempt) => count + attempt.activities.length, 0)
    return `Running · ${toolCount} ${toolCount === 1 ? 'activity' : 'activities'}`
  }
  if (agent.status === 'queued' && agent.queuedAt) return agent.queueReason ?? 'Queued'
  const provider = agent.attempts.at(-1)?.provider
  const status = agent.status.charAt(0).toUpperCase() + agent.status.slice(1)
  return provider ? `${status} · ${provider}` : status
}

function WorkflowAgentRowImpl({
  agent,
  expanded,
  onToggle,
}: {
  agent: WorkflowAgentState
  expanded: boolean
  onToggle: (agentId: string) => void
}): React.JSX.Element {
  const glyph = statusGlyph(agent.status)
  return (
    <div data-workflow-agent-id={agent.id}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => onToggle(agent.id)}
        className="grid w-full cursor-pointer grid-cols-[16px_minmax(0,1fr)_auto_14px] items-baseline gap-x-2 rounded px-1 py-1.5 text-left hover:bg-surface-hi focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      >
        <span
          aria-hidden="true"
          className={agent.status === 'failed' ? 'text-danger' : 'text-muted'}
        >
          {glyph}
        </span>
        <span className="min-w-0 truncate text-[12px] font-medium text-ink">
          {agent.label || `agent:${agent.callIndex}`}
        </span>
        <span className="whitespace-nowrap text-[10px] text-muted">
          {agentRightLabel(agent)}
        </span>
        <span aria-hidden="true" className="text-muted">{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded ? <WorkflowAgentDetails agent={agent} /> : null}
    </div>
  )
}

function sameAttempts(
  left: WorkflowAgentState['attempts'],
  right: WorkflowAgentState['attempts'],
): boolean {
  if (left.length !== right.length) return false
  return left.every((attempt, index) => {
    const candidate = right[index]
    return candidate !== undefined &&
      attempt.id === candidate.id &&
      attempt.status === candidate.status &&
      attempt.provider === candidate.provider &&
      attempt.completedAt === candidate.completedAt &&
      attempt.providerSession === candidate.providerSession &&
      attempt.usage === candidate.usage &&
      attempt.error === candidate.error &&
      attempt.activities === candidate.activities
  })
}

function sameAgentRow(
  previous: Parameters<typeof WorkflowAgentRowImpl>[0],
  next: Parameters<typeof WorkflowAgentRowImpl>[0],
): boolean {
  if (previous.expanded !== next.expanded || previous.onToggle !== next.onToggle) return false
  const left = previous.agent
  const right = next.agent
  // WHY this compares render-bearing fields instead of agent object identity: lineage composition
  // intentionally creates a fresh agent shell to join immutable attempts from parent runs. Most
  // live events touch one agent, so object identity would still rerender every row in the lineage.
  // Activity arrays preserve identity for untouched attempts and give us a cheap exact boundary.
  return left.id === right.id &&
    left.label === right.label &&
    left.status === right.status &&
    left.queuedAt === right.queuedAt &&
    left.queueReason === right.queueReason &&
    left.prompt === right.prompt &&
    left.outcome === right.outcome &&
    left.error === right.error &&
    left.skippedReason === right.skippedReason &&
    left.cancelledReason === right.cancelledReason &&
    sameAttempts(left.attempts, right.attempts)
}

export const WorkflowAgentRow = memo(WorkflowAgentRowImpl, sameAgentRow)

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
  if (agent.status === 'queued' && agent.queuedAt) return 'Queued'
  const provider = agent.attempts.at(-1)?.provider
  const status = agent.status.charAt(0).toUpperCase() + agent.status.slice(1)
  return provider ? `${status} · ${provider}` : status
}

export function WorkflowAgentRow({
  agent,
  expanded,
  onToggle,
}: {
  agent: WorkflowAgentState
  expanded: boolean
  onToggle: () => void
}): React.JSX.Element {
  const glyph = statusGlyph(agent.status)
  return (
    <div data-workflow-agent-id={agent.id}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
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

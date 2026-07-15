import type { WorkflowAgentState, WorkflowPhaseState } from '../model/workflowState'

import { WorkflowAgentRow } from './WorkflowAgentRow'

export function WorkflowPhaseSection({
  phase,
  agents,
  expandedAgentId,
  onToggleAgent,
}: {
  phase: Pick<WorkflowPhaseState, 'id' | 'title' | 'detail' | 'complete'>
  agents: WorkflowAgentState[]
  expandedAgentId: string | null
  onToggleAgent: (agentId: string) => void
}): React.JSX.Element {
  const completed = agents.filter(agent =>
    ['completed', 'failed', 'skipped', 'cancelled'].includes(agent.status),
  ).length
  return (
    <section className="rounded border border-border bg-surface px-2 py-2">
      <div className="mb-1.5 flex items-baseline gap-2 border-b border-border px-1 pb-1.5">
        <span className="text-[11px] font-semibold text-ink">{phase.title}</span>
        <span className="text-[10px] text-muted">
          {completed}/{agents.length} agents
        </span>
        <span className="ml-auto text-[10px] text-muted">
          {phase.complete ? 'done' : 'active'}
        </span>
      </div>
      {phase.detail ? (
        <div className="mb-1.5 px-1 text-[11px] leading-[1.5] text-ink-dim">
          {phase.detail}
        </div>
      ) : null}
      <div className="flex flex-col">
        {agents.map(agent => (
          <WorkflowAgentRow
            key={agent.id}
            agent={agent}
            expanded={expandedAgentId === agent.id}
            onToggle={onToggleAgent}
          />
        ))}
        {agents.length === 0 ? (
          <div className="px-1 py-1 text-[11px] italic text-muted">Waiting for agents…</div>
        ) : null}
      </div>
    </section>
  )
}

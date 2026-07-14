import { useContext } from 'react'

import { SubAgentsContext } from '@renderer/features/feed/context'

// The "Spawned N agents · ◐ R running · ✓ D done" line that sits above a run
// of sibling `Agent` tool_use blocks (the main agent fired several subagents in
// one turn). Answers "how many are running right now" at a glance. The
// per-agent rows render below it (TaskSubagentRow), so this is just the live
// tally — derived from SubAgentsContext for the given parent tool_use ids.
export function SubagentGroupHeader({ toolUseIds }: { toolUseIds: string[] }) {
  const subAgents = useContext(SubAgentsContext)
  const states = toolUseIds.map(id => subAgents[id]).filter(Boolean)
  const running = states.filter(s => s.status === 'running').length
  const done = states.filter(s => s.status === 'done').length
  const failed = states.filter(s => s.status === 'error').length

  const parts: string[] = []
  if (running > 0) parts.push(`◐ ${running} running`)
  if (done > 0) parts.push(`✓ ${done} done`)
  if (failed > 0) parts.push(`✗ ${failed} failed`)

  return (
    <div className="flex items-center gap-2 text-[13px] leading-[1.65]">
      <span className="text-accent font-semibold">
        Spawned {toolUseIds.length} agents
      </span>
      {parts.length > 0 && (
        <span className="text-muted text-[11px]">{parts.join(' · ')}</span>
      )}
    </div>
  )
}

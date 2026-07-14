import { memo, useContext } from 'react'

import { SubAgentsContext } from '@renderer/features/feed/context'

/**
 * A tally above adjacent sibling spawns from one provider turn.
 *
 * WHY this is a sibling presentation node rather than a wrapper: nesting the
 * operation rows under a group keyed by their committed entry would reparent
 * them during semantic -> committed hand-off and discard expansion/scroll
 * state. The projector adds this header without changing any operation id.
 */
export const CollaborationGroupRow = memo(function CollaborationGroupRow({
  toolUseIds,
}: {
  toolUseIds: string[]
}) {
  const subAgents = useContext(SubAgentsContext)
  const states = toolUseIds.map(id => subAgents[id]).filter(Boolean)
  const running = states.filter(state => state.status === 'running').length
  const done = states.filter(state => state.status === 'done').length
  const failed = states.filter(state => state.status === 'error').length

  const parts: string[] = []
  if (running > 0) parts.push(`◐ ${running} running`)
  if (done > 0) parts.push(`✓ ${done} done`)
  if (failed > 0) parts.push(`✗ ${failed} failed`)

  return (
    <div
      data-collaboration-group
      className="flex items-center gap-2 text-[13px] leading-[1.65]"
    >
      <span className="text-accent font-semibold">
        Spawned {toolUseIds.length} agents
      </span>
      {parts.length > 0 ? (
        <span className="text-muted text-[11px]">{parts.join(' · ')}</span>
      ) : null}
    </div>
  )
})

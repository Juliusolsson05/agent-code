import { useAgentName } from '@renderer/workspace/agentNames/useAgentName'
import type { SessionId } from '@renderer/workspace/types'

// One visual contract for explicit agent titles and spoken agent names across
// the structured Agent surface and the raw agent-terminal surface. Plain shell
// terminals intentionally do not use this component: titles belong to provider
// agents and the command refuses terminal targets at the mutation boundary too.
// The name selector refuses them a second time, so a terminal that somehow
// mounts this still renders nothing.
//
// WHY the component subscribes rather than taking `agentName` as a prop: both
// call sites sit on the hot pane-render path and already thread a dozen props;
// see useAgentName for why a primitive subscription is cheaper than widening
// them.
export function AgentTitleHeader({ sessionId, title }: { sessionId: SessionId; title?: string }) {
  const agentName = useAgentName(sessionId)
  const visibleTitle = title?.trim()
  // WHY the guard now checks BOTH: this row used to exist only for a title, so
  // an untitled agent rendered nothing. With names on, that would hide the only
  // address a voice operator can use while the operator can still reach it.
  if (!visibleTitle && !agentName) return null

  return (
    <div
      data-agent-title-header="true"
      className="flex min-w-0 items-center gap-2 border-t border-border/70 bg-canvas px-3 py-1 font-code text-[11px] font-medium text-ink select-none"
      title={[agentName, visibleTitle].filter(Boolean).join(' — ')}
    >
      {agentName && (
        // Fixed width contribution, never truncated: the name is the thing a
        // user says out loud, so it must survive a narrow Tiled Dispatch lane
        // even when the title does not.
        <span
          data-agent-name-badge="true"
          className="flex-shrink-0 rounded-chip border border-border px-1 leading-[14px] text-[10px] font-semibold tracking-wide text-ink"
        >
          {agentName}
        </span>
      )}
      {visibleTitle && <div className="truncate">{visibleTitle}</div>}
    </div>
  )
}

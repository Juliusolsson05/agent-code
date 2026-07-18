import { useContext, useState } from 'react'

import type { CodexNativeSpawnModel } from '@providers/codex/renderer/adapters/collaboration'
import {
  SubAgentsContext,
  ToolResultIndexContext,
} from '@renderer/features/feed/context'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { SubagentMiniFeed } from '@renderer/features/feed/ui/rows/SubagentMiniFeed'
import { PagedTextViewer } from '@renderer/lib/text/PagedTextViewer'

export function CodexNativeSpawnRow({ model }: { model: CodexNativeSpawnModel }) {
  const [open, setOpen] = useState(false)
  const subagent = useContext(SubAgentsContext)[model.operationId]
  const committed = useContext(ToolResultIndexContext).get(model.operationId) ?? null
  // WHY Codex deliberately does not consult TaskNotificationsContext:
  // `<task-notification>` is a Claude transcript grammar. Codex completion
  // arrives through function_call_output / committed tool_result evidence,
  // with the subagent watcher providing richer state while the child is live.
  // The former cross-provider fallback could let an impossible Claude-shaped
  // side channel override real Codex evidence and kept the central XML parser
  // coupled to every provider card merely for speculative compatibility.
  const state = subagent?.status ?? (committed
    ? committed.is_error === true ? 'error' : 'reported'
    : 'running')
  const unverifiedReport = !subagent && committed?.is_error !== true && Boolean(committed)
  const marker = state === 'done'
    ? '✓'
    : state === 'error'
      ? '✗'
      : state === 'stale' || unverifiedReport
        ? '◌'
        : '◐'
  const toolCount = subagent ? subagent.toolCalls.length + subagent.droppedToolCalls : 0
  const status = subagent
    ? subagent.status === 'running'
      ? `${toolCount} tool${toolCount === 1 ? '' : 's'}`
      : subagent.status === 'error' ? 'failed' : subagent.status
    : committed ? committed.is_error === true ? 'failed' : 'response received' : 'starting…'

  // WHY a result without transport-level is_error is only "reported", not
  // "spawned": Codex function_call_output has no universal success bit and
  // both observed spawn generations use different acknowledgement fields.
  // The separate structured result row preserves those fields; this card must
  // not convert mere response presence into a success claim.

  return (
    <MarkerRow marker={marker}>
      <div>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(current => !current)}
          className="flex w-full items-center gap-2 cursor-pointer text-left text-[13px] leading-[1.65]"
        >
          <span className="text-muted shrink-0">Codex agent</span>
          <span className="text-ink flex-1 min-w-0 truncate" title={model.description}>
            {model.agentType} · {model.description}
          </span>
          <span className="text-muted text-[11px] whitespace-nowrap">{status}</span>
          <span className="text-muted shrink-0" aria-hidden="true">{open ? '▾' : '▸'}</span>
        </button>
        {/* WHY the full delegated message and child timeline are click-only:
            spawn prompts are often entire research briefs, and a fan-out turn
            may contain many siblings. Closed cards must stay O(1) DOM while
            retaining exact instructions for audit. */}
        {open ? (
          <div className="mt-2 ml-4 border-l border-border/60 pl-3 space-y-2">
            <section aria-label="Codex delegated task">
              <div className="text-muted text-[10px] uppercase tracking-wider mb-1">Delegated task</div>
              <PagedTextViewer source={model.prompt} />
            </section>
            {subagent ? <SubagentMiniFeed sa={subagent} /> : null}
          </div>
        ) : null}
      </div>
    </MarkerRow>
  )
}

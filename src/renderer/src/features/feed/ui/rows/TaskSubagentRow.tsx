import { memo, useContext, useState } from 'react'

import type { ToolUseBlock } from '@shared/types/transcript'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { SubAgentsContext } from '@renderer/features/feed/context'
import { SubagentMiniFeed } from '@renderer/features/feed/ui/rows/SubagentMiniFeed'

// Renderer for an `Agent` tool_use block — the card the main agent shows when
// it spawns a subagent. Replaces the generic ToolUseRow (which only printed
// "Agent" + the description and never updated) with a live, expandable card.
//
// Live state comes from SubAgentsContext keyed by this block's id — which the
// main-process watcher links via meta.toolUseId. Until the subagent's file is
// observed (or if it lacks meta.toolUseId), we fall back to the raw `Agent`
// tool_use input so the card still reads correctly; it just won't have counts.

function elapsedLabel(startedAt: number | null, lastAt: number | null): string {
  if (startedAt == null || lastAt == null) return ''
  const s = Math.max(0, Math.round((lastAt - startedAt) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export const TaskSubagentRow = memo(function TaskSubagentRow({
  block,
}: {
  block: ToolUseBlock
}) {
  const subAgents = useContext(SubAgentsContext)
  const sa = subAgents[block.id]
  const [open, setOpen] = useState(false)

  const input = block.input as Record<string, unknown> | undefined
  const agentType =
    sa?.agentType ??
    (typeof input?.subagent_type === 'string'
      ? input.subagent_type
      : typeof input?.agent_type === 'string'
        ? input.agent_type
        : 'agent')
  const description =
    sa?.description ??
    (typeof input?.description === 'string'
      ? input.description
      : typeof input?.message === 'string'
        ? input.message
        : '')

  const glyph =
    sa?.status === 'done' ? '✓' : sa?.status === 'error' ? '✗' : '◐'
  const toolTotal = sa ? sa.toolCalls.length + sa.droppedToolCalls : 0
  const right = !sa
    ? 'starting…'
    : sa.status === 'running'
      ? `${toolTotal} tools · ${elapsedLabel(sa.startedAt, sa.lastActivityAt)}`
      : `${toolTotal} tools · ${
          sa.status === 'error' ? 'failed' : 'done'
        }`

  return (
    <MarkerRow marker={glyph}>
      <div>
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          className="flex w-full items-center gap-2 cursor-pointer text-left text-[13px] leading-[1.65]"
        >
          <span className="text-muted shrink-0">{agentType}</span>
          <span className="text-ink flex-1 min-w-0 truncate">{description}</span>
          <span className="text-muted text-[11px] whitespace-nowrap">{right}</span>
          <span className="text-muted shrink-0">{open ? '▾' : '▸'}</span>
        </button>
        {open && sa && <SubagentMiniFeed sa={sa} />}
      </div>
    </MarkerRow>
  )
})

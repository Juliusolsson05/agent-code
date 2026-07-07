import { memo, useContext, useState } from 'react'

import type { ToolUseBlock } from '@shared/types/transcript'
import {
  taskNotificationStatusKind,
} from '@renderer/features/feed/lib/taskNotification'
import { TaskNotificationsContext } from '@renderer/features/feed/context'
import { TextProse } from '@renderer/features/feed/ui/markdown'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { SubAgentsContext } from '@renderer/features/feed/context'
import { ToolResultIndexContext } from '@renderer/features/feed/context'
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
  // P2b evidence priority: the task-notification is the child's OWN
  // completion report — it outranks watcher-derived state (which can be
  // stale/pruned) and fills status even when the watcher never tracked
  // this child (MCP-spawned, cross-session).
  const notifications = useContext(TaskNotificationsContext)
  const notification = block.id ? notifications.get(block.id) ?? null : null
  const notifKind = notification ? taskNotificationStatusKind(notification) : null
  // C3: the committed tool_result for this Agent block. SubAgentsContext
  // entries are pruned after SUBAGENT_PRUNE_AFTER_MS, and once `sa` is gone
  // this row would otherwise fall back to the live spinner ('◐'/'starting…')
  // even for a subagent that already FINISHED — a completed synchronous Task
  // that never emitted a <task-notification> (so notifKind is null) would
  // visibly regress to "running" after pruning. The committed tool_result is
  // the durable source of truth the prune logic itself relies on ("committed
  // tool_result owns the truth"): if it exists, the child's Agent call has
  // returned, so we can render a terminal state without watcher state.
  const toolResults = useContext(ToolResultIndexContext)
  const committed = block.id ? toolResults.get(block.id) ?? null : null
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
    notifKind === 'done'
      ? '✓'
      : notifKind === 'error'
        ? '✗'
        : notifKind === 'other'
          ? // C11: a notification is PRESENT but its status is not one we map
            // to done/error ('other'). The child reported something terminal —
            // rendering the live spinner '◐' beside that raw status text would
            // falsely imply the subagent is still in flight. Show a neutral,
            // non-spinning glyph ('◌') so an unrecognized-but-present
            // notification can never masquerade as running.
            '◌'
          : sa?.status === 'done'
            ? '✓'
            : sa?.status === 'error'
              ? '✗'
              : sa?.status === 'stale'
                ? '◌'
                : // C3: no notification (notifKind === null) and the watcher
                  // entry has been pruned (sa absent). If the committed
                  // tool_result exists, the Agent call has returned — derive a
                  // terminal glyph from it instead of flipping back to the live
                  // spinner '◐'. is_error distinguishes a failed sync Task.
                  !sa && committed
                  ? committed.is_error
                    ? '✗'
                    : '✓'
                  : '◐'
  const toolTotal = sa ? sa.toolCalls.length + sa.droppedToolCalls : 0
  const right = notification
    ? `${notification.status ?? 'completed'}${notification.usage ? ` · ${notification.usage}` : ''}`
    : !sa
    ? // C3: watcher entry pruned. If the committed tool_result exists the
      // Agent call finished — label it terminally ('done'/'failed') rather
      // than the misleading 'starting…', which would imply the subagent is
      // just now spinning up when it has in fact already completed.
      committed
      ? committed.is_error
        ? 'failed'
        : 'done'
      : 'starting…'
    : sa.status === 'running'
      ? `${toolTotal} tools · ${elapsedLabel(sa.startedAt, sa.lastActivityAt)}`
      : sa.status === 'stale'
        ? // #341: "gone quiet" — never an eternal spinner, never a
          // fabricated "done". Minutes-ago anchors WHEN it went dark.
          `${toolTotal} tools · quiet ${
            sa.lastActivityAt !== null
              ? `${Math.max(1, Math.round((Date.now() - sa.lastActivityAt) / 60_000))}m`
              : ''
          }`
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
        {open && notification?.result && (
          // The child's own report, delivered by its notification — the
          // content that used to drown as raw XML in a queued <li>
          // (2026-06-29 "agent output is buried" bundle).
          <div className="mt-1 text-[12px]">
            <TextProse text={notification.result} />
          </div>
        )}
      </div>
    </MarkerRow>
  )
})

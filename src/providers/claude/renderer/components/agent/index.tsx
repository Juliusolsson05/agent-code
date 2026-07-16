import { useContext, useState } from 'react'

import {
  fromClaudeAgentResult,
  type ClaudeAgentModel,
} from '@providers/claude/renderer/adapters/collaboration'
import { LazyTextProse } from '@providers/shared/renderer/components/lazy-prose'
import {
  SubAgentsContext,
  TaskNotificationsContext,
  ToolResultIndexContext,
} from '@renderer/features/feed/context'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { SubagentMiniFeed } from '@renderer/features/feed/ui/rows/SubagentMiniFeed'
import { taskNotificationStatusKind } from '@renderer/session-runtime/taskNotification'

function elapsedLabel(startedAt: number | null, lastAt: number | null): string | null {
  if (startedAt === null || lastAt === null) return null
  const seconds = Math.max(0, Math.round((lastAt - startedAt) / 1_000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function ClaudeAgentRow({ model }: { model: ClaudeAgentModel }) {
  const [open, setOpen] = useState(false)
  const subagent = useContext(SubAgentsContext)[model.operationId]
  const notification = useContext(TaskNotificationsContext).get(model.operationId) ?? null
  const committed = useContext(ToolResultIndexContext).get(model.operationId) ?? null
  const source = {
    type: 'tool_use' as const,
    id: model.operationId,
    name: 'Agent',
    input: {
      description: model.description,
      prompt: model.prompt,
      subagent_type: model.agentType,
      ...(model.background ? { run_in_background: true } : {}),
    },
  }
  const durableResult = committed ? fromClaudeAgentResult(committed, source) : null

  // Status precedence follows evidence durability, not arrival timing. A task
  // notification is the child's explicit terminal report; watcher state is
  // richer while live; a committed result proves completion after watcher
  // pruning. None of those signals is inferred from terminal screen text.
  const notificationKind = notification ? taskNotificationStatusKind(notification) : null
  const state = notificationKind
    ? notificationKind
    : (subagent?.status ?? (committed ? (committed.is_error ? 'error' : 'done') : 'running'))
  const marker =
    state === 'done'
      ? '✓'
      : state === 'error'
        ? '✗'
        : state === 'stale' || state === 'other'
          ? '◌'
          : '◐'
  const toolTotal = subagent ? subagent.toolCalls.length + subagent.droppedToolCalls : 0
  const elapsed = subagent ? elapsedLabel(subagent.startedAt, subagent.lastActivityAt) : null
  const status = notification
    ? // A notification without a recognized/raw status proves that the child
      // reported, not that it succeeded. "reported" keeps the neutral marker
      // and label aligned instead of fabricating completion.
      `${notification.status ?? 'reported'}${notification.usage ? ` · ${notification.usage}` : ''}`
    : !subagent
      ? committed
        ? committed.is_error
          ? 'failed'
          : 'done'
        : model.background
          ? 'starting in background…'
          : 'starting…'
      : subagent.status === 'running'
        ? `${toolTotal} tools${elapsed ? ` · ${elapsed}` : ''}`
        : subagent.status === 'stale'
          ? `${toolTotal} tools · quiet`
          : `${toolTotal} tools · ${subagent.status === 'error' ? 'failed' : 'done'}`
  // Once a committed result exists it owns durable output. Notification text
  // is only a pre-commit fallback; showing both would duplicate the report.
  const reportTexts =
    durableResult?.texts ?? (!committed && notification?.result ? [notification.result] : [])

  return (
    <MarkerRow marker={marker}>
      <div>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
          className="flex w-full items-center gap-2 cursor-pointer text-left text-[13px] leading-[1.65]"
        >
          <span className="text-muted shrink-0">{model.agentType}</span>
          <span className="text-ink flex-1 min-w-0 truncate" title={model.description}>
            {model.description}
          </span>
          <span className="text-muted text-[11px] whitespace-nowrap">{status}</span>
          <span className="text-muted shrink-0" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
        </button>
        {/* Prompt/report Markdown and the child timeline are interaction-only.
            Keeping them unmounted while closed prevents every historical
            agent card from retaining parser trees and nested row DOM. */}
        {open ? (
          <div className="mt-2 ml-4 border-l border-border/60 pl-3 flex flex-col gap-2">
            <section aria-label="Agent prompt">
              <div className="text-muted text-[10px] uppercase tracking-wider mb-1">Prompt</div>
              <LazyTextProse text={model.prompt} />
            </section>
            {subagent ? <SubagentMiniFeed sa={subagent} /> : null}
            {reportTexts.length > 0 ? (
              <section aria-label="Agent final report">
                <div className="text-muted text-[10px] uppercase tracking-wider mb-1">
                  Final report
                </div>
                <div className="flex flex-col gap-2">
                  {reportTexts.map((text, index) => (
                    // Provider result arrays are ordered evidence; duplicate
                    // text is valid, so the index is the stable identity.
                    <LazyTextProse key={index} text={text} />
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        ) : null}
      </div>
    </MarkerRow>
  )
}

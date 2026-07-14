import { memo } from 'react'

import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import type { AgentProviderKind } from '@shared/types/providerKind'

import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { StatusBadge } from '@renderer/features/feed/ui/kit/StatusBadge'
import { parseSemanticTodos, type SemanticLiveTurn } from '@renderer/session-runtime/state'

import type { ArtifactStatus, TodoArtifact } from './types'

type SemanticLiveBlock = SemanticLiveTurn['blocks'][number]
type SemanticToolCallSnapshot = SemanticLiveTurn['lookups']['toolCallsById'][string]

// TodoCard — the ONE checklist surface (spec §6), unifying the
// committed TodoRow (ClaudeRows) and the live SemanticTodoList that
// had near-identical but separately-maintained JSX. Glyph vocabulary
// preserved from TodoRow: ☑ done (accent, strikethrough), ◐ in
// progress (accent, activeForm label), ☐ pending (muted).
//
// `label` names the tool the agent actually called — OpenCode's
// lowercase `todowrite` reuses this card (the 2026-07-06 cross-provider
// reuse), so the header must not hardcode Claude's "TodoWrite".

function parseTodos(input: unknown): TodoArtifact['todos'] {
  const rec = (input ?? {}) as Record<string, unknown>
  const raw = Array.isArray(rec.todos) ? rec.todos : []
  return raw.map(t => {
    const item = (t ?? {}) as Record<string, unknown>
    const status =
      item.status === 'in_progress' || item.status === 'completed'
        ? item.status
        : 'pending'
    return {
      content: typeof item.content === 'string' ? item.content : '',
      status,
      activeForm: typeof item.activeForm === 'string' ? item.activeForm : '',
    }
  })
}

export function todoFromCommitted(
  tu: ToolUseBlock,
  result: ToolResultBlock | null,
  provider: AgentProviderKind,
): TodoArtifact {
  return {
    family: 'todo',
    id: `todo:${tu.id}`,
    provider,
    status: !result ? 'running' : result.is_error === true ? 'error' : 'complete',
    plane: 'committed',
    toolUseId: tu.id,
    startedAt: null,
    endedAt: null,
    todos: parseTodos(tu.input),
  }
}

export function todoFromLive(
  block: SemanticLiveBlock,
  toolState: SemanticToolCallSnapshot | null,
  provider: AgentProviderKind,
): TodoArtifact {
  const id = block.toolUseId ?? block.callId ?? block.itemId ?? `live:${block.blockIndex}`
  const hasResult = block.resultAt != null || block.resultContent != null
  const status: ArtifactStatus =
    toolState?.status === 'error' || block.resultIsError === true
      ? 'error'
      : hasResult
        ? 'complete'
        : block.finalized === true
          ? 'running'
          : 'streaming'
  return {
    family: 'todo',
    id: `todo:${id}`,
    provider,
    status,
    plane: 'live',
    toolUseId: block.toolUseId ?? block.callId ?? null,
    startedAt: null,
    endedAt: block.resultAt ?? null,
    todos: parseSemanticTodos(block.parsedInput),
  }
}

const TodoItemRow = memo(function TodoItemRow({
  item,
}: {
  item: TodoArtifact['todos'][number]
}) {
  const glyph =
    item.status === 'completed' ? '☑' : item.status === 'in_progress' ? '◐' : '☐'
  const textCls =
    item.status === 'completed'
      ? 'text-muted line-through'
      : item.status === 'in_progress'
        ? 'text-ink'
        : 'text-ink-dim'
  const glyphCls =
    item.status === 'completed' || item.status === 'in_progress'
      ? 'text-accent'
      : 'text-muted'
  const label =
    item.status === 'in_progress' && item.activeForm ? item.activeForm : item.content
  return (
    <li className="flex items-start gap-2 text-[13px] leading-[1.55]">
      <span
        className={`${glyphCls} select-none flex-shrink-0 w-4 tabular-nums`}
        aria-hidden="true"
      >
        {glyph}
      </span>
      <span className={`${textCls} flex-1 min-w-0 break-words`}>{label}</span>
    </li>
  )
})

export const TodoCard = memo(function TodoCard({
  vm,
  label = 'TodoWrite',
}: {
  vm: TodoArtifact
  label?: string
}) {
  const done = vm.todos.filter(t => t.status === 'completed').length
  return (
    <MarkerRow marker="⏺">
      <div className="flex flex-col gap-1">
        <div className="flex items-baseline gap-2 text-[13px] leading-[1.65]">
          <span className="text-accent font-semibold">{label}</span>
          <span className="text-muted text-[11px] tabular-nums flex-1">
            {done} / {vm.todos.length} done
          </span>
          <StatusBadge status={vm.status} />
        </div>
        {vm.todos.length === 0 ? (
          <div className="text-muted text-[12px] italic">(empty list)</div>
        ) : (
          <ul className="flex flex-col gap-0.5 list-none m-0 p-0">
            {vm.todos.map((t, i) => (
              <TodoItemRow key={i} item={t} />
            ))}
          </ul>
        )}
      </div>
    </MarkerRow>
  )
})

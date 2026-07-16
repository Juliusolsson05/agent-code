import { memo, useMemo } from 'react'

import type { ToolUseBlock } from '@shared/types/transcript'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'

// Todo-checklist row (Claude TodoWrite, OpenCode todowrite).
//
// MOVED from claude/renderer/rows/ClaudeRows.tsx (Phase 1 of the
// evidence-first rendering plan, PR #554): opencode's dispatch was importing
// this row straight out of Claude's provider directory — the one
// provider→provider renderer import in the codebase, and exactly the edge
// the plan's import-boundary rules (providers/importBoundaries.test.ts)
// forbid. Both providers importing a SHARED row is legal under every rule;
// a provider importing another provider is never legal, because it welds
// their wire-format fates together (the failure mode that sank PR #524).
//
// WHY sharing the ROW is honest here (vs. the plan's "no sharing before two
// providers prove the same semantic model"): the live probe of a real
// opencode 1.15.2 session (2026-07-06, /tmp/oc-probe-events.jsonl) captured
// todowrite's finalized input as { todos: [{ content, status, priority }] }
// — a compatible subset of what parseTodos already handles defensively
// (activeForm simply renders empty, priority is ignored). Two providers,
// same proven input shape. The `label` prop keeps the row header honest
// about which tool the agent actually called. If opencode's todo shape ever
// diverges, THIS is the seam to fork at — clone into the provider's own
// rows/ rather than growing provider branches here: a shared row must never
// branch on provider (plan import rule 7).

type TodoItem = {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm: string
}

/** Pull the checklist out of a shape we don't fully trust — transcript
 *  typing is `unknown`. Missing/foreign fields degrade to empty strings and
 *  'pending' so a malformed item renders as an empty row, never a crash. */
function parseTodos(block: ToolUseBlock): TodoItem[] {
  const input = (block.input ?? {}) as Record<string, unknown>
  const raw = Array.isArray(input.todos) ? input.todos : []
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

// `label` exists for cross-provider reuse (2026-07-06): the header must name
// the tool the AGENT actually called (TodoWrite vs todowrite), not hardcode
// Claude's spelling.
export const TodoRow = memo(function TodoRow({ block, label = 'TodoWrite' }: { block: ToolUseBlock; label?: string }) {
  const todos = useMemo(() => parseTodos(block), [block])
  const done = todos.filter(t => t.status === 'completed').length
  return (
    <MarkerRow marker="⏺">
      <div className="flex flex-col gap-1">
        <div className="flex items-baseline justify-between text-[13px] leading-[1.65]">
          <span className="text-accent font-semibold">{label}</span>
          <span className="text-muted text-[11px] tabular-nums">
            {done} / {todos.length} done
          </span>
        </div>
        {todos.length === 0 ? (
          <div className="text-muted text-[12px] italic">(empty list)</div>
        ) : (
          <ul className="flex flex-col gap-0.5 list-none m-0 p-0">
            {todos.map((t, i) => (
              <TodoItemRow key={i} item={t} />
            ))}
          </ul>
        )}
      </div>
    </MarkerRow>
  )
})

const TodoItemRow = memo(function TodoItemRow({ item }: { item: TodoItem }) {
  const glyph =
    item.status === 'completed'
      ? '☑'
      : item.status === 'in_progress'
        ? '◐'
        : '☐'
  const textCls =
    item.status === 'completed'
      ? 'text-muted line-through'
      : item.status === 'in_progress'
        ? 'text-ink'
        : 'text-ink-dim'
  const glyphCls =
    item.status === 'completed'
      ? 'text-accent'
      : item.status === 'in_progress'
        ? 'text-accent'
        : 'text-muted'
  const label =
    item.status === 'in_progress' && item.activeForm
      ? item.activeForm
      : item.content
  return (
    <li className="flex items-start gap-2 text-[13px] leading-[1.55]">
      <span
        className={`${glyphCls} select-none flex-shrink-0 w-4 tabular-nums`}
        aria-hidden="true"
      >
        {glyph}
      </span>
      <span className={`${textCls} flex-1 min-w-0 break-words`}>
        {label}
      </span>
    </li>
  )
})

import { memo } from 'react'

import type { SemanticTodoItem } from '@renderer/workspace/workspaceState'

// Inline todo-list rendering for the semantic-streaming TodoWrite
// tool row. Shows the list with status glyphs (☑ done, ◐ in-progress,
// ☐ pending) and a "N/M done" header. The `activeForm` override for
// in-progress todos matches upstream Claude's "I am doing X" live
// phrasing — the todo's permanent content is a planning-tense
// sentence ("Fix the login flow"), the activeForm is the live-tense
// progress sentence ("Fixing the login flow"), and the latter reads
// better while a turn is in-flight.
export const SemanticTodoList = memo(function SemanticTodoList({
  todos,
}: {
  todos: SemanticTodoItem[]
}) {
  const done = todos.filter(todo => todo.status === 'completed').length
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between text-[13px] leading-[1.65]">
        <span className="text-accent font-semibold">TodoWrite</span>
        <span className="text-muted text-[11px] tabular-nums">
          {done} / {todos.length} done
        </span>
      </div>
      {todos.length === 0 ? (
        <div className="text-muted text-[12px] italic">(empty list)</div>
      ) : (
        <ul className="flex flex-col gap-0.5 list-none m-0 p-0">
          {todos.map((todo, index) => {
            const glyph =
              todo.status === 'completed'
                ? '☑'
                : todo.status === 'in_progress'
                  ? '◐'
                  : '☐'
            const glyphCls =
              todo.status === 'pending' ? 'text-muted' : 'text-accent'
            const textCls =
              todo.status === 'completed'
                ? 'text-muted line-through'
                : todo.status === 'in_progress'
                  ? 'text-ink'
                  : 'text-ink-dim'
            const label =
              todo.status === 'in_progress' && todo.activeForm
                ? todo.activeForm
                : todo.content
            return (
              <li key={index} className="flex items-start gap-2 text-[13px] leading-[1.55]">
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
          })}
        </ul>
      )}
    </div>
  )
})

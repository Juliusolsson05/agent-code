import { memo } from 'react'

import type { OpencodeTodoItem, OpencodeTodoModel } from '@providers/opencode/renderer/adapters/todo'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'

export const OpencodeTodoRow = memo(function OpencodeTodoRow({
  model,
}: {
  model: OpencodeTodoModel
}) {
  const done = model.items.filter(item => item.status === 'completed').length
  return (
    <MarkerRow marker="⏺">
      <div className="flex flex-col gap-1">
        <div className="flex items-baseline justify-between text-[13px] leading-[1.65]">
          <span className="text-accent font-semibold">todowrite</span>
          <span className="text-muted text-[11px] tabular-nums">
            {done} / {model.items.length} done
          </span>
        </div>
        {model.items.length === 0 ? (
          <div className="text-muted text-[12px] italic">(empty list)</div>
        ) : (
          <ul className="flex flex-col gap-0.5 list-none m-0 p-0">
            {model.items.map((item, index) => <TodoItemRow key={index} item={item} />)}
          </ul>
        )}
      </div>
    </MarkerRow>
  )
})

const TodoItemRow = memo(function TodoItemRow({ item }: { item: OpencodeTodoItem }) {
  const glyph = item.status === 'completed' ? '☑' : item.status === 'in_progress' ? '◐' : '☐'
  const textClass = item.status === 'completed'
    ? 'text-muted line-through'
    : item.status === 'in_progress'
      ? 'text-ink'
      : 'text-ink-dim'
  const glyphClass = item.status === 'pending' ? 'text-muted' : 'text-accent'
  return (
    <li className="flex items-start gap-2 text-[13px] leading-[1.55]">
      <span className={`${glyphClass} select-none flex-shrink-0 w-4 tabular-nums`} aria-hidden="true">
        {glyph}
      </span>
      <span className={`${textClass} flex-1 min-w-0 break-words`}>{item.content}</span>
    </li>
  )
})

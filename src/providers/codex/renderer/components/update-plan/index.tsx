import { useContext, useState } from 'react'

import {
  isCodexPlanResult,
  type CodexPlanItem,
  type CodexPlanModel,
} from '@providers/codex/renderer/adapters/tasks'
import { ToolResultIndexContext } from '@renderer/features/feed/context'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { LazyJsonDisclosure } from '@providers/shared/renderer/rows/LazyJsonDisclosure'

function PlanItem({ item }: { item: CodexPlanItem }) {
  const glyph = item.status === 'completed' ? '☑' : item.status === 'in_progress' ? '◐' : '☐'
  const textClass = item.status === 'completed'
    ? 'text-muted line-through'
    : item.status === 'in_progress' ? 'text-ink' : 'text-ink-dim'
  return (
    <li className="flex items-start gap-2 text-[12px] leading-[1.55]">
      <span className={item.status === 'pending' ? 'text-muted' : 'text-accent'} aria-hidden="true">
        {glyph}
      </span>
      <span className={textClass}>{item.step}</span>
    </li>
  )
}

export function CodexPlanRow({ model }: { model: CodexPlanModel }) {
  const [open, setOpen] = useState(false)
  const result = useContext(ToolResultIndexContext).get(model.operationId) ?? null
  const validated = result ? isCodexPlanResult(result, model) : false
  const failed = result?.is_error === true
  const status = [
    `${model.completedItems}/${model.totalItems} complete`,
    model.activeItems > 0 ? `${model.activeItems} active` : null,
    failed ? 'failed' : result ? validated ? 'updated' : 'response received' : 'running',
  ].filter(Boolean).join(' · ')

  return (
    <MarkerRow marker={failed ? '✗' : validated ? '✓' : result ? '◌' : '◐'}>
      <div className="min-w-0">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(current => !current)}
          className="flex w-full items-center gap-2 cursor-pointer text-left text-[13px] leading-[1.65]"
        >
          <span className="text-accent font-semibold">Plan</span>
          <span className="flex-1 min-w-0 truncate text-ink-dim" title={model.explanation ?? undefined}>
            {model.explanation || model.items.find(item => item.status === 'in_progress')?.step || 'Update plan'}
          </span>
          <span className={failed ? 'text-danger text-[11px]' : 'text-muted text-[11px]'}>{status}</span>
          <span className="text-muted" aria-hidden="true">{open ? '▾' : '▸'}</span>
        </button>
        {open ? (
          <div className="mt-2 ml-4 border-l border-border/60 pl-3 space-y-2">
            {model.explanation ? <div className="text-[12px] text-ink-dim">{model.explanation}</div> : null}
            <ol className="list-none m-0 p-0 space-y-0.5">
              {model.items.map((item, index) => <PlanItem key={`${index}:${item.step}`} item={item} />)}
            </ol>
            {model.items.length < model.totalItems ? (
              <div className="text-[11px] text-muted">
                {model.totalItems - model.items.length} additional plan items are preserved in the exact input.
              </div>
            ) : null}
            <LazyJsonDisclosure label="Exact plan input" value={model.input} />
          </div>
        ) : null}
      </div>
    </MarkerRow>
  )
}

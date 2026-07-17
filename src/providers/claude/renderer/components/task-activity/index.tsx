import { useContext, useState } from 'react'

import {
  fromClaudeTaskActivityResult,
  type ClaudeTaskActivityModel,
} from '@providers/claude/renderer/adapters/tasks'
import { ToolResultIndexContext } from '@renderer/features/feed/context'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { PagedTextViewer } from '@renderer/lib/text/PagedTextViewer'
import { LazyJsonDisclosure } from '@providers/shared/renderer/rows/LazyJsonDisclosure'

function statusLabel(model: ClaudeTaskActivityModel): string {
  if (model.kind !== 'update') return ''
  return model.status === 'in_progress' ? 'in progress' : model.status
}

export function ClaudeTaskActivityRow({ model }: { model: ClaudeTaskActivityModel }) {
  const [open, setOpen] = useState(false)
  const resultBlock = useContext(ToolResultIndexContext).get(model.operationId) ?? null
  const result = resultBlock ? fromClaudeTaskActivityResult(resultBlock, model) : null
  const failed = resultBlock?.is_error === true
  const marker = failed ? '✗' : result ? '✓' : resultBlock ? '◌' : '◐'
  const lifecycle = failed
    ? 'failed'
    : result
      ? model.kind === 'create'
        ? 'created'
        : model.kind === 'update'
          ? statusLabel(model)
          : model.kind === 'schedule'
            ? 'scheduled'
            : 'launched'
      : resultBlock ? 'response received' : 'running'

  return (
    <MarkerRow marker={marker}>
      <div className="min-w-0">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(current => !current)}
          className="flex w-full min-w-0 items-center gap-2 cursor-pointer text-left text-[13px] leading-[1.65]"
        >
          <span className="shrink-0 text-accent font-semibold">{model.label}</span>
          <span className="min-w-0 flex-1 truncate text-ink" title={model.subject}>
            {model.subject}
          </span>
          <span className={`shrink-0 text-[11px] ${failed ? 'text-danger' : 'text-muted'}`}>
            {lifecycle}
          </span>
          <span className="shrink-0 text-muted" aria-hidden="true">{open ? '▾' : '▸'}</span>
        </button>

        {open ? (
          <div className="mt-2 ml-4 border-l border-border/60 pl-3 space-y-2">
            {model.kind === 'create' ? (
              <>
                <div className="text-[12px] text-ink-dim">{model.description}</div>
                <div className="text-[11px] text-muted">While active: {model.activeForm}</div>
              </>
            ) : null}
            {model.kind === 'schedule' ? (
              <>
                <section>
                  <div className="text-muted text-[10px] uppercase tracking-wider">Reason</div>
                  <div className="text-[12px] text-ink-dim">{model.reason}</div>
                </section>
                <section>
                  <div className="text-muted text-[10px] uppercase tracking-wider">Wake prompt</div>
                  <PagedTextViewer source={model.prompt} />
                </section>
              </>
            ) : null}
            {result ? (
              <div className="text-[11px] text-muted">{result.text}</div>
            ) : null}
            <LazyJsonDisclosure label="Exact tool input" value={model.input} />
          </div>
        ) : null}
      </div>
    </MarkerRow>
  )
}

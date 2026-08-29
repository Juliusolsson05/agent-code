import { useContext, useMemo, useState } from 'react'

import { ToolResultIndexContext } from '@renderer/features/feed/context'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { PagedTextViewer } from '@renderer/lib/text/PagedTextViewer'
import { LazyJsonDisclosure } from '@providers/shared/renderer/rows/LazyJsonDisclosure'

import {
  fromAgentCodeWorkflowResult,
  type AgentCodeWorkflowModel,
} from './model'

function ExactInput({ input }: { input: Record<string, unknown> }) {
  const [open, setOpen] = useState(false)
  const source = useMemo(() => {
    if (!open) return null
    try {
      return JSON.stringify(input, null, 2)
    } catch {
      return null
    }
  }, [input, open])
  return (
    <details className="text-[11px] text-muted" onToggle={event => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer select-none">Exact workflow input</summary>
      {open ? (
        <div className="mt-1 rounded-slab border border-border bg-surface px-2 py-1.5">
          {source === null ? 'Exact input unavailable.' : <PagedTextViewer source={source} />}
        </div>
      ) : null}
    </details>
  )
}

export function AgentCodeWorkflowView({ model }: { model: AgentCodeWorkflowModel }) {
  const [open, setOpen] = useState(false)
  const resultBlock = useContext(ToolResultIndexContext).get(model.operationId) ?? null
  // WHY the adapter-created model object is not a dependency: unrelated feed
  // index updates can rerun parent dispatch and allocate a structurally equal
  // model. Result ownership depends only on the operation id, while parsing the
  // result may traverse a multi-megabyte workflow payload. The exact result
  // object plus that scalar identity are therefore the complete cache key.
  const run = useMemo(
    () => resultBlock ? fromAgentCodeWorkflowResult(resultBlock, model) : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see identity proof above.
    [model.operationId, resultBlock],
  )
  const failed = resultBlock?.is_error === true
  const marker = failed ? '✗' : run ? '✓' : resultBlock ? '◌' : '◐'
  const status = failed
    ? 'failed'
    : run?.status ?? (resultBlock ? 'response received' : 'starting')
  const workflowName = run?.workflow?.title ?? run?.workflow?.name ?? null

  return (
    <MarkerRow marker={marker}>
      <div className="min-w-0">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(current => !current)}
          className="flex w-full min-w-0 items-center gap-2 cursor-pointer text-left text-[13px] leading-[1.65]"
        >
          <span className="shrink-0 rounded-chip border border-border px-1 text-[10px] uppercase tracking-wider text-muted">
            Agent Code MCP
          </span>
          <span className="shrink-0 text-accent font-semibold">Workflow</span>
          <span className="shrink-0 text-ink-dim">{model.action}</span>
          <span className="min-w-0 flex-1 truncate font-code text-[12px] text-ink" title={model.subject}>
            {workflowName ?? model.subject}
          </span>
          <span className={failed ? 'shrink-0 text-danger text-[11px]' : 'shrink-0 text-muted text-[11px]'}>
            {status}
          </span>
          <span className="shrink-0 text-muted" aria-hidden="true">{open ? '▾' : '▸'}</span>
        </button>

        {open ? (
          <div className="mt-2 ml-4 border-l border-border/60 pl-3 space-y-2">
            {run ? (
              <div className="grid grid-cols-[auto_1fr] gap-x-2 text-[11px]">
                <span className="text-muted">Run</span>
                <span className="font-code text-ink-dim break-all">{run.runId}</span>
                {run.resumedFromRunId ? (
                  <>
                    <span className="text-muted">Resumed from</span>
                    <span className="font-code text-ink-dim break-all">{run.resumedFromRunId}</span>
                  </>
                ) : null}
              </div>
            ) : null}
            <LazyJsonDisclosure label="Workflow input preview" value={model.input} />
            <ExactInput input={model.input} />
            {resultBlock && !run ? (
              <div className="text-[11px] text-danger">
                The launch response did not contain a proven run reference; its generic result remains visible.
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </MarkerRow>
  )
}

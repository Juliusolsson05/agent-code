import { useContext, useMemo, useState } from 'react'

import { ToolResultIndexContext } from '@renderer/features/feed/context'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { PagedTextViewer } from '@renderer/lib/text/PagedTextViewer'
import { LazyJsonDisclosure } from '@providers/shared/renderer/rows/LazyJsonDisclosure'

import {
  fromAgentCodeWorkspaceResult,
  type AgentCodeWorkspaceModel,
} from './model'

function ExactSourceDisclosure({ source, isError }: { source: string; isError: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <details
      className="text-[11px] text-muted"
      onToggle={event => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer select-none">Exact result source</summary>
      {/* WHY `details` alone is not lazy: collapsed descendants still mount.
          Workspace results can contain whole files, so constructing the paged
          viewer while this nested disclosure is closed would retain the very
          payload the two-stage card is meant to keep out of the hot feed. */}
      {open ? (
        <div className="mt-1 rounded border border-border bg-surface px-2 py-1.5">
          <PagedTextViewer source={source} isError={isError} />
        </div>
      ) : null}
    </details>
  )
}

export function AgentCodeWorkspaceView({ model }: { model: AgentCodeWorkspaceModel }) {
  const [open, setOpen] = useState(false)
  const resultBlock = useContext(ToolResultIndexContext).get(model.operationId) ?? null
  // Context identity changes whenever any paired result changes, and provider
  // dispatch may allocate a fresh but equivalent model while reconciling that
  // update. Parsing up to the owned protocol ceiling for every unrelated append
  // would make one large response tax every future feed event. Workspace result
  // ownership uses only operationId from the model, so the exact result object
  // and that scalar are the complete semantic cache key.
  const result = useMemo(
    () => resultBlock ? fromAgentCodeWorkspaceResult(resultBlock, model) : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see identity proof above.
    [model.operationId, resultBlock],
  )
  const failed = resultBlock?.is_error === true || result?.ok === false
  const marker = failed ? '✗' : result ? '✓' : resultBlock ? '◌' : '◐'
  const status = failed
    ? 'failed'
    : result ? 'done'
      : resultBlock ? 'unrecognized response' : 'running'

  return (
    <MarkerRow marker={marker}>
      <div className="min-w-0">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(current => !current)}
          className="flex w-full min-w-0 items-center gap-2 cursor-pointer text-left text-[13px] leading-[1.65]"
        >
          <span className="shrink-0 rounded border border-border px-1 text-[10px] uppercase tracking-wider text-muted">
            Agent Code MCP
          </span>
          <span className="shrink-0 text-accent font-semibold">AI Workspace</span>
          <span className="shrink-0 text-ink-dim">{model.action}</span>
          {model.subject ? (
            <span className="min-w-0 flex-1 truncate font-code text-[12px] text-ink" title={model.subject}>
              {model.subject}
            </span>
          ) : <span className="flex-1" />}
          <span className={`shrink-0 text-[11px] ${failed ? 'text-danger' : 'text-muted'}`}>
            {status}
          </span>
          <span className="shrink-0 text-muted" aria-hidden="true">{open ? '▾' : '▸'}</span>
        </button>

        {open ? (
          <div className="mt-2 ml-4 border-l border-border/60 pl-3 space-y-2">
            {result?.summary ? (
              <div className={failed ? 'text-danger text-[12px]' : 'text-ink-dim text-[12px]'}>
                {result.summary}
              </div>
            ) : null}
            <LazyJsonDisclosure label="Protocol input" value={model.input} />
            {result ? (
              <>
                <LazyJsonDisclosure label="Protocol result" value={result.value} />
                <ExactSourceDisclosure source={result.source} isError={failed} />
              </>
            ) : resultBlock ? (
              <div className="text-danger text-[11px]">
                The response no longer matches the owned workspace contract; its generic result remains below.
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </MarkerRow>
  )
}

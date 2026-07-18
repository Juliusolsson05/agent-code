import { useMemo, useState } from 'react'

import type {
  CodexEmbeddedOperationModel,
  CodexWaitOperationModel,
} from '@providers/codex/renderer/adapters/embeddedOperation'
import { CodexToolResultRow } from '@providers/codex/renderer/components/tool-result'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { PagedTextViewer } from '@renderer/lib/text/PagedTextViewer'
import { LazyJsonDisclosure } from '@providers/shared/renderer/rows/LazyJsonDisclosure'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'

export function CodexEmbeddedOperationRow({
  model,
}: {
  model: CodexEmbeddedOperationModel
}) {
  const [open, setOpen] = useState(false)
  const status = model.failed
    ? 'failed'
    : model.resultPresent
      ? 'response received'
      : model.finalized
        ? 'request completed'
        : 'running'
  return (
    <MarkerRow marker={model.failed ? '✗' : model.resultPresent ? '✓' : '◐'}>
      <div className="min-w-0 w-full">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(value => !value)}
          className="flex w-full min-w-0 items-center gap-2 text-left text-[13px] leading-[1.65]"
        >
          <span className="shrink-0 rounded border border-border px-1 text-[10px] uppercase tracking-wider text-muted">
            Agent Code MCP
          </span>
          <span className="shrink-0 text-accent font-semibold">{model.action}</span>
          {model.subject ? (
            <span className="min-w-0 flex-1 truncate font-code text-[12px] text-ink-dim" title={model.subject}>
              {model.subject}
            </span>
          ) : <span className="min-w-0 flex-1" />}
          <span className={model.failed ? 'shrink-0 text-[11px] text-danger' : 'shrink-0 text-[11px] text-muted'}>
            {status}
          </span>
          <span className="shrink-0 text-muted" aria-hidden="true">{open ? '▾' : '▸'}</span>
        </button>
        {open ? (
          <div className="mt-2 ml-4 border-l border-border/60 pl-3 space-y-2">
            <div className="font-code text-[11px] text-muted break-all">{model.toolName}</div>
            <LazyJsonDisclosure label="Operation input" value={model.input} />
            <details className="text-[11px] text-muted">
              <summary className="cursor-pointer select-none">Exact Codex script</summary>
              <div className="mt-1 rounded border border-border bg-surface px-2 py-1.5">
                <PagedTextViewer source={model.exactScript} />
              </div>
            </details>
          </div>
        ) : null}
      </div>
    </MarkerRow>
  )
}

export function CodexWaitOperationRow({ model }: { model: CodexWaitOperationModel }) {
  const meta = useMemo(() => [
    model.yieldTimeMs === null ? null : `wait ${model.yieldTimeMs}ms`,
    model.maxTokens === null ? null : `max ${model.maxTokens} tok`,
  ].filter(Boolean).join(' · '), [model.maxTokens, model.yieldTimeMs])
  const marker = model.failed
    ? '✗'
    : model.status === 'completed'
      ? '✓'
      : model.status === 'waiting' || model.status === 'running'
        ? '◐'
        : '•'
  return (
    <MarkerRow marker={marker}>
      <div className="min-w-0 flex items-baseline gap-2 text-[13px] leading-[1.65]">
        {/* WHY termination is named in the collapsed headline: `terminate`
            changes this from an observation into a destructive control. Hiding
            it behind “Wait” makes the transcript materially false even if the
            raw input remains available elsewhere in debug state. */}
        <span className="shrink-0 text-accent font-semibold">
          {model.terminate ? 'Terminate command' : 'Wait for command'}
        </span>
        <span className="min-w-0 truncate font-code text-[12px] text-ink-dim" title={model.cellId}>
          {model.cellId}
        </span>
        {meta ? <span className="shrink-0 text-[11px] text-muted">{meta}</span> : null}
        <span className={model.failed ? 'shrink-0 text-[11px] text-danger' : 'shrink-0 text-[11px] text-muted'}>
          {model.status}
        </span>
      </div>
    </MarkerRow>
  )
}

export function CodexNamedOperationResultRow({
  label,
  block,
  sourceTool,
}: {
  label: string
  block: ToolResultBlock
  sourceTool: ToolUseBlock
}) {
  return (
    <div className="flex flex-col gap-0.5">
      {/* WHY this context line has no second marker: CodexToolResultRow owns
          the one real result marker below. Rendering another `⎿` merely to
          attach a label recreated the doubled, detached transport appearance
          this component is meant to eliminate. */}
      <div className="pl-[22px] text-[11px] font-medium text-muted">
        {label} output
      </div>
      <CodexToolResultRow block={block} sourceTool={sourceTool} />
    </div>
  )
}

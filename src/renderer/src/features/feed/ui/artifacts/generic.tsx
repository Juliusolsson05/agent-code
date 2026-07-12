import { memo } from 'react'

import { formatToolFilePath } from '@shared/paths/displayPath'
import {
  isAbsolutePathLike,
  isHttpUrl,
  slabEntries,
  smartHeadline,
  tryExtractJson,
} from '@providers/shared/renderer/rows/jsonToolPresentation'
import { JsonResultSlab } from '@providers/shared/renderer/rows/JsonResultSlab'
import { SLAB_MAX_CHARS } from '@providers/shared/renderer/rows/JsonToolRow'

import { truncateBashCommand } from '@renderer/features/feed/lib/helpers'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { CodeBlock } from '@renderer/lib/code/CodeBlock'
import { OutputWell } from '@renderer/features/feed/ui/kit/OutputWell'
import { StatusBadge } from '@renderer/features/feed/ui/kit/StatusBadge'
import { StreamingCodeBlock } from '@renderer/features/feed/ui/kit/StreamingCodeBlock'

import type { GenericToolArtifact } from './types'

// GenericToolCard — THE one fallback for tools without a dedicated
// family card, identical live and committed (spec §6). Successor to
// the committed JsonToolRow AND the hand-rolled live generic branch in
// BlockRow (which dumped raw partial inputJson into a <pre> — audit
// finding 7). The per-param presentation (path shortening, URL links,
// 400-char scalar clamp, nested-JSON slab with the 16KB cap) is
// preserved from JsonToolRow because the corpus work behind it
// (plan-json-tool-rows.md) is exactly what made MCP/orchestration
// payloads readable.
//
// The live upgrade over the old raw dump: a PARTIAL params buffer
// renders as growing highlighted JSON through StreamingCodeBlock
// (sealed-line cache — cheap per delta), flipping to the structured
// per-param slab the moment the JSON parses. Same card, body fills in.

function ParamValue({ value }: { value: unknown }) {
  if (typeof value === 'string') {
    if (isHttpUrl(value)) {
      return (
        <a href={value} target="_blank" rel="noreferrer" className="text-accent underline break-all">
          {value}
        </a>
      )
    }
    if (isAbsolutePathLike(value)) {
      return (
        <span title={value} className="break-all">
          {formatToolFilePath(value, null)}
        </span>
      )
    }
    // 400-char clamp: a scalar param is a one-line hint in a collapsed
    // slab, not a document (see JsonToolRow's original rationale).
    return (
      <span className="break-all whitespace-pre-wrap">
        {value.length > 400 ? `${value.slice(0, 400)}…` : value}
      </span>
    )
  }
  if (value === null || typeof value !== 'object') {
    return <span>{String(value)}</span>
  }
  return <span className="text-ink-dim">{Array.isArray(value) ? `[${value.length}]` : '{…}'}</span>
}

export const GenericToolCard = memo(function GenericToolCard({
  vm,
}: {
  vm: GenericToolArtifact
}) {
  const headline = smartHeadline(vm.params)
  const headlineText = (() => {
    if (!headline) return null
    if (vm.toolName === 'Bash' && headline.key === 'command') {
      return truncateBashCommand(headline.value)
    }
    if (isAbsolutePathLike(headline.value)) return formatToolFilePath(headline.value, null)
    return headline.value
  })()

  const params = slabEntries(vm.params, headline?.key ?? null)
  const nested = params.filter(([, v]) => typeof v === 'object' && v !== null)
  const nestedJson = (() => {
    if (nested.length === 0) return null
    try {
      const json = JSON.stringify(Object.fromEntries(nested), null, 2)
      return json.length > SLAB_MAX_CHARS ? `${json.slice(0, SLAB_MAX_CHARS)}\n…` : json
    } catch {
      return null
    }
  })()

  // Partial live input: the JSON hasn't parsed yet, so there is no
  // params record — show the raw buffer as growing highlighted JSON.
  // Capped like every slab; the moment vm.params materializes this
  // branch is skipped and the structured slab takes over.
  const showStreamingParams = vm.params === null && vm.paramsJson.length > 0

  const parsedResult =
    vm.resultText !== null ? tryExtractJson(vm.resultText) : null

  return (
    <MarkerRow marker="⏺">
      <div>
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[13px] leading-[1.65]">
          <span className="text-accent font-semibold">{vm.prettyName}</span>
          {vm.mcp && (
            <span className="text-[11px] text-ink-dim border border-border rounded px-1 py-px align-middle">
              MCP · {vm.mcp.server}
            </span>
          )}
          <StatusBadge status={vm.status} />
        </div>
        {headlineText && (
          <MarkerRow marker="⎿" tone="muted">
            <pre className="font-code text-[12px] leading-[1.55] text-ink-dim whitespace-pre-wrap break-all m-0">
              {headlineText}
            </pre>
          </MarkerRow>
        )}
        {showStreamingParams ? (
          <MarkerRow marker="⎿" tone="muted">
            <StreamingCodeBlock
              code={
                vm.paramsJson.length > SLAB_MAX_CHARS
                  ? `${vm.paramsJson.slice(0, SLAB_MAX_CHARS)}\n…`
                  : vm.paramsJson
              }
              language="json"
              blockKey={`params:${vm.id}`}
            />
          </MarkerRow>
        ) : params.length > 0 ? (
          <MarkerRow marker="⎿" tone="muted">
            <details className="text-[12px]">
              <summary className="cursor-pointer text-ink-dim select-none">
                {params.length} param{params.length === 1 ? '' : 's'}
              </summary>
              <div className="mt-1 space-y-0.5">
                {params
                  .filter(([, v]) => typeof v !== 'object' || v === null)
                  .map(([k, v]) => (
                    <div key={k} className="font-code text-[12px] leading-[1.55]">
                      <span className="text-ink-dim">{k}:</span> <ParamValue value={v} />
                    </div>
                  ))}
                {nestedJson && (
                  <CodeBlock
                    code={nestedJson}
                    language="json"
                    codeId={`generic-tool:${vm.id}`}
                    // Always highlight: nestedJson only exists once the
                    // input parsed, i.e. it is stable — and branching on
                    // vm.plane here violated the card contract (PR524
                    // review: live MCP params were plain, committed
                    // highlighted — a visible provenance seam).
                    highlight
                  />
                )}
              </div>
            </details>
          </MarkerRow>
        ) : null}
        {vm.parseError && (
          <MarkerRow marker="⎿" tone="muted">
            <div className="text-danger text-[12px] leading-[1.55]">
              invalid tool input: {vm.parseError}
            </div>
          </MarkerRow>
        )}
        {vm.resultText !== null ? (
          parsedResult !== null && typeof parsedResult === 'object' ? (
            <JsonResultSlab value={parsedResult} isError={vm.resultIsError} />
          ) : (
            <OutputWell text={vm.resultText} isError={vm.resultIsError} ansi />
          )
        ) : null}
      </div>
    </MarkerRow>
  )
})

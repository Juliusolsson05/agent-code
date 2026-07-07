import { memo } from 'react'

import type { ToolUseBlock } from '@shared/types/transcript'
import { formatToolFilePath } from '@shared/paths/displayPath'

import { truncateBashCommand } from '@renderer/features/feed/lib/helpers'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { CodeBlock } from '@renderer/lib/code/CodeBlock'
import {
  isAbsolutePathLike,
  isHttpUrl,
  prettifyToolName,
  slabEntries,
  smartHeadline,
} from '@providers/shared/renderer/rows/jsonToolPresentation'

/* ---------- Generic JSON tool row: the shared feed fallback ---------- */
//
// Fires when NO provider claims a tool name (Block.tsx fallback seam). The
// corpus proved the previous fallback starved exactly the tools users
// complained about (plan-json-tool-rows.md): claude MCP tools painted a
// bare name with nothing under it (no input key matched the old headline
// chain), codex orchestration/workspace tools dumped raw JSON <pre> blobs.
//
// Degrades to EXACTLY the old ToolUseRow look (name + one muted headline)
// when the input has nothing beyond its headline — so Bash rows keep their
// current rendering, including the upstream 2-line/160-char command cap.
//
// `live` opts out of highlighting: one-shot hljs is fine for committed
// rows, but per-delta re-highlighting on the live path is the O(bytes²)
// trap documented at the Write streaming preview.

// Hard cap on any pretty-printed JSON slab we hand to the DOM / highlighter.
// WHY 16KB: a single tool payload can carry a multi-megabyte blob (a whole
// file's contents, an orchestration graph, a base64 image). Stringifying and
// mounting that verbatim is the O(bytes²) highlight trap and a memory spike on
// the live path — the slab is a *preview*, not a viewer, so we truncate. The
// exact number is a readability/safety trade, not a semantic boundary; 16KB is
// far more context than any collapsed preview needs while staying cheap to
// paint. Exported so the live BlockRow path caps identically instead of
// re-deriving its own magic number (they used to drift).
export const SLAB_MAX_CHARS = 16 * 1024

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
    // 400-char clamp: a scalar param is a one-line hint in a collapsed slab,
    // not a document. Some tools smuggle a whole prompt / diff into a single
    // string param; past ~400 chars it stops being a glanceable value and
    // starts pushing the row height (and paint cost) unboundedly. The full
    // value is still available on the underlying entry — this is preview text.
    return <span className="break-all whitespace-pre-wrap">{value.length > 400 ? `${value.slice(0, 400)}…` : value}</span>
  }
  if (value === null || typeof value !== 'object') {
    return <span>{String(value)}</span>
  }
  // Nested objects render as pretty JSON below — the top-level key just
  // shows a shape hint here.
  return <span className="text-ink-dim">{Array.isArray(value) ? `[${value.length}]` : '{…}'}</span>
}

export const JsonToolRow = memo(function JsonToolRow({
  block,
  live = false,
}: {
  block: ToolUseBlock
  live?: boolean
}) {
  const input = (block.input ?? null) as Record<string, unknown> | null
  const { display, mcpServer } = prettifyToolName(block.name)
  const headline = smartHeadline(input)

  const headlineText = (() => {
    if (!headline) return null
    if (block.name === 'Bash' && headline.key === 'command') {
      return truncateBashCommand(headline.value)
    }
    if (isAbsolutePathLike(headline.value)) return formatToolFilePath(headline.value, null)
    return headline.value
  })()

  const params = slabEntries(input, headline?.key ?? null)
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

  return (
    <MarkerRow marker="⏺">
      <div>
        <div className="text-[13px] leading-[1.65]">
          <span className="text-accent font-semibold">{display}</span>
          {mcpServer && (
            <span className="ml-2 text-[11px] text-ink-dim border border-border rounded px-1 py-px align-middle">
              MCP · {mcpServer}
            </span>
          )}
        </div>
        {headlineText && (
          <MarkerRow marker="⎿" tone="muted">
            <pre className="font-code text-[12px] leading-[1.55] text-ink-dim whitespace-pre-wrap break-all m-0">
              {headlineText}
            </pre>
          </MarkerRow>
        )}
        {params.length > 0 && (
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
                    codeId={`json-tool:${block.id ?? block.name}`}
                    highlight={!live}
                  />
                )}
              </div>
            </details>
          </MarkerRow>
        )}
      </div>
    </MarkerRow>
  )
})

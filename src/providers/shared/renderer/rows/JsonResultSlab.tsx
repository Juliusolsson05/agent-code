import { memo, useState } from 'react'

import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { CodeBlock } from '@renderer/lib/code/CodeBlock'
import { jsonResultSummary } from '@providers/shared/renderer/rows/jsonToolPresentation'

/* ---------- Collapsed pretty-JSON tool RESULT ---------- */
//
// Companion of JsonToolRow for the result side (residue plan P1): tool
// results that parse as JSON (after tryExtractJson unwraps the MCP text
// envelope / codex wall-time wrapper) render as a collapsed <details>
// with a one-line summary instead of an escaped single-line blob.
//
// The summary keys off `ok` when present — every orchestration/workspace
// result payload in the corpus carries it — and styles danger on
// ok:false even when the transport-level is_error flag was not set
// (MCP errors often ride inside a "successful" envelope).

const RESULT_MAX_CHARS = 16 * 1024

export const JsonResultSlab = memo(function JsonResultSlab({
  value,
  isError,
}: {
  value: unknown
  isError: boolean
}) {
  const summary = jsonResultSummary(value)
  const danger = isError || summary.isError

  // Defer the JSON.stringify + syntax-highlighted CodeBlock until the
  // <details> is first opened. WHY: these slabs render collapsed by default,
  // and on a session restore many result rows mount at once. Stringifying a
  // (potentially 16KB) payload and running the highlighter for every collapsed
  // row is pure wasted work — the pretty JSON is invisible until the user
  // expands it. Mirrors the LazyDetails pattern: `opened` latches true on the
  // first toggle-open and never resets, so re-collapsing keeps the already
  // highlighted body mounted (no re-highlight thrash on toggle).
  const [opened, setOpened] = useState(false)

  return (
    <MarkerRow marker="⎿" tone="muted">
      <details
        className="text-[12px]"
        onToggle={(e) => {
          if (e.currentTarget.open) setOpened(true)
        }}
      >
        <summary
          className={`cursor-pointer select-none ${danger ? 'text-danger' : 'text-ink-dim'}`}
        >
          {summary.label}
        </summary>
        {opened &&
          (() => {
            // Stringify lazily here (not at module top) so this cost is only
            // paid post-expand. A payload that fails to serialize (e.g. a BigInt
            // or a circular structure that slipped past tryExtractJson) yields
            // null and simply renders an empty body rather than throwing.
            const json = (() => {
              try {
                const s = JSON.stringify(value, null, 2)
                return s.length > RESULT_MAX_CHARS
                  ? `${s.slice(0, RESULT_MAX_CHARS)}\n…`
                  : s
              } catch {
                return null
              }
            })()
            if (json === null) return null
            return (
              <div className="mt-1">
                <CodeBlock code={json} language="json" />
              </div>
            )
          })()}
      </details>
    </MarkerRow>
  )
})

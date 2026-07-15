import { memo, useState } from 'react'

import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { CodeBlock } from '@renderer/lib/code/CodeBlock'
import { boundedJsonPreview } from '@renderer/lib/text/boundedJson'
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

  const [open, setOpen] = useState(false)

  return (
    <MarkerRow marker="⎿" tone="muted">
      <details
        className="text-[12px]"
        onToggle={event => setOpen(event.currentTarget.open)}
      >
        <summary
          className={`cursor-pointer select-none ${danger ? 'text-danger' : 'text-ink-dim'}`}
        >
          {summary.label}
        </summary>
        {open &&
          (() => {
            // WHY projection happens only while open and before stringify:
            // slicing a full JSON string is not a work bound because the full
            // object was already traversed and allocated. The bounded projector
            // caps traversal itself, and closing releases the highlighted DOM.
            const json = boundedJsonPreview(value, RESULT_MAX_CHARS)
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

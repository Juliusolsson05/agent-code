import { memo, useState } from 'react'

import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { CodeBlock } from '@renderer/lib/code/CodeBlock'
import { boundedJsonPreview } from '@renderer/lib/text/boundedJson'
import { PagedTextViewer } from '@renderer/lib/text/PagedTextViewer'
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

function ExactJsonDetails({
  value,
  source,
  isError,
}: {
  value: unknown
  source?: string
  isError: boolean
}) {
  const [open, setOpen] = useState(false)
  let exactSource: string | null = null
  if (open) {
    try {
      const serialized = source ?? JSON.stringify(value, null, 2)
      exactSource = typeof serialized === 'string' ? serialized : null
    } catch {
      exactSource = null
    }
  }
  return (
    <details
      className="text-[11px] text-muted"
      onToggle={event => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer select-none">View exact paged source</summary>
      {open ? (
        <div className="mt-1 rounded border border-border bg-surface px-2 py-1.5">
          {exactSource === null ? (
            <span>Exact JSON is unavailable for this non-serializable value.</span>
          ) : (
            <PagedTextViewer source={exactSource} isError={isError} />
          )}
        </div>
      ) : null}
    </details>
  )
}

export const JsonResultSlab = memo(function JsonResultSlab({
  value,
  isError,
  source,
}: {
  value: unknown
  isError: boolean
  source?: string
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
              <div className="mt-1 space-y-2">
                <CodeBlock code={json} language="json" />
                {/* WHY exact serialization is behind its own disclosure: raw object results do not
                    have a source string, and JSON.stringify is proportional to the whole payload.
                    The compact preview must never pay that work. User intent admits the one-time
                    serialization, after which only one bounded text page owns DOM at a time. */}
                <ExactJsonDetails value={value} source={source} isError={danger} />
              </div>
            )
          })()}
      </details>
    </MarkerRow>
  )
})

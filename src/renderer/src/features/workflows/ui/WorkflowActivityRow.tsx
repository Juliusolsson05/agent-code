import { memo, useMemo, useState } from 'react'

import type { WorkflowActivityState } from '../model/workflowState'
import { boundedJsonPreview } from '@renderer/lib/text/boundedJson'
import { PagedTextViewer } from '@renderer/lib/text/PagedTextViewer'

const MAX_SUMMARY_CHARACTERS = 180
const MAX_SUMMARY_SCAN_CHARACTERS = MAX_SUMMARY_CHARACTERS * 2

function contentText(activity: WorkflowActivityState): string | null {
  const content = activity.content
  if (content) {
    // WHY a CSS max-height is insufficient protection: layout still has to create and measure the
    // entire text node before overflow can clip it. Older durable runs may contain megabytes behind
    // a correctly-marked truncated reference, so choose the already-bounded preview without ever
    // stringifying the historical full object in the renderer.
    if (content.truncated) return content.preview || null
    if (typeof content.content === 'string') return content.content
    if (content.content !== undefined) {
      return boundedJsonPreview(content.content) ?? content.preview
    }
    if (content.preview) return content.preview
  }
  if (activity.data !== undefined) {
    return boundedJsonPreview(activity.data) ?? String(activity.data)
  }
  return null
}

function activityGlyph(activity: WorkflowActivityState): string {
  if (activity.status === 'failed') return '✗'
  if (activity.status === 'running') return '◉'
  switch (activity.kind) {
    case 'command': return '$'
    case 'file_change': return '±'
    case 'web_search': return '⌕'
    case 'reasoning': return '∴'
    default: return '✓'
  }
}

function summaryContent(activity: WorkflowActivityState): string | null {
  const content = activity.content
  if (content?.preview) return content.preview.slice(0, MAX_SUMMARY_SCAN_CHARACTERS)
  if (typeof content?.content === 'string') {
    return content.content.slice(0, MAX_SUMMARY_SCAN_CHARACTERS)
  }
  if (typeof activity.data === 'string') {
    return activity.data.slice(0, MAX_SUMMARY_SCAN_CHARACTERS)
  }
  return null
}

function oneLineSummary(activity: WorkflowActivityState): string {
  // WHY summary construction never walks the full tool payload: completed workflow activities can
  // retain a 10 KiB bounded content body for click-through detail. Calling whitespace replacement
  // over every body whenever any sibling activity changes made an expanded resumed agent repeatedly
  // rescan megabytes on the React hot path. The list needs only one line, so the title/pre-bounded
  // preview is authoritative here; exact content is materialized only after this row is expanded.
  const source = activity.title?.slice(0, MAX_SUMMARY_SCAN_CHARACTERS) ||
    summaryContent(activity) ||
    activity.kind.replace(/_/g, ' ')
  const compact = source.replace(/\s+/g, ' ').trim()
  if (compact.length <= MAX_SUMMARY_CHARACTERS) return compact
  return `${compact.slice(0, MAX_SUMMARY_CHARACTERS - 1).trimEnd()}…`
}

function WorkflowActivityRowImpl({
  activity,
}: {
  activity: WorkflowActivityState
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const summary = useMemo(() => oneLineSummary(activity), [activity])
  const content = useMemo(
    () => expanded ? contentText(activity) : null,
    [activity, expanded],
  )
  return (
    <div
      data-workflow-activity-id={activity.activityId}
      className="grid grid-cols-[16px_minmax(0,1fr)] gap-x-2 py-1"
    >
      <span
        className={activity.status === 'failed' ? 'text-danger' : 'text-muted'}
        aria-hidden="true"
      >
        {activityGlyph(activity)}
      </span>
      <div className="min-w-0">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(current => !current)}
          className="flex w-full min-w-0 cursor-pointer items-baseline gap-2 text-left text-[12px] leading-[1.5] hover:bg-surface-hi focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        >
          <span className="shrink-0 capitalize text-ink-dim">
            {activity.kind.replace(/_/g, ' ')}
          </span>
          {/* WHY the command is both character-bounded and CSS-truncated: CSS alone still leaves a
              giant accessible/text node and can expand unexpectedly in nonstandard clients. The
              compact label is the browsing surface; the exact provider payload remains one click
              away below it. */}
          <span className="min-w-0 flex-1 truncate font-code text-ink" title={summary}>
            {summary}
          </span>
          {activity.status === 'running' ? (
            <span className="shrink-0 text-muted">running…</span>
          ) : null}
          <span aria-hidden="true" className="shrink-0 px-1 text-muted">
            {expanded ? '▾' : '▸'}
          </span>
        </button>
        {expanded && activity.title ? (
          <div className="mt-1 rounded-slab bg-surface-hi px-2 py-1.5">
            <PagedTextViewer source={activity.title} />
          </div>
        ) : null}
        {expanded && content && content !== activity.title ? (
          <div className="mt-1 rounded-slab bg-surface-hi px-2 py-1.5">
            <PagedTextViewer source={content} />
          </div>
        ) : null}
        {expanded && activity.error ? (
          <div className="mt-1 text-[11px] text-danger">{activity.error.message}</div>
        ) : null}
      </div>
    </div>
  )
}

// WHY row memoization matters even with bounded text: workflow state is immutable at event
// granularity, so all historical activity objects retain identity when one live tool starts or
// finishes. Re-rendering those unchanged rows discards that useful invariant and makes lineage
// length multiply the cost of each tiny live update.
export const WorkflowActivityRow = memo(WorkflowActivityRowImpl)

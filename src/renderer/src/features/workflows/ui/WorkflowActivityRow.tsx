import { useState } from 'react'

import type { WorkflowActivityState } from '../model/workflowState'

const MAX_SUMMARY_CHARACTERS = 180

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
      try {
        return JSON.stringify(content.content, null, 2)
      } catch {
        return content.preview
      }
    }
    if (content.preview) return content.preview
  }
  if (activity.data !== undefined) {
    try {
      return JSON.stringify(activity.data, null, 2)
    } catch {
      return String(activity.data)
    }
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

function oneLineSummary(activity: WorkflowActivityState, content: string | null): string {
  const source = activity.title || content || activity.kind.replace(/_/g, ' ')
  const compact = source.replace(/\s+/g, ' ').trim()
  if (compact.length <= MAX_SUMMARY_CHARACTERS) return compact
  return `${compact.slice(0, MAX_SUMMARY_CHARACTERS - 1).trimEnd()}…`
}

export function WorkflowActivityRow({
  activity,
}: {
  activity: WorkflowActivityState
}): React.JSX.Element {
  const content = contentText(activity)
  const [expanded, setExpanded] = useState(false)
  const summary = oneLineSummary(activity, content)
  return (
    <div className="grid grid-cols-[16px_minmax(0,1fr)] gap-x-2 py-1">
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
          className="flex w-full min-w-0 cursor-pointer items-baseline gap-2 rounded text-left text-[12px] leading-[1.5] hover:bg-surface-hi focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
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
          <pre className="m-0 mt-1 max-h-[220px] overflow-auto whitespace-pre-wrap break-words rounded bg-surface-hi px-2 py-1.5 font-code text-[11px] leading-[1.5] text-ink-dim">
            {activity.title}
          </pre>
        ) : null}
        {expanded && content && content !== activity.title ? (
          <pre className="m-0 mt-1 max-h-[220px] overflow-auto whitespace-pre-wrap break-words rounded bg-surface-hi px-2 py-1.5 font-code text-[11px] leading-[1.5] text-ink-dim">
            {content}
          </pre>
        ) : null}
        {expanded && activity.error ? (
          <div className="mt-1 text-[11px] text-danger">{activity.error.message}</div>
        ) : null}
      </div>
    </div>
  )
}

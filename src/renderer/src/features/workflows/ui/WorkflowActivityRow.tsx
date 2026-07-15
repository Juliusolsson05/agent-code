import type { WorkflowActivityState } from '../model/workflowState'

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

export function WorkflowActivityRow({
  activity,
}: {
  activity: WorkflowActivityState
}): React.JSX.Element {
  const content = contentText(activity)
  return (
    <div className="grid grid-cols-[16px_minmax(0,1fr)] gap-x-2 py-1">
      <span
        className={activity.status === 'failed' ? 'text-danger' : 'text-muted'}
        aria-hidden="true"
      >
        {activityGlyph(activity)}
      </span>
      <div className="min-w-0">
        <div className="flex min-w-0 items-baseline gap-2 text-[12px] leading-[1.5]">
          <span className="shrink-0 capitalize text-ink-dim">
            {activity.kind.replace(/_/g, ' ')}
          </span>
          {activity.title ? (
            <span className="min-w-0 truncate font-code text-ink">{activity.title}</span>
          ) : null}
          {activity.status === 'running' ? (
            <span className="shrink-0 text-muted">running…</span>
          ) : null}
        </div>
        {content ? (
          <pre className="m-0 mt-1 max-h-[220px] overflow-auto whitespace-pre-wrap break-words rounded bg-surface-hi px-2 py-1.5 font-code text-[11px] leading-[1.5] text-ink-dim">
            {content}
          </pre>
        ) : null}
        {activity.error ? (
          <div className="mt-1 text-[11px] text-danger">{activity.error.message}</div>
        ) : null}
      </div>
    </div>
  )
}

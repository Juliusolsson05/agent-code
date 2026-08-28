import { useState } from 'react'

import type { WorkflowRunReference } from '../client/WorkflowClient'
import { workflowRunActivity, workflowRunStatusLabel } from '../model/workflowRunStatus'
import { WorkflowHistoryDialog } from './WorkflowHistoryDialog'

function workflowLabel(reference: WorkflowRunReference): string {
  return (
    reference.workflow?.title ??
    reference.workflow?.name ??
    `Workflow ${reference.runId.slice(0, 8)}`
  )
}

export function WorkflowViewSelector({
  references,
  historyReferences = references,
  cwd = null,
  selectedRunId,
  onSelect,
}: {
  references: readonly WorkflowRunReference[]
  historyReferences?: readonly WorkflowRunReference[]
  cwd?: string | null
  selectedRunId: string | null
  onSelect: (runId: string | null) => void
}): React.JSX.Element | null {
  const [historyOpen, setHistoryOpen] = useState(false)
  if (references.length === 0) return null

  return (
    <nav
      aria-label="Session views"
      className="flex flex-shrink-0 flex-col border-t border-border bg-surface"
    >
      {/* WHY these are full-width vertical rows rather than a compact tab strip: workflows can
          have descriptive names and status context, and the product model is an ordered stack of
          session views below the composer. A horizontal strip would silently turn that model back
          into side-by-side tabs and collapse as soon as more than one workflow exists. */}
      <div role="tablist" aria-orientation="vertical" className="flex flex-col">
        <div className="flex border-b border-border">
          <button
            type="button"
            role="tab"
            aria-selected={selectedRunId === null}
            onClick={() => onSelect(null)}
            className={`flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left font-code text-[11px] transition-colors ${
              selectedRunId === null
                ? 'bg-surface-hi text-ink'
                : 'text-muted hover:bg-surface-hi/60 hover:text-ink'
            }`}
          >
            <span aria-hidden="true" className="w-3 text-center text-accent">
              {selectedRunId === null ? '●' : ''}
            </span>
            <span>Main</span>
          </button>
          <button
            type="button"
            aria-haspopup="dialog"
            onClick={() => setHistoryOpen(true)}
            className="shrink-0 px-3 py-2 font-code text-[10px] text-muted underline-offset-2 hover:bg-surface-hi/60 hover:text-ink hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-focus-ring"
          >
            Show all
          </button>
        </div>

        {references.map(reference => {
          const selected = selectedRunId === reference.runId
          const activity = workflowRunActivity(reference.status)
          const activityLabel = activity === 'active'
            ? 'Active'
            : activity === 'inactive'
              ? 'Inactive'
              : 'Unknown'
          return (
            <button
              key={reference.runId}
              type="button"
              role="tab"
              aria-selected={selected}
              data-workflow-activity={activity}
              onClick={() => onSelect(reference.runId)}
              className={`flex w-full min-w-0 items-center gap-2 border-b border-border px-3 py-2 text-left font-code text-[11px] transition-colors last:border-b-0 ${
                activity === 'active'
                  ? selected
                    ? 'bg-accent/15 text-ink'
                    : 'bg-accent/10 text-ink-dim hover:bg-accent/15 hover:text-ink'
                  : activity === 'inactive'
                    ? selected
                      ? 'bg-surface-hi text-ink'
                      : 'bg-surface-hi/35 text-muted hover:bg-surface-hi/60 hover:text-ink'
                    : selected
                      ? 'bg-surface-hi text-ink'
                      : 'text-muted hover:bg-surface-hi/60 hover:text-ink'
              }`}
            >
              <span aria-hidden="true" className="w-3 shrink-0 text-center text-accent">
                {selected ? '●' : ''}
              </span>
              <span className="min-w-0 truncate">{workflowLabel(reference)}</span>
              <span
                aria-label={`Status: ${activityLabel} (${workflowRunStatusLabel(reference.status)})`}
                className={`ml-auto shrink-0 border px-1.5 py-0.5 text-[9px] leading-none ${
                  activity === 'active'
                    ? 'border-accent/35 text-accent'
                    : 'border-border text-muted'
                }`}
              >
                {activityLabel}
              </span>
            </button>
          )
        })}
      </div>
      <WorkflowHistoryDialog
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        references={historyReferences}
        cwd={cwd}
      />
    </nav>
  )
}

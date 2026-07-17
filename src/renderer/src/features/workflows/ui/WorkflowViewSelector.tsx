import type { WorkflowRunReference } from '../client/WorkflowClient'

function workflowLabel(reference: WorkflowRunReference): string {
  return (
    reference.workflow?.title ??
    reference.workflow?.name ??
    `Workflow ${reference.runId.slice(0, 8)}`
  )
}

export function WorkflowViewSelector({
  references,
  selectedRunId,
  onSelect,
}: {
  references: readonly WorkflowRunReference[]
  selectedRunId: string | null
  onSelect: (runId: string | null) => void
}): React.JSX.Element | null {
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
        <button
          type="button"
          role="tab"
          aria-selected={selectedRunId === null}
          onClick={() => onSelect(null)}
          className={`flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left font-code text-[11px] transition-colors ${
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

        {references.map(reference => {
          const selected = selectedRunId === reference.runId
          return (
            <button
              key={reference.runId}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => onSelect(reference.runId)}
              className={`flex w-full min-w-0 items-center gap-2 border-b border-border px-3 py-2 text-left font-code text-[11px] transition-colors last:border-b-0 ${
                selected
                  ? 'bg-surface-hi text-ink'
                  : 'text-muted hover:bg-surface-hi/60 hover:text-ink'
              }`}
            >
              <span aria-hidden="true" className="w-3 shrink-0 text-center text-accent">
                {selected ? '●' : ''}
              </span>
              <span className="min-w-0 truncate">{workflowLabel(reference)}</span>
            </button>
          )
        })}
      </div>
    </nav>
  )
}

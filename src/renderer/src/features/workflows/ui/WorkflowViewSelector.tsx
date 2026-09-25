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

  // Vertical tablist keys (plan K5, ledger N7), the SettingsSidebar shape:
  // ↑↓ and Home/End move focus AND select, wrapping. Automatic activation is
  // right here because a view switch is cheap and reversible, unlike a live
  // settings radio. Before this every row was its own Tab stop with no arrows,
  // so reaching the composer from Main meant tabbing through every workflow.
  //
  // `tabbableId` is the ONE row that is a Tab stop. A selectedRunId that is
  // not listed (a run still loading, or one that has dropped out of
  // `references`) falls back to Main. Otherwise no row would be tabbable and
  // the whole group would drop out of the Tab order.
  const ids: Array<string | null> = [null, ...references.map(reference => reference.runId)]
  const tabbableId = ids.includes(selectedRunId) ? selectedRunId : null
  const onTabListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const index = Math.max(0, ids.indexOf(tabbableId))
    const next =
      event.key === 'ArrowDown' ? index + 1
        : event.key === 'ArrowUp' ? index - 1
          : event.key === 'Home' ? 0
            : event.key === 'End' ? ids.length - 1
              : null
    if (next === null) return
    event.preventDefault()
    const target = (next + ids.length) % ids.length
    onSelect(ids[target]!)
    event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')[target]?.focus()
  }
  const tabFocus = 'outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-focus-ring'

  return (
    <nav
      aria-label="Session views"
      // `relative` anchors "Show All", which sits OUTSIDE the tablist (see
      // below) but is drawn over the Main row's right end.
      className="relative flex flex-shrink-0 flex-col border-t border-border bg-surface"
    >
      {/* WHY these are full-width vertical rows rather than a compact tab strip: workflows can
          have descriptive names and status context, and the product model is an ordered stack of
          session views below the composer. A horizontal strip would silently turn that model back
          into side-by-side tabs and collapse as soon as more than one workflow exists. */}
      <div
        role="tablist"
        aria-orientation="vertical"
        // Not "Session views" again: the <nav> already carries that name, and
        // a screen reader would announce it twice on the way in.
        aria-label="Views"
        className="flex flex-col"
        onKeyDown={onTabListKeyDown}
      >
          {/* h-8 is pinned (not py-2) so "Show All", positioned over this row
              from outside the tablist, is exactly as tall as the row it sits
              on. pr-20 keeps the label clear of it. */}
          <button
            type="button"
            role="tab"
            aria-selected={selectedRunId === null}
            tabIndex={tabbableId === null ? 0 : -1}
            onClick={() => onSelect(null)}
            className={`flex h-8 w-full min-w-0 items-center gap-2 border-b border-border px-3 pr-20 text-left font-code text-[11px] transition-colors ${tabFocus} ${
              selectedRunId === null
                ? 'bg-surface-hi text-ink'
                : 'text-muted hover:bg-row-hover-bg hover:text-ink'
            }`}
          >
            <span aria-hidden="true" className="w-3 text-center text-accent">
              {selectedRunId === null ? '●' : ''}
            </span>
            <span>Main</span>
          </button>

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
              tabIndex={tabbableId === reference.runId ? 0 : -1}
              data-workflow-activity={activity}
              onClick={() => onSelect(reference.runId)}
              className={`flex w-full min-w-0 items-center gap-2 border-b border-border px-3 py-2 text-left font-code text-[11px] transition-colors last:border-b-0 ${tabFocus} ${
                activity === 'active'
                  ? selected
                    ? 'bg-accent/15 text-ink'
                    : 'bg-accent/10 text-ink-dim hover:bg-accent/15 hover:text-ink'
                  : activity === 'inactive'
                    ? selected
                      ? 'bg-surface-hi text-ink'
                      : 'bg-surface-hi/35 text-muted hover:bg-row-hover-bg hover:text-ink'
                    : selected
                      ? 'bg-surface-hi text-ink'
                      : 'text-muted hover:bg-row-hover-bg hover:text-ink'
              }`}
            >
              <span aria-hidden="true" className="w-3 shrink-0 text-center text-accent">
                {selected ? '●' : ''}
              </span>
              <span className="min-w-0 truncate">{workflowLabel(reference)}</span>
              <span
                aria-label={`Status: ${activityLabel} (${workflowRunStatusLabel(reference.status)})`}
                className={`rounded-chip ml-auto shrink-0 border px-1.5 py-0.5 text-[10px] leading-none ${
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
      {/* "Show All" is a dialog opener, not a view, so it must not live inside
          the tablist: a plain button among tabs is invalid ARIA (tablist owns
          only tabs) and would be skipped by the arrow keys while still
          sitting between tabs in DOM order. It is last in DOM order (Tab
          reaches it after the one tablist stop) and is drawn over the Main
          row, where it always was. */}
      <button
        type="button"
        aria-haspopup="dialog"
        onClick={() => setHistoryOpen(true)}
        className="absolute right-0 top-0 flex h-8 items-center px-3 font-code text-[10px] text-muted underline-offset-2 hover:bg-control-hover-bg hover:text-ink hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-focus-ring"
      >
        Show All
      </button>
      <WorkflowHistoryDialog
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        references={historyReferences}
        cwd={cwd}
      />
    </nav>
  )
}

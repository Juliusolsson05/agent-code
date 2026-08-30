import { useCallback, useMemo } from 'react'

import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { tabIndexLabel } from '@renderer/workspace/tile-tree/paneLabels'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { normalizeGridShape } from '@renderer/workspace/dispatch/gridShape'
import type { TabId } from '@renderer/workspace/types'

// Which projects a Grid Dispatch row is restricted to.
//
// WHY a multi-select rather than the single-choice list this replaced: a row is
// a working context, and a working context routinely spans two repos — an app
// and the service it calls, a package and its consumer. One was the wrong
// number, and `buildDispatchGroups` already groups by tab, so a two-project row
// renders as two labelled sections in its index for free.
//
// "Any project" is the EMPTY SET, not a separate value — which is why it is
// rendered as a clear action rather than a checkbox that would let the user
// construct the contradictory "any project, and also B".
//
// Binding FILTERS, it never fills. The row's index and strips stop offering
// other projects' agents; no lane is populated, moved, or cleared.
export function DispatchRowProjectModal({
  rowIndex,
  workspace,
  onClose,
}: {
  rowIndex: number | null
  workspace: Workspace
  onClose: () => void
}) {
  const tiled = workspace.state.dispatchMode?.tiled
  // Read the CURRENT bindings so the right rows are checked. Guard the null
  // rowIndex: the surface stays mounted-but-closed between opens.
  const selected = useMemo<TabId[]>(() => {
    if (rowIndex === null || !tiled) return []
    return normalizeGridShape(tiled).rows[rowIndex]?.projectTabIds ?? []
  }, [rowIndex, tiled])

  const commit = useCallback(
    (next: TabId[]) => {
      if (rowIndex === null) return
      workspace.setDispatchRowProjects(rowIndex, next)
    },
    [rowIndex, workspace],
  )

  const toggle = useCallback(
    (tabId: TabId) => {
      // Toggling keeps the dialog OPEN — picking several projects is the point,
      // and a list that closed on the first click would make the second choice
      // a second trip. The single-choice version it replaced closed on click.
      commit(
        selected.includes(tabId)
          ? selected.filter(id => id !== tabId)
          : [...selected, tabId],
      )
    },
    [commit, selected],
  )

  return (
    <Dialog open={rowIndex !== null} onOpenChange={next => { if (!next) onClose() }}>
      <DialogContent className="w-[380px] max-w-[calc(100vw-64px)]">
        <DialogHeader>
          <DialogTitle>Row projects</DialogTitle>
          <DialogDescription className="text-[10px]">
            Restrict this row&rsquo;s index and lane selectors. Agents already in
            its lanes are left alone.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col px-2 py-2">
          {workspace.state.tabs.map((tab, index) => {
            const checked = selected.includes(tab.id)
            return (
              <button
                key={tab.id}
                type="button"
                role="checkbox"
                aria-checked={checked}
                onClick={() => toggle(tab.id)}
                className={`flex items-center gap-2 rounded px-3 py-1.5 text-left text-xs hover:bg-surface-raised focus:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring ${
                  checked ? 'text-accent' : 'text-fg'
                }`}
              >
                <span className="w-3 flex-shrink-0 text-center">{checked ? '✓' : ''}</span>
                {/* The same A/B/C vocabulary the dispatch labels and pinned
                    project chips use, so the picker names projects the way the
                    index does rather than inventing a second scheme. */}
                <span className="min-w-0 truncate">
                  {tabIndexLabel(index)} · {tab.title}
                </span>
              </button>
            )
          })}
        </div>

        <DialogFooter className="items-center justify-between">
          <Button
            type="button"
            variant="ghost"
            disabled={selected.length === 0}
            onClick={() => commit([])}
          >
            Any project
          </Button>
          <Button type="button" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

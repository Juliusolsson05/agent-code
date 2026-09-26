import { useCallback, useMemo, useRef } from 'react'

import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { DialogActions } from '@renderer/components/ui/dialog-actions'
import { KbdLegend } from '@renderer/components/ui/kbd'
import { useListNavigation } from '@renderer/lib/useListNavigation'
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
  const stage = workspace.state.stage
  // Read the CURRENT bindings so the right rows are checked. Guard the null
  // rowIndex: the surface stays mounted-but-closed between opens.
  const selected = useMemo<TabId[]>(() => {
    if (rowIndex === null) return []
    return normalizeGridShape(stage).rows[rowIndex]?.projectTabIds ?? []
  }, [rowIndex, stage])

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

  // KEYBOARD (plan S10): a multi-select listbox on the shared list keys.
  // Before, every project was its own Tab stop (a role=checkbox button) and
  // no arrow key moved. Space and Enter both toggle the highlighted project
  // (there is nothing to "commit" — toggles apply live, which is why the
  // footer's only exit is Close). Keyed by tab id so the highlight stays on
  // its project if a tab closes while the dialog is open.
  const listRef = useRef<HTMLDivElement>(null)
  const tabs = workspace.state.tabs
  const keys = useMemo(() => tabs.map(tab => tab.id), [tabs])
  const toggleAt = (index: number) => {
    const tab = tabs[index]
    if (tab) toggle(tab.id)
  }
  const nav = useListNavigation({
    count: tabs.length,
    keys,
    resetKey: rowIndex,
    onActivate: toggleAt,
    onToggle: toggleAt,
    idPrefix: 'row-project',
  })

  return (
    <Dialog open={rowIndex !== null} onOpenChange={next => { if (!next) onClose() }}>
      <DialogContent
        size="sm"
        onKeyDown={nav.onKeyDown}
        onOpenAutoFocus={event => {
          // The listbox is the focus owner (focus-owner invariant).
          event.preventDefault()
          listRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>Row Projects</DialogTitle>
          <DialogDescription>
            Restrict this row&rsquo;s index and lane selectors. Agents already in
            its lanes are left alone.
          </DialogDescription>
        </DialogHeader>

        <div className="px-4 py-3">
        <div
          ref={listRef}
          role="listbox"
          aria-multiselectable
          aria-label="Row projects"
          aria-activedescendant={nav.activeId}
          tabIndex={0}
          className="rounded-slab flex flex-col overflow-hidden border border-border bg-canvas py-1 outline-none focus-visible:border-focus-ring focus-visible:ring-1 focus-visible:ring-focus-ring"
        >
          {tabs.map((tab, index) => {
            const checked = selected.includes(tab.id)
            const highlighted = index === nav.index
            return (
              <button
                key={tab.id}
                type="button"
                {...nav.getItemProps(index)}
                role="option"
                aria-selected={checked}
                // Not a tab stop: the listbox is (plan K4).
                tabIndex={-1}
                // Tokens (plan T1/T7): these used bare `rounded` (renders 0),
                // `text-fg` and `bg-surface-raised`, neither of which exists
                // in the theme — so the hover and resting text colours were
                // silently unset.
                className={`flex items-center gap-2 border-l-2 px-3 py-1.5 text-left text-[12px] ${
                  highlighted ? 'border-l-accent bg-row-selected-bg' : 'border-l-transparent hover:bg-row-hover-bg'
                } ${checked ? 'text-accent' : 'text-ink'}`}
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

        </div>

        {/* Done only ever closed (toggles apply live), so it is the
            close-only `Close ⎋` (plan H5), with Any Project beside it. */}
        <DialogActions
          onCancel={onClose}
          cancelLabel="Close"
          legend={<KbdLegend items={[{ keys: ['Up', 'Down'], label: 'move' }, { keys: ['Space'], label: 'toggle' }]} />}
          extraActions={
            <Button type="button" variant="ghost" size="sm" disabled={selected.length === 0} onClick={() => commit([])}>
              Any Project
            </Button>
          }
        />
      </DialogContent>
    </Dialog>
  )
}

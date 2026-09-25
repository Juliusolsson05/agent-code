import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { DialogActions, focusedControlOwnsEnter } from '@renderer/components/ui/dialog-actions'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { KbdLegend } from '@renderer/components/ui/kbd'
import type { TabId } from '@renderer/workspace/types'
import { withVisibleControls } from '@shared/text/visibleControls'

type ReorderTabOption = {
  id: TabId
  title: string
}

type Props = {
  open: boolean
  tabs: ReorderTabOption[]
  activeTabId: TabId
  onCancel: () => void
  onConfirm: (tabIds: TabId[]) => void
}

export function ReorderTabsModal({
  open,
  tabs,
  activeTabId,
  onCancel,
  onConfirm,
}: Props) {
  const [draftTabs, setDraftTabs] = useState<ReorderTabOption[]>(tabs)
  const [cursorTabId, setCursorTabId] = useState<TabId>(activeTabId)
  const [movingTabId, setMovingTabId] = useState<TabId | null>(null)
  const [snapshotTabIds, setSnapshotTabIds] = useState<TabId[]>(() => tabs.map(tab => tab.id))
  const [error, setError] = useState<string | null>(null)
  // The LISTBOX is the focus owner (aria-activedescendant must sit on the
  // focused element — lib/useListNavigation's focus-owner invariant).
  const listRef = useRef<HTMLDivElement>(null)
  const wasOpenRef = useRef(false)

  // The modal keeps its own snapshot while open because tab order is a
  // short-lived draft, not workspace state. That lets arrow navigation feel
  // instant and cancelable, and it also gives confirm() a stable baseline for
  // detecting "the real tab list changed underneath us" before submitting a
  // permutation that may no longer describe the workspace.
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setDraftTabs(tabs)
      setSnapshotTabIds(tabs.map(tab => tab.id))
      setCursorTabId(
        tabs.some(tab => tab.id === activeTabId)
          ? activeTabId
          : (tabs[0]?.id ?? activeTabId),
      )
      setMovingTabId(null)
      setError(null)
    }
    wasOpenRef.current = open
  }, [activeTabId, open, tabs])

  const cursorIndex = useMemo(
    () => draftTabs.findIndex(tab => tab.id === cursorTabId),
    [cursorTabId, draftTabs],
  )

  const moveCursor = useCallback(
    (delta: number) => {
      setError(null)
      setCursorTabId(prevId => {
        const index = draftTabs.findIndex(tab => tab.id === prevId)
        const fallbackIndex = index < 0 ? 0 : index
        const nextIndex = Math.max(0, Math.min(draftTabs.length - 1, fallbackIndex + delta))
        return draftTabs[nextIndex]?.id ?? prevId
      })
    },
    [draftTabs],
  )

  /**
   * Move a specific tab by one slot.
   *
   * WHY this takes an explicit id rather than reading `movingTabId`: reordering
   * was Enter-to-pick then Arrow-to-move, which meant a mouse user could open
   * this dialog, click rows all day, press Done, and commit the UNCHANGED
   * order — the dialog's entire purpose was keyboard-only. The per-row ↑/↓
   * buttons need to move the row they belong to without first requiring a
   * "pick" step that only Enter can perform.
   */
  const moveTabById = useCallback(
    (tabId: TabId, delta: -1 | 1) => {
      setError(null)
      // The picked row follows the moved row, the way a row CLICK already made
      // it (`if (movingTabId) setMovingTabId(tab.id)` below). Enter on a ↑/↓
      // button only became reachable with #867's guard, and without this the
      // accent "moving" paint stayed on the row the user picked earlier while
      // the move happened elsewhere — so the next arrow key moved the wrong
      // row, which is the exact confusion the two-phase model exists to avoid.
      setMovingTabId(prev => (prev ? tabId : prev))
      setDraftTabs(prev => {
        const index = prev.findIndex(tab => tab.id === tabId)
        if (index < 0) return prev
        const nextIndex = index + delta
        if (nextIndex < 0 || nextIndex >= prev.length) return prev
        const next = [...prev]
        const [tab] = next.splice(index, 1)
        next.splice(nextIndex, 0, tab)
        return next
      })
      setCursorTabId(tabId)
      // A move can DISABLE the button that performed it (the row is now at an
      // end), and a disabled control keeps focus while dropping out of the
      // event path — real keys then reach neither the button nor this dialog's
      // ancestor handler, so arrows and Enter went dead mid-reorder. Hand focus
      // back to the list, which is where every key in this dialog belongs.
      listRef.current?.focus()
    },
    [],
  )

  const movePickedTab = useCallback(
    (delta: number) => {
      if (!movingTabId) return
      setError(null)
      setDraftTabs(prev => {
        const index = prev.findIndex(tab => tab.id === movingTabId)
        if (index < 0) return prev
        // Clamped, so Home/End (delta ±length) land the tab at an end.
        const nextIndex = Math.max(0, Math.min(prev.length - 1, index + delta))
        if (nextIndex === index) return prev
        const next = [...prev]
        const [tab] = next.splice(index, 1)
        next.splice(nextIndex, 0, tab)
        return next
      })
      setCursorTabId(movingTabId)
    },
    [movingTabId],
  )

  const confirm = useCallback(() => {
    const currentTabIds = tabs.map(tab => tab.id)
    // `reorderTabs` defensively rejects stale permutations too, but doing the
    // check here lets the modal stay open and tell the user what happened
    // instead of closing after a no-op. The exact-order comparison is
    // deliberate: even another reorder elsewhere invalidates this draft because
    // its positions were authored against the snapshot captured on open.
    const tabsUnchanged =
      currentTabIds.length === snapshotTabIds.length &&
      currentTabIds.every((id, index) => id === snapshotTabIds[index])
    if (!tabsUnchanged) {
      setError('Tabs changed while this modal was open. Close and reopen to reorder.')
      return
    }
    onConfirm(draftTabs.map(tab => tab.id))
  }, [draftTabs, onConfirm, snapshotTabIds, tabs])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Two-phase keyboard model: arrows navigate the cursor until Enter picks
      // a tab, then arrows move only that picked tab. Keeping cursor and moving
      // ids separate is what prevents accidental reorders while the user is
      // still browsing the list.
      if (e.key === 'Enter') {
        // A focused footer button owns its own Enter (#867). This footer is a
        // plain `<div>` rather than a `DialogFooter`, which is exactly why the
        // check is on the focused CONTROL and not on the slot: Tab to Cancel
        // and Enter used to `confirm()` the reorder being abandoned, and Tab
        // to Done with nothing picked entered move mode instead.
        if (focusedControlOwnsEnter(e.target)) return
        e.preventDefault()
        if (movingTabId) {
          confirm()
          return
        }
        if (cursorIndex >= 0) {
          setError(null)
          setMovingTabId(cursorTabId)
        }
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (movingTabId) {
          movePickedTab(-1)
        } else {
          moveCursor(-1)
        }
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (movingTabId) {
          movePickedTab(1)
        } else {
          moveCursor(1)
        }
        return
      }
      // Home/End (plan K5): jump the cursor to an end while browsing, or send
      // the PICKED tab to the top/bottom while moving — "move this tab to
      // the front" was N presses of ↑ before.
      if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault()
        const delta = (e.key === 'Home' ? -1 : 1) * draftTabs.length
        if (movingTabId) movePickedTab(delta)
        else moveCursor(delta)
      }
    },
    [confirm, cursorIndex, cursorTabId, draftTabs.length, moveCursor, movePickedTab, movingTabId],
  )

  return (
    <Dialog
      open={open}
      onOpenChange={nextOpen => {
        if (!nextOpen) onCancel()
      }}
    >
      <DialogContent
        onKeyDown={onKeyDown}
        onOpenAutoFocus={event => {
          event.preventDefault()
          listRef.current?.focus()
        }}
        onEscapeKeyDown={event => {
          // WHY the first Escape can be consumed: while a row is "picked",
          // Escape means abandon that local move, not abandon the entire
          // reorder draft. Radix remains the owner of the actual dialog close.
          if (!movingTabId) return
          event.preventDefault()
          setMovingTabId(null)
        }}
        size="sm"
        // Standard anatomy (plan T3) instead of the whole-content p-5 card.
        className="flex max-h-[80vh] flex-col"
      >
        <DialogHeader>
          <DialogTitle>Reorder Tabs</DialogTitle>
          <DialogDescription className="sr-only">
            Select a tab, then use arrow keys to move it. Enter confirms the order.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col px-4 py-3">

        {/* Roving focus: the rows left the tab order, so the cursor has to be
            announced rather than focused (#867 review). */}
        <div
          ref={listRef}
          role="listbox"
          // One Tab stop (plan K4): Shift+Tab from the footer returns here.
          tabIndex={0}
          aria-label="Tab order"
          aria-activedescendant={cursorTabId ? `reorder-tabs-row-${cursorTabId}` : undefined}
          className="rounded-slab flex-1 min-h-0 overflow-auto border border-border bg-canvas outline-none focus-visible:border-focus-ring focus-visible:ring-1 focus-visible:ring-focus-ring"
        >
          {draftTabs.map((tab, index) => {
            // (row highlight: T7 — row-selected + 2px accent bar for the
            // cursor; the PICKED row keeps solid accent, because "this tab is
            // lifted and moving" is a different state from "the cursor is
            // here" and must not look like a hover.)
            const cursor = tab.id === cursorTabId
            const moving = tab.id === movingTabId
            const active = tab.id === activeTabId
            return (
              // Row + reorder controls. The row itself stays a <button> (it
              // sets the cursor), so the arrows must be SIBLINGS, not children
              // — nested buttons are invalid HTML and the inner one would not
              // receive clicks reliably.
              <div
                key={tab.id}
                className="flex items-stretch border-b border-border last:border-b-0"
              >
              <button
                type="button"
                id={`reorder-tabs-row-${tab.id}`}
                role="option"
                aria-selected={moving}
                // Out of the tab order, with the arrow-driven highlight the
                // only selection signal (#867, same as #862). A Tab-focused
                // row can diverge from that highlight, and Space clicks the
                // FOCUSED one — so the user would act on a row other than the
                // one the dialog is showing as chosen, whatever Enter does.
                tabIndex={-1}
                // And `tabIndex={-1}` does not stop CLICK focus. A clicked row
                // held focus and owned the next Enter, so Enter-to-pick bowed
                // out: move mode was never entered, the arrows kept moving the
                // cursor instead of the tab, and keyboard reordering was dead
                // for the rest of the dialog — after one mouse click, in the
                // dialog built for mixed mouse and keyboard use.
                onMouseDown={event => event.preventDefault()}
                onClick={() => {
                  setError(null)
                  setCursorTabId(tab.id)
                  if (movingTabId) setMovingTabId(tab.id)
                }}
                className={`
                  min-w-0 flex-1 flex items-center gap-3 px-3 py-1.5 border-l-2
                  text-left
                  ${moving
                    ? 'border-l-accent bg-accent text-accent-fg'
                    : cursor
                      ? 'border-l-accent text-ink bg-row-selected-bg'
                      : 'border-l-transparent text-ink hover:bg-row-hover-bg'}
                `}
              >
                <span className="w-6 flex-shrink-0 text-[10px] tabular-nums opacity-70">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 truncate text-[12px]">
                  {withVisibleControls(tab.title)}
                </span>
                {active && (
                  <span
                    className={`
                      h-1.5 w-1.5 flex-shrink-0 rounded-full
                      ${moving ? 'bg-accent-fg' : 'bg-accent'}
                    `}
                    aria-label="Active tab"
                  />
                )}
              </button>
                <button
                  type="button"
                  aria-label={`Move ${tab.title} up`}
                  disabled={index === 0}
                  onClick={() => moveTabById(tab.id, -1)}
                  className="w-7 shrink-0 border-l border-border text-[11px] leading-none text-muted outline-none hover:bg-control-hover-bg hover:text-ink focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-focus-ring disabled:opacity-30 disabled:hover:bg-transparent"
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label={`Move ${tab.title} down`}
                  disabled={index === draftTabs.length - 1}
                  onClick={() => moveTabById(tab.id, 1)}
                  className="w-7 shrink-0 border-l border-border text-[11px] leading-none text-muted outline-none hover:bg-control-hover-bg hover:text-ink focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-focus-ring disabled:opacity-30 disabled:hover:bg-transparent"
                >
                  ↓
                </button>
              </div>
            )
          })}
        </div>

        </div>

        {/* The legend follows the phase, because the same keys mean different
            things in each (plan H3): browsing, ↑↓ move the cursor and Enter
            PICKS; with a tab picked, ↑↓ move that tab and Escape puts it
            down. Done's ↩ chip likewise appears only while a tab is picked —
            before that, Enter picks rather than commits, and a chip claiming
            otherwise would be a lie. confirmOnEnter is false because the
            list's own handler owns Enter in both phases. */}
        <DialogActions
          confirmLabel="Done"
          onConfirm={confirm}
          onCancel={onCancel}
          confirmOnEnter={false}
          confirmKey={movingTabId ? 'Enter' : null}
          legend={
            <KbdLegend
              items={movingTabId
                ? [{ keys: ['Up', 'Down'], label: 'move tab' }, { keys: ['Escape'], label: 'put down' }]
                : [{ keys: ['Up', 'Down'], label: 'select' }, { keys: ['Enter'], label: 'pick up' }]}
            />
          }
        >
          <span className={error ? 'text-danger' : 'tabular-nums'}>
            {error ?? `${cursorIndex >= 0 ? cursorIndex + 1 : 0}/${draftTabs.length}`}
          </span>
        </DialogActions>
      </DialogContent>
    </Dialog>
  )
}

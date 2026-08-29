import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import type { TabId } from '@renderer/workspace/types'

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
  const dialogRef = useRef<HTMLDivElement>(null)
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
    (delta: -1 | 1) => {
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
    },
    [],
  )

  const movePickedTab = useCallback(
    (delta: -1 | 1) => {
      if (!movingTabId) return
      setError(null)
      setDraftTabs(prev => {
        const index = prev.findIndex(tab => tab.id === movingTabId)
        if (index < 0) return prev
        const nextIndex = index + delta
        if (nextIndex < 0 || nextIndex >= prev.length) return prev
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
      }
    },
    [confirm, cursorIndex, cursorTabId, moveCursor, movePickedTab, movingTabId],
  )

  return (
    <Dialog
      open={open}
      onOpenChange={nextOpen => {
        if (!nextOpen) onCancel()
      }}
    >
      <DialogContent
        ref={dialogRef}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onOpenAutoFocus={event => {
          event.preventDefault()
          dialogRef.current?.focus()
        }}
        onEscapeKeyDown={event => {
          // WHY the first Escape can be consumed: while a row is "picked",
          // Escape means abandon that local move, not abandon the entire
          // reorder draft. Radix remains the owner of the actual dialog close.
          if (!movingTabId) return
          event.preventDefault()
          setMovingTabId(null)
        }}
        className="flex max-h-[80vh] w-[460px] max-w-[calc(100vw-64px)] flex-col p-5"
      >
        <DialogTitle className="mb-1 flex-shrink-0 font-semibold">Reorder Tabs</DialogTitle>
        <DialogDescription className="sr-only">
          Select a tab, then use arrow keys to move it. Enter confirms the order.
        </DialogDescription>

        <div className="rounded-slab flex-1 min-h-0 overflow-auto border border-border bg-canvas">
          {draftTabs.map((tab, index) => {
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
                onClick={() => {
                  setError(null)
                  setCursorTabId(tab.id)
                  if (movingTabId) setMovingTabId(tab.id)
                }}
                className={`
                  min-w-0 flex-1 flex items-center gap-3 px-3 py-2 border-l-4
                  text-left
                  ${moving
                    ? 'border-l-accent bg-accent text-accent-fg'
                    : cursor
                      ? 'border-l-accent text-ink bg-surface-hi'
                      : 'border-l-transparent text-ink hover:bg-surface'}
                `}
              >
                <span className="w-6 flex-shrink-0 text-[10px] tabular-nums opacity-70">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 truncate text-[12px]">
                  {tab.title}
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
                  className="w-7 shrink-0 border-l border-border text-[11px] leading-none text-muted hover:bg-surface-hi hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label={`Move ${tab.title} down`}
                  disabled={index === draftTabs.length - 1}
                  onClick={() => moveTabById(tab.id, 1)}
                  className="w-7 shrink-0 border-l border-border text-[11px] leading-none text-muted hover:bg-surface-hi hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
                >
                  ↓
                </button>
              </div>
            )
          })}
        </div>

        <div className="mt-4 flex flex-shrink-0 items-center justify-between">
          <div className="min-w-0 flex-1 truncate pr-3 text-[10px] text-muted tabular-nums">
            {error ?? `${cursorIndex >= 0 ? cursorIndex + 1 : 0}/${draftTabs.length}`}
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              onClick={onCancel}
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={confirm}
            >
              Done
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

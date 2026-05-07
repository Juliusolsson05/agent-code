import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

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
      requestAnimationFrame(() => dialogRef.current?.focus())
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
      if (e.key === 'Escape') {
        e.preventDefault()
        if (movingTabId) {
          setMovingTabId(null)
          return
        }
        onCancel()
        return
      }
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
    [confirm, cursorIndex, cursorTabId, moveCursor, movePickedTab, movingTabId, onCancel],
  )

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-canvas/80 backdrop-blur-sm"
      onMouseDown={e => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="w-[460px] max-w-[calc(100vw-64px)] max-h-[80vh] bg-surface border border-border-hi p-5 flex flex-col outline-none"
      >
        <div className="text-[13px] font-semibold text-ink mb-4 flex-shrink-0">
          Reorder Tabs
        </div>

        <div className="flex-1 min-h-0 overflow-auto border border-border bg-canvas">
          {draftTabs.map((tab, index) => {
            const cursor = tab.id === cursorTabId
            const moving = tab.id === movingTabId
            const active = tab.id === activeTabId
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => {
                  setError(null)
                  setCursorTabId(tab.id)
                  if (movingTabId) setMovingTabId(tab.id)
                }}
                className={`
                  w-full flex items-center gap-3 px-3 py-2 border-l-4
                  border-b border-border last:border-b-0 text-left
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
            )
          })}
        </div>

        <div className="mt-4 flex flex-shrink-0 items-center justify-between">
          <div className="min-w-0 flex-1 truncate pr-3 text-[10px] text-muted tabular-nums">
            {error ?? `${cursorIndex >= 0 ? cursorIndex + 1 : 0}/${draftTabs.length}`}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-1.5 text-[12px] border border-border text-ink-dim hover:text-ink hover:border-border-hi"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={confirm}
              className="px-4 py-1.5 text-[12px] bg-accent text-accent-fg border border-accent"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

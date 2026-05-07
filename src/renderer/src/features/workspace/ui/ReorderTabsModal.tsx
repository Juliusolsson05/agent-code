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
  const [selectedTabId, setSelectedTabId] = useState<TabId>(activeTabId)
  const dialogRef = useRef<HTMLDivElement>(null)
  const wasOpenRef = useRef(false)

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setDraftTabs(tabs)
      setSelectedTabId(
        tabs.some(tab => tab.id === activeTabId)
          ? activeTabId
          : (tabs[0]?.id ?? activeTabId),
      )
      requestAnimationFrame(() => dialogRef.current?.focus())
    }
    wasOpenRef.current = open
  }, [activeTabId, open, tabs])

  const selectedIndex = useMemo(
    () => draftTabs.findIndex(tab => tab.id === selectedTabId),
    [draftTabs, selectedTabId],
  )

  const moveSelected = useCallback(
    (delta: -1 | 1) => {
      setDraftTabs(prev => {
        const index = prev.findIndex(tab => tab.id === selectedTabId)
        if (index < 0) return prev
        const nextIndex = index + delta
        if (nextIndex < 0 || nextIndex >= prev.length) return prev
        const next = [...prev]
        const [tab] = next.splice(index, 1)
        next.splice(nextIndex, 0, tab)
        return next
      })
    },
    [selectedTabId],
  )

  const confirm = useCallback(() => {
    onConfirm(draftTabs.map(tab => tab.id))
  }, [draftTabs, onConfirm])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        confirm()
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        moveSelected(-1)
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        moveSelected(1)
      }
    },
    [confirm, moveSelected, onCancel],
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
            const selected = tab.id === selectedTabId
            const active = tab.id === activeTabId
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setSelectedTabId(tab.id)}
                className={`
                  w-full flex items-center gap-3 px-3 py-2
                  border-b border-border last:border-b-0 text-left
                  ${selected ? 'bg-accent text-accent-fg' : 'text-ink hover:bg-surface'}
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
                      ${selected ? 'bg-accent-fg' : 'bg-accent'}
                    `}
                    aria-label="Active tab"
                  />
                )}
              </button>
            )
          })}
        </div>

        <div className="mt-4 flex flex-shrink-0 items-center justify-between">
          <div className="text-[10px] text-muted tabular-nums">
            {selectedIndex >= 0 ? selectedIndex + 1 : 0}/{draftTabs.length}
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

import { useEffect, useMemo, useState } from 'react'

import type { TabId } from './types'

type TileTabOption = {
  id: TabId
  title: string
}

type Props = {
  open: boolean
  tabs: TileTabOption[]
  initialSelectedIds: TabId[]
  onCancel: () => void
  onConfirm: (tabIds: TabId[]) => void
}

export function TileTabsModal({
  open,
  tabs,
  initialSelectedIds,
  onCancel,
  onConfirm,
}: Props) {
  const [selected, setSelected] = useState<TabId[]>(initialSelectedIds)

  useEffect(() => {
    if (!open) return
    setSelected(initialSelectedIds)
  }, [open, initialSelectedIds])

  const selectedSet = useMemo(() => new Set(selected), [selected])

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
      <div className="w-[540px] max-w-[calc(100vw-64px)] bg-surface border border-border-hi p-6 max-h-[80vh] flex flex-col">
        <div className="text-[13px] font-semibold text-ink mb-2 flex-shrink-0">
          Tile Tabs
        </div>
        <div className="text-[11px] text-muted mb-4 flex-shrink-0">
          Select two or more tabs to show side by side.
        </div>

        <div className="flex-1 min-h-0 overflow-auto border border-border bg-canvas">
          {tabs.map(tab => {
            const checked = selectedSet.has(tab.id)
            return (
              <label
                key={tab.id}
                className="flex items-center gap-3 px-3 py-2 border-b border-border last:border-b-0 cursor-pointer hover:bg-surface"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => {
                    setSelected(prev =>
                      prev.includes(tab.id)
                        ? prev.filter(id => id !== tab.id)
                        : [...prev, tab.id],
                    )
                  }}
                />
                <span className="text-[12px] text-ink truncate">{tab.title}</span>
              </label>
            )
          })}
        </div>

        <div className="flex justify-end gap-2 mt-4 flex-shrink-0">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-1.5 text-[12px] border border-border text-ink-dim hover:text-ink hover:border-border-hi"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(selected)}
            disabled={selected.length < 2}
            className="px-4 py-1.5 text-[12px] bg-accent text-accent-fg border border-accent disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Tile Tabs
          </button>
        </div>
      </div>
    </div>
  )
}

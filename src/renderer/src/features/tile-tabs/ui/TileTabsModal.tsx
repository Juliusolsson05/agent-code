import { useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import type { TabId } from '@renderer/workspace/types'

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
  const wasOpenRef = useRef(false)

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setSelected(initialSelectedIds)
    }
    wasOpenRef.current = open
  }, [open, initialSelectedIds])

  useEffect(() => {
    if (!open) return
    const validIds = new Set(tabs.map(tab => tab.id))
    setSelected(prev => {
      const next = prev.filter(id => validIds.has(id))
      return next.length === prev.length ? prev : next
    })
  }, [open, tabs])

  const selectedSet = useMemo(() => new Set(selected), [selected])

  return (
    <Dialog
      open={open}
      onOpenChange={nextOpen => {
        if (!nextOpen) onCancel()
      }}
    >
      <DialogContent className="flex max-h-[80vh] w-[540px] max-w-[calc(100vw-64px)] flex-col">
        <DialogHeader>
          <DialogTitle className="font-semibold">Tiled Tabs</DialogTitle>
          <DialogDescription>Select two or more tabs to show side by side.</DialogDescription>
        </DialogHeader>

        <div className="rounded-slab mx-4 my-4 min-h-0 flex-1 overflow-auto border border-border bg-canvas">
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

        <DialogFooter>
          <Button
            type="button"
            onClick={onCancel}
            variant="outline"
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => onConfirm(selected)}
            disabled={selected.length < 2}
          >
            Open Tiled Tabs
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

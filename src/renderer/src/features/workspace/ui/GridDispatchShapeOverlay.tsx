import { useCallback, useState } from 'react'

import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { NumberInput } from '@renderer/components/ui/number-input'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import {
  MAX_DISPATCH_LANES,
  MAX_DISPATCH_ROWS,
  MAX_DISPATCH_TILES,
  MIN_DISPATCH_TILES,
  normalizeGridShape,
} from '@renderer/workspace/dispatch/gridShape'

// The Grid Dispatch shape editor.
//
// WHY a per-row editor and NOT two inputs labelled "rows" and "columns":
//
// This modal is where the user forms their mental model of what Grid Dispatch
// IS. Two number inputs teach a rows x columns rectangle, and the rectangle is
// the exception, not the rule — projects do not have equal agent counts, so
// four lanes on top and two below is the ordinary shape. A user taught the
// rectangle here spends the rest of the session feeling like they are fighting
// the tool every time they want an uneven row.
//
// A stepper per row teaches the truth (rows are independent) and the block
// preview SHOWS raggedness rather than describing it, so "4 on top, 2 below" is
// something the user sees before committing rather than discovers later.
//
// This is the bulk path, not the primary one. Day to day the shape is edited in
// place by New Lane / New Row / Remove Lane / Remove Row, which is why those
// commands keep their exact per-row semantics.
//
// We deliberately do NOT use window.prompt/confirm — Electron modal dialogs
// block the renderer's event loop and the project's browser-automation guidance
// forbids them.

type Props = {
  workspace: Workspace
  onClose: () => void
}

export function GridDispatchShapeOverlay({ workspace, onClose }: Props) {
  const tiled = workspace.state.dispatchMode?.tiled
  // Open on the CURRENT shape when a grid already exists, so re-running the
  // command is the "reshape it" path rather than a reset.
  const [rowLengths, setRowLengths] = useState<number[]>(() =>
    tiled ? normalizeGridShape(tiled).rows.map(row => row.length) : [2],
  )

  const total = rowLengths.reduce((sum, length) => sum + length, 0)
  const remaining = MAX_DISPATCH_LANES - total

  const setRow = useCallback((index: number, next: number) => {
    setRowLengths(current => current.map((length, i) => (i === index ? next : length)))
  }, [])

  const addRow = useCallback(() => {
    setRowLengths(current => [
      ...current,
      // Inherit the last row's width, clamped to what is left — the same rule
      // the New Row command follows, so the two paths cannot disagree.
      Math.max(MIN_DISPATCH_TILES, Math.min(current[current.length - 1] ?? 1, remaining)),
    ])
  }, [remaining])

  const removeRow = useCallback((index: number) => {
    setRowLengths(current => current.filter((_, i) => i !== index))
  }, [])

  const commit = useCallback(() => {
    if (tiled) workspace.setDispatchGridShape(rowLengths)
    else void workspace.enterTiledDispatch(rowLengths)
    onClose()
  }, [tiled, workspace, rowLengths, onClose])

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key !== 'Enter') return
      event.preventDefault()
      commit()
    },
    [commit],
  )

  return (
    <Dialog open onOpenChange={next => { if (!next) onClose() }}>
      <DialogContent className="w-[400px] max-w-[calc(100vw-64px)]">
        <DialogHeader>
          <DialogTitle>Grid Dispatch</DialogTitle>
          <DialogDescription className="text-[10px]">
            Set a lane count per row. Rows are independent — uneven rows are
            normal. Each row gets its own agent index and project.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2 px-4 py-3" onKeyDown={onKeyDown}>
          {rowLengths.map((length, index) => (
            <div key={index} className="flex items-center gap-3">
              <span className="w-12 flex-shrink-0 text-[10px] uppercase text-muted">
                Row {index + 1}
              </span>
              <div className="w-[118px] flex-shrink-0">
                <NumberInput
                  id={`grid-row-${index}`}
                  aria-label={`Row ${index + 1} lane count`}
                  min={MIN_DISPATCH_TILES}
                  // Cap at what this row could actually grow to, so a stepper
                  // never offers a value the commit would refuse.
                  max={Math.min(MAX_DISPATCH_TILES, length + Math.max(0, remaining))}
                  value={length}
                  onChange={next => setRow(index, next)}
                />
              </div>
              {/* The preview is the point: unequal rows are legible as unequal
                  before the user commits to them. */}
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-[3px]">
                {Array.from({ length }, (_, lane) => (
                  <span key={lane} className="h-3 w-3 rounded-[2px] bg-accent/50" />
                ))}
              </div>
              {rowLengths.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeRow(index)}
                  aria-label={`Remove row ${index + 1}`}
                  title={`Remove row ${index + 1}`}
                  className="flex-shrink-0 px-1 text-xs text-muted hover:text-fg"
                >
                  ×
                </button>
              )}
            </div>
          ))}

          <div className="flex items-center justify-between pt-1">
            <Button
              type="button"
              variant="ghost"
              onClick={addRow}
              disabled={rowLengths.length >= MAX_DISPATCH_ROWS || remaining < MIN_DISPATCH_TILES}
            >
              + Add row
            </Button>
            {/* Steppers and Add row disable at the ceiling rather than
                accepting input and clamping it silently, so the limit is
                visible before it bites. */}
            <span className="text-[10px] text-muted">
              {total} of {MAX_DISPATCH_LANES} lanes
            </span>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" onClick={onClose} variant="ghost">
            Cancel
          </Button>
          <Button type="button" onClick={commit}>
            {tiled ? 'Apply' : 'Open'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

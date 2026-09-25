import { useCallback, useMemo, useRef, useState } from 'react'

import { Button } from '@renderer/components/ui/button'
import { DialogActions } from '@renderer/components/ui/dialog-actions'
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import type { GridShapeRow } from '@renderer/workspace/dispatch/gridShape'
import { tabIndexLabel } from '@renderer/workspace/tile-tree/paneLabels'
import { radioGroupKeyDown } from '@renderer/lib/radioGroupKeys'
import type { DispatchGridRow, TabId } from '@renderer/workspace/types'

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
  const stage = workspace.state.stage
  // Rows carry their SOURCE index, not just a length. A bare number[] cannot
  // express which row was removed: deleting the middle of three shifts every
  // later row up a slot, and a positional apply then re-points row 1's binding
  // at row 2's contents — deleting the last row and resizing the survivors.
  // The draft carries the per-row CONFIG too, not just lengths, because
  // Advanced mode edits projects and density here. Applying config through the
  // same commit as the shape is what makes "set the whole grid up in one place"
  // true rather than a second trip through per-row header controls.
  type DraftRow = GridShapeRow & Pick<DispatchGridRow, 'projectTabIds' | 'capChildren'>
  const [rows, setRows] = useState<DraftRow[]>(() =>
    // The draft always starts from the CURRENT shape. It used to fall back to
    // a fresh `[2]` draft when no lane grid existed, because this dialog was
    // also how Grid Dispatch was ENTERED; the stage always exists now (#992),
    // so the editor only ever reshapes.
    normalizeGridShape(stage).rows.map((row, index) => ({
      length: row.length,
      sourceRow: index,
      projectTabIds: row.projectTabIds,
      capChildren: row.capChildren,
    })),
  )
  // Opens in the mode that can REPRESENT the current grid. Derived rather than
  // persisted: no new settings key, and the editor can never open in a mode
  // that hides configuration the user already made.
  const [advanced, setAdvanced] = useState(() =>
    rows.some(row => (row.projectTabIds?.length ?? 0) > 0 || row.capChildren === false),
  )
  const tabs = workspace.state.tabs
  const projectLabel = useMemo(
    () => (ids: TabId[] | undefined) => {
      if (!ids || ids.length === 0) return 'Any project'
      return ids
        .map(id => {
          const index = tabs.findIndex(tab => tab.id === id)
          return index >= 0 ? `${tabIndexLabel(index)} ${tabs[index]!.title}` : id
        })
        .join(', ')
    },
    [tabs],
  )
  const firstInputRef = useRef<HTMLInputElement | null>(null)

  const total = rows.reduce((sum, row) => sum + row.length, 0)
  const remaining = MAX_DISPATCH_LANES - total

  const setRowLength = useCallback((index: number, next: number) => {
    setRows(current => current.map((row, i) => (i === index ? { ...row, length: next } : row)))
  }, [])

  const toggleRowProject = useCallback((index: number, tabId: TabId) => {
    setRows(current => current.map((row, i) => {
      if (i !== index) return row
      const ids = row.projectTabIds ?? []
      const next = ids.includes(tabId) ? ids.filter(id => id !== tabId) : [...ids, tabId]
      return { ...row, projectTabIds: next.length > 0 ? next : undefined }
    }))
  }, [])

  const setRowCap = useCallback((index: number, cap: boolean) => {
    setRows(current => current.map((row, i) => (i === index ? { ...row, capChildren: cap } : row)))
  }, [])

  const addRow = useCallback(() => {
    setRows(current => [
      ...current,
      {
        // Inherits the LAST row's width. The New Row command inherits the
        // FOCUSED row's instead — the editor has no focus concept, so the two
        // deliberately differ rather than pretending to share a rule.
        length: Math.max(
          MIN_DISPATCH_TILES,
          Math.min(current[current.length - 1]?.length ?? 1, remaining),
        ),
        sourceRow: null,
      },
    ])
  }, [remaining])

  const removeRow = useCallback((index: number) => {
    setRows(current => current.filter((_, i) => i !== index))
  }, [])

  const commit = useCallback(() => {
    // Only close when the reshape was actually accepted. The controls constrain
    // input to what setGridShape allows, so a refusal should be unreachable —
    // but closing on a refusal would silently discard the user's edit.
    if (!workspace.setDispatchGridShape(rows)) return
    // Config is applied AFTER the shape, by output position: setGridShape may
    // have added or removed rows, so a row's config can only be addressed
    // once the new shape exists.
    //
    // (An `else` branch entered Grid Dispatch asynchronously and applied the
    // config in its `.then` until #992. Reshape is synchronous, so the whole
    // commit is now one tick and cannot be observed half-applied.)
    rows.forEach((row, index) => {
      workspace.setDispatchRowProjects(index, row.projectTabIds ?? [])
      workspace.setDispatchRowCapChildren(index, row.capChildren !== false)
    })
    onClose()
  }, [workspace, rows, onClose])

  // Enter commits ONLY from a number field. Scoped to the inputs rather than
  // the whole body because a body-level handler swallows Enter on the row-remove
  // and Add row buttons, applying the dialog instead of activating the control
  // the user had focused.
  const onInputKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key !== 'Enter') return
      event.preventDefault()
      commit()
    },
    [commit],
  )

  return (
    <Dialog open onOpenChange={next => { if (!next) onClose() }}>
      <DialogContent
        // Presets (plan T2): 400/560 were two more one-off widths.
        size={advanced ? 'md' : 'sm'}
        // Take mount focus back from Radix, which would otherwise land it on a
        // stepper button — see the inputRef note below.
        onOpenAutoFocus={event => {
          event.preventDefault()
          firstInputRef.current?.focus()
          firstInputRef.current?.select()
        }}
      >
        <DialogHeader>
          <div className="flex items-baseline justify-between gap-3">
            <DialogTitle>Grid Dispatch</DialogTitle>
            {/* A two-state mode switch: aria-pressed says which is on (it was
                colour only), and each half takes the focus ring (plan T4).
                `text-fg` here and below was an undefined token — hover did
                nothing. */}
            <div className="flex items-center gap-1 text-[10px] uppercase text-muted">
              <button
                type="button"
                aria-pressed={!advanced}
                onClick={() => setAdvanced(false)}
                className={`rounded-control px-1 outline-none focus-visible:ring-1 focus-visible:ring-focus-ring ${advanced ? 'hover:text-ink' : 'text-accent'}`}
              >
                Simple
              </button>
              <span aria-hidden>│</span>
              <button
                type="button"
                aria-pressed={advanced}
                onClick={() => setAdvanced(true)}
                className={`rounded-control px-1 outline-none focus-visible:ring-1 focus-visible:ring-focus-ring ${advanced ? 'text-accent' : 'hover:text-ink'}`}
              >
                Advanced
              </button>
            </div>
          </div>
          <DialogDescription>
            {advanced
              ? 'Each row is its own dispatch view: its own agent index, its own projects, its own density.'
              : 'Set a lane count per row. Rows are independent — uneven rows are normal.'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2 px-4 py-3">
          {rows.map((draft, index) => (
            <div
              key={index}
              className={advanced ? 'rounded-slab flex flex-col gap-1.5 border border-border px-2 py-2' : ''}
            >
            <div className="flex items-center gap-3">
              <span className="w-12 flex-shrink-0 text-[10px] uppercase text-muted">
                Row {index + 1}
              </span>
              <div className="w-[118px] flex-shrink-0" onKeyDown={onInputKeyDown}>
                <NumberInput
                  id={`grid-row-${index}`}
                  aria-label={`Row ${index + 1} lane count`}
                  // NumberInput documents that dialogs must forward this:
                  // Radix's FocusScope focuses the first TABBABLE node after
                  // mount — the "−" stepper — and does so after any child
                  // autoFocus, so typing a count would otherwise go nowhere.
                  inputRef={index === 0 ? firstInputRef : undefined}
                  min={MIN_DISPATCH_TILES}
                  // Cap at what this row could actually grow to, so a stepper
                  // never offers a value the commit would refuse.
                  max={Math.min(MAX_DISPATCH_TILES, draft.length + Math.max(0, remaining))}
                  value={draft.length}
                  onChange={next => setRowLength(index, next)}
                />
              </div>
              {/* The preview is the point: unequal rows are legible as unequal
                  before the user commits to them. */}
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-[3px]">
                {Array.from({ length: draft.length }, (_, lane) => (
                  // Square, no radius: a preview of GRID lanes, and the grid
                  // is square (styles.css hard rule 1). `rounded-[2px]` was
                  // an arbitrary radius outside the token tiers.
                  <span key={lane} className="h-3 w-3 bg-accent/50" />
                ))}
              </div>
              {rows.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeRow(index)}
                  aria-label={`Remove row ${index + 1}`}
                  title={`Remove row ${index + 1}`}
                  className="rounded-control flex-shrink-0 px-1 text-[12px] text-muted outline-none hover:text-ink focus-visible:ring-1 focus-visible:ring-focus-ring"
                >
                  ×
                </button>
              )}
            </div>
            {advanced && (
              <>
                <div className="flex flex-wrap items-center gap-1.5 pl-12 text-[10px]">
                  <span className="uppercase text-muted">Projects</span>
                  {tabs.map((tab, tabIndex) => {
                    const on = draft.projectTabIds?.includes(tab.id) ?? false
                    return (
                      <button
                        key={tab.id}
                        type="button"
                        role="checkbox"
                        aria-checked={on}
                        onClick={() => toggleRowProject(index, tab.id)}
                        title={tab.title}
                        className={`rounded-control max-w-[10rem] truncate border px-1.5 py-0.5 outline-none focus-visible:ring-1 focus-visible:ring-focus-ring ${
                          on
                            ? 'border-accent/60 text-accent'
                            : 'border-border text-muted hover:text-ink'
                        }`}
                      >
                        {on ? '✓ ' : ''}{tabIndexLabel(tabIndex)} {tab.title}
                      </button>
                    )
                  })}
                  {/* Named so the empty set is legible as a STATE, not as an
                      absence the user has to infer from nothing being ticked. */}
                  {(draft.projectTabIds?.length ?? 0) === 0 && (
                    <span className="text-muted">— {projectLabel(undefined)}</span>
                  )}
                </div>
                {/* A real radio group: the "(•)" glyphs were the only signal of
                    which option was on, so assistive tech heard two plain
                    buttons. */}
                <div
                  role="radiogroup"
                  aria-label={`Row ${index + 1} nested agents`}
                  className="flex items-center gap-3 pl-12 text-[10px]"
                  // Shared radio keys: arrows move AND choose (APG, a draft
                  // edit until Apply). A focused radio keeps its own Enter,
                  // so Enter here never reaches the dialog's Apply (K3).
                  onKeyDown={radioGroupKeyDown}
                >
                  <span className="uppercase text-muted">Nested agents</span>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={draft.capChildren === false}
                    tabIndex={draft.capChildren === false ? 0 : -1}
                    onClick={() => setRowCap(index, false)}
                    className={`rounded-control outline-none focus-visible:ring-1 focus-visible:ring-focus-ring ${draft.capChildren === false ? 'text-accent' : 'text-muted hover:text-ink'}`}
                  >
                    {draft.capChildren === false ? '(•)' : '( )'} Show all
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={draft.capChildren !== false}
                    tabIndex={draft.capChildren !== false ? 0 : -1}
                    onClick={() => setRowCap(index, true)}
                    className={`rounded-control outline-none focus-visible:ring-1 focus-visible:ring-focus-ring ${draft.capChildren !== false ? 'text-accent' : 'text-muted hover:text-ink'}`}
                  >
                    {draft.capChildren !== false ? '(•)' : '( )'} Cap
                  </button>
                </div>
              </>
            )}
            </div>
          ))}

          <div className="flex items-center justify-between pt-1">
            <Button
              type="button"
              variant="ghost"
              onClick={addRow}
              disabled={rows.length >= MAX_DISPATCH_ROWS || remaining < MIN_DISPATCH_TILES}
            >
              + Add Row
            </Button>
            {/* Steppers and Add row disable at the ceiling rather than
                accepting input and clamping it silently, so the limit is
                visible before it bites. */}
            <span className="text-[10px] text-muted">
              {total} of {MAX_DISPATCH_LANES} lanes
            </span>
          </div>
        </div>

        {/* Enter applies from a number field (onInputKeyDown above), which
            is why Apply carries ↩ while DialogActions does NOT wire Enter
            itself: a dialog-level Enter would also fire from the row-remove
            and Add Row buttons (see onInputKeyDown's note). */}
        <DialogActions confirmLabel="Apply" onConfirm={commit} onCancel={onClose} confirmOnEnter={false} />
      </DialogContent>
    </Dialog>
  )
}

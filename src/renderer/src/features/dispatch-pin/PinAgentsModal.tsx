import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { KbdLegend } from '@renderer/components/ui/kbd'
import { DialogActions } from '@renderer/components/ui/dialog-actions'
import { tabIndexLabel } from '@renderer/workspace/tile-tree/paneLabels'
import type { SessionId } from '@renderer/workspace/types'

import { useRef } from 'react'

import { usePinAgentsKeybinds } from './usePinAgentsKeybinds'
import { withVisibleControls } from '@shared/text/visibleControls'

// Modal for the `Pin Sessions…` command. Multi-select: Space toggles
// the focused row, Enter commits, Escape cancels. Mouse click also
// toggles; hover moves focus so a mouse user gets the same
// selection-cursor feedback as a keyboard user.
//
// Why this lives in features/dispatch-pin/ rather than next to
// DispatchLayout: the modal is command-palette chrome (mounted at
// the App root, not inside Dispatch), and putting it next to the
// command that opens it keeps the small feature self-contained.
//
// The modal is intentionally dumb. The owning App builds the
// candidate row list (it has cheap access to WorkspaceState) and
// passes it in via props. We don't reach into useAppStore from this
// component so the keybind hook's selection draft is the single
// source of truth while the modal is open — restating the same
// "transient draft, not workspace data" invariant that
// uiShell.pinAgentsOpen documents.

export type PinAgentsModalRow = {
  sessionId: SessionId
  /** Index of the owning tab in workspace.state.tabs. Used to render
   *  the tab letter chip (A · …, B · …) so cross-project pins stay
   *  disambiguable while picking. */
  tabIndex: number
  tabTitle: string
  /** Display title — pre-resolved by the parent so this component
   *  doesn't have to know about the title/cwd fallback logic. */
  title: string
}

type Props = {
  open: boolean
  rows: PinAgentsModalRow[]
  initialSelectedIds: SessionId[]
  onCancel: () => void
  onConfirm: (ids: SessionId[]) => void
}

export function PinAgentsModal({
  open,
  rows,
  initialSelectedIds,
  onCancel,
  onConfirm,
}: Props) {
  const { selectedIds, focusedIndex, onKeyDown, getRowProps } =
    usePinAgentsKeybinds({
      rows,
      initialSelectedIds,
      open,
      onCommit: onConfirm,
    })

  const selectedSet = new Set(selectedIds)
  const listRef = useRef<HTMLDivElement>(null)

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
          // WHY this dialog needs what its two siblings already had (#867
          // review): Radix's FocusScope focuses the first TABBABLE node on
          // mount. Taking the rows out of the tab order made that node
          // CANCEL — so on a fresh open, the Enter this dialog advertises as
          // "commit" was handed to Cancel and threw the pins away.
          //
          // Focus goes to the LISTBOX, not the dialog surface: it carries
          // aria-activedescendant, which only announces from the focused
          // element (focus-owner invariant, lib/useListNavigation header).
          // Keys still reach onKeyDown above by bubbling.
          event.preventDefault()
          listRef.current?.focus()
        }}
        // Standard anatomy (plan T3): header / padded body / DialogActions.
        // It used to pad the WHOLE content (p-5) with a bespoke title and a
        // legend row in the body, so it matched no sibling dialog.
        className="flex max-h-[86vh] flex-col"
      >
        <DialogHeader>
          <DialogTitle>Pin Sessions</DialogTitle>
          <DialogDescription className="sr-only">
            Choose the agents pinned in Dispatch. Space toggles and Enter commits.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col px-4 py-3">
        {/* Roving focus: the rows left the tab order, so the highlight has to be
            announced instead of focused. `aria-activedescendant` on the
            listbox is what tells a screen reader which option the arrows are
            on — without it the highlight is a CSS class and nothing else
            (#867 review). */}
        <div
          ref={listRef}
          role="listbox"
          // One Tab stop (plan K4) so Shift+Tab from the footer returns here.
          tabIndex={0}
          aria-label="Agents to pin"
          aria-multiselectable
          aria-activedescendant={rows[focusedIndex] ? `pin-agents-row-${rows[focusedIndex]!.sessionId}` : undefined}
          className="rounded-slab flex-1 min-h-0 overflow-auto border border-border bg-canvas py-1 outline-none focus-visible:border-focus-ring focus-visible:ring-1 focus-visible:ring-focus-ring"
        >
          {rows.length === 0 ? (
            <div className="px-3 py-4 text-[12px] text-muted">
              No agents available to pin.
            </div>
          ) : (
            rows.map((row, index) => {
              const isSelected = selectedSet.has(row.sessionId)
              const isFocused = index === focusedIndex
              // Hover (mousemove), click (highlight + toggle, via the hook's
              // onItemClick), no focus theft on mousedown, and keyboard
              // scroll-into-view all come from useListNavigation.
              return (
                <button
                  key={row.sessionId}
                  type="button"
                  {...getRowProps(index)}
                  id={`pin-agents-row-${row.sessionId}`}
                  role="option"
                  aria-selected={isSelected}
                  // Out of the tab order, with the arrow-driven highlight the
                  // only selection signal (#867, same as #862). A Tab-focused
                  // row can diverge from that highlight, and Space clicks the
                  // FOCUSED one — so the user would act on a row other than the
                  // one the dialog is showing as chosen, whatever Enter does.
                  tabIndex={-1}
                  className={`
                    w-full flex items-center gap-3 px-3 py-1.5 border-l-2 text-left text-ink
                    ${isFocused ? 'border-l-accent bg-row-selected-bg' : 'border-l-transparent hover:bg-row-hover-bg'}
                  `}
                >
                  <span
                    className={`
                      w-4 flex-shrink-0 text-center text-[11px] leading-none
                      ${isSelected ? 'text-accent' : 'text-muted'}
                    `}
                    aria-hidden="true"
                  >
                    {isSelected ? '★' : '·'}
                  </span>
                  <span className="w-6 flex-shrink-0 text-[10px] tabular-nums text-muted">
                    {tabIndexLabel(row.tabIndex)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[12px]">
                    {withVisibleControls(row.title)}
                  </span>
                  <span
                    className="rounded-chip
                      flex-shrink-0 px-1.5 py-px text-[10px] font-code
                      leading-none text-muted border border-border bg-surface-hi
                      truncate max-w-[160px]
                    "
                    title={row.tabTitle}
                  >
                    {row.tabTitle}
                  </span>
                </button>
              )
            })
          )}
        </div>
        </div>

        {/* WHY this footer had to exist: rows toggle on click, but `onCommit`
            fired ONLY from the Enter branch of usePinAgentsKeybinds. A mouse
            user could build an entire selection and then have no way to save
            it — and the only pointer-reachable exit, clicking the backdrop,
            ran onCancel and silently discarded the whole draft.

            The key legend moved here from a row in the body (plan H3): ↑↓ and
            Space have no button, so they are the legend; Enter and Escape
            are chips on the buttons they perform. The counter rides in the
            same left slot.

            confirmOnEnter is false because the row list already owns Enter via
            usePinAgentsKeybinds — wiring it here too would commit twice. The
            ↩ chip still shows, because Enter still commits. */}
        <DialogActions
          confirmLabel={
            selectedIds.length === 1 ? 'Pin 1 Agent' : `Pin ${selectedIds.length} Agents`
          }
          // Nothing selected commits an empty list under a button reading
          // "Pin 0 Agents", which reads like a no-op the user has to guess at.
          confirmDisabled={selectedIds.length === 0}
          onConfirm={() => onConfirm(selectedIds)}
          onCancel={onCancel}
          confirmOnEnter={false}
          legend={<KbdLegend items={[{ keys: ['Up', 'Down'], label: 'move' }, { keys: ['Space'], label: 'toggle' }]} />}
        >
          <span className="tabular-nums">
            {selectedIds.length} pinned · {Math.min(focusedIndex + 1, Math.max(1, rows.length))}/{Math.max(1, rows.length)}
          </span>
        </DialogActions>
      </DialogContent>
    </Dialog>
  )
}

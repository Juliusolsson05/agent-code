import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { DialogActions } from '@renderer/components/ui/dialog-actions'
import { tabIndexLabel } from '@renderer/workspace/tile-tree/paneLabels'
import type { SessionId } from '@renderer/workspace/types'

import { usePinAgentsKeybinds } from './usePinAgentsKeybinds'

// Modal for the `Pin Agents…` command. Multi-select: Space toggles
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
  const { selectedIds, focusedIndex, setFocusedIndex, toggle, onKeyDown } =
    usePinAgentsKeybinds({
      rows,
      initialSelectedIds,
      open,
      onCommit: onConfirm,
    })

  const selectedSet = new Set(selectedIds)

  return (
    <Dialog
      open={open}
      onOpenChange={nextOpen => {
        if (!nextOpen) onCancel()
      }}
    >
      <DialogContent
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="flex max-h-[80vh] w-[520px] max-w-[calc(100vw-64px)] flex-col p-5"
      >
        <DialogTitle className="mb-1 flex-shrink-0 font-semibold">Pin Agents</DialogTitle>
        <DialogDescription className="sr-only">
          Choose the agents pinned in Dispatch. Space toggles and Enter commits.
        </DialogDescription>

        <div className="flex-1 min-h-0 overflow-auto border border-border bg-canvas">
          {rows.length === 0 ? (
            <div className="px-3 py-4 text-[12px] text-muted">
              No agents available to pin.
            </div>
          ) : (
            rows.map((row, index) => {
              const isSelected = selectedSet.has(row.sessionId)
              const isFocused = index === focusedIndex
              return (
                <button
                  key={row.sessionId}
                  type="button"
                  onClick={() => {
                    setFocusedIndex(index)
                    toggle(row.sessionId)
                  }}
                  onMouseEnter={() => setFocusedIndex(index)}
                  className={`
                    w-full flex items-center gap-3 px-3 py-2 border-l-4
                    border-b border-border last:border-b-0 text-left
                    ${isFocused
                      ? 'border-l-accent text-ink bg-surface-hi'
                      : 'border-l-transparent text-ink hover:bg-surface'}
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
                  <span className="w-6 flex-shrink-0 text-[10px] tabular-nums opacity-70">
                    {tabIndexLabel(row.tabIndex)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[12px]">
                    {row.title}
                  </span>
                  <span
                    className="
                      flex-shrink-0 px-1.5 py-[1px] text-[9px] font-code
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

        <div className="mt-4 flex flex-shrink-0 items-center justify-between text-[10px] text-muted">
          {/* Selection counter on the left, key legend on the right.
              Legend stays compact — no separate help dialog because the
              three bindings ARE the entire interaction surface. */}
          <span className="tabular-nums">
            {selectedIds.length} pinned · {focusedIndex + 1}/{Math.max(1, rows.length)}
          </span>
          <span className="flex items-center gap-3">
            <span><kbd>Space</kbd> toggle</span>
            <span><kbd>Enter</kbd> commit</span>
            <span><kbd>Esc</kbd> cancel</span>
          </span>
        </div>
        {/* WHY this footer had to exist: rows toggle on click, but `onCommit`
            fired ONLY from the Enter branch of usePinAgentsKeybinds. A mouse
            user could build an entire selection and then have no way to save
            it — and the only pointer-reachable exit, clicking the backdrop,
            ran onCancel and silently discarded the whole draft. The key legend
            above stays because those bindings are still real; it just is not
            the only way out any more.

            confirmOnEnter is false because the row list already owns Enter via
            usePinAgentsKeybinds — wiring it here too would commit twice. */}
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
        />
      </DialogContent>
    </Dialog>
  )
}

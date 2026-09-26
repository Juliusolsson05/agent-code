import { useEffect, useState } from 'react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { DialogActions, focusDialogActionOnOpen } from '@renderer/components/ui/dialog-actions'
import {
  currentCloseConfirmation,
  resolveCloseConfirmation,
  subscribeToCloseConfirmation,
} from '@renderer/workspace/closeConfirmationBroker'
import type { PendingCloseConfirmation } from '@renderer/workspace/closeConfirmationBroker'
import { withVisibleControls } from '@shared/text/visibleControls'

/**
 * The confirmation the close paths await before ending anything.
 *
 * It LISTS the sessions rather than only counting them. The audit's finding was
 * that a close expanding from one row to four looked identical to closing one;
 * a bare "close 4 sessions?" fixes the count but still leaves the user unable
 * to check whether the four are the four they meant.
 *
 * Keyboard contract (#867, keyboard-first plan K1): there is deliberately
 * NO commit key on this dialog (`confirmKey={null}`), and focus is put on
 * Cancel EXPLICITLY on open. Enter on open therefore cancels, and Enter on a
 * Tab-focused Close activates it natively. A dialog-level Enter handler would
 * call preventDefault and could turn Enter-on-Cancel into a close — the exact
 * bug #867 found in three other dialogs. Before DialogActions this relied on
 * Radix focusing "the first tabbable control", which was Cancel only because
 * of footer order; the explicit focus makes it a contract instead of layout
 * luck. Cancel shows ⎋; Close shows no chip, because no key performs it.
 */
export function CloseConfirmationDialog() {
  const [pending, setPending] = useState<PendingCloseConfirmation | null>(
    currentCloseConfirmation(),
  )

  useEffect(() => subscribeToCloseConfirmation(setPending), [])

  const request = pending?.request
  const live = request?.targets.filter(target => target.live) ?? []
  // A third, "scoped" presentation lived here until #992 — "Close the agent or
  // the tab?", with Close Agent / Close Tab (N) buttons — for the one session
  // whose close used to take its project with it (the tab's root tile leaf).
  // No session is special like that any more, so this dialog only ever asks
  // one question about one list: end these, or don't.

  return (
    <Dialog
      open={Boolean(request)}
      onOpenChange={nextOpen => {
        // Escape, the overlay, and the close button all mean DECLINE. Leaving
        // the promise unresolved would hang the close path forever, which
        // presents as a pane that will not close with no error anywhere.
        if (!nextOpen) resolveCloseConfirmation(false)
      }}
    >
      <DialogContent size="sm" onOpenAutoFocus={focusDialogActionOnOpen('cancel')}>
        <DialogHeader>
          <DialogTitle>
            {request?.reason === 'running'
              // "session" not "agent": a shell running a job reaches this
              // dialog too now that terminal foreground state counts as
              // working (#865), and it isn't an agent.
              ? 'Close a working session?'
              : request?.reason === 'irreversible'
                ? 'Kill this session permanently?'
                : 'Close these sessions?'}
          </DialogTitle>
          {/* The summary embeds the session's own title, and for a SINGLE
              target the escaped target list below never renders — so this line
              is the only identity the user is shown before authorising a kill
              (#1049 re-review). */}
          <DialogDescription>{request ? withVisibleControls(request.summary) : null}</DialogDescription>
        </DialogHeader>

        {/* One padded body (plan T3). The list and the Undo note used to sit
            directly in the grid with no inset, so both ran flush into the
            dialog's rounded border. */}
        {(request && request.targets.length > 1) || live.length > 0 ? (
        <div className="flex flex-col gap-3 px-4 py-3">
        {request && request.targets.length > 1 ? (
          <div className="rounded-slab max-h-56 overflow-auto border border-border">
            {request.targets.map(target => (
              <div
                key={target.sessionId}
                className="flex items-center justify-between border-b border-border/40 px-2 py-1 text-[12px] last:border-b-0"
              >
                {/* The title is model-controlled (#1049 review): a reordered
                    one misrepresents WHICH session is about to be killed. */}
                <span className="min-w-0 truncate text-ink">{withVisibleControls(target.title)}</span>
                {target.live ? (
                  <span className="ml-2 flex-shrink-0 text-[10px] uppercase tracking-wider text-danger">
                    working
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}

        {live.length > 0 ? (
          <div className="text-[11px] text-muted">
            Undo Close restores the layout, but not live terminal output or unsent drafts.
          </div>
        ) : null}
        </div>
        ) : null}

        <DialogActions
          tone="danger"
          confirmKey={null}
          confirmLabel={request && request.targets.length > 1 ? `Close ${request.targets.length}` : 'Close'}
          onConfirm={() => resolveCloseConfirmation(true)}
          onCancel={() => resolveCloseConfirmation(false)}
        />
      </DialogContent>
    </Dialog>
  )
}

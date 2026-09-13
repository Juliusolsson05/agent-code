import { useEffect, useState } from 'react'

import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import {
  currentCloseConfirmation,
  resolveCloseConfirmation,
  subscribeToCloseConfirmation,
} from '@renderer/workspace/closeConfirmationBroker'
import type { PendingCloseConfirmation } from '@renderer/workspace/closeConfirmationBroker'

/**
 * The confirmation the close paths await before ending anything.
 *
 * It LISTS the sessions rather than only counting them. The audit's finding was
 * that a close expanding from one row to four looked identical to closing one;
 * a bare "close 4 sessions?" fixes the count but still leaves the user unable
 * to check whether the four are the four they meant.
 *
 * Keyboard contract (#867): there is deliberately NO Enter handler on this
 * dialog. Radix focuses the first tabbable control, which is Cancel, so Enter
 * on open cancels, and Enter on any Tab-focused button activates that button
 * natively. A dialog-level Enter handler would call preventDefault and could
 * turn Enter-on-Cancel into a close — the exact bug #867 found in three other
 * dialogs. The renderer test pins this.
 */
export function CloseConfirmationDialog() {
  const [pending, setPending] = useState<PendingCloseConfirmation | null>(
    currentCloseConfirmation(),
  )

  useEffect(() => subscribeToCloseConfirmation(setPending), [])

  const request = pending?.request
  const live = request?.targets.filter(target => target.live) ?? []
  const scoped = request?.agentOnly
  // "Close Agent" / "Close Terminal": the button names what the root actually
  // is. The request carries the noun because only the close action knows the
  // session kind; the dialog stays a renderer of plain data.
  const Noun = scoped?.noun === 'terminal' ? 'Terminal' : 'Agent'

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
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {scoped ? `Close the ${scoped.noun} or the tab?` : request?.reason === 'running'
              // "session" not "agent": a shell running a job reaches this
              // dialog too now that terminal foreground state counts as
              // working (#865), and it isn't an agent.
              ? 'Close a working session?'
              : request?.reason === 'irreversible'
                ? 'Kill this session permanently?'
                : 'Close these sessions?'}
          </DialogTitle>
          <DialogDescription>{request?.summary}</DialogDescription>
        </DialogHeader>

        {scoped ? (
          <p className="text-xs text-ink-dim">
            Close {Noun} ends {scoped.title}
            {scoped.targets.length > 1 ? ` and ${scoped.targets.length - 1} linked session(s)` : ''}.
            {' '}Other sessions in the tab stay open. Close Tab ends every session listed below.
          </p>
        ) : null}

        {request && request.targets.length > 1 ? (
          <div className="rounded-slab max-h-56 overflow-auto border border-border">
            {request.targets.map(target => (
              <div
                key={target.sessionId}
                className="flex items-center justify-between border-b border-border/40 px-2 py-1 text-xs last:border-b-0"
              >
                <span className="min-w-0 truncate text-ink">{target.title}</span>
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

        <DialogFooter>
          <Button variant="ghost" onClick={() => resolveCloseConfirmation(false)}>
            Cancel
          </Button>
          {scoped ? (
            // WHY `secondary`, not `destructive`, even though this button can
            // end a working session (#886 review n3): the dialog offers two
            // destructive scopes and exists to steer toward the NARROWER one.
            // Painting both red erases the only visual difference between
            // "end one session, keep the project, undo restores the root" and
            // "end every listed session" — and the review's m5 finding is
            // precisely that an operator reaching for the most prominent
            // destructive button closes a whole project. The danger cue for a
            // working root is not lost: the list marks it "working" and the
            // Undo note above appears. The house rule's intent (a destructive
            // confirmation looks destructive) is kept by Close Tab.
            <Button variant="secondary" onClick={() => resolveCloseConfirmation('agent')}>
              Close {Noun}
            </Button>
          ) : null}
          <Button variant="destructive" onClick={() => resolveCloseConfirmation(true)}>
            {scoped ? `Close Tab (${request!.targets.length})` : request && request.targets.length > 1
              ? `Close ${request.targets.length}`
              : 'Close'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

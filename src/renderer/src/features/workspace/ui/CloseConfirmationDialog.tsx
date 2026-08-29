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
 */
export function CloseConfirmationDialog() {
  const [pending, setPending] = useState<PendingCloseConfirmation | null>(
    currentCloseConfirmation(),
  )

  useEffect(() => subscribeToCloseConfirmation(setPending), [])

  const request = pending?.request
  const live = request?.targets.filter(target => target.live) ?? []

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
            {request?.reason === 'running'
              ? 'Close a working agent?'
              : request?.reason === 'irreversible'
                ? 'Kill this session permanently?'
                : 'Close these sessions?'}
          </DialogTitle>
          <DialogDescription>{request?.summary}</DialogDescription>
        </DialogHeader>

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
          <Button variant="destructive" onClick={() => resolveCloseConfirmation(true)}>
            {request && request.targets.length > 1
              ? `Close ${request.targets.length}`
              : 'Close'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

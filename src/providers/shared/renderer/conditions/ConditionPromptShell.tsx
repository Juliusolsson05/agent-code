import type { ReactNode } from 'react'

import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import type { ConditionAction } from '@shared/conditions-core/contract'
import { withVisibleControls } from '@shared/text/visibleControls'

/**
 * The must-answer prompt shell for providers whose runtime authors its own
 * action list (Grok, OpenCode): permission asks, questions, plan approvals.
 *
 * WHY one shared shell (UI pass): Grok's copy was a line-for-line clone of
 * OpenCode's, both hand-laid outside the app's dialog grammar (an 18px "!"
 * glyph, a 14px title, a pl-6 body indent, full-size buttons in a bespoke
 * footer). It now uses DialogHeader / a px-4 body / DialogFooter with sm
 * buttons, the same shape as every other dialog, and a fix lands in both
 * providers at once.
 *
 * WHY not DialogActions: the runtime supplies N actions with its own labels
 * ("Allow once", "Allow always", "Reject"), not one Cancel plus one confirm.
 * The footer keeps DialogActions' visual order and weights: reject actions
 * are ghost like Cancel, the rest are filled like a confirm.
 *
 * Must-answer: Escape and outside clicks never dismiss. In pane mode (#713)
 * there is no onOpenChange, so the pane dialog's Escape has nothing to call.
 * Initial focus is the first NON-reject action, so Enter accepts rather than
 * rejects, the trust-dialog convention; `data-autofocus` works in both modes.
 */
export function ConditionPromptShell({
  heading,
  description,
  children,
  actions,
  dispatch,
  isReject,
}: {
  heading: string
  /** One line under the heading, for sighted and assistive readers alike. */
  description: string
  children: ReactNode
  actions: ConditionAction[]
  dispatch: (action: ConditionAction) => Promise<void>
  /** Which runtime labels read as the destructive choice. Each provider's
   *  runtime words it differently, so each passes its own rule. */
  isReject: (action: ConditionAction) => boolean
}) {
  const firstPrimaryIdx = actions.findIndex(action => !isReject(action))
  return (
    <Dialog open>
      <DialogContent
        className="modal-pop"
        onEscapeKeyDown={event => event.preventDefault()}
        onPointerDownOutside={event => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{heading}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="px-4 py-3 text-[12px] leading-[1.6] text-ink-dim">{children}</div>
        <DialogFooter>
          {actions.map((action, i) => (
            <Button
              key={action.kind === 'custom' ? action.id : `pty-${i}`}
              type="button"
              size="sm"
              variant={isReject(action) ? 'ghost' : 'default'}
              // data-autofocus (not autoFocus): see pane-dialog.tsx (#713).
              data-autofocus={i === firstPrimaryIdx ? '' : undefined}
              onClick={() => {
                void dispatch(action)
              }}
            >
              {/* Runtime-supplied, and it is the text the user reads to decide
                  WHICH grant they are giving (#1049 re-review). */}
              {withVisibleControls(action.label)}
            </Button>
          ))}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

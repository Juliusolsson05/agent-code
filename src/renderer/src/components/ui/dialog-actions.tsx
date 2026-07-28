import * as React from 'react'

import { Button } from '@renderer/components/ui/button'
import { DialogFooter } from '@renderer/components/ui/dialog'

// DialogActions — the confirm/cancel footer every dialog should use.
//
// WHY THIS EXISTS
//
// `DialogFooter` is layout only: a flex row with a top border and nothing
// else. Every dialog therefore hand-wrote its own button pair, and they
// diverged exactly as much as you would expect from thirteen independent
// authors. An audit found six different cancel labels in the tree — "Cancel",
// "Skip", "close", "Close", "Esc", and a bare "✕" — across four different
// Button variants, plus four dialogs with no footer at all whose only mouse
// exit was clicking the backdrop.
//
// Worse, there is not a single `<form>` element in the entire renderer, so
// nothing gets submit-on-Enter for free. Sixteen dialogs hand-wrote their own
// `onKeyDown` Enter handler. One of them (the debug-bundle note prompt) binds
// Cmd+Enter where every sibling binds plain Enter — not a decision anyone
// made, just drift nobody noticed.
//
// This component owns all of it once: the button pair, the labels, the
// variants, the ordering, and the Enter/Escape wiring. A dialog that uses it
// is guaranteed to have a clickable exit, which is the property that matters
// for a mouse-only user — several dialogs currently let you do all the work
// and then strand you with no way to commit it.
//
// WHY the house rules below are fixed rather than props:
//   - Cancel is always literally "Cancel". "Skip" and "Esc" were describing
//     the KEY, not the action; a mouse user does not care what key it maps to.
//   - Cancel is always `ghost` and sits LEFT of confirm. Consistent position
//     matters more than any individual dialog's preference, because muscle
//     memory is the thing that makes a mouse-driven UI fast.
//   - Destructive confirms are `destructive`. That is the only signal telling
//     a user the right-hand button is not safe.
//
// Escape is deliberately NOT handled here — Radix already owns it on
// `DialogContent` and adding a second listener would mean two things racing to
// close the same surface. Only Enter is wired here, because Radix has no
// opinion about it.

export type DialogActionsProps = {
  /** Label for the primary action. Imperative verb, e.g. "Bury", "Close 3
   *  Agents". Not "OK" — a mouse user reads the button, not the title. */
  confirmLabel: string
  onConfirm: () => void
  /** Omit to render a confirm-only footer (an acknowledgement dialog). */
  onCancel?: () => void
  cancelLabel?: string
  /** `danger` swaps the confirm to the destructive variant. */
  tone?: 'default' | 'danger'
  /** Blocks confirm and dims it. Use for "nothing selected yet". */
  confirmDisabled?: boolean
  /** In-flight: blocks confirm and both key paths, without implying the input
   *  is invalid. */
  busy?: boolean
  /**
   * When false, Enter does not confirm. Set this for any dialog whose body
   * owns Enter — a multiline textarea, or a list whose Enter means "choose the
   * highlighted row". Defaults to true because the common case is a dialog
   * with one obvious commit.
   */
  confirmOnEnter?: boolean
  /** Extra content rendered left of the buttons, e.g. a summary count. */
  children?: React.ReactNode
}

export function DialogActions({
  confirmLabel,
  onConfirm,
  onCancel,
  cancelLabel = 'Cancel',
  tone = 'default',
  confirmDisabled = false,
  busy = false,
  confirmOnEnter = true,
  children,
}: DialogActionsProps) {
  const blocked = confirmDisabled || busy
  const footerRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    if (!confirmOnEnter) return
    // Scope the listener to THIS footer's own dialog rather than the document.
    // Two mounted dialogs (or a dialog over a full-page surface) would
    // otherwise both fire on a single Enter, and the one the user is not
    // looking at would commit.
    // HTMLElement rather than Element so the keydown listener types check —
    // Element's event map does not include keyboard events.
    const root = footerRef.current?.closest<HTMLElement>('[data-slot="dialog-content"]') ?? null
    if (!root) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter') return
      // Shift+Enter is newline everywhere in this app; a modifier means the
      // user is composing, not committing.
      if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      // A textarea owns its own Enter. Without this the footer would commit
      // the dialog while the user was trying to start a new line — the exact
      // reason several dialogs previously hand-rolled `!shiftKey` checks.
      if (target?.tagName === 'TEXTAREA') return
      // A FOCUSED BUTTON OWNS ITS OWN ENTER. This is the important one:
      // calling preventDefault below suppresses the synthesized click that
      // Enter would have sent to the focused control, so without this guard
      // tabbing to Cancel and pressing Enter would CONFIRM — and for a
      // destructive dialog that means Enter-on-Cancel performs the deletion.
      if (target?.tagName === 'BUTTON' || target?.tagName === 'A') return
      if (blocked) return
      event.preventDefault()
      onConfirm()
    }
    // Bubble phase on the dialog root. Anything inside that genuinely owns
    // Enter can stopPropagation to claim it first; note that a child using a
    // plain React onKeyDown WITHOUT stopPropagation will still reach this, so
    // such dialogs should pass confirmOnEnter={false} rather than rely on
    // ordering.
    root.addEventListener('keydown', onKeyDown)
    return () => root.removeEventListener('keydown', onKeyDown)
  }, [blocked, confirmOnEnter, onConfirm])

  return (
    <DialogFooter ref={footerRef}>
      {children ? <div className="mr-auto text-[11px] text-muted">{children}</div> : null}
      {onCancel ? (
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {cancelLabel}
        </Button>
      ) : null}
      <Button
        variant={tone === 'danger' ? 'destructive' : 'default'}
        size="sm"
        disabled={blocked}
        onClick={onConfirm}
      >
        {busy ? '…' : confirmLabel}
      </Button>
    </DialogFooter>
  )
}

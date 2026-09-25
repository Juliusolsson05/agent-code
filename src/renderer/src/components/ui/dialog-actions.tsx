import * as React from 'react'

import { Button } from '@renderer/components/ui/button'
import { DialogFooter } from '@renderer/components/ui/dialog'
import { Kbd } from '@renderer/components/ui/kbd'

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
   *  Agents". Not "OK" — a mouse user reads the button, not the title.
   *  Omit both confirmLabel and onConfirm for a CLOSE-ONLY dialog (a
   *  read-only viewer): the footer then renders just the cancel button,
   *  labelled via cancelLabel="Close" — one ghost `Close ⎋` (plan H5), which
   *  replaced the outline/secondary/"close"/"✕" variants those viewers used. */
  confirmLabel?: string
  onConfirm?: () => void
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
   * Which key commits, shown as a chip on the confirm button.
   *
   * `Enter` (default) — the common single-commit dialog.
   * `Cmd+Enter` — the dialog's body owns plain Enter (a multiline textarea),
   *   so commit needs a modifier. ⌘↩ commits from ANYWHERE in the dialog,
   *   including a focused textarea or button, because the modifier is the
   *   user saying "commit", not "type a newline" or "press this button".
   * `null` — no key commits; no chip is shown. Use it for a dialog whose
   *   commit genuinely should be deliberate (none today) rather than
   *   pretending with a chip that lies.
   *
   * WHY the chip and the listener are driven by the SAME prop: a hint that
   * names a key which does not do the thing is worse than no hint. Keeping
   * one source for "what commits" makes that drift impossible here.
   */
  confirmKey?: 'Enter' | 'Cmd+Enter' | null
  /**
   * When false, DialogActions does not WIRE the commit key itself — the
   * surface's own handler does (a list whose Enter means "commit the
   * selection", e.g. Pin Agents). The chip is still shown, because the key
   * still commits; only the listener's owner differs. Defaults to true.
   */
  confirmOnEnter?: boolean
  /**
   * Whether Escape cancels. Only affects the ⎋ chip on Cancel — Escape itself
   * belongs to Radix on DialogContent. Pass false while a surface blocks
   * Escape (Bulk Provider Switch mid-run, a must-answer Setup), so the chip
   * does not promise an exit the dialog is refusing.
   */
  escapeCancels?: boolean
  /**
   * Keys that have no button of their own (↑↓ move, Space toggle, ⌫ back),
   * rendered as ONE compact line left of the buttons. See `KbdLegend`.
   * WHY here and not a body row: the footer is where the eye already goes for
   * "what can I do now", and a legend row in the body costs a line on every
   * list dialog. Mutually compatible with `children`; legend renders first.
   */
  legend?: React.ReactNode
  /**
   * Extra buttons rendered between the legend and Cancel — a step dialog's
   * `Back ⌫`. Rendered as given; callers use `<Button variant="ghost"
   * size="sm">` + a `Kbd` so the row stays one visual family. Kept a slot, not
   * a config object, because each such button owns its own key and state.
   */
  extraActions?: React.ReactNode
  /** Extra content rendered left of the buttons, e.g. a summary count. */
  children?: React.ReactNode
}

/**
 * Whether the element an Enter keydown landed on owns that Enter itself.
 *
 * A focused button or link activates on Enter (the browser synthesizes a
 * click), and a textarea inserts a newline. Any dialog-level Enter handler that
 * calls `preventDefault` suppresses those, so it must ask this first — or Tab to
 * Cancel + Enter CONFIRMS, which for a destructive dialog means Enter-on-Cancel
 * performs the destructive action.
 *
 * Exported (rather than living only inside DialogActions' listener) because
 * list-style dialogs handle Enter on `DialogContent` themselves — New Agent In
 * and Switch Provider did, and both committed the highlighted row when Cancel
 * had focus (#862). One predicate keeps "which controls own Enter" in one place
 * instead of a guard copied into every list dialog.
 *
 * Such dialogs must also keep their list rows out of the tab order: a
 * Tab-focused row would own Enter here and diverge from the arrow-driven
 * highlight.
 *
 * `tabIndex={-1}` is only HALF of that, and the half that is easy to forget is
 * the one this predicate cannot help with: Chromium focuses a `<button>` on
 * CLICK regardless of `tabindex="-1"`. A clicked row therefore holds DOM focus,
 * owns the next Enter by this predicate, and the dialog-level handler bows out
 * of a keystroke the user meant for it. Rows in these dialogs pair the
 * tabIndex with `onMouseDown={e => e.preventDefault()}`, which keeps focus on
 * the dialog while still firing the click.
 */
export function focusedControlOwnsEnter(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.tagName === 'BUTTON' || target.tagName === 'A' || target.tagName === 'TEXTAREA'
}

/**
 * The same question for SPACE, which a dialog-level handler must ask whenever
 * it `preventDefault`s Space — a toggling list is the case here.
 *
 * WHY it is a separate predicate rather than `focusedControlOwnsEnter` reused:
 * the two keys do not activate the same set of elements. Space activates a
 * focused BUTTON and types into a TEXTAREA or INPUT, but it does NOT activate
 * a link — on an `<a>` it scrolls. Sharing the Enter predicate would have this
 * hand Space to a focused link and swallow the scroll; answering "which
 * element owns this key" with one list for two different keys is how the wrong
 * one gets quietly returned.
 *
 * The bug it is for (#867, found in review): Pin Sessions `preventDefault`s
 * Space unconditionally and toggles the HIGHLIGHTED row, so with Cancel
 * focused, Space did not press Cancel — it toggled a pin the user was not
 * looking at.
 */
export function focusedControlOwnsSpace(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.tagName === 'BUTTON' || target.tagName === 'TEXTAREA' || target.tagName === 'INPUT'
}

/**
 * `onOpenAutoFocus` handler that lands focus on one of this dialog's
 * DialogActions buttons (keyboard-first plan K1).
 *
 * WHY it exists: a DESTRUCTIVE dialog must open with focus on Cancel so that
 * a reflexive Enter cancels. Radix's default — "the first tabbable element" —
 * happened to be Cancel in most footers only because Cancel is rendered
 * first; any body control (a checkbox, a list) or a footer reorder silently
 * moved focus elsewhere. Keyed on `data-dialog-action`, not DOM order, so the
 * choice survives layout changes. Non-destructive single-commit dialogs use
 * 'confirm' so Enter-on-open commits.
 *
 * Falls back to Radix's default when the button is absent (a confirm-only
 * footer asked for 'cancel'), so focus is never left on <body>.
 */
export function focusDialogActionOnOpen(which: 'cancel' | 'confirm') {
  return (event: Event) => {
    const root = event.currentTarget instanceof HTMLElement ? event.currentTarget : null
    const target = root?.querySelector<HTMLButtonElement>(`[data-dialog-action="${which}"]:not(:disabled)`)
    if (!target) return
    event.preventDefault()
    target.focus()
  }
}

export function DialogActions({
  confirmLabel,
  onConfirm,
  onCancel,
  cancelLabel = 'Cancel',
  tone = 'default',
  confirmDisabled = false,
  busy = false,
  confirmKey = 'Enter',
  confirmOnEnter = true,
  escapeCancels = true,
  legend,
  extraActions,
  children,
}: DialogActionsProps) {
  const blocked = confirmDisabled || busy
  const footerRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    if (!onConfirm || !confirmOnEnter || confirmKey === null) return
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
      if (confirmKey === 'Cmd+Enter') {
        // Meta OR Ctrl: the canonical grammar spells it Cmd, but the one
        // dialog that had this binding before (debug-bundle note) accepted
        // both, and Ctrl+Enter reaching a non-mac keyboard layout costs
        // nothing. Shift/Alt on top means something else is being composed.
        if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return
        // Deliberately NO focusedControlOwnsEnter check: the modifier is an
        // explicit "commit" from wherever focus is, textarea included — that
        // is the entire reason a textarea dialog uses ⌘↩.
      } else {
        // Shift+Enter is newline everywhere in this app; a modifier means the
        // user is composing, not committing.
        if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return
        // A FOCUSED BUTTON OWNS ITS OWN ENTER, and a textarea owns its newline.
        // This is the important one: calling preventDefault below suppresses the
        // synthesized click that Enter would have sent to the focused control, so
        // without this guard tabbing to Cancel and pressing Enter would CONFIRM —
        // and for a destructive dialog that means Enter-on-Cancel performs the
        // deletion. The textarea half is the reason several dialogs previously
        // hand-rolled `!shiftKey` checks. See `focusedControlOwnsEnter`.
        if (focusedControlOwnsEnter(event.target)) return
      }
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
  }, [blocked, confirmKey, confirmOnEnter, onConfirm])

  return (
    <DialogFooter ref={footerRef}>
      {legend || children ? (
        // min-w-0 + truncate: the legend yields space to the buttons at narrow
        // widths instead of wrapping the footer onto two lines.
        <div className="mr-auto flex min-w-0 items-center gap-3 truncate text-[10px] text-muted">
          {legend}
          {children ? <span className="min-w-0 truncate text-[11px]">{children}</span> : null}
        </div>
      ) : null}
      {extraActions}
      {onCancel ? (
        <Button variant="ghost" size="sm" data-dialog-action="cancel" onClick={onCancel}>
          {cancelLabel}
          {escapeCancels ? <Kbd binding="Escape" /> : null}
        </Button>
      ) : null}
      {onConfirm ? (
        <Button
          variant={tone === 'danger' ? 'destructive' : 'default'}
          size="sm"
          data-dialog-action="confirm"
          disabled={blocked}
          onClick={onConfirm}
        >
          {busy ? '…' : confirmLabel}
          {confirmKey !== null && !busy ? (
            // onAccent: both confirm variants (default, destructive) are
            // FILLED, so the chip takes the button's foreground.
            <Kbd binding={confirmKey} tone="onAccent" />
          ) : null}
        </Button>
      ) : null}
    </DialogFooter>
  )
}

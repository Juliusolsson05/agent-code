import * as React from 'react'
import { create } from 'zustand'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { DialogActions } from '@renderer/components/ui/dialog-actions'

// ConfirmDialog + requestConfirm — the in-app replacement for window.confirm
// (keyboard-first plan decision D8; B7 and the steering reviewer concurred).
//
// WHY replace window.confirm at all, when it is keyboard-operable: 17 call
// sites (skills, conventions, custom skills, key vault, workflow runs) used
// it, and it is the one dialog in the app that looks like a different
// program — system chrome, system font, "OK"/"Cancel" instead of a verb, no
// key chips, and it BLOCKS the renderer's event loop while open (IPC replies,
// terminal output and streaming feeds all stall behind it). Those confirms are
// also opened from inside Radix dialogs, where a native modal on top of an
// app modal is two focus systems fighting.
//
// WHY a promise and one host, instead of each caller rendering its own
// <ConfirmDialog open>: every call site is a one-line guard of the shape
// `if (!window.confirm(msg)) return`. Turning each into local open-state +
// a second render branch would multiply 17 small guards into 17 small state
// machines. `if (!(await requestConfirm({...}))) return` keeps the call
// site's shape and puts the state in one place.
//
// WHERE THIS MUST NOT BE USED (B7's note): any confirm on a quit,
// beforeunload or window-close path. Those must block synchronously, and an
// async in-app dialog cannot — the window is gone before the promise settles.
// Keep those native or route them through main's dialog. None of the 17
// replaced sites is on such a path.
//
// KEYBOARD CONTRACT (plan K1/K3, steering note 1):
//   - danger: focus lands on CANCEL, and the confirm button shows NO Enter
//     chip and wires NO key. Enter-on-open therefore presses Cancel — a
//     destructive action is never one reflexive Enter away. Tab to the
//     destructive button and Enter (native button activation) or a click are
//     the only ways to confirm. ⌘↩ is deliberately NOT offered here: a
//     modifier commit that skips the focused Cancel would reopen exactly the
//     "Enter on open must never destroy" hole for anyone who learned ⌘↩ from
//     the note dialogs.
//   - default tone: focus lands on the confirm, Enter confirms.
//   - Escape always cancels (Radix, topmost-only, so the dialog underneath
//     stays open).

export type ConfirmRequest = {
  title: string
  /** Optional detail line under the title. */
  description?: React.ReactNode
  /** Imperative verb: "Delete Key", "Discard Changes". Not "OK". */
  confirmLabel: string
  cancelLabel?: string
  tone?: 'default' | 'danger'
}

type PendingConfirm = ConfirmRequest & { id: number; resolve: (confirmed: boolean) => void }

type ConfirmStore = {
  queue: PendingConfirm[]
  push: (request: PendingConfirm) => void
  settle: (id: number, confirmed: boolean) => void
}

let nextConfirmId = 1

// A queue, not a single slot: two confirms can be requested back to back
// (a bulk action whose guard fires twice). Showing the second only after the
// first settles keeps exactly one confirm on screen, and neither promise is
// silently dropped — a dropped promise would leave its caller awaiting
// forever with its own dialog stuck open.
const useConfirmStore = create<ConfirmStore>(set => ({
  queue: [],
  push: request => set(state => ({ queue: [...state.queue, request] })),
  settle: (id, confirmed) =>
    set(state => {
      const pending = state.queue.find(item => item.id === id)
      pending?.resolve(confirmed)
      return { queue: state.queue.filter(item => item.id !== id) }
    }),
}))

/** Ask the user. Resolves true on confirm, false on cancel/Escape/outside. */
export function requestConfirm(request: ConfirmRequest): Promise<boolean> {
  return new Promise(resolve => {
    useConfirmStore.getState().push({ ...request, id: nextConfirmId++, resolve })
  })
}

type ConfirmDialogProps = ConfirmRequest & {
  open: boolean
  onResolve: (confirmed: boolean) => void
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel,
  tone = 'default',
  onResolve,
}: ConfirmDialogProps) {
  const contentRef = React.useRef<HTMLDivElement>(null)
  const danger = tone === 'danger'
  return (
    <Dialog open={open} onOpenChange={next => { if (!next) onResolve(false) }}>
      <DialogContent
        ref={contentRef}
        size="sm"
        onOpenAutoFocus={event => {
          // Radix would focus the first tabbable element, which is Cancel
          // (DialogActions puts it left of confirm) — correct for danger by
          // accident of layout. Make both outcomes explicit so a footer
          // reorder can never silently move focus onto a destructive button.
          event.preventDefault()
          const buttons = contentRef.current?.querySelectorAll<HTMLButtonElement>('[data-slot="dialog-footer"] button')
          const target = danger ? buttons?.[0] : buttons?.[buttons.length - 1]
          target?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <DialogActions
          confirmLabel={confirmLabel}
          cancelLabel={cancelLabel}
          tone={tone}
          onConfirm={() => onResolve(true)}
          onCancel={() => onResolve(false)}
          confirmKey={danger ? null : 'Enter'}
        />
      </DialogContent>
    </Dialog>
  )
}

/**
 * Mounted once, last in the modal stack (app/surfaces/registry.tsx), so a
 * confirm always paints above the dialog that asked for it.
 */
export function ConfirmHost() {
  const current = useConfirmStore(state => state.queue[0])
  const settle = useConfirmStore(state => state.settle)
  if (!current) return null
  return (
    <ConfirmDialog
      // Keyed by id: a queued confirm replacing a settled one must be a NEW
      // dialog instance, so onOpenAutoFocus runs again for it.
      key={current.id}
      open
      title={current.title}
      description={current.description}
      confirmLabel={current.confirmLabel}
      cancelLabel={current.cancelLabel}
      tone={current.tone}
      onResolve={confirmed => settle(current.id, confirmed)}
    />
  )
}

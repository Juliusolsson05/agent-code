import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { DialogActions } from '@renderer/components/ui/dialog-actions'
import { withVisibleControls } from '@shared/text/visibleControls'

// WHY the modal takes intent callbacks instead of an onSend(bytes) writer:
// this component used to write a bare '\r' for accept, assuming Claude Code
// pre-highlights "Yes, I trust this folder". Claude Code 2.1.251 pre-highlights
// "No, exit", so that Enter confirmed the exit option and killed the session
// (#705). The correct keystrokes depend on the live screen, which only the
// headless side can observe — so the modal expresses INTENT and views.tsx
// dispatches the condition actions (custom accept resolved by the headless
// trust-dialog driver; Esc for decline). No raw bytes originate here anymore.
type Props = {
  state: { workspace?: string } | null
  onAccept: () => Promise<void>
  onDecline: () => Promise<void>
}

export function TrustDialogModal({ state, onAccept, onDecline }: Props) {
  if (!state) return null

  const accept = () => { void onAccept() }
  const decline = () => { void onDecline() }

  // The app's dialog grammar (UI pass): DialogHeader, a px-4 body, and the
  // shared DialogActions footer with sentence-case labels and key chips.
  // It was a hand-laid card with an 18px "!" glyph, 14px title, pl-6 body
  // indent and lowercase "cancel" / "trust this folder", unlike any other
  // dialog. The focus choice is unchanged: the TRUST button, as since #705.
  // Enter follows the focused button; the footer's dialog-level Enter is the
  // same confirm.
  return (
    <Dialog open onOpenChange={nextOpen => {
      if (!nextOpen) decline()
    }}>
      <DialogContent
        className="modal-pop"
        onPointerDownOutside={event => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Trust this folder?</DialogTitle>
          <DialogDescription>Claude Code will be able to read, edit, and run files in it.</DialogDescription>
        </DialogHeader>
        <div className="px-4 py-3 text-[12px] leading-[1.6] text-ink-dim">
          {state.workspace && (
            <pre className="mb-2 overflow-x-auto whitespace-nowrap rounded-slab bg-code-bg px-3 py-2 font-code text-[12px] text-accent">
              {withVisibleControls(state.workspace)}
            </pre>
          )}
          <p className="text-[11px] text-muted">
            Only continue if this is a project you created or one you trust.
          </p>
        </div>
        <DialogActions
          onCancel={decline}
          confirmLabel="Trust folder"
          onConfirm={accept}
          initialFocus="confirm"
        />
      </DialogContent>
    </Dialog>
  )
}

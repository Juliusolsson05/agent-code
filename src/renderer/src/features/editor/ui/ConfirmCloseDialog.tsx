import { Button } from '@renderer/components/ui/button'
import { DialogActions, focusDialogActionOnOpen } from '@renderer/components/ui/dialog-actions'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { withVisibleControls } from '@shared/text/visibleControls'

type Props = {
  fileName: string
  deleted?: boolean
  saving?: boolean
  error?: string | null
  onSaveAndClose: () => void
  onDiscard: () => void
  onCancel: () => void
}

// Unsaved-changes gate for tab close.
//
// WHY this uses the shared Dialog despite belonging to one workbench: losing
// edits is an application-modal decision. Radix supplies the focus trap,
// Escape arbitration, focus restoration, and interaction-owner marker that
// global capture/native input routers require. The old absolute scrim looked
// local but leaked Cmd+W/Escape into the hidden workspace behind it.
export function ConfirmCloseDialog({
  fileName,
  deleted = false,
  saving = false,
  error,
  onSaveAndClose,
  onDiscard,
  onCancel,
}: Props) {
  return (
    <Dialog
      open
      onOpenChange={open => {
        if (!open) onCancel()
      }}
    >
      <DialogContent
        size="sm"
        // Save & Close takes focus (it had autoFocus): the SAFE answer keeps
        // the edits, so Enter-on-open saving is the right reflex here.
        onOpenAutoFocus={focusDialogActionOnOpen('confirm')}
        // Mid-save the dialog must not vanish (steering note k3's rule):
        // Escape and outside clicks wait, as Cancel does (cancelDisabled).
        onEscapeKeyDown={event => { if (saving) event.preventDefault() }}
        onInteractOutside={event => { if (saving) event.preventDefault() }}
      >
        <DialogHeader>
          <DialogTitle>{deleted ? 'File deleted on disk' : 'Unsaved changes'}</DialogTitle>
          <DialogDescription>
            {/* Which file is saved, discarded or recreated is the whole
                decision, and an invisible character makes two names identical
                (#1049 re-review). */}
            {deleted
              ? `“${withVisibleControls(fileName)}” no longer exists on disk. Its in-memory copy is still safe here. Recreate it before closing?`
              : `“${withVisibleControls(fileName)}” has unsaved changes. Save before closing?`}
          </DialogDescription>
          {error ? (
            <p role="alert" className="mt-2 text-[11px] text-danger">
              {error}
            </p>
          ) : null}
        </DialogHeader>
        {/* Every old `disabled={saving}` guard carries over (k3): Cancel,
            Discard and the confirm all wait for the save. Discard is the
            destructive-OUTLINE variant — it is the dangerous answer but not
            the primary one, and a second filled button beside Save & Close
            competed with it. It has no key: Enter saves, Escape cancels. */}
        <DialogActions
          confirmLabel={saving ? 'Saving…' : deleted ? 'Recreate & Close' : 'Save & Close'}
          confirmDisabled={saving}
          onConfirm={onSaveAndClose}
          onCancel={onCancel}
          cancelDisabled={saving}
          escapeCancels={!saving}
          extraActions={
            <Button type="button" variant="destructive-outline" size="sm" className="mr-auto" onClick={onDiscard} disabled={saving}>
              Discard
            </Button>
          }
        />
      </DialogContent>
    </Dialog>
  )
}

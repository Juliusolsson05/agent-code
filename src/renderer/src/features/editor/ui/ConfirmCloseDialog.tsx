import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'

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
      <DialogContent className="w-[min(420px,92vw)]">
        <DialogHeader>
          <DialogTitle>{deleted ? 'File deleted on disk' : 'Unsaved changes'}</DialogTitle>
          <DialogDescription>
            {deleted
              ? `“${fileName}” no longer exists on disk. Its in-memory copy is still safe here. Recreate it before closing?`
              : `“${fileName}” has unsaved changes. Save before closing?`}
          </DialogDescription>
          {error ? (
            <p role="alert" className="mt-2 text-[11px] text-danger">
              {error}
            </p>
          ) : null}
        </DialogHeader>
        <DialogFooter>
          <Button type="button" onClick={onCancel} variant="outline" disabled={saving}>
            Cancel
          </Button>
          <Button type="button" onClick={onDiscard} variant="destructive" disabled={saving}>
            Discard
          </Button>
          <Button type="button" onClick={onSaveAndClose} autoFocus disabled={saving}>
            {saving ? 'Saving…' : deleted ? 'Recreate & Close' : 'Save & Close'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

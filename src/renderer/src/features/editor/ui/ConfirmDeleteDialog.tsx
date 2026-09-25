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
  path: string
  dirtyPaths: string[]
  onCancel: () => void
  onConfirm: () => void
}

// Explorer deletion is a disk mutation, so the dirty-buffer decision must
// happen before IPC. A post-delete dirty-tab prompt is too late: Cancel could
// no longer restore the file that was already removed.
export function ConfirmDeleteDialog({ path, dirtyPaths, onCancel, onConfirm }: Props) {
  const dirtyCount = dirtyPaths.length
  return (
    <Dialog open onOpenChange={open => !open && onCancel()}>
      {/* Destructive (plan K1): focus on Cancel (it had autoFocus), no
          commit key — Tab to Delete, or click. */}
      <DialogContent size="sm" onOpenAutoFocus={focusDialogActionOnOpen('cancel')}>
        <DialogHeader>
          <DialogTitle>Delete from disk?</DialogTitle>
          <DialogDescription>
            {/* `report.txt<U+200B>` and `report.txt` are different files and
                render identically; this dialog authorises deleting one of
                them (#1049 re-review). */}
            “{withVisibleControls(path)}” will be permanently deleted.
            {dirtyCount > 0
              ? ` ${dirtyCount} open unsaved ${dirtyCount === 1 ? 'file is' : 'files are'} inside it; confirming will discard those edits.`
              : ' This action cannot be undone in Agent Code.'}
          </DialogDescription>
        </DialogHeader>
        {dirtyCount > 0 ? (
          <div className="max-h-28 overflow-auto px-4 py-3 font-code text-[11px] text-danger">
            {dirtyPaths.map(dirtyPath => (
              <div key={dirtyPath} className="truncate" title={dirtyPath}>
                {withVisibleControls(dirtyPath)}
              </div>
            ))}
          </div>
        ) : null}
        <DialogActions
          tone="danger"
          confirmKey={null}
          confirmLabel={dirtyCount > 0 ? 'Delete & Discard' : 'Delete'}
          onConfirm={onConfirm}
          onCancel={onCancel}
        />
      </DialogContent>
    </Dialog>
  )
}

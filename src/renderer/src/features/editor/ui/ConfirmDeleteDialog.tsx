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
      <DialogContent className="w-[min(460px,92vw)]">
        <DialogHeader>
          <DialogTitle>Delete from disk?</DialogTitle>
          <DialogDescription>
            “{path}” will be permanently deleted.
            {dirtyCount > 0
              ? ` ${dirtyCount} open unsaved ${dirtyCount === 1 ? 'file is' : 'files are'} inside it; confirming will discard those edits.`
              : ' This action cannot be undone in Agent Code.'}
          </DialogDescription>
        </DialogHeader>
        {dirtyCount > 0 ? (
          <div className="max-h-28 overflow-auto px-4 pb-3 font-code text-[10px] text-danger">
            {dirtyPaths.map(dirtyPath => (
              <div key={dirtyPath} className="truncate" title={dirtyPath}>
                {dirtyPath}
              </div>
            ))}
          </div>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel} autoFocus>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={onConfirm}>
            {dirtyCount > 0 ? 'Delete & Discard' : 'Delete'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
